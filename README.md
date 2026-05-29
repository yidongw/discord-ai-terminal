# AI Discord Bot

A Discord bot that runs Claude Code or Codex sessions on different projects based on Discord channel names. Each channel maps to a folder in your file system, allowing you to interact with repositories through Discord.

![image](https://github.com/user-attachments/assets/d78c6dcd-eb28-48b6-be1c-74e25935b86b)

## Quickstart

1. Install [Bun](https://bun.sh/), [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), and [Codex CLI](https://github.com/openai/codex)
2. Create a Discord bot at [Discord Developer Portal](https://discord.com/developers/applications)
3. Clone and setup:
   ```bash
   git clone <repository-url>
   cd ai-discord-bot
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
3. Give your application a name (e.g., "AI Discord Bot")
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
cd ai-discord-bot

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
Bot is ready! Logged in as AI Discord Bot#1234
Successfully registered application commands.
```

## Usage

Type any message in a channel that corresponds to a repository folder. The bot will run the selected provider with your message as the prompt and stream the results.

### Provider Notes

- **Claude** uses the `/model` and `/mode` settings.
- **Codex** ignores `/model` for now and always runs in full access mode.
- Use `/provider` per channel to switch between Claude and Codex.

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
- **/model**: Set the Claude model for the channel
  - `opus` - Most capable, best for complex tasks
  - `sonnet` - Balanced performance and cost
  - `haiku` - Fastest and most affordable
- **/provider**: Switch between Claude and Codex for the channel
- **/status**: Show current mode, model, provider, and session info

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

## Running as a Service (Linux)

To keep the bot running persistently, use the included systemd user service:

```bash
# Copy service file to user systemd directory
mkdir -p ~/.config/systemd/user
cp deploy/ai-discord-bot.service ~/.config/systemd/user/

# Edit the service file to match your paths if needed
# The default uses %h (home directory) for paths
# If Codex was installed via a Node version manager, ensure its bin path is included
# in the service's Environment=PATH entry.

# Reload systemd and enable the service
systemctl --user daemon-reload
systemctl --user enable ai-discord-bot
systemctl --user start ai-discord-bot

# Enable lingering so service runs without active login session
loginctl enable-linger
```

### Service Management

```bash
# Check status
systemctl --user status ai-discord-bot

# View logs
journalctl --user -u ai-discord-bot -n 50 -f

# Restart after code changes
systemctl --user restart ai-discord-bot

# Stop the service
systemctl --user stop ai-discord-bot
```

## Credits

This project is based on the original "Claude Code Discord Bot" by timoconnellaus.
Original repo: https://github.com/timoconnellaus/claude-code-discord-bot

## License

This project is licensed under the MIT License.
