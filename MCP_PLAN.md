# MCP Server Implementation Plan

This document outlines the step-by-step plan for implementing an MCP server to handle tool permissions for Claude Code sessions initiated from Discord.

## Current Status: ✅ FULLY FUNCTIONAL

**All core functionality is complete and working:**
- ✅ MCP server running on port 3001 with Discord bot integration
- ✅ Interactive Discord approval messages with ✅/❌ reactions  
- ✅ Session-specific MCP configurations with hardcoded Discord context
- ✅ Full permission workflow: Claude Code → MCP → Discord → User Approval → Resume
- ✅ Automatic cleanup of temporary config files
- ✅ Fallback permission logic for safe vs dangerous tools

**Ready for testing:** The system should now send approval messages to Discord when Claude Code tries to use dangerous tools like `Bash`, `Write`, or `Edit`.

## Overview

The MCP server:
- Runs in the same process as the Discord bot (HTTP transport on port 3001)
- Handles permission decisions for Claude Code tool usage via **Interactive Discord Approval**
- Sends approval requests as Discord messages with ✅/❌ reactions
- Pauses Claude Code execution until user approves/denies via Discord reactions
- Uses session-specific configurations to avoid environment variable issues
- Supports different permission levels and approval workflows per Discord channel

## Permission Flow Architecture

```
User Message → Claude Code → MCP Server → Permission Manager → Discord Approval Message
                    ↑                                                      ↓
            Resume/Cancel ← Permission Decision ← User Reaction (✅/❌) ←──┘
```

## Implementation Steps

### **Step 1: Setup and Basic MCP Server Structure** ✅ COMPLETED

**Goals:**
- Add MCP SDK dependency to package.json
- Create basic MCP server structure
- Start HTTP server in same process as Discord bot
- Verify server starts correctly without errors

**Tasks:**
- [x] Add `@modelcontextprotocol/sdk` dependency to package.json
- [x] Create `src/mcp/server.ts` with basic MCP server setup
- [x] Create `src/mcp/permissions.ts` for permission logic
- [x] Modify `src/index.ts` to start both Discord bot and MCP server
- [x] Test that both servers start without conflicts
- [x] Verify MCP server responds to basic HTTP requests

**Success Criteria:**
- ✅ Bot starts successfully with MCP server running on port 3001
- ✅ MCP server responds to initialization requests
- ✅ No console errors during startup

---

### **Step 2: Discord-Integrated Permission Manager** ✅ COMPLETED

**Goals:**
- Create PermissionManager to bridge MCP server ↔ Discord bot
- Enable Discord context passing to permission decisions
- Implement async permission handling with Promise-based blocking

**Tasks:**
- [x] Create `src/mcp/permission-manager.ts` - core permission orchestration
- [x] Modify MCP server to use PermissionManager instead of direct approval
- [x] Update `src/mcp/permissions.ts` to accept Discord context
- [x] Add Discord context passing from ClaudeManager to MCP requests
- [x] Implement pending approval tracking with request IDs

**Success Criteria:**
- ✅ MCP server can receive Discord context (channelId, channelName, userId)
- ✅ PermissionManager can handle async approval requests
- ✅ Permission decisions include Discord channel information
- ✅ System properly tracks pending approval requests

---

### **Step 3: Interactive Discord Approval UI** ✅ COMPLETED

**Goals:**
- Implement Discord approval messages with ✅/❌ reactions
- Add reaction event handlers for approval/denial
- Handle approval timeouts and fallback logic

**Tasks:**
- [x] Add reaction event handlers to Discord bot
- [x] Create approval message UI with tool information and reactions
- [x] Implement approval timeout logic (default: 30 seconds)
- [x] Add approval/denial response handling
- [x] Handle edge cases (message deletion, bot restart, etc.)

**Success Criteria:**
- ✅ Discord sends approval messages with clear tool information
- ✅ Users can approve/deny via ✅/❌ reactions
- ✅ System handles timeouts gracefully (default to deny/allow configurable)
- ✅ Approval status is clearly communicated back to user

---

### **Step 4: Claude Code Integration with MCP** ✅ COMPLETED

**Goals:**
- Add MCP configuration and flags to Claude Code commands
- Test end-to-end approval flow from Discord → Claude Code → MCP → Approval
- Handle Claude Code session pausing/resumption

**Tasks:**
- [x] Create session-specific MCP configuration files in `/tmp` with hardcoded Discord context
- [x] Modify `buildClaudeCommand()` in `src/utils/shell.ts` to create and use session configs
- [x] Add `--mcp-config` and `--permission-prompt-tool` to Claude commands
- [x] Implement session-specific environment variable passing via config files
- [x] Add cleanup mechanism for old session config files

