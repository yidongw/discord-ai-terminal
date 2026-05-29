export function escapeShellString(str: string): string {
  // Replace ' with '\'' and wrap in single quotes
  return `'${str.replace(/'/g, "'\\''")}'`;
}

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface DiscordContext {
  channelId: string;
  channelName: string;
  userId: string;
  messageId?: string;
}

export type PermissionMode = "auto" | "plan" | "approve";

export function buildClaudeCommand(
  workingDir: string,
  prompt: string,
  sessionId?: string,
  discordContext?: DiscordContext,
  mode: PermissionMode = "auto",
  model: string = "sonnet"
): string {
  const escapedPrompt = escapeShellString(prompt);

  const commandParts = [
    `cd ${workingDir}`,
    "&&",
    "claude",
    "--output-format",
    "stream-json",
    "--model",
    model,
    "-p",
    escapedPrompt,
    "--verbose",
  ];

  // Add permission mode based on setting
  if (mode === "plan") {
    // Plan mode with MCP permission tool for Discord approval
    const sessionMcpConfigPath = createSessionMcpConfig(discordContext);
    commandParts.push("--permission-mode", "plan");
    commandParts.push("--mcp-config", sessionMcpConfigPath);
    commandParts.push("--permission-prompt-tool", "mcp__discord-permissions__approve_tool");
    commandParts.push("--allowedTools", "mcp__discord-permissions");
  } else if (mode === "approve") {
    // Approve mode - prompt for each dangerous action via Discord
    const sessionMcpConfigPath = createSessionMcpConfig(discordContext);
    commandParts.push("--mcp-config", sessionMcpConfigPath);
    commandParts.push("--permission-prompt-tool", "mcp__discord-permissions__approve_tool");
    commandParts.push("--allowedTools", "mcp__discord-permissions");
  } else {
    // auto mode - skip all permissions
    commandParts.push("--dangerously-skip-permissions");
  }

  if (sessionId) {
    commandParts.splice(3, 0, "--resume", sessionId);
  }

  return commandParts.join(" ");
}

export function buildCodexCommand(
  workingDir: string,
  prompt: string,
  sessionId?: string,
  skipGitCheck: boolean = false
): string {
  const escapedPrompt = escapeShellString(prompt);

  if (sessionId) {
    const resumeParts = [
      `cd ${workingDir} &&`,
      "codex",
      "exec",
      "resume",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
    ];
    if (skipGitCheck) {
      resumeParts.push("--skip-git-repo-check");
    }
    resumeParts.push(sessionId, escapedPrompt);
    return resumeParts.join(" ");
  }

  const commandParts = [
    `cd ${workingDir} &&`,
    "codex",
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (skipGitCheck) {
    commandParts.push("--skip-git-repo-check");
  }
  commandParts.push("-C", workingDir, escapedPrompt);

  return commandParts.join(" ");
}

/**
 * Create a session-specific MCP config file with hardcoded Discord context
 */
function createSessionMcpConfig(discordContext?: DiscordContext): string {
  // Generate unique session ID for this config
  const sessionId = `claude-discord-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const configPath = path.join(os.tmpdir(), `mcp-config-${sessionId}.json`);
  
  const baseDir = path.dirname(path.dirname(__dirname)); // Go up to project root
  const bridgeScriptPath = path.join(baseDir, 'mcp-bridge.cjs');
  
  // Create MCP config with hardcoded environment variables
  const mcpConfig = {
    mcpServers: {
      "discord-permissions": {
        command: "node",
        args: [bridgeScriptPath],
        env: {
          DISCORD_CHANNEL_ID: discordContext?.channelId || "unknown",
          DISCORD_CHANNEL_NAME: discordContext?.channelName || "unknown", 
          DISCORD_USER_ID: discordContext?.userId || "unknown",
          DISCORD_MESSAGE_ID: discordContext?.messageId || ""
        }
      }
    }
  };
  
  // Write the config file
  fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  
  console.log(`Created session MCP config: ${configPath}`);
  console.log(`Discord context: ${JSON.stringify(discordContext)}`);
  
  // Clean up old session config files (older than 1 hour)
  cleanupOldSessionConfigs();
  
  return configPath;
}

/**
 * Clean up old session MCP config files from /tmp
 */
function cleanupOldSessionConfigs(): void {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);
    const oneHourAgo = Date.now() - (60 * 60 * 1000); // 1 hour in milliseconds
    
    for (const file of files) {
      if (file.startsWith('mcp-config-claude-discord-') && file.endsWith('.json')) {
        const filePath = path.join(tmpDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < oneHourAgo) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up old MCP config: ${filePath}`);
        }
      }
    }
  } catch (error) {
    console.error('Error cleaning up old MCP configs:', error);
  }
}
