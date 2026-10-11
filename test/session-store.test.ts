import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/core/session-store.js";

test("sessions persist threads and modes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cowoker-store-"));
  const filePath = path.join(directory, "sessions.json");
  try {
    const first = new SessionStore(filePath);
    await first.load();
    const session = first.getOrCreate("qq", "chat-1", "cowoker", "read-only");
    first.update("qq", "chat-1", {
      threadId: "thread-1",
      mode: "workspace-write",
      incrementTurns: true,
    });
    await first.flush();

    const second = new SessionStore(filePath);
    await second.load();
    const restored = second.get("qq", "chat-1");
    assert.equal(restored?.conversationId, session.conversationId);
    assert.equal(restored?.threadId, "thread-1");
    assert.equal(restored?.mode, "workspace-write");
    assert.equal(restored?.turns, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
