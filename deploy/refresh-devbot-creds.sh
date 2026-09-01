#!/bin/bash
# Bidirectional sync of Claude Code OAuth credentials between the bot user's
# macOS Keychain (Claude Code reads this when the Discord bot runs cc) and a
# shared credentials file (e.g. devbot's ~/.claude/.credentials.json).
#
# Install: copy to ~/refresh-devbot-creds.sh, set env vars below, and load
# deploy/com.refresh-devbot-creds.plist into ~/Library/LaunchAgents/.
#
# Required env:
#   DEVBOT_SUDO_PASSWORD — password for sudo writes to DEST
# Optional env (defaults shown):
#   REFRESH_CREDS_LOG, REFRESH_CREDS_DEST, REFRESH_CREDS_LOCAL,
#   REFRESH_KEYCHAIN_SERVICE, REFRESH_KEYCHAIN_ACCOUNT, REFRESH_STALE_BUFFER_MS

: "${REFRESH_CREDS_LOG:=$HOME/refresh-devbot-creds.log}"
: "${REFRESH_CREDS_DEST:=/Users/devbot/.claude/.credentials.json}"
: "${REFRESH_CREDS_LOCAL:=$HOME/.claude/.credentials.json}"
: "${REFRESH_KEYCHAIN_SERVICE:=Claude Code-credentials}"
: "${REFRESH_KEYCHAIN_ACCOUNT:=$USER}"
: "${REFRESH_STALE_BUFFER_MS:=300000}"

if [ -z "${DEVBOT_SUDO_PASSWORD:-}" ]; then
  echo "$(date): ERROR - DEVBOT_SUDO_PASSWORD is not set" >> "$REFRESH_CREDS_LOG"
  exit 1
fi

export REFRESH_CREDS_LOG REFRESH_CREDS_DEST REFRESH_CREDS_LOCAL
export REFRESH_KEYCHAIN_SERVICE REFRESH_KEYCHAIN_ACCOUNT REFRESH_STALE_BUFFER_MS
export DEVBOT_SUDO_PASSWORD

python3 - <<'PY'
import json, os, subprocess, sys, time
from datetime import datetime

LOG = os.environ["REFRESH_CREDS_LOG"]
DEST = os.environ["REFRESH_CREDS_DEST"]
LOCAL = os.environ["REFRESH_CREDS_LOCAL"]
PW = os.environ["DEVBOT_SUDO_PASSWORD"] + "\n"
KEYCHAIN_SERVICE = os.environ["REFRESH_KEYCHAIN_SERVICE"]
KEYCHAIN_ACCOUNT = os.environ["REFRESH_KEYCHAIN_ACCOUNT"]
STALE_BUFFER_MS = int(os.environ["REFRESH_STALE_BUFFER_MS"])

def log(msg):
    with open(LOG, "a") as f:
        f.write("{0}: {1}\n".format(datetime.now(), msg))

def read_keychain(retries=5):
    for attempt in range(1, retries + 1):
        r = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0:
            try:
                data = json.loads(r.stdout.strip())
                oauth = data.get("claudeAiOauth") or {}
                if oauth.get("accessToken"):
                    return oauth
            except json.JSONDecodeError:
                pass
        if attempt < retries:
            time.sleep(3)
    return None

def read_devbot():
    r = subprocess.run(
        ["sudo", "-S", "cat", DEST],
        input=PW,
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        return None
    try:
        oauth = json.loads(r.stdout).get("claudeAiOauth") or {}
        return oauth if oauth.get("accessToken") else None
    except json.JSONDecodeError:
        return None

def is_valid(oauth):
    if not oauth or not oauth.get("accessToken"):
        return False
    expires_at = oauth.get("expiresAt") or 0
    return expires_at > int(time.time() * 1000) + STALE_BUFFER_MS

def write_keychain(oauth):
    payload = json.dumps({"claudeAiOauth": oauth})
    subprocess.run(
        ["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE],
        capture_output=True,
    )
    r = subprocess.run(
        [
            "security",
            "add-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
            payload,
        ],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise RuntimeError("keychain write failed: " + r.stderr.strip())

def write_local(oauth):
    os.makedirs(os.path.dirname(LOCAL), exist_ok=True)
    tmp = LOCAL + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"claudeAiOauth": oauth}, f, indent=2)
        f.write("\n")
    os.replace(tmp, LOCAL)
    os.chmod(LOCAL, 0o600)

def write_devbot(oauth):
    payload = json.dumps({"claudeAiOauth": oauth}, indent=2) + "\n"
    tmp = DEST + ".tmp"
    r = subprocess.run(["sudo", "-S", "tee", tmp], input=(PW + payload).encode(), capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("devbot tee failed: " + r.stderr.decode())
    subprocess.run(["sudo", "-S", "/usr/sbin/chown", "devbot:staff", tmp], input=PW.encode(), capture_output=True)
    subprocess.run(["sudo", "-S", "chmod", "600", tmp], input=PW.encode(), capture_output=True)
    subprocess.run(["sudo", "-S", "mv", "-f", tmp, DEST], input=PW.encode(), capture_output=True)

kc = read_keychain()
db = read_devbot()
kc_ok = is_valid(kc)
db_ok = is_valid(db)

source = None
if kc_ok:
    source = kc
elif db_ok:
    source = db
    log("Keychain stale/empty — restoring from devbot")
    write_keychain(source)
    write_local(source)
    log("Restored Keychain + local creds from devbot")
else:
    log("ERROR - no valid creds in Keychain or devbot")
    sys.exit(1)

try:
    with open(LOCAL) as f:
        local_oauth = json.load(f).get("claudeAiOauth") or {}
except Exception:
    local_oauth = {}
if local_oauth.get("accessToken") != source.get("accessToken"):
    write_local(source)

if not db_ok or (db and db.get("accessToken") != source.get("accessToken")):
    write_devbot(source)
    log("token changed -> synced to devbot")
PY
