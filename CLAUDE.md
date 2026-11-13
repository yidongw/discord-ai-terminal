# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Committing Changes

After making any code change, always create a git commit before ending the session. This is required so the Stop hook can push and open a PR automatically. Do not leave changes uncommitted.

## Shipping (owner 11-11: the same flow as yidongw/tralyx, pikeway and foxhole-backend)

Production is the systemd unit `discord-ai-terminal.service` on **cx43** (the 总控). It runs the code in
`/home/ubuntu/deploy/discord-ai-terminal/current` (a symlink to `releases/<sha>`, a detached worktree of a
deploy-only clone), with its working directory, `.env`, `sessions.db`, `runs/` and `jobs/` in
`/home/ubuntu/git/discord-ai-terminal`. Editing or checking out that clone does not change the running bot.
The bot is critical: its MCP server on :3001 is where agents' `wake_thread` calls fall back to
(wake-t3-relay on :3011 reads `sessions.db` to map Discord threads to T3 threads).

- **Branches.** Commits reach main through the shared `dev` branch (rebased onto `origin/dev`, never
  force-pushed); side branches are not merged. The one exception is a single commit on main carrying a
  `Hotfix: <why>` trailer, for runtime emergencies: it ships once the trusted tests pass on it, its review runs
  afterwards, and a blocked re-check is fixed forward without holding up deploys. CI and docs changes go
  through dev.
