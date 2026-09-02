#!/usr/bin/env python3
"""Minimal JSON bridge between Electron and the laboratory IPI Java Card applet."""

import hashlib
import hmac
import json
import signal
import sys
import threading

from smartcard.System import readers
from smartcard.CardMonitoring import CardMonitor, CardObserver

APPLETS = (
    ("secure", [0xF0, 0x49, 0x50, 0x49, 0x43, 0x01, 0x01]),
    ("ethereum-mainnet", [0xF0, 0x49, 0x50, 0x49, 0x45, 0x02, 0x01]),
    ("bitcoin-mainnet", [0xF0, 0x49, 0x50, 0x49, 0x42, 0x02, 0x01]),
)

PROFILE_SELECTORS = {
    "ipi": "secure",
    "ethereum": "ethereum-mainnet",
    "bitcoin": "bitcoin-mainnet",
}

AUTH_DOMAINS = {
    "secure": {
        "verify": b"IPI_CARD_VERIFY_V2",
        "change-password": b"IPI_CARD_CHANGE_V2",
        "sign": b"IPI_CARD_SIGN_V2",
        "recover": b"IPI_CARD_RECOVERY_V1",
    },
    "ethereum-mainnet": {
        "verify": b"IPI_CARD_ETH_MAINNET_VERIFY_V1",
        "change-password": b"IPI_CARD_ETH_MAINNET_CHANGE_V1",
        "sign": b"IPI_CARD_ETH_MAINNET_SIGN_V1",
        "recover": b"IPI_CARD_ETH_MAINNET_RECOVERY_V1",
    },
    "bitcoin-mainnet": {
        "verify": b"IPI_CARD_BTC_MAINNET_VERIFY_V1",
        "change-password": b"IPI_CARD_BTC_MAINNET_CHANGE_V1",
        "sign": b"IPI_CARD_BTC_MAINNET_SIGN_V1",
        "recover": b"IPI_CARD_BTC_MAINNET_RECOVERY_V1",
    },
}


def is_contactless_atr(atr):
    """Recognize the PC/SC pseudo-ATR prefix generated for ISO 14443 cards."""
    return (
        len(atr) >= 4
        and atr[0] == 0x3B
        and atr[1] & 0xF0 == 0x80
        and atr[2] == 0x80
        and atr[3] == 0x01
    )


def present_interfaces(available):
    """Probe card presence cheaply and prefer contactless interfaces."""
    present = []
    attempts = []
    for reader in available:
        connection = None
        try:
            connection = reader.createConnection()
            connection.connect()
            present.append((reader, bytes(connection.getATR())))
        except Exception as error:
            attempts.append(f"{reader}: {error}")
        finally:
            if connection is not None:
                try:
                    connection.disconnect()
                except Exception:
                    pass
    present.sort(key=lambda item: int(is_contactless_atr(item[1])), reverse=True)
    return present, attempts


def transmit(connection, apdu):
    data, sw1, sw2 = connection.transmit(apdu)
    if sw1 == 0x61:
        extra, sw1, sw2 = connection.transmit([0x00, 0xC0, 0x00, 0x00, sw2])
        data += extra
    return data, (sw1 << 8) | sw2


def connect(requested_profile=None):
    available = list(readers())
    if not available:
        raise RuntimeError("No PC/SC reader is available")

    # Do not assume a fixed reader name or contact slot. The same ISO 7816
    # applet can be selected over a contact or ISO 14443-4 interface when the
    # physical card supports it.
    present, attempts = present_interfaces(available)
    for reader, _atr in present:
        connection = None
        matched = False
        try:
            connection = reader.createConnection()
            connection.connect()
            for profile, aid in APPLETS:
                if requested_profile is not None and profile != requested_profile:
                    continue
                _, sw = transmit(connection, [0x00, 0xA4, 0x04, 0x00, len(aid), *aid, 0x00])
                if sw == 0x9000:
                    matched = True
                    return connection, str(reader), profile
            attempts.append(f"{reader}: no supported IPI applet")
        except Exception as error:
            attempts.append(f"{reader}: {error}")
        finally:
            if connection is not None and not matched:
                try:
                    connection.disconnect()
                except Exception:
                    pass

    detail = "; ".join(attempts)
    raise RuntimeError(f"IPI Card applet was not found on any PC/SC interface ({detail})")


def detect_card(available=None):
    """Detect any ISO 7816/PCSC card without requiring an IPI applet."""
    available = list(readers()) if available is None else list(available)
    if not available:
        raise RuntimeError("No PC/SC reader is available")
    present, attempts = present_interfaces(available)
    if present:
        reader, atr = present[0]
        return {"connected": True, "reader": str(reader), "atr": atr.hex()}
    raise RuntimeError(f"No card is present on any PC/SC interface ({'; '.join(attempts)})")


