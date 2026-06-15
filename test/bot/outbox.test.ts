import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// session-manager transitively imports DatabaseManager (bun:sqlite), which the
// vitest/node runner can't resolve. Stub it so the module loads.
vi.mock("bun:sqlite", () => ({
  Database: vi.fn().mockImplementation(() => ({
    exec: vi.fn(),
    query: vi.fn(() => ({ get: vi.fn(), run: vi.fn(), all: vi.fn() })),
    close: vi.fn(),
  })),
}));

import { Outbox, listNewCodexGeneratedImages } from "../../src/bot/session-manager.js";

// A fake Discord thread whose send() resolves only when we tell it to, so we
// can simulate a rate-limited backlog and assert ordering/batching/draining.
function makeThread() {
  const sends: any[] = [];
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;

  const thread = {
    sends,
    send: vi.fn((payload: any) => {
      sends.push(payload);
      return gate ?? Promise.resolve({ id: `msg-${sends.length}` });
    }),
    // Block the NEXT send until releaseGate() is called.
    openGate() {
      gate = new Promise<void>((res) => { release = () => { res(); }; });
    },
    releaseGate() {
      gate = null;
      release?.();
      release = null;
    },
  };
  return thread;
}

const descOf = (payload: any) => payload.embeds[0].data.description as string;

