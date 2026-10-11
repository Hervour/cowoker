import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AttachmentStore } from "../src/core/attachment-store.js";

test("attachment store downloads allowed files and rejects unrelated hosts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cowoker-attachment-"));
  try {
    const store = new AttachmentStore(path.join(directory, "inbox"), 1024 * 1024, 5, ["qq.com", "qq.com.cn"]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(Buffer.from("hello"), { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
    try {
      const files = await store.materialize("message-1", [
        { url: "https://multimedia.nt.qq.com.cn/file", filename: "../hello.txt", kind: "file", contentType: "text/plain" },
        { url: "https://example.com/evil", filename: "evil.txt", kind: "file" },
      ]);
      assert.equal(files.length, 1);
      assert.equal(files[0]?.filename, "hello.txt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