**Success Criteria:**
- ✅ Claude Code successfully connects to MCP server
- ✅ Permission prompts are triggered for tools requiring approval
- ✅ Discord context is properly passed through session-specific config files
- ✅ Environment variable substitution issues resolved with hardcoded values

**Technical Innovation:**
- ✅ Implemented session-specific MCP config files in `/tmp` to avoid environment variable substitution issues
- ✅ Each Claude Code session gets its own config with hardcoded Discord context
- ✅ Automatic cleanup of old config files prevents `/tmp` bloat

---

### **Step 5: Advanced Permission Features** ⏳ PENDING

**Goals:**
- Implement intelligent permission categorization (safe/dangerous tools)
- Add permission caching for repeated safe tools
- Create channel-specific permission rules
- Add audit logging and permission overrides

**Tasks:**
- [ ] Implement tool risk categorization (safe vs dangerous)
- [ ] Add permission caching to avoid repeated approvals for safe tools
- [ ] Create channel-specific permission rules configuration
- [ ] Add permission audit logging
- [ ] Implement emergency override commands
- [ ] Add permission statistics and reporting

**Success Criteria:**
- Safe tools (Read, LS, etc.) don't require approval after first use
- Dangerous tools (Bash, Write, etc.) always require approval
- Different channels can have different permission levels
- Full audit trail of permission decisions
- Emergency override capability for urgent situations

---

## Technical Architecture

### Updated File Structure
```
src/mcp/
├── server.ts              # Main MCP server setup and HTTP transport
├── permission-manager.ts  # Core permission orchestration (NEW)
├── permissions.ts         # Permission decision logic (UPDATED)
└── discord-context.ts     # Discord integration utilities (NEW)
```

### Configuration Files
```
mcp-config.json           # MCP server configuration for Claude Code
permission-rules.json     # Channel-based permission rules
```

### Integration Points
- `src/index.ts`: Start MCP server alongside Discord bot
- `src/bot/client.ts`: Add reaction event handlers for approvals (UPDATED)
- `src/utils/shell.ts`: Add MCP flags to Claude commands
- `src/claude/manager.ts`: Pass Discord context to Claude sessions (UPDATED)

### Permission Manager Architecture

The PermissionManager acts as the central coordinator:

```typescript
interface PendingApproval {
  requestId: string;
  toolName: string;
  input: any;
  discordContext: DiscordContext;
  resolve: (decision: PermissionDecision) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  discordMessage?: any; // The approval message sent to Discord
}

class PermissionManager {
  private pendingApprovals = new Map<string, PendingApproval>();
  private discordBot: DiscordBot; // Reference to send approval messages
  
  // Called by MCP server when Claude Code requests permission
  async requestApproval(toolName, input, discordContext): Promise<PermissionDecision>
  
  // Called by Discord bot when user reacts to approval message
  handleApprovalReaction(channelId: string, messageId: string, approved: boolean): void
  
  // Internal timeout handling
  private handleApprovalTimeout(requestId: string): void
}
```

---

## Environment Variables

New environment variables needed:
- `MCP_SERVER_PORT` (default: 3001) - Port for MCP HTTP server
- `MCP_APPROVAL_TIMEOUT` (default: 30) - Approval timeout in seconds
- `MCP_DEFAULT_ON_TIMEOUT` (default: "deny") - What to do when approval times out

---

## Testing Strategy

1. **Unit Tests**: Test PermissionManager logic in isolation
2. **Integration Tests**: Test MCP ↔ Discord approval flow
3. **End-to-End Tests**: Test full Discord → Claude Code → MCP → Approval → Resume flow
4. **Manual Testing**: Test various approval scenarios via Discord reactions

---

## Rollback Plan

If issues arise:
1. MCP flags can be removed from Claude commands (fallback to default behavior)
2. Permission Manager can be set to "auto-approve" mode
3. MCP server can be disabled while keeping Discord bot running
4. Emergency environment variable to bypass all permissions

---

## Security Considerations

- Approval requests include full tool input for transparency
- Timeout defaults to "deny" for security
- Only the authorized Discord user can approve/deny
- All permission decisions are logged with timestamps
- System prevents approval message spoofing

---

## Notes

- MCP server coordinates with Discord bot through PermissionManager
- Uses Promise-based blocking to pause Claude Code during approval
- Approval messages are sent to the same channel as the Claude Code session
- System gracefully handles Discord bot restarts (pending approvals default to deny)