describe("Outbox", () => {
  it("delivers text immediately when there is no backlog", async () => {
    const thread = makeThread();
    const outbox = new Outbox(thread);

    outbox.pushText("hello");
    await outbox.drain();

    expect(thread.send).toHaveBeenCalledTimes(1);
    expect(descOf(thread.sends[0])).toContain("hello");
  });

  it("coalesces text that arrives while a send is in flight", async () => {
    const thread = makeThread();
    const outbox = new Outbox(thread);

    // First send blocks, simulating a slow/rate-limited Discord call.
    thread.openGate();
    outbox.pushText("A");
    // Let the pump start and pick up "A" (now awaiting the gated send).
    await Promise.resolve();
    await Promise.resolve();

    // These three arrive during the in-flight send and should batch into one.
    outbox.pushText("B");
    outbox.pushText("C");
    outbox.pushText("D");

    thread.releaseGate();
    await outbox.drain();

    expect(thread.send).toHaveBeenCalledTimes(2); // "A", then "BCD"
    expect(descOf(thread.sends[0])).toContain("A");
    expect(descOf(thread.sends[1])).toContain("BCD");
  });

  it("preserves order between text and enqueued ops", async () => {
    const thread = makeThread();
    const outbox = new Outbox(thread);
    const order: string[] = [];

    thread.openGate();
    outbox.pushText("first");
    await Promise.resolve();
    await Promise.resolve();

    outbox.enqueue(async () => { order.push("op"); });
    outbox.pushText("last");

    thread.releaseGate();
    await outbox.drain();

    // text "first" sends, then the op runs, then text "last" sends.
    expect(descOf(thread.sends[0])).toContain("first");
    expect(order).toEqual(["op"]);
    expect(descOf(thread.sends[1])).toContain("last");
  });

  it("drain() waits until every queued message is delivered", async () => {
    const thread = makeThread();
    const outbox = new Outbox(thread);

    thread.openGate();
    outbox.pushText("queued before stop");
    await Promise.resolve();

    let drained = false;
    const drainPromise = outbox.drain().then(() => { drained = true; });

    // Still in flight — drain must not have resolved yet.
    await Promise.resolve();
    expect(drained).toBe(false);

    thread.releaseGate();
    await drainPromise;
    expect(drained).toBe(true);
    expect(thread.send).toHaveBeenCalledTimes(1);
  });

  it("keeps delivering even if one send throws", async () => {
    const thread = makeThread();
    const outbox = new Outbox(thread);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    outbox.enqueue(async () => { throw new Error("boom"); });
    outbox.pushText("after error");
    await outbox.drain();

    expect(descOf(thread.sends[0])).toContain("after error");
    errSpy.mockRestore();
  });

  it("uploads URL-encoded local markdown images as Discord files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-ai-terminal-image-"));
    const imagePath = path.join(dir, "Screenshot 2026-04-22 at 2.16.28\u202fAM.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const thread = makeThread();
    const outbox = new Outbox(thread);

    outbox.pushText(`Here it is:\n\n![Screenshot](${encodeURI(imagePath)})`);
    await outbox.drain();

    expect(thread.send).toHaveBeenCalledTimes(2);
    expect(descOf(thread.sends[0])).toBe("Here it is:");
    expect(thread.sends[1].files).toHaveLength(1);
    expect(thread.sends[1].files[0].name).toBe("image.png");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Codex generated image discovery", () => {
  it("finds unsent generated images for a Codex session", () => {
    const oldHome = process.env.CODEX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-generated-images-"));
    const sessionId = "thread-123";
    const imageDir = path.join(home, "generated_images", sessionId);
    fs.mkdirSync(imageDir, { recursive: true });
    const imagePath = path.join(imageDir, "ig_new.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(imageDir, "notes.txt"), "ignore me");
    process.env.CODEX_HOME = home;

    try {
      expect(listNewCodexGeneratedImages(sessionId, new Set(["ig_old"]))).toEqual([imagePath]);
      expect(listNewCodexGeneratedImages(sessionId, new Set(["ig_new"]))).toEqual([]);
    } finally {
      if (oldHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// A thread whose send() returns an editable message, so we can assert the hidden
// summary updates one message in place rather than spamming new ones.
function makeEditableThread() {
  const sends: any[] = [];
  const messages: any[] = [];
  const thread = {
    sends,
    messages,
    send: vi.fn((payload: any) => {
      sends.push(payload);
      const msg: any = {
        id: `msg-${sends.length}`,
        embeds: payload.embeds,
        edits: [] as any[],
        edit: vi.fn((p: any) => { msg.edits.push(p); msg.embeds = p.embeds; return Promise.resolve(msg); }),
      };
      messages.push(msg);
      return Promise.resolve(msg);
    }),
  };
  return thread;
}

// Read a description off whatever embeds a message currently holds (post-edit).
const msgDesc = (msg: any) => msg.embeds[0].data.description as string;

describe("Outbox hidden-tool summary", () => {
  it("collapses a run of hidden tools into one updating summary message", async () => {
    const thread = makeEditableThread();
    const outbox = new Outbox(thread);

    outbox.pushHiddenTool("Bash");
    await outbox.drain();
    outbox.pushHiddenTool("Bash");
    await outbox.drain();
    outbox.pushHiddenTool("Edit");
    await outbox.drain();

    // One message, edited in place — never a second summary.
    expect(thread.messages).toHaveLength(1);
    expect(msgDesc(thread.messages[0])).toBe("🙈 2 Bash, 1 Edit messages hidden");
  });

  it("coalesces hidden tools queued together", async () => {
    const thread = makeEditableThread();
    const outbox = new Outbox(thread);

    outbox.pushHiddenTool("Bash");
    outbox.pushHiddenTool("Bash");
    outbox.pushHiddenTool("Bash");
    outbox.pushHiddenTool("Edit");
    await outbox.drain();

    expect(thread.messages).toHaveLength(1);
    expect(msgDesc(thread.messages[0])).toBe("🙈 3 Bash, 1 Edit messages hidden");
  });

  it("uses singular 'message' for a single hidden tool", async () => {
    const thread = makeEditableThread();
    const outbox = new Outbox(thread);

    outbox.pushHiddenTool("Read");
    await outbox.drain();

    expect(msgDesc(thread.messages[0])).toBe("🙈 1 Read message hidden");
  });

  it("seals the summary on a text message and starts a fresh one after", async () => {
    const thread = makeEditableThread();
    const outbox = new Outbox(thread);

    outbox.pushHiddenTool("Bash");
    await outbox.drain();
    outbox.pushText("here is what I found");
    await outbox.drain();
    outbox.pushHiddenTool("Edit");
    await outbox.drain();

    // summary #1, text, summary #2 — the text reset the count.
    expect(thread.messages).toHaveLength(3);
    expect(msgDesc(thread.messages[0])).toBe("🙈 1 Bash message hidden");
    expect(msgDesc(thread.messages[1])).toContain("here is what I found");
    expect(msgDesc(thread.messages[2])).toBe("🙈 1 Edit message hidden");
  });

  it("seals the summary on an enqueued op (a visible tool/status embed)", async () => {
    const thread = makeEditableThread();
    const outbox = new Outbox(thread);

    outbox.pushHiddenTool("Bash");
    await outbox.drain();
    outbox.enqueue(async () => { await thread.send({ embeds: [{ data: { description: "🔧 visible" } }] }); });
    await outbox.drain();
    outbox.pushHiddenTool("Bash");
    await outbox.drain();

    expect(thread.messages).toHaveLength(3);
    expect(msgDesc(thread.messages[0])).toBe("🙈 1 Bash message hidden");
    expect(msgDesc(thread.messages[2])).toBe("🙈 1 Bash message hidden");
    // The two summaries are distinct messages, not one edited twice.
    expect(thread.messages[0].id).not.toBe(thread.messages[2].id);
  });
});
