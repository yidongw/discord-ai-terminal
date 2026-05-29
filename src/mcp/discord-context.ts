export interface DiscordContext {
  channelId: string;
  channelName: string;
  userId: string;
  messageId?: string; // The original Discord message that triggered Claude Code
}

export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: any;
  discordContext: DiscordContext;
  resolve: (decision: import('./permissions.js').PermissionDecision) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  discordMessage?: any; // The approval message sent to Discord
  createdAt: Date;
}

export function generateRequestId(): string {
  return `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Format tool information for Discord display
 */
export function formatToolForDiscord(toolName: string, input: any): string {
  const inputStr = JSON.stringify(input, null, 2);
  const truncatedInput = inputStr.length > 1000 
    ? inputStr.substring(0, 1000) + '...' 
    : inputStr;
  
  return `**Tool:** \`${toolName}\`\n**Input:**\n\`\`\`json\n${truncatedInput}\n\`\`\``;
}

/**
 * Determine if a tool requires approval based on risk level
 */
export function requiresApproval(toolName: string, input: any): boolean {
  // For Step 2, we'll implement basic logic
  // This will be enhanced in later steps with more sophisticated rules
  
  const safeTools = [
    'Read',
    'Glob', 
    'Grep',
    'LS',
    'TodoRead',
    'WebFetch',
    'WebSearch',
  ];
  
  const dangerousTools = [
    'Bash',
    'Write',
    'Edit',
    'MultiEdit',
    'TodoWrite',
  ];
  
  // Safe tools don't require approval
  if (safeTools.includes(toolName)) {
    return false;
  }
  
  // Dangerous tools always require approval
  if (dangerousTools.includes(toolName)) {
    return true;
  }
  
  // Unknown tools require approval for safety
  return true;
}