# Goal Implementation Summary

## Overview
The `/goal` command allows users to set a persistent goal for any thread (cc, cx, or cs). The goal is stored in the database and automatically invokes each agent's native `/goal` command functionality.

## Architecture

### Database Layer
- **Table**: `thread_sessions`
- **Column**: `goal TEXT` (nullable)
- **Methods**: 
  - `updateGoal(threadId, goal)` - Set or clear goal
  - `getThreadSession(threadId)` - Retrieve session including goal

### Discord Commands
- `/goal set <text>` - Set a goal for the current thread
- `/goal show` - Display the current goal (ephemeral message)
- `/goal clear` - Remove the goal from the thread

**Restrictions**:
- Only works in threads (not channels)
- Works with all agents (cc, cx, cs)

### Agent-Specific Implementation

All three agents (Claude Code, Codex, and Cursor) have **native `/goal` command support**. The implementation prepends the `/goal <condition>` command to the user's prompt, which the agent then processes natively.

#### Claude Code (@cc)
**File**: `src/agents/cc.ts`

**Approach**: Prepend `/goal <condition>` to user prompt

```typescript
// In ccAgent.buildCommand():
const effectivePrompt = opts.goal
  ? `/goal ${opts.goal}\n${prompt}`
  : prompt;
```

**Native Support**: ✅ Claude Code 2.1.139+ (May 2026)
- Recognizes `/goal` as a native command
- Sets up autonomous loop until goal is met
- Evaluates goal condition after each turn

#### Codex (@cx)
**File**: `src/agents/codex.ts`

**Approach**: Prepend `/goal <condition>` to user prompt

```typescript
// In codexAgent.buildCommand():
const effectivePrompt = opts.goal
  ? `/goal ${opts.goal}\n${prompt}`
  : prompt;
```

**Native Support**: ✅ Codex CLI 0.133.0+ (May 2026)
- Goal mode graduated from experimental to standard feature
- Works across app, IDE, and CLI
- Autonomous workflow until goal is satisfied

#### Cursor (@cs)
**File**: `src/agents/cs.ts`

**Approach**: Prepend `/goal <condition>` before Discord wrapper

```typescript
// In cursorAgent.buildCommand():
let effectivePrompt = opts.goal
  ? `/goal ${opts.goal}\n${prompt}`
  : prompt;
// Then wrap with Discord context
effectivePrompt = opts.discordContext
  ? wrapCursorDiscordPrompt(effectivePrompt)
  : effectivePrompt;
```

**Native Support**: ✅ Cursor Agent 2026+
- Responds with "Goal met" when condition is satisfied
- Native goal recognition and evaluation

## Data Flow

1. User runs `/goal set Fix the auth bug` in a thread
2. Command handler validates (thread-only, session exists)
3. Database updates: `db.updateGoal(threadId, goalText)`
4. User sends a message: "what should I do?"
5. SessionManager retrieves session (including goal)
6. Agent's `buildCommand()` receives `opts.goal`
7. Agent prepends goal to prompt/system prompt
8. AI sees: "Your goal for this session is: Fix the auth bug\n\n{rest of context}\n\nUser: what should I do?"

## Persistence

- **Storage**: SQLite database (`sessions.db`)
- **Lifetime**: Until cleared with `/goal clear` or session deleted
- **Survives**: Bot restarts, message edits, session resume

## Testing

See `test-goal-feature.md` for manual test plan covering:
- Setting goals
- Showing goals  
- Clearing goals
- Cross-agent compatibility
- Persistence across restarts
- Validation (thread-only, session-exists)
