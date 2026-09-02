#!/usr/bin/env bash
# Keep OpenSC available to PC/SC applications while preventing browser NSS
# profiles from polling every inserted smart card.

set -euo pipefail
shopt -s nullglob

PROGRAM="${0##*/}"
ACTION="status"
FORCE=0
HOME_OVERRIDE=""
STAMP="$(date +%Y%m%d-%H%M%S)-${BASHPID}"

log() { printf '[ipi-browser-guard] %s\n' "$*"; }
warn() { printf '[ipi-browser-guard] WARN: %s\n' "$*" >&2; }
fail() { printf '[ipi-browser-guard] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $PROGRAM [status|apply|restore] [--home DIRECTORY] [--force]

  status   Report browser processes, OpenSC NSS modules and XDG protection.
  apply    Disable OpenSC browser autostart and remove current NSS modules.
  restore  Restore saved OpenSC modules and the previous autostart setting.

Options:
  --home DIRECTORY  Operate on this home directory (mainly for tests/admins).
  --force           Continue while a browser is running or replace a custom
                    pkcs11-register autostart override after backing it up.
  -h, --help        Show this help.

Run this as the desktop user, with Firefox, Chromium/Chrome and Thunderbird
closed. Root privileges are not required.
EOF
}

if [[ $# -gt 0 && "$1" != --* && "$1" != "-h" ]]; then
  ACTION="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home)
      [[ $# -ge 2 ]] || fail "--home requires a directory"
      HOME_OVERRIDE="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

case "$ACTION" in
  status|apply|restore) ;;
  *) fail "unknown action: $ACTION" ;;
esac

[[ "$(uname -s)" == "Linux" ]] || fail "this guard supports Linux only"

if [[ -n "$HOME_OVERRIDE" ]]; then
  [[ -d "$HOME_OVERRIDE" ]] || fail "home directory does not exist: $HOME_OVERRIDE"
  TARGET_HOME="$(realpath -e -- "$HOME_OVERRIDE")"
  TARGET_USER="$(stat -c '%U' -- "$TARGET_HOME")"
else
  TARGET_USER="${SUDO_USER:-${USER:-$(id -un)}}"
  TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  [[ -n "$TARGET_HOME" && -d "$TARGET_HOME" ]] || fail "cannot resolve home for $TARGET_USER"
fi

if [[ -z "$HOME_OVERRIDE" && -z "${SUDO_USER:-}" && -n "${XDG_CONFIG_HOME:-}" ]]; then
  [[ "$XDG_CONFIG_HOME" == /* ]] || fail "XDG_CONFIG_HOME must be an absolute path"
  CONFIG_HOME="$XDG_CONFIG_HOME"
else
  CONFIG_HOME="$TARGET_HOME/.config"
fi

AUTOSTART_DIR="$CONFIG_HOME/autostart"
AUTOSTART_OVERRIDE="$AUTOSTART_DIR/pkcs11-register.desktop"
STATE_DIR="$CONFIG_HOME/ipi-browser-guard"
AUTOSTART_BACKUP="$STATE_DIR/pkcs11-register.desktop.original"

declare -a DATABASES=()
declare -A SEEN_DATABASES=()

add_database() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || return 0
  if [[ -z "${SEEN_DATABASES[$file]:-}" ]]; then
    DATABASES+=("$file")
    SEEN_DATABASES["$file"]=1
  fi
}

discover_databases() {
  local root file
  add_database "$TARGET_HOME/.pki/nssdb/pkcs11.txt"
  local -a roots=(
    "$TARGET_HOME/.mozilla/firefox"
    "$TARGET_HOME/.thunderbird"
    "$TARGET_HOME/snap/firefox/common/.mozilla/firefox"
    "$TARGET_HOME/snap/thunderbird/common/.thunderbird"
    "$TARGET_HOME/snap/chromium/common"
    "$TARGET_HOME/.var/app/org.mozilla.firefox"
    "$TARGET_HOME/.var/app/org.mozilla.Thunderbird"
    "$TARGET_HOME/.var/app/org.chromium.Chromium"
    "$TARGET_HOME/.var/app/com.google.Chrome"
    "$TARGET_HOME/.var/app/com.brave.Browser"
  )
  for root in "${roots[@]}"; do
    [[ -d "$root" ]] || continue
    while IFS= read -r -d '' file; do
      add_database "$file"
    done < <(find "$root" -maxdepth 5 -type f -name pkcs11.txt -print0 2>/dev/null)
  done
}

declare -a BROWSER_PROCESSES=()

discover_browser_processes() {
  local pid command
  while read -r pid command; do
    case "$command" in
      firefox|firefox-esr|chromium|chromium-browser|chrome|google-chrome|google-chrome-stable|google-chrome-beta|brave|brave-browser|vivaldi-bin|opera|thunderbird)
        BROWSER_PROCESSES+=("$pid:$command")
        ;;
    esac
  done < <(ps -eo pid=,comm= 2>/dev/null)
}

system_autostart_exists() {
  local directory
  local config_dirs="${XDG_CONFIG_DIRS:-/etc/xdg}"
  local old_ifs="$IFS"
  IFS=:
  for directory in $config_dirs; do
    if [[ -f "$directory/autostart/pkcs11-register.desktop" ]]; then
      IFS="$old_ifs"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

autostart_is_hidden() {
  [[ -f "$AUTOSTART_OVERRIDE" ]] || return 1
  awk -F= '
    tolower($1) ~ /^[[:space:]]*hidden[[:space:]]*$/ {
      value=tolower($2); gsub(/[[:space:]]/, "", value); if (value == "true") found=1
    }
    END { exit found ? 0 : 1 }
  ' "$AUTOSTART_OVERRIDE"
}

autostart_is_managed() {
  [[ -f "$AUTOSTART_OVERRIDE" ]] || return 1
  grep -Eqi '^[[:space:]]*X-IPI-Managed[[:space:]]*=[[:space:]]*true[[:space:]]*$' "$AUTOSTART_OVERRIDE"
}

database_has_opensc() {
  grep -qi 'opensc' "$1"
}

opensc_database_count() {
  local database count=0
  for database in "${DATABASES[@]}"; do
    database_has_opensc "$database" && ((count += 1))
  done
  printf '%d\n' "$count"
}

guard_is_active() {
  if system_autostart_exists; then
    autostart_is_hidden
  else
    return 0
  fi
}

print_status() {
  local database opensc_count
  opensc_count="$(opensc_database_count)"

  if [[ ${#BROWSER_PROCESSES[@]} -eq 0 ]]; then
    log "browser processes: none"
  else
    log "browser processes: ${BROWSER_PROCESSES[*]}"
  fi

  if system_autostart_exists; then
    if autostart_is_hidden; then
      log "OpenSC login autostart: disabled for $TARGET_USER"
    else
      log "OpenSC login autostart: ACTIVE for $TARGET_USER"
    fi
  else
    log "OpenSC login autostart: not installed"
  fi

  log "NSS databases found: ${#DATABASES[@]}; containing OpenSC: $opensc_count"
  for database in "${DATABASES[@]}"; do
    if database_has_opensc "$database"; then
      log "OpenSC registered: $database"
    fi
  done

  if [[ "$opensc_count" -eq 0 ]] && guard_is_active; then
    log "result: protected; PC/SC and command-line OpenSC remain available"
    return 0
  fi
  log "result: action required; run '$PROGRAM apply' with browsers closed"
  return 1
}

ensure_owner() {
  local path="$1"
  if [[ "$(id -u)" -eq 0 && "$TARGET_USER" != "root" ]]; then
    chown "$TARGET_USER:$(stat -c '%G' -- "$TARGET_HOME")" "$path"
  fi
}

install_autostart_override() {
  local temporary

  if [[ -f "$AUTOSTART_OVERRIDE" ]] && ! autostart_is_hidden && ! autostart_is_managed; then
    if [[ "$FORCE" -ne 1 ]]; then
      fail "custom autostart override exists: $AUTOSTART_OVERRIDE (use --force to back it up)"
    fi
    mkdir -p -- "$STATE_DIR"
    chmod 700 "$STATE_DIR"
    ensure_owner "$STATE_DIR"
    if [[ ! -f "$AUTOSTART_BACKUP" ]]; then
      cp -p -- "$AUTOSTART_OVERRIDE" "$AUTOSTART_BACKUP"
      ensure_owner "$AUTOSTART_BACKUP"
    fi
  elif autostart_is_hidden && ! autostart_is_managed; then
    log "existing user autostart override already disables pkcs11-register"
    return 0
  fi

  mkdir -p -- "$AUTOSTART_DIR"
  ensure_owner "$CONFIG_HOME"
  ensure_owner "$AUTOSTART_DIR"
  temporary="$(mktemp "$AUTOSTART_DIR/.pkcs11-register.desktop.XXXXXX")"
  cat >"$temporary" <<'EOF'
[Desktop Entry]
Type=Application
Name=OpenSC browser registration disabled by IPI
Hidden=true
NoDisplay=true
X-IPI-Managed=true
X-IPI-Reason=Prevent browser NSS polling from blocking IPI Java Cards
EOF
  chmod 644 "$temporary"
  ensure_owner "$temporary"
  mv -f -- "$temporary" "$AUTOSTART_OVERRIDE"
  log "disabled OpenSC browser registration at login: $AUTOSTART_OVERRIDE"
}

module_names() {
  awk '
    BEGIN { RS=""; FS="\n" }
    tolower($0) ~ /opensc/ {
      for (line=1; line<=NF; line++) {
        if (tolower($line) ~ /^name[[:space:]]*=/) {
          value=$line
          sub(/^[^=]*=[[:space:]]*/, "", value)
          gsub(/^"|"$/, "", value)
          print value
          break
        }
      }
    }
  ' "$1"
}

