/**
 * While ask_user_question's "Other..." path is waiting for a typed reply,
 * that reply is a normal channel message. Without this guard it also goes
 * through handleThreadMessage → busy Interrupt/Queue UI → often killProcess,
 * which kills the Claude session that was waiting for the answer and produces
 * the Session started → Done 0 turns loop.
 */
export class AskOtherCapture {
  // channelId → userId currently expected to type an Other... reply
  private pending = new Map<string, string>();

  begin(channelId: string, userId: string): void {
    this.pending.set(channelId, userId);
  }

  end(channelId: string, userId: string): void {
    if (this.pending.get(channelId) === userId) this.pending.delete(channelId);
  }

  /** True when this message should be left for awaitMessages, not the agent. */
  shouldSkip(channelId: string, userId: string): boolean {
    return this.pending.get(channelId) === userId;
  }
}
