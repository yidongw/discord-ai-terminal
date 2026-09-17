#!/usr/bin/env python3
"""Archive trade-signal threads with no new messages for IDLE_HOURS.

Discord caps a server at 1000 active threads; the trade-signal channels
create hundreds per day, so without this the cap fills within ~2 days and
message sends start failing. Runs hourly via launchd
(deploy/com.discord-signal-thread-cleaner.plist). Archiving is reversible:
a new message in an archived thread auto-unarchives it.
"""
import json
import subprocess
import time

ENV_PATH = "/Users/xinjuan/git/discord-ai-terminal/.env"
GUILD = "1509786717731688498"
SIGNAL_CHANNELS = {
    "1544660493887610910",  # rb-trade-signal
    "1544700576087015545",  # eth-trade-signal
    "1544700920577790032",  # bsc-trade-signal
    "1544701285025185892",  # sol-trade-signal
    "1544701578466820206",  # base-trade-signal
}
IDLE_HOURS = 12
DISCORD_EPOCH = 1420070400000


def read_token() -> str:
    with open(ENV_PATH) as f:
        for line in f:
            if line.startswith("DISCORD_TOKEN="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("DISCORD_TOKEN not found in .env")


# curl instead of urllib: Discord's CDN rejects the default python UA.
def curl(args: list[str]) -> str:
    r = subprocess.run(["curl", "-s", *args], capture_output=True, text=True, timeout=30)
    return r.stdout


def main() -> None:
    auth = ["-H", f"Authorization: Bot {read_token()}"]
    active = json.loads(curl([*auth, f"https://discord.com/api/v10/guilds/{GUILD}/threads/active"]))
    threads = active.get("threads", [])
    now = time.time() * 1000

    def idle_hours(t: dict) -> float:
        last = t.get("last_message_id") or t["id"]
        return (now - ((int(last) >> 22) + DISCORD_EPOCH)) / 3600000

    stale = [
        t["id"]
        for t in threads
        if t.get("parent_id") in SIGNAL_CHANNELS and idle_hours(t) >= IDLE_HOURS
    ]
    ok = fail = 0
    for tid in stale:
        code = ""
        for _ in range(4):
            code = curl([
                "-o", "/dev/null", "-w", "%{http_code}", "-X", "PATCH",
                *auth, "-H", "Content-Type: application/json",
                "-d", '{"archived":true}',
                f"https://discord.com/api/v10/channels/{tid}",
            ])
            if code == "429":
                time.sleep(3)
                continue
            break
        if code == "200":
            ok += 1
        else:
            fail += 1
        time.sleep(0.35)

    print(
        f"{time.strftime('%Y-%m-%d %H:%M:%S')} active={len(threads)} "
        f"stale={len(stale)} archived={ok} failed={fail}",
        flush=True,
    )


if __name__ == "__main__":
    main()
