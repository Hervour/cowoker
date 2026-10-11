import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageDeduplicator } from "../src/core/message-deduplicator.js";

test("webhook messages are claimed once and persist across restarts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cowoker-events-"));
  const filePath = path.join(directory, "events.json");
  try {
    const first = new MessageDeduplicator(filePath);
    assert.equal(await first.claim("qq", "message-1"), true);
    assert.equal(await first.claim("qq", "message-1"), false);
    await first.flush();

    const second = new MessageDeduplicator(filePath);
    assert.equal(await second.claim("qq", "message-1"), false);
    assert.equal(await second.claim("wecom", "message-1"), true);
    await second.flush();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