def protected_profile(profile):
    return True


def challenge_profile(profile):
    return profile in (
        "secure-v2",
        "ethereum-mainnet-v1",
        "bitcoin-mainnet-v1",
        "secure-v3",
        "ethereum-mainnet-v2",
        "bitcoin-mainnet-v2",
    )


def domain_family(profile):
    if profile.startswith("secure-"):
        return "secure"
    return profile[:-3] if profile.endswith(("-v1", "-v2")) else profile


def public_key(connection, profile):
    ins = 0x21 if protected_profile(profile) else 0x30
    data, sw = transmit(connection, [0x80, ins, 0x00, 0x00, 0x00])
    if sw == 0x6985:
        return None
    if sw != 0x9000 or len(data) != 65 or data[0] != 0x04:
        raise RuntimeError(f"Cannot read card public key (SW={sw:04X})")
    return bytes(data).hex()


def read_arguments():
    """Read action data from stdin so credentials never appear in process argv."""
    if len(sys.argv) > 2:
        raise RuntimeError("Card bridge action data must be supplied through stdin")
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise RuntimeError("Card bridge input is too large")
    if not raw:
        return []
    values = json.loads(raw.decode("utf-8"))
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        raise RuntimeError("Card bridge input must be a JSON string array")
    return values


def secure_info(connection):
    info, sw = transmit(connection, [0x80, 0x20, 0x00, 0x00, 0x00])
    if sw != 0x9000 or len(info) not in (4, 24, 26):
        raise RuntimeError(f"Cannot read card security state (SW={sw:04X})")
    version = info[0]
    if info[1] not in (0, 1, 2) or info[2] > info[3] or info[3] == 0:
        raise RuntimeError("Card returned an invalid security state")
    if version == 2 and len(info) == 24:
        return {
            "profile": "secure-v2",
            "stateCode": info[1],
            "triesRemaining": info[2],
            "retryLimit": info[3],
            "credentialSalt": bytes(info[4:20]).hex(),
            "authCounter": int.from_bytes(bytes(info[20:24]), "big"),
            "recoveryTriesRemaining": None,
            "recoveryRetryLimit": None,
            "recoverySupported": False,
        }
    if version == 3 and len(info) == 26:
        if info[24] > info[25] or info[25] == 0:
            raise RuntimeError("Card returned an invalid recovery state")
        return {
            "profile": "secure-v3",
            "stateCode": info[1],
            "triesRemaining": info[2],
            "retryLimit": info[3],
            "credentialSalt": bytes(info[4:20]).hex(),
            "authCounter": int.from_bytes(bytes(info[20:24]), "big"),
            "recoveryTriesRemaining": info[24],
            "recoveryRetryLimit": info[25],
            "recoverySupported": True,
        }
    if version == 1 and len(info) == 4:
        return {
            "profile": "secure-v1",
            "stateCode": info[1],
            "triesRemaining": info[2],
            "retryLimit": info[3],
            "credentialSalt": None,
            "authCounter": None,
            "recoveryTriesRemaining": None,
            "recoveryRetryLimit": None,
            "recoverySupported": False,
        }
    raise RuntimeError(f"Unsupported secure IPI Card protocol version {version}")


def require_hex(value, byte_length, label):
    if len(value) != byte_length * 2:
        raise RuntimeError(f"{label} must contain exactly {byte_length} bytes")
    try:
        return bytearray.fromhex(value)
    except ValueError as error:
        raise RuntimeError(f"{label} must be hexadecimal") from error


def ensure_expected_salt(metadata, expected):
    actual = metadata.get("credentialSalt")
    if actual is not None and expected != actual:
        raise RuntimeError("The IPI Card changed during password preparation")


def get_challenge(connection):
    challenge, sw = transmit(connection, [0x80, 0x32, 0x00, 0x00, 0x00])
    if sw != 0x9000 or len(challenge) != 36:
        raise RuntimeError(f"Cannot obtain a one-time card challenge (SW={sw:04X})")
    return bytes(challenge)


def get_recovery_challenge(connection):
    challenge, sw = transmit(connection, [0x80, 0x33, 0x00, 0x00, 0x00])
    if sw != 0x9000 or len(challenge) != 36:
        raise RuntimeError(f"Cannot obtain a one-time recovery challenge (SW={sw:04X})")
    return bytes(challenge)


def authentication_tag(credential, profile, action, challenge, payload=b""):
    domains = AUTH_DOMAINS.get(domain_family(profile))
    if domains is None:
        raise RuntimeError(f"No authentication domain for profile {profile}")
    return bytearray(hmac.new(credential, domains[action] + challenge + payload, hashlib.sha256).digest())