- **Each dev push** starts `review.yml` (main's copy, via `workflow_run`): the trusted tests on the InstaBox
  VM (runner `instabox-discord-ai-terminal`) as a throwaway per-job user without Docker or sudo — `bun install
  --frozen-lockfile`, `tsc -p tsconfig.ci.json` (src/), `bun build src/index.ts`, the MCP smoke test
  `scripts/ci/smoke-mcp.ts`, and `bun test`, where any failing test not listed in `test/known-failures.txt`
  fails the job — and the commit gates plus the isolated blocking code review (tralyx main's review-gate) on
  cx43 runner `cx43-discord-ai-terminal-review`, in parallel. A running dev review is not cancelled.
- **Merge train.** The cx43 timer `discord-ai-terminal-review-dispatch` acts on each finished round: a passed
  round fast-forwards main to the reviewed dev sha; a blocked round's findings go to the `Thread:` of every
  author in it, and a fixer agent commits one fix on the blocked sha to `devfix/<sha>`, which lands on main
  once the trusted tests pass there.
- **Review contract** (11-13; `.github/workflows/review.yml` + `scripts/ci/{hotfix-review-base,dev-review-base,
  review-passed,review-repair}.sh`, adapted from yidongw/tralyx). Each commit is reviewed once on dev and once on main:
  - *main*: every `Hotfix:` and `Train-Merge:` head is re-checked over everything since the last **completed** main
    review (the reviewer gave a verdict: passed, or "review-gate: BLOCKED #n"), merge resolutions and tests-only dev
    fixes included; one main reviewer at a time, a superseded waiting one is cancelled and its commits ride the next
    range. A main head carrying `Review-Fix-Of:` (a fix that landed on its tests alone) is re-checked the same way, and
    `merge-branch.sh` lands a tests-only approval only as such a head — no tests-only fix sits on main unreviewed. No
    completed main review yet → the range starts at the deployed sha (tag `deployed`, moved by the autodeploy), never
    at ancient history.
  - *dev*: everything since the last completed dev review that passed or was repaired. A range made only of
    `Review-Fix-Of:` repairs of blocked reviews (plus clean merges) is a **tests-only fix** round: the blocking review
    step does not run (skipped, never reported as passed), the attestation says `"kind":"tests-only-fix"`, and
    `review-passed.sh` accepts it only when the trusted tests passed and its own re-check from the review runs confirms
    every dev commit of the range repairs a completed, blocked review. Main then reviews the fix under the main rule.
  - *evidence* (`scripts/ci/review-runs.sh`, one rule for range selection, repair eligibility and approval): only runs
    GitHub started from main's `review.yml` by `workflow_run` count (a branch's own run with the same title is
    ignored); every page of runs is read; a review is a range base only while its attestation artifact is usable —
    otherwise the range falls back to an older base.
  - *attestations*: `{"head","base","kind","main"}`, base = the last completed review, main = origin/main at review time
    (the boundary a tests-only round is re-checked against, also after main advanced); uploaded only when this run's
    attestation step succeeded. `review-passed.sh <sha> <repo> <deployed>` accepts a chain of completed reviews from
    `deployed` to `sha` (P → A → B); a skipped, cancelled or never-run review is never a link.
- **Deploy.** The cx43 timer `discord-ai-terminal-autodeploy` (`~/bin/discord-ai-terminal-autodeploy`, every
  3 min) deploys main's head once its trusted `tests` job passed and every commit since the live release came
  through the flow: it prepares `releases/<sha>` (bun install), waits until no agent run is active
  (`active_runs` in sessions.db, at most 2 h), flips `current`, restarts the unit (in-flight agent runs stay
  alive detached and are re-attached on boot), and health-checks it (MCP `/health`, `/tool/wake_thread`, the
  Discord gateway ready). A failed deploy flips back to the previous release and the controller pauses
  (`~/.local/state/discord-ai-terminal-autodeploy/PAUSED`). Ranges that change no runtime file (CI, docs,
  tests) are not deployed.

Commit messages carry `Loop:`, `Thread:` (a T3 thread id, `mcp:<uuid>`, or a numeric Discord thread id) and a
`Verify:` checklist (`Verify:` alone on its line, then `- [x] <evidence>` items); the commit gates refuse a
commit without them.

GitHub-hosted runners do not start for this account (unpaid minutes), so every job runs on a self-hosted
runner, and each runner accepts only its own job (job-started hook `job-guard.sh`).

## Runtime and Package Management

This project uses **Bun** as the JavaScript runtime instead of Node.js. Always use Bun commands:

- `bun install` - Install dependencies
- `bun run index.ts` - Run the main application
- `bun --hot ./index.ts` - Run with hot reload for development
- `bun run test` - Run tests (instead of jest/vitest)
- `bun build <file>` - Build files (instead of webpack/esbuild)

## Architecture

This is a TypeScript project with strict type checking enabled. The project structure is minimal:
- `src/index.ts` - Main entry point
- TypeScript configuration uses modern ES features (ESNext) with bundler module resolution

## Bun-Specific APIs

When adding functionality, prefer Bun's built-in APIs:
- `Bun.serve()` for HTTP servers with WebSocket support (instead of Express)
- `bun:sqlite` for SQLite (instead of better-sqlite3)
- `Bun.redis` for Redis (instead of ioredis)  
- `Bun.sql` for Postgres (instead of pg)
- Built-in `WebSocket` (instead of ws library)
- `Bun.$`command`` for shell commands (instead of execa)

## Frontend Development

If adding frontend features, use HTML imports with `Bun.serve()`:
- HTML files can directly import .tsx/.jsx/.js files
- CSS files can be imported directly in components
- Bun handles transpilation and bundling automatically
- Use `development: { hmr: true }` for hot module replacement

## Discord Bot Functionality

This bot runs Claude Code and Codex sessions on different projects based on Discord channel names:

- Each Discord channel maps to a folder: `BASE_FOLDER/channel-name`
- Sessions persist per channel with automatic resume using session IDs
- Only responds to messages from the configured `ALLOWED_USER_ID`
- Streams provider output and updates Discord messages in real-time
- Shows the last 3 streamed responses in each message
- Use `/clear` slash command to reset a session

### Commands
- Any message in a channel runs Claude Code with that prompt
- `/clear` - Reset the current session (starts fresh next time)

## Environment Variables

Required environment variables:
- `DISCORD_TOKEN` - Bot token from Discord Developer Portal
- `ALLOWED_USER_ID` - Discord user ID who can use the bot
- `BASE_FOLDER` - Base path where Claude Code operates (e.g., `/Users/tim/repos`)

## Environment

- Bun automatically loads .env files (no need for dotenv)
- TypeScript is configured with strict mode and modern features
- No emit compilation (bundler handles this)

## Important Restrictions (for Claude Code)

- **Never run the bot** - The bot is likely already running as a service. Running a second instance would cause conflicts (duplicate responses, port conflicts). Use `launchctl list | grep discord-ai-terminal` (macOS) to check if it's running.
- You can run tests, but never run the main application.

## Service Management

On macOS this bot runs as a launchd user agent (`com.discord-ai-terminal`). It is
configured with `RunAtLoad` and `KeepAlive` so it starts on login/boot and
restarts automatically if it exits. Common commands:

```bash
# Check if running (running PID shows in the first column)
launchctl list | grep discord-ai-terminal

# View logs
tail -f discord-ai-terminal.log

# Restart after code changes
launchctl kickstart -k gui/$(id -u)/com.discord-ai-terminal

# Stop / unload
launchctl bootout gui/$(id -u)/com.discord-ai-terminal
```

On Linux (cx43) the bot runs as the system unit `discord-ai-terminal.service` (user ubuntu), from the
release directory `/home/ubuntu/deploy/discord-ai-terminal/current`; deploys and restarts are done by the
autodeploy controller (see "Shipping"). Log: `/home/ubuntu/logs/discord-ai-terminal.log`.

```bash
systemctl status discord-ai-terminal
readlink /home/ubuntu/deploy/discord-ai-terminal/current   # the deployed release
```

See `deploy/com.discord-ai-terminal.plist` (macOS) and `deploy/discord-ai-terminal.service`
(Linux) for the service files, and README.md for installation instructions.

## Testing Notes

- `bun run test:run` runs the suite under vitest. CI runs `bun test` (the code imports `bun:sqlite`, which
  vitest under Node cannot load) and compares its failures with `test/known-failures.txt`.
