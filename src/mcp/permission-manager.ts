import type { DiscordContext, PendingApproval } from './discord-context.js';
import type { PermissionDecision } from './permissions.js';
import { generateRequestId, formatToolForDiscord, requiresApproval } from './discord-context.js';
import { approveToolRequest } from './permissions.js';

export class PermissionManager {
  private pendingApprovals = new Map<string, PendingApproval>();
  private discordBot: any = null; // Will be set via setDiscordBot
  private approvalTimeout: number;
  private defaultOnTimeout: 'allow' | 'deny';

  constructor() {
    this.approvalTimeout = parseInt(process.env.MCP_APPROVAL_TIMEOUT || '30') * 1000; // Convert to ms
    this.defaultOnTimeout = (process.env.MCP_DEFAULT_ON_TIMEOUT as 'allow' | 'deny') || 'deny';
  }

  /**
   * Set the Discord bot instance for sending approval messages
   */
  setDiscordBot(discordBot: any): void {
    this.discordBot = discordBot;
  }

  /**
   * Main entry point for permission requests from MCP server
   */
  async requestApproval(
    toolName: string, 
    input: any, 
    discordContext?: DiscordContext
  ): Promise<PermissionDecision> {
    console.log('PermissionManager: Processing approval request:', { 
      toolName, 
      input, 
      discordContext,
      hasDiscordBot: !!this.discordBot 
    });

    // If no Discord context, fall back to basic approval logic
    if (!discordContext) {
      console.log('PermissionManager: No Discord context, using basic approval');
      return await approveToolRequest(toolName, input, discordContext);
    }

    // If no Discord bot available, fall back to basic approval
    if (!this.discordBot) {
      console.log('PermissionManager: No Discord bot available, using basic approval');
      return await approveToolRequest(toolName, input, discordContext);
    }

    // Check if this tool requires approval
    if (!requiresApproval(toolName, input)) {
      console.log(`PermissionManager: Tool ${toolName} is safe, auto-approving`);
      return {
        behavior: 'allow',
        updatedInput: input,
      };
    }

    // Tool requires interactive approval
    console.log(`PermissionManager: Tool ${toolName} requires approval, requesting Discord approval`);
    return await this.requestInteractiveApproval(toolName, input, discordContext);
  }

  /**
   * Request interactive approval via Discord message
   */
  private async requestInteractiveApproval(
    toolName: string,
    input: any,
    discordContext: DiscordContext
  ): Promise<PermissionDecision> {
    if (!this.discordBot) {
      console.error('PermissionManager: No Discord bot available, falling back to basic approval');
      return await approveToolRequest(toolName, input, discordContext);
    }

    const requestId = generateRequestId();
    
    return new Promise<PermissionDecision>((resolve, reject) => {
      // Create timeout handler
      const timeout = setTimeout(() => {
        this.handleApprovalTimeout(requestId);
      }, this.approvalTimeout);

      // Store pending approval
      const pending: PendingApproval = {
        requestId,
        toolName,
        input,
        discordContext,
        resolve,
        reject,
        timeout,
        createdAt: new Date(),
      };

      this.pendingApprovals.set(requestId, pending);

      // Send approval message to Discord
      this.sendApprovalMessage(pending).catch((error) => {
        console.error('PermissionManager: Failed to send approval message:', error);
        // Clean up and fall back to basic approval
        this.cleanupPendingApproval(requestId);
        approveToolRequest(toolName, input, discordContext).then(resolve).catch(reject);
      });
    });
  }

  /**
   * Send approval message to Discord with reactions
   */
  private async sendApprovalMessage(pending: PendingApproval): Promise<void> {
    try {
      // Get the Discord channel
      const channel = await this.discordBot.client.channels.fetch(pending.discordContext.channelId);
      if (!channel) {
        throw new Error(`Could not find Discord channel: ${pending.discordContext.channelId}`);
      }

      // Format the approval message
      const toolInfo = formatToolForDiscord(pending.toolName, pending.input);
      const approvalMessage = `🔐 **Permission Required**\n\n${toolInfo}\n\n**Claude Code is requesting permission to use this tool.**\nReact with ✅ to approve or ❌ to deny.\n\n*Timeout in ${this.approvalTimeout / 1000} seconds (default: ${this.defaultOnTimeout})*`;

      // Send the message
      const message = await channel.send(approvalMessage);
      
      // Add reactions
      await message.react('✅');
      await message.react('❌');

      // Store the message reference
      const pendingApproval = this.pendingApprovals.get(pending.requestId);
      if (pendingApproval) {
        pendingApproval.discordMessage = message;
      }

      console.log(`PermissionManager: Sent approval message for ${pending.requestId}`);
    } catch (error) {
      console.error('PermissionManager: Error sending approval message:', error);
      throw error;
    }
  }

