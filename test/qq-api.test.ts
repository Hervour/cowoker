import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { QqApiClient } from "../src/platform/qq-api.js";

test("QQ API uploads a local file and sends a rich media message", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cowoker-qq-file-"));
  const filePath = path.join(directory, "hello.txt");
  await writeFile(filePath, "hello cowoker", "utf8");
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    if (init?.body && typeof init.body === "string") body = JSON.parse(init.body);
    calls.push({ url, method, ...(body !== undefined ? { body } : {}) });
    if (url.includes("/getAppAccessToken")) return Response.json({ access_token: "token", expires_in: 7200 });
    if (url.endsWith("/upload_prepare")) return Response.json({ upload_id: "upload-1", block_size: "6", parts: [{ index: 1, presigned_url: "https://upload.example/1", block_size: "6" }, { index: 2, presigned_url: "https://upload.example/2", block_size: "7" }] });
    if (url.startsWith("https://upload.example/")) return new Response("", { status: 200 });
    if (url.endsWith("/files")) return Response.json({ file_info: "file-info-1", ttl: 60 });
    return Response.json({ id: "message-2" });
  }) as typeof fetch;

  try {
    const api = new QqApiClient({ appId: "app", appSecret: "secret" });
    await api.sendFile({ isGroup: false, chatId: "openid", messageId: "message-1" }, { path: filePath, caption: "" });
    const messageCall = calls.find((call) => call.url.endsWith("/messages"));
    assert.deepEqual(messageCall?.body, {
      msg_type: 7,
      media: { file_info: "file-info-1" },
      msg_id: "message-1",
      msg_seq: 1,
    });
    assert.equal(calls.some((call) => call.url.endsWith("/upload_part_finish")), true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