def main():
    if len(sys.argv) < 2:
        raise RuntimeError("Card bridge action is required")
    action = sys.argv[1]
    if action == "watch":
        stop = threading.Event()

        class Observer(CardObserver):
            def update(self, observable, actions):
                added, removed = actions
                for card in added:
                    print(json.dumps({"event": "inserted", "reader": str(card.reader)}), flush=True)
                for card in removed:
                    print(json.dumps({"event": "removed", "reader": str(card.reader)}), flush=True)

        monitor = CardMonitor()
        observer = Observer()
        monitor.addObserver(observer)
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        print(json.dumps({"event": "watching"}), flush=True)
        try:
            while not stop.wait(1):
                # pyscard stops its internal thread when pcscd disappears, but
                # CardMonitor does not propagate that failure to this process.
                # Exit so Electron can create a fresh PC/SC context.
                monitor_thread = getattr(monitor, "rmthread", None)
                if monitor_thread is not None and not monitor_thread.is_alive():
                    raise RuntimeError("PC/SC card monitor stopped")
        finally:
            monitor.deleteObserver(observer)
        return

    arguments = read_arguments()
    if action == "presence":
        if arguments:
            raise RuntimeError("Card presence check accepts no arguments")
        print(json.dumps(detect_card(), separators=(",", ":")))
        return
    profile_actions = {
        "status-profile": "status",
        "initialize-profile": "initialize",
        "verify-profile": "verify",
        "change-password-profile": "change-password",
        "recover-profile": "recover",
        "sign-profile": "sign",
    }
    requested_profile = None
    if action in profile_actions:
        if not arguments:
            raise RuntimeError("A card profile selector is required")
        selector = arguments.pop(0)
        requested_profile = PROFILE_SELECTORS.get(selector)
        if requested_profile is None:
            raise RuntimeError(f"Unsupported card profile selector {selector}")
        action = profile_actions[action]
    else:
        raise RuntimeError("Wallet card operations require an explicit production profile")

    connection, reader, selected_profile = connect(requested_profile)
    sensitive = []
    try:
        metadata = secure_info(connection)
        if selected_profile == "secure":
            profile = metadata["profile"]
        elif selected_profile in (
            "ethereum-mainnet",
            "bitcoin-mainnet",
        ):
            if metadata["profile"] not in ("secure-v2", "secure-v3"):
                raise RuntimeError(f"Unsupported {selected_profile} card protocol")
            profile = f"{selected_profile}-{'v2' if metadata['profile'] == 'secure-v3' else 'v1'}"
        else:
            profile = selected_profile
        if action == "status":
            initialized = metadata["stateCode"] != 0
            key = public_key(connection, profile) if initialized else None
            security = {"supported": True, "state": ("blocked" if metadata["stateCode"] == 2 else "locked" if initialized else "factory"), "triesRemaining": metadata["triesRemaining"], "retryLimit": metadata["retryLimit"], "recoverySupported": metadata["recoverySupported"], "recoveryTriesRemaining": metadata["recoveryTriesRemaining"], "recoveryRetryLimit": metadata["recoveryRetryLimit"]}
            result = {"connected": True, "initialized": initialized, "publicKey": key, "reader": reader, "profile": profile, "credentialSalt": metadata["credentialSalt"], "authCounter": metadata["authCounter"], "security": security}
        elif action == "initialize":
            if not protected_profile(profile):
                raise RuntimeError("The installed probe cannot be password-protected; use the secure IPI Card applet")
            expected_count = 3 if metadata["recoverySupported"] else 2
            if len(arguments) != expected_count:
                raise RuntimeError("Initialization requires primary and recovery credentials")
            if challenge_profile(profile):
                ensure_expected_salt(metadata, arguments[-1])
            # Never expose the probe's destructive re-generation behavior to
            # the Wallet. A production applet must enforce this itself too.
            if metadata["stateCode"] != 0:
                raise RuntimeError("This IPI Card is already initialized; refusing to replace its private key")
            credential = require_hex(arguments[0], 32, "Initialization credential")
            sensitive.append(credential)
            if metadata["recoverySupported"]:
                recovery = require_hex(arguments[1], 32, "Recovery credential")
                sensitive.append(recovery)
                data, sw = transmit(connection, [0x80, 0x10, 0x00, 0x00, 0x40, *credential, *recovery, 0x00])
            else:
                data, sw = transmit(connection, [0x80, 0x10, 0x00, 0x00, 0x20, *credential, 0x00])
            if sw != 0x9000 or len(data) != 65 or data[0] != 0x04:
                raise RuntimeError(f"Card initialization failed (SW={sw:04X})")
            result = {"connected": True, "initialized": True, "publicKey": bytes(data).hex(), "reader": reader, "profile": profile}
        elif action == "verify":
            if not protected_profile(profile) or len(arguments) not in (1, 2):
                raise RuntimeError("Password verification is not supported by this card")
            credential = require_hex(arguments[0], 32, "Password credential")
            sensitive.append(credential)
            if challenge_profile(profile):
                ensure_expected_salt(metadata, arguments[1] if len(arguments) == 2 else "")
                challenge = get_challenge(connection)
                proof = authentication_tag(credential, profile, "verify", challenge)
                sensitive.append(proof)
                _, sw = transmit(connection, [0x80, 0x30, 0x00, 0x00, 0x20, *proof])
            else:
                _, sw = transmit(connection, [0x80, 0x30, 0x00, 0x00, 0x20, *credential])
            if sw != 0x9000:
                remaining = sw & 0x0F if (sw & 0xFFF0) == 0x63C0 else None
                raise RuntimeError(f"Incorrect password{f'; {remaining} attempts remaining' if remaining is not None else ''}")
            result = {"verified": True, "reader": reader}
        elif action == "change-password":
            if not protected_profile(profile) or len(arguments) not in (2, 3):
                raise RuntimeError("Password change requires old and new credentials")
            old = require_hex(arguments[0], 32, "Current password credential")
            new = require_hex(arguments[1], 32, "New password credential")
            sensitive.extend((old, new))
            if challenge_profile(profile):
                ensure_expected_salt(metadata, arguments[2] if len(arguments) == 3 else "")
                challenge = get_challenge(connection)
                proof = authentication_tag(old, profile, "change-password", challenge, new)
                sensitive.append(proof)
                _, sw = transmit(connection, [0x80, 0x31, 0x00, 0x00, 0x40, *new, *proof])
            else:
                _, sw = transmit(connection, [0x80, 0x31, 0x00, 0x00, 0x40, *old, *new])
            if sw != 0x9000:
                remaining = sw & 0x0F if (sw & 0xFFF0) == 0x63C0 else None
                raise RuntimeError(f"Password change failed{f'; {remaining} attempts remaining' if remaining is not None else ''}")
            result = {"changed": True, "reader": reader}
        elif action == "recover":
            if not metadata["recoverySupported"] or len(arguments) != 3:
                raise RuntimeError("Password recovery is not supported by this card")
            recovery = require_hex(arguments[0], 32, "Recovery credential")
            new = require_hex(arguments[1], 32, "New password credential")
            sensitive.extend((recovery, new))
            ensure_expected_salt(metadata, arguments[2])
            key_before = public_key(connection, profile)
            challenge = get_recovery_challenge(connection)
            proof = authentication_tag(recovery, profile, "recover", challenge, new)
            sensitive.append(proof)
            _, sw = transmit(connection, [0x80, 0x34, 0x00, 0x00, 0x40, *new, *proof])
            if sw != 0x9000:
                remaining = sw & 0x0F if (sw & 0xFFF0) == 0x63C0 else None
                raise RuntimeError(f"Incorrect recovery password{f'; {remaining} attempts remaining' if remaining is not None else ''}")
            if public_key(connection, profile) != key_before:
                raise RuntimeError("Card public key changed during password recovery")
            result = {"recovered": True, "reader": reader}
        elif action == "sign":
            expected = (2, 3) if protected_profile(profile) else (1,)
            if len(arguments) not in expected:
                raise RuntimeError("Signing requires one 32-byte hexadecimal digest")
            digest = require_hex(arguments[1] if protected_profile(profile) else arguments[0], 32, "Signing digest")
            if protected_profile(profile):
                credential = require_hex(arguments[0], 32, "Signing credential")
                sensitive.append(credential)
                if challenge_profile(profile):
                    ensure_expected_salt(metadata, arguments[2] if len(arguments) == 3 else "")
                    challenge = get_challenge(connection)
                    proof = authentication_tag(credential, profile, "sign", challenge, digest)
                    sensitive.append(proof)
                    data, sw = transmit(connection, [0x80, 0x40, 0x00, 0x00, 0x40, *digest, *proof, 0x00])
                else:
                    data, sw = transmit(connection, [0x80, 0x40, 0x00, 0x00, 0x40, *credential, *digest, 0x00])
            else:
                data, sw = transmit(connection, [0x80, 0x20, 0x00, 0x00, 0x20, *digest, 0x00])
            if sw != 0x9000:
                raise RuntimeError(f"Card signing failed (SW={sw:04X})")
            result = {"signatureDer": bytes(data).hex(), "publicKey": public_key(connection, profile), "reader": reader}
        else:
            raise RuntimeError("Unknown card bridge action")
    finally:
        for secret in sensitive:
            for index in range(len(secret)):
                secret[index] = 0
        connection.disconnect()
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
