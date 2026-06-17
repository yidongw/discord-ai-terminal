# Discord AI Terminal

A Discord bot that runs Claude Code or Codex sessions on different projects based on Discord channel names. Each channel maps to a folder in your file system, allowing you to interact with repositories through Discord.

![image](https://github.com/user-attachments/assets/d78c6dcd-eb28-48b6-be1c-74e25935b86b)

## Quickstart

1. Install [Bun](https://bun.sh/), [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), and [Codex CLI](https://github.com/openai/codex)
2. Create a Discord bot at [Discord Developer Portal](https://discord.com/developers/applications)
3. Clone and setup:
   ```bash
   git clone <repository-url>
   cd discord-ai-terminal
   bun install
   ```
4. Create `.env` file:
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   ALLOWED_USER_ID=your_discord_user_id_here
   BASE_FOLDER=/path/to/your/repos
   ```
5. Run: `bun start`

## Features

- **Channel-based project mapping**: Each Discord channel corresponds to a folder (e.g., `#my-project` → `/path/to/repos/my-project`)
- **Persistent sessions**: Sessions are maintained per channel and automatically resume
- **Real-time streaming**: See Claude Code or Codex activity and responses as they happen
- **Activity logging**: Shows up to 20 lines of activity including tool calls with parameters
- **Slash commands**: Configure sessions, browse files, and manage projects

## Setup Instructions

### 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Give your application a name (e.g., "Discord AI Terminal")
4. Click "Create"

### 2. Create a Bot User

1. In your application, go to the "Bot" section in the left sidebar
2. Click "Add Bot"
3. Under "Token", click "Copy" to copy your bot token (keep this secure!)
4. Under "Privileged Gateway Intents", enable:
   - Message Content Intent
5. Click "Save Changes"

### 3. Invite the Bot to Your Server

1. Go to the "OAuth2" → "URL Generator" section
2. Under "Scopes", select:
   - `bot`
   - `applications.commands`
3. Under "Bot Permissions", select:
   - Send Messages
   - Use Slash Commands
   - Read Message History
   - Embed Links
4. Copy the generated URL and open it in your browser
5. Select your Discord server and authorize the bot

### 4. Get Your Discord User ID

1. Enable Developer Mode in Discord:
   - Go to Discord Settings → Advanced → Enable "Developer Mode"
2. Right-click on your username in any channel
3. Click "Copy User ID"
4. Save this ID - you'll need it for the configuration

### 5. Clone and Setup the Bot

```bash
# Clone the repository
git clone <repository-url>
cd discord-ai-terminal

# Install dependencies
bun install
```

### 6. Configure Environment Variables

Create a `.env` file in the project root:

```env
# Discord bot token from step 2
DISCORD_TOKEN=your_discord_bot_token_here

# Your Discord user ID from step 4
ALLOWED_USER_ID=your_discord_user_id_here

# Base folder containing your repositories
# Each Discord channel will map to a subfolder here
# Example: if BASE_FOLDER=/Users/you/repos and channel is #my-project
# The bot will operate in /Users/you/repos/my-project
BASE_FOLDER=/path/to/your/repos
```

### 7. Prepare Your Repository Structure

Organize your repositories under the base folder with names matching your Discord channels:

```
/path/to/your/repos/
├── my-project/          # Maps to #my-project channel
├── another-repo/        # Maps to #another-repo channel
├── test-app/           # Maps to #test-app channel
└── experimental/       # Maps to #experimental channel
```

**Important**: Channel names in Discord should match folder names exactly (Discord will convert spaces to hyphens).

### 8. Create Discord Channels

In your Discord server, create channels for each repository:
- `#my-project`
- `#another-repo` 
- `#test-app`
- `#experimental`

### 9. Run the Bot

```bash
# Start the bot
bun run src/index.ts

# Or use the npm script
bun start
```

**Important**: Do not use hot reload (`bun --hot`) as it can cause issues with process management and spawn multiple AI processes.

You should see:
```
Bot is ready! Logged in as Discord AI Terminal#1234
Successfully registered application commands.
```

## Usage

Type any message in a channel that corresponds to a repository folder. The bot will run the selected provider with your message as the prompt and stream the results.

### Provider Notes

- **Claude Code** uses `/model cc` and `/mode` settings.
- **Codex** uses `/model codex` and always runs in full access mode.

### Commands

- **Any message**: Runs the selected provider with your message as the prompt

#### Session Commands
- **/clear**: Resets the current channel's session (starts fresh next time)
- **/stop**: Stop the currently running AI process

#### Configuration Commands
- **/mode**: Set Claude's permission mode for the channel
  - `auto` - Execute immediately without asking
  - `plan` - Create detailed plan before executing
  - `approve` - Ask permission (✅/❌) before each dangerous action
- **/model cc**: Set the Claude Code model for the channel (pinned version IDs)
  - `claude-sonnet-4-6` - Balanced default
  - `claude-opus-4-8` - Most capable Opus
  - `claude-opus-4-7`, `claude-opus-4-6` - Earlier Opus versions
  - `claude-sonnet-4-5` - Earlier Sonnet
  - `claude-haiku-4-5` - Fastest
  - `claude-fable-5` - Long autonomous tasks
- **/model codex**: Set the Codex model for the channel
  - `gpt-5.5` - Most capable
  - `gpt-5.4-mini` - Fast and affordable (default)
  - `gpt-5.4` - Capable
- **/status**: Show current mode, models, and session info

#### Project Commands
- **/init**: Create a new project folder matching the channel name
- **/setpath**: Set a custom folder path for the channel (use `clear` to reset)
- **/ls** `[path]`: List files and directories in the project
- **/cat** `<file>` `[lines]`: Display contents of a file (default: 50 lines)
- **/tree** `[depth]`: Show directory structure (default depth: 2)

### Example

```
You: hello
Bot: 🔧 LS (path: .)
     🔧 Read (file_path: ./package.json)
     Hello! I can see this is a Node.js project. What would you like to work on?
     ✅ Completed (3 turns)
```

## How It Works

- Each Discord channel maps to a folder: `#my-project` → `/path/to/repos/my-project`
- Sessions persist per channel and automatically resume
- Shows real-time tool usage and responses
- Only responds to the configured `ALLOWED_USER_ID`

For detailed setup instructions, troubleshooting, and development information, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Running as a Service (macOS)

To keep the bot running persistently and start it automatically after a reboot,
use the included launchd agent. It is configured with `RunAtLoad` (start on
login/boot) and `KeepAlive` (restart automatically if it ever exits).

```bash
# Edit deploy/com.discord-ai-terminal.plist so the paths match your machine:
#   - the `cd <project path>` and bun path in ProgramArguments
#   - the StandardOutPath / StandardErrorPath log location

# Install the agent
cp deploy/com.discord-ai-terminal.plist ~/Library/LaunchAgents/

# Load and enable it (starts the bot immediately and on every login/boot)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.discord-ai-terminal.plist
launchctl enable gui/$(id -u)/com.discord-ai-terminal
```

> Note: launchd will not `posix_spawn` the `bun` binary directly, so the plist
> launches it through `/bin/sh -c "cd <project> && exec bun run src/index.ts"`.

### Service Management (macOS)

```bash
# Check status (the running PID shows in the first column)
launchctl list | grep discord-ai-terminal

# View logs
tail -f discord-ai-terminal.log

# Restart after code changes
launchctl kickstart -k gui/$(id -u)/com.discord-ai-terminal

# Stop / unload the service
launchctl bootout gui/$(id -u)/com.discord-ai-terminal
```

## Running as a Service (Linux)

To keep the bot running persistently on Linux, use the included systemd user service:

```bash
# Copy service file to user systemd directory
mkdir -p ~/.config/systemd/user
cp deploy/discord-ai-terminal.service ~/.config/systemd/user/

# Edit the service file to match your paths if needed
# The default uses %h (home directory) for paths
# If Codex was installed via a Node version manager, ensure its bin path is included
# in the service's Environment=PATH entry.

# Reload systemd and enable the service
systemctl --user daemon-reload
systemctl --user enable discord-ai-terminal
systemctl --user start discord-ai-terminal

# Enable lingering so service runs without active login session
loginctl enable-linger
```

### Service Management (Linux)

```bash
# Check status
systemctl --user status discord-ai-terminal

# View logs
journalctl --user -u discord-ai-terminal -n 50 -f

# Restart after code changes
systemctl --user restart discord-ai-terminal

# Stop the service
systemctl --user stop discord-ai-terminal
```

## Connecting a New Repo to the Bot

Follow these steps to get a new GitHub repo wired up with the bot. Once connected, the bot provides these automatic behaviors:

- **PR opened** — the bot posts the PR URL to the maker thread and pins it, then renames the thread to include the PR number (e.g., `my feature [#42]`)
- **Preview URL ready** — the bot posts the preview link directly to the thread so it's visible alongside the ongoing work
- **Automated testing** — the bot runs the test agent against the preview URL using the test plan from the PR description, then posts results back to the PR

### 1. Discord channel

Create a channel in your Discord server whose name **exactly matches the repo name** (e.g., repo `yidongw/my-app` → channel `#my-app`). This is how the bot finds the right thread to post into.

### 2. Add the agent-trigger workflow

Copy `.github/workflows/agent-trigger.yml` from this repo into the target repo (unchanged). This workflow fires on `pull_request` (opened/reopened/ready_for_review/synchronize/closed) and `issue_comment` events and forwards them to the bot's webhook server at `http://localhost:3002`.

### 3. Set the `AGENT_WEBHOOK_SECRET` repo secret

In the target repo's GitHub Settings → Secrets → Actions, add:

| Secret | Value |
|---|---|
| `AGENT_WEBHOOK_SECRET` | Same value as `GITHUB_WEBHOOK_SECRET` in the bot's `.env` |

### 4. Register the self-hosted runner

The workflow requires a runner with labels `[self-hosted, macOS, preview]`. Register the bot machine as a runner for each new repo:

```bash
# Get a registration token
TOKEN=$(gh api -X POST repos/OWNER/REPO/actions/runners/registration-token --jq '.token')

# Copy the existing runner binaries and configure for the new repo
cp -r ~/preview/runner ~/preview/runner-REPO
cd ~/preview/runner-REPO
./config.sh --url https://github.com/OWNER/REPO \
            --token "$TOKEN" \
            --name mac-preview \
            --labels self-hosted,macOS,preview \
            --unattended --replace

# Install and start as a launchd service
./svc.sh install
./svc.sh start
```

### 5. Add a Test plan to PR descriptions

For automated testing to trigger when a preview URL is ready, include a `Test plan:` section in the PR body:

```
## Test plan:
- User can log in with email and password
- Dashboard loads without errors
- Clicking "Save" persists changes
```

The bot extracts this list and posts a `/cx test:` comment (or `/cc test:` if `DEFAULT_TESTING_AGENT=cc`) which kicks off the test agent.

### 6. (Optional) Preview URL integration

When a preview deployment is ready, the bot posts the URL to the Discord thread **and** kicks off the test agent. Two ways to notify the bot:

**A. Push from CI** — Post to the bot's `/preview-ready` endpoint from your deploy workflow:

```bash
curl -X POST http://localhost:3002/preview-ready \
  -H "Authorization: Bearer $PREVIEW_READY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"repo":"OWNER/REPO","prNumber":42,"previewUrl":"https://my-app-pr-42.example.com"}'
```

Set `PREVIEW_READY_SECRET` in the bot's `.env` to require auth on this endpoint.

**B. URL pattern** — Set `PREVIEW_URL_PATTERN` in the bot's `.env` if your preview URLs follow a predictable pattern:

```env
PREVIEW_URL_PATTERN=https://my-app-pr-{n}.example.com
```

The bot will derive the URL from the PR number automatically.

### Summary checklist

- [ ] Discord channel name matches repo name
- [ ] `.github/workflows/agent-trigger.yml` copied into repo
- [ ] `AGENT_WEBHOOK_SECRET` secret set on the repo
- [ ] Self-hosted runner registered with `preview` label
- [ ] PR descriptions include a `Test plan:` section
- [ ] (Optional) Preview URL integration configured

## Credits

This project is based on the original "Claude Code Discord Bot" by timoconnellaus.
Original repo: https://github.com/timoconnellaus/claude-code-discord-bot

## License

This project is licensed under the MIT License.

<!-- round-2 marker 2026-06-17T09:21:03Z -->
