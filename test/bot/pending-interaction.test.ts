import { describe, it, expect } from "vitest";
import { resolvePendingInteractionContext } from "../../src/bot/pending-interaction.js";

describe("pending interaction recovery", () => {
  it("rebuilds button context from the original Discord message when memory is empty", async () => {
    const thread = {
      id: "thread-1",
      name: "fix-login",
      messages: {
        fetch: async () => ({
          id: "msg-1",
          content: "Here are the screenshots",
          author: { id: "user-1" },
          attachments: new Map(),
        }),
      },
    };

    const recovered = await resolvePendingInteractionContext({
      msgId: "msg-1",
      thread,
      session: {
        agent: "cc",
        workDir: "/tmp/work",
        channelId: "channel-1",
      },
      downloadMsgAttachments: async () => [
        {
          tempPath: "/tmp/image.png",
          originalName: "image.png",
          isImage: true,
        },
      ],
      fetchReplyContext: async () => ({
        text: "[Replying to: previous note]\n\n",
        attachments: [
          {
            tempPath: "/tmp/quote.txt",
            originalName: "quote.txt",
            isImage: false,
          },
        ],
      }),
    });

    expect(recovered).toMatchObject({
      originalText: "Here are the screenshots",
      agentKey: "cc",
      workDir: "/tmp/work",
      channelId: "channel-1",
      discordContext: {
        channelId: "thread-1",
        channelName: "fix-login",
        userId: "user-1",
        messageId: "msg-1",
      },
    });
    expect(recovered?.prompt).toContain("Here are the screenshots");
    expect(recovered?.prompt).toContain("/tmp/quote.txt");
    expect(recovered?.prompt).toContain("/tmp/image.png");
  });
});