rewrite_without_opensc() {
  local database="$1" temporary="$2"
  awk 'BEGIN { RS=""; ORS="\n\n" } tolower($0) !~ /opensc/' "$database" >"$temporary"
  [[ -s "$temporary" ]] || return 1
  ! grep -qi 'opensc' "$temporary"
  grep -qi 'NSS Internal PKCS' "$temporary"
  chmod --reference="$database" "$temporary"
  chown --reference="$database" "$temporary" 2>/dev/null || true
  mv -f -- "$temporary" "$database"
}

run_modutil() {
  if [[ "$(id -u)" -eq 0 && "$TARGET_USER" != "root" && -x "$(command -v runuser 2>/dev/null || true)" ]]; then
    runuser -u "$TARGET_USER" -- env HOME="$TARGET_HOME" XDG_CONFIG_HOME="$CONFIG_HOME" "$@"
  else
    "$@"
  fi
}

clean_database() {
  local database="$1" directory backup temporary name
  local -a names=()
  database_has_opensc "$database" || return 0

  directory="${database%/*}"
  backup="$database.ipi-browser-guard.bak-$STAMP"
  cp -p -- "$database" "$backup"
  ensure_owner "$backup"
  mapfile -t names < <(module_names "$database")

  if command -v modutil >/dev/null 2>&1 && [[ -f "$directory/cert9.db" && ${#names[@]} -gt 0 ]]; then
    for name in "${names[@]}"; do
      if ! run_modutil modutil -force -dbdir "sql:$directory" -delete "$name" >/dev/null 2>&1; then
        cp -p -- "$backup" "$database"
        fail "NSS rejected removal from $database; restored $backup"
      fi
    done
    if database_has_opensc "$database"; then
      cp -p -- "$backup" "$database"
      fail "OpenSC remained in $database; restored $backup"
    fi
    log "removed OpenSC with modutil: $database (backup: $backup)"
    return 0
  fi

  temporary="$(mktemp "$directory/.pkcs11.txt.XXXXXX")"
  if ! rewrite_without_opensc "$database" "$temporary"; then
    rm -f -- "$temporary"
    fail "refused to rewrite malformed NSS database: $database"
  fi
  log "removed OpenSC atomically: $database (backup: $backup)"
}

restore_database() {
  local database="$1" backup temporary
  local -a backups=("$database".ipi-browser-guard.bak-*)
  database_has_opensc "$database" && return 0
  [[ ${#backups[@]} -gt 0 ]] || return 0
  backup="${backups[${#backups[@]}-1]}"
  temporary="$(mktemp "${database%/*}/.pkcs11.txt.XXXXXX")"
  cp -p -- "$database" "$temporary"
  printf '\n' >>"$temporary"
  awk 'BEGIN { RS=""; ORS="\n\n" } tolower($0) ~ /opensc/' "$backup" >>"$temporary"
  if ! database_has_opensc "$temporary"; then
    rm -f -- "$temporary"
    fail "backup contains no OpenSC module: $backup"
  fi
  chmod --reference="$database" "$temporary"
  chown --reference="$database" "$temporary" 2>/dev/null || true
  mv -f -- "$temporary" "$database"
  log "restored OpenSC module in $database from $backup"
}

remove_managed_autostart_override() {
  local temporary
  if ! autostart_is_managed; then
    [[ -f "$AUTOSTART_OVERRIDE" ]] && log "left non-IPI autostart override unchanged"
    return 0
  fi

  if [[ -f "$AUTOSTART_BACKUP" ]]; then
    temporary="$(mktemp "$AUTOSTART_DIR/.pkcs11-register.desktop.XXXXXX")"
    cp -p -- "$AUTOSTART_BACKUP" "$temporary"
    ensure_owner "$temporary"
    mv -f -- "$temporary" "$AUTOSTART_OVERRIDE"
    log "restored previous autostart override: $AUTOSTART_OVERRIDE"
  else
    rm -f -- "$AUTOSTART_OVERRIDE"
    log "re-enabled the system OpenSC browser autostart"
  fi
}

discover_databases
discover_browser_processes

case "$ACTION" in
  status)
    print_status
    ;;
  apply)
    if [[ ${#BROWSER_PROCESSES[@]} -gt 0 && "$FORCE" -ne 1 ]]; then
      fail "close these browser processes first: ${BROWSER_PROCESSES[*]}"
    fi
    [[ ${#BROWSER_PROCESSES[@]} -eq 0 ]] || warn "continuing with running browsers because --force was supplied"
    install_autostart_override
    for database in "${DATABASES[@]}"; do clean_database "$database"; done
    log "apply complete"
    print_status
    ;;
  restore)
    if [[ ${#BROWSER_PROCESSES[@]} -gt 0 && "$FORCE" -ne 1 ]]; then
      fail "close these browser processes first: ${BROWSER_PROCESSES[*]}"
    fi
    [[ ${#BROWSER_PROCESSES[@]} -eq 0 ]] || warn "continuing with running browsers because --force was supplied"
    for database in "${DATABASES[@]}"; do restore_database "$database"; done
    remove_managed_autostart_override
    log "restore complete; log out and back in if OpenSC was not restored to a newly-created browser profile"
    ;;
esac