  /**
   * Handle approval reaction from Discord
   */
  handleApprovalReaction(channelId: string, messageId: string, userId: string, approved: boolean): void {
    console.log('PermissionManager: Handling approval reaction:', { 
      channelId, 
      messageId, 
      userId, 
      approved 
    });

    // Find the pending approval by message ID and channel ID
    let pendingApproval: PendingApproval | undefined;
    let requestId: string | undefined;

    for (const [id, approval] of this.pendingApprovals.entries()) {
      if (approval.discordContext.channelId === channelId && 
          approval.discordMessage?.id === messageId) {
        pendingApproval = approval;
        requestId = id;
        break;
      }
    }

    if (!pendingApproval || !requestId) {
      console.log('PermissionManager: No pending approval found for message:', messageId);
      return;
    }

    // Verify the user is authorized to approve
    if (userId !== pendingApproval.discordContext.userId) {
      console.log('PermissionManager: Unauthorized user attempted approval:', userId);
      return;
    }

    // Clear timeout
    clearTimeout(pendingApproval.timeout);

    // Create permission decision
    const decision: PermissionDecision = {
      behavior: approved ? 'allow' : 'deny',
      updatedInput: approved ? pendingApproval.input : undefined,
      message: approved ? undefined : 'Denied by user via Discord reaction',
    };

    console.log(`PermissionManager: User ${approved ? 'approved' : 'denied'} tool ${pendingApproval.toolName}`);

    // Resolve the promise
    pendingApproval.resolve(decision);

    // Clean up
    this.cleanupPendingApproval(requestId);

    // Update the Discord message to show the result
    this.updateApprovalMessage(pendingApproval.discordMessage, approved).catch(console.error);
  }

  /**
   * Handle approval timeout
   */
  private handleApprovalTimeout(requestId: string): void {
    const pendingApproval = this.pendingApprovals.get(requestId);
    if (!pendingApproval) {
      return;
    }

    console.log(`PermissionManager: Approval timed out for ${pendingApproval.toolName}, defaulting to ${this.defaultOnTimeout}`);

    const decision: PermissionDecision = {
      behavior: this.defaultOnTimeout,
      updatedInput: this.defaultOnTimeout === 'allow' ? pendingApproval.input : undefined,
      message: `Timed out after ${this.approvalTimeout / 1000} seconds, defaulted to ${this.defaultOnTimeout}`,
    };

    // Resolve the promise
    pendingApproval.resolve(decision);

    // Clean up
    this.cleanupPendingApproval(requestId);

    // Update the Discord message to show timeout
    this.updateApprovalMessage(pendingApproval.discordMessage, null).catch(console.error);
  }

  /**
   * Update the approval message to show the result
   */
  private async updateApprovalMessage(message: any, approved: boolean | null): Promise<void> {
    if (!message) return;

    try {
      if (approved === true || approved === false) {
        // For user approvals/denials, delete the message to keep chat clean
        await message.delete();
        console.log(`PermissionManager: Deleted approval message after user ${approved ? 'approved' : 'denied'}`);
      } else {
        // For timeouts, show what happened then delete after a delay
        const statusEmoji = '⏰';
        const statusText = `**TIMED OUT** - defaulted to ${this.defaultOnTimeout.toUpperCase()}`;
        const updatedContent = message.content + `\n\n${statusEmoji} ${statusText}`;
        
        await message.edit(updatedContent);
        
        // Remove reactions to prevent further interaction
        await message.reactions.removeAll().catch(() => {
          // Ignore errors if we can't remove reactions (permissions)
        });
        
        // Delete the timeout message after 5 seconds
        setTimeout(async () => {
          try {
            await message.delete();
            console.log('PermissionManager: Deleted timeout message after delay');
          } catch (error) {
            console.error('PermissionManager: Error deleting timeout message:', error);
          }
        }, 5000);
      }
    } catch (error) {
      console.error('PermissionManager: Error updating approval message:', error);
    }
  }

  /**
   * Clean up a pending approval
   */
  private cleanupPendingApproval(requestId: string): void {
    const pendingApproval = this.pendingApprovals.get(requestId);
    if (pendingApproval) {
      clearTimeout(pendingApproval.timeout);
      this.pendingApprovals.delete(requestId);
    }
  }

  /**
   * Clean up all pending approvals (e.g., on shutdown)
   */
  cleanup(): void {
    console.log(`PermissionManager: Cleaning up ${this.pendingApprovals.size} pending approvals`);
    
    for (const [requestId, approval] of this.pendingApprovals.entries()) {
      clearTimeout(approval.timeout);
      approval.reject(new Error('Permission manager shutting down'));
    }
    
    this.pendingApprovals.clear();
  }

  /**
   * Get status information for debugging
   */
  getStatus(): {
    pendingCount: number;
    pendingRequests: Array<{
      requestId: string;
      toolName: string;
      channelId: string;
      createdAt: Date;
    }>;
  } {
    const pendingRequests = Array.from(this.pendingApprovals.entries()).map(([requestId, approval]) => ({
      requestId,
      toolName: approval.toolName,
      channelId: approval.discordContext.channelId,
      createdAt: approval.createdAt,
    }));

    return {
      pendingCount: this.pendingApprovals.size,
      pendingRequests,
    };
  }
}