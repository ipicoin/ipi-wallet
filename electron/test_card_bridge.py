import unittest

import card_bridge


class CardProtocolV2Tests(unittest.TestCase):
    def setUp(self):
        self.credential = bytes(range(32))
        self.challenge = bytes([0, 0, 0, 7]) + bytes(range(32, 64))

    def test_verify_proof_matches_cross_language_vector(self):
        proof = card_bridge.authentication_tag(
            self.credential, "secure-v2", "verify", self.challenge
        )
        self.assertEqual(
            proof.hex(),
            "63962c8fa128e7cb5c5371e3246f569c5b37327edad2f118718e79c025261376",
        )

    def test_sign_proof_binds_digest(self):
        digest = bytes(range(64, 96))
        proof = card_bridge.authentication_tag(
            self.credential, "secure-v2", "sign", self.challenge, digest
        )
        self.assertEqual(
            proof.hex(),
            "f2de2b7027bdc49af062798f5c5b4df7382e68d8b4f9a01a47e9ac62a04d5885",
        )
        changed = digest[:-1] + bytes([digest[-1] ^ 1])
        self.assertNotEqual(
            proof,
            card_bridge.authentication_tag(
                self.credential, "secure-v2", "sign", self.challenge, changed
            ),
        )

    def test_change_proof_binds_new_credential(self):
        new_credential = bytes(range(96, 128))
        proof = card_bridge.authentication_tag(
            self.credential, "secure-v2", "change-password", self.challenge, new_credential
        )
        self.assertEqual(
            proof.hex(),
            "7e324844455c61d09c60623284f96a81cedb9e21e1fb2011b3c7f7c337ec1073",
        )

    def test_new_challenge_cannot_reuse_old_proof(self):
        digest = bytes(range(64, 96))
        first = card_bridge.authentication_tag(
            self.credential, "secure-v2", "sign", self.challenge, digest
        )
        next_challenge = bytes([0, 0, 0, 8]) + self.challenge[4:]
        second = card_bridge.authentication_tag(
            self.credential, "secure-v2", "sign", next_challenge, digest
        )
        self.assertNotEqual(first, second)

    def test_chain_profiles_are_cryptographically_separated(self):
        digest = bytes(range(64, 96))
        ipi = card_bridge.authentication_tag(
            self.credential, "secure-v2", "sign", self.challenge, digest
        )
        ethereum = card_bridge.authentication_tag(
            self.credential, "ethereum-mainnet-v1", "sign", self.challenge, digest
        )
        bitcoin = card_bridge.authentication_tag(
            self.credential, "bitcoin-mainnet-v1", "sign", self.challenge, digest
        )
        self.assertEqual(len({bytes(ipi), bytes(ethereum), bytes(bitcoin)}), 3)


class CardProtocolV3RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.recovery_credential = bytes(range(32))
        self.challenge = bytes([0, 0, 0, 7]) + bytes(range(32, 64))
        self.new_credential = bytes(range(96, 128))

    def test_recovery_proof_binds_new_credential_and_profile(self):
        proofs = {
            profile: card_bridge.authentication_tag(
                self.recovery_credential, profile, "recover", self.challenge, self.new_credential
            ).hex()
            for profile in ("secure-v3", "ethereum-mainnet-v2", "bitcoin-mainnet-v2")
        }
        self.assertEqual(proofs, {
            "secure-v3": "ea12aa9ef480774dc17663c8a54692400720040c5e16b0714c8b9509e3c73032",
            "ethereum-mainnet-v2": "31cb0fe30b5a9a828a0365438e4a2da6d9407ff949a9f2ed611a2b65443a64ba",
            "bitcoin-mainnet-v2": "00ed32d360daec09096e0bae24130fe7da994f81bd4eb205eaffd155f7d1e773",
        })
        changed = self.new_credential[:-1] + bytes([self.new_credential[-1] ^ 1])
        self.assertNotEqual(
            proofs["secure-v3"],
            card_bridge.authentication_tag(
                self.recovery_credential, "secure-v3", "recover", self.challenge, changed
            ).hex(),
        )

    def test_v3_metadata_exposes_independent_ten_attempt_counters(self):
        info = bytes([3, 2, 0, 10, *range(16), 0, 0, 0, 9, 7, 10])

        class Connection:
            def transmit(self, _apdu):
                return list(info), 0x90, 0x00

        metadata = card_bridge.secure_info(Connection())
        self.assertEqual(metadata["profile"], "secure-v3")
        self.assertEqual(metadata["triesRemaining"], 0)
        self.assertEqual(metadata["retryLimit"], 10)
        self.assertEqual(metadata["recoveryTriesRemaining"], 7)
        self.assertEqual(metadata["recoveryRetryLimit"], 10)
        self.assertTrue(metadata["recoverySupported"])

    def test_v2_metadata_never_claims_recovery_support(self):
        info = bytes([2, 1, 5, 5, *range(16), 0, 0, 0, 1])

        class Connection:
            def transmit(self, _apdu):
                return list(info), 0x90, 0x00

        metadata = card_bridge.secure_info(Connection())
        self.assertFalse(metadata["recoverySupported"])
        self.assertIsNone(metadata["recoveryTriesRemaining"])


class CardPresenceTests(unittest.TestCase):
    class Connection:
        def __init__(self, atr=None):
            self.atr = atr or [0x3B, 0x00]
            self.connected = False
            self.disconnected = False

        def connect(self):
            self.connected = True

        def getATR(self):
            return self.atr

        def disconnect(self):
            self.disconnected = True

    class Reader:
        def __init__(self, connection):
            self.connection = connection

        def createConnection(self):
            return self.connection

        def __str__(self):
            return "Test reader 00 00"

    def test_unprovisioned_card_is_still_detected(self):
        connection = self.Connection()
        result = card_bridge.detect_card([self.Reader(connection)])
        self.assertTrue(result["connected"])
        self.assertEqual(result["reader"], "Test reader 00 00")
        self.assertEqual(result["atr"], "3b00")
        self.assertTrue(connection.connected)
        self.assertTrue(connection.disconnected)

    def test_presence_requires_a_reader(self):
        with self.assertRaisesRegex(RuntimeError, "No PC/SC reader"):
            card_bridge.detect_card([])

    def test_contactless_interface_is_preferred(self):
        contact = self.Reader(
            self.Connection(bytes.fromhex("3BF81300008131FE454A434F5076323431B7"))
        )
        contactless = self.Reader(
            self.Connection(bytes.fromhex("3B8A800150564A434F503453494471"))
        )
        contactless.__str__ = lambda: "Test reader 00 01"
        present, _attempts = card_bridge.present_interfaces([contact, contactless])
        self.assertTrue(card_bridge.is_contactless_atr(present[0][1]))


if __name__ == "__main__":
    unittest.main()
