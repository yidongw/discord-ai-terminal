# Manual Test Plan for /goal Command

## Prerequisites
- Discord bot running
- Test threads for @cc, @cx, and @cs

## Test Cases

### 1. Test /goal set
**Steps:**
1. In a cc thread, run: `/goal set Fix the authentication bug`
2. Verify bot responds with "🎯 Goal Set" embed showing the goal
3. Send a message to the thread (e.g., "what's the goal?")
4. Check that Claude Code receives the goal in its system prompt

**Expected:**
- Goal is stored in database
- Claude Code should be aware of the goal and mention it when asked

### 2. Test /goal show
**Steps:**
1. In the same thread, run: `/goal show`
2. Verify bot shows the current goal

**Expected:**
- Shows "🎯 Current Goal" with the text "Fix the authentication bug"

### 3. Test goal persists across messages
**Steps:**
1. Send multiple messages in the thread
2. Each time, Claude Code should have the goal in its system prompt

**Expected:**
- Goal remains active for all messages until cleared

### 4. Test /goal clear
**Steps:**
1. Run: `/goal clear`
2. Verify bot responds with "🗑️ Goal Cleared"
3. Run: `/goal show`
4. Verify bot says "ℹ️ No Goal"

**Expected:**
- Goal is removed from database
- Subsequent messages don't include goal in system prompt

### 5. Test /goal in channel (should fail)
**Steps:**
1. In a channel (not thread), run: `/goal set test`

**Expected:**
- Bot responds: "ℹ️ Use in Thread - The /goal command only works in threads, not channels."

### 6. Test /goal with Codex (@cx)
**Steps:**
1. Create a @cx thread
2. Run: `/goal set Find and fix any TypeScript errors`
3. Send a message and verify goal is prepended to the prompt

**Expected:**
- Goal is set successfully
- Codex receives the goal in its prompt

### 6b. Test /goal with Cursor (@cs)
**Steps:**
1. Create a @cs thread
2. Run: `/goal set Refactor the database layer`
3. Send a message and verify goal is prepended to the prompt

**Expected:**
- Goal is set successfully
- Cursor receives the goal in its prompt

### 7. Test goal survives bot restart
**Steps:**
1. Set a goal in a cc thread
2. Restart the bot
3. Check the goal is still there with `/goal show`

**Expected:**
- Goal persists in database and is loaded on restart

## Verification Checklist
- [ ] Goal can be set via `/goal set`
- [ ] Goal is shown via `/goal show`
- [ ] Goal can be cleared via `/goal clear`
- [ ] Goal is prepended to Claude Code system prompt
- [ ] Goal is prepended to Codex prompt
- [ ] Goal is prepended to Cursor prompt
- [ ] Goal only works in threads (not channels)
- [ ] Goal works with all agents (cc, cx, cs)
- [ ] Goal persists across messages
- [ ] Goal persists across bot restarts
- [ ] README documentation is accurate
