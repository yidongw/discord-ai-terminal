# Contributing

## Development

This project uses:

- **Bun** as the JavaScript runtime
- **TypeScript** with strict type checking
- **discord.js** for Discord API interaction
- **Claude Code CLI** and **Codex CLI** for AI interactions

To modify the code:

```bash
# Install dependencies
bun install

# Run during development (restart manually after changes)
bun start

# Run tests
bun run test:run
```

**Note**: Hot reload is not recommended for this bot as it can cause process management issues and spawn multiple AI processes.

## Security Notes

- **Private Server Recommended**: Use a private Discord server for your repositories to avoid exposing project details
- **User Restriction**: Only the configured `ALLOWED_USER_ID` can interact with the bot
- **Environment Variables**: Keep your `.env` file secure and never commit it to version control
- **Bot Token**: Keep your Discord bot token secure - treat it like a password

## Troubleshooting

### Bot doesn't respond

- Check that the bot has proper permissions in the channel
- Verify your `ALLOWED_USER_ID` is correct
- Check the console for error messages

### "Working directory does not exist" error

- Ensure the folder exists: `/path/to/repos/channel-name`
- Check that `BASE_FOLDER` in `.env` is correct
- Verify folder names match Discord channel names exactly

### Session not persisting

- Sessions are stored in memory and reset when the bot restarts
- Use `/clear` if you want to intentionally reset a session
