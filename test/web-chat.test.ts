import { test } from "node:test";
import assert from "node:assert/strict";
import { WebChatConnector } from "../src/connectors/web-chat.js";
import type { InboundMessage } from "../src/types.js";

function request(method: string, pathname: string, query: URLSearchParams, body = "", token = true) {
  return {
    method,
    pathname,
    query,
    headers: token ? { authorization: "Bearer test-token" } : {},
    rawBody: Buffer.from(body),
  };
}

test("web chat serves the UI and requires its token", async () => {
  const connector = new WebChatConnector(async () => undefined, "test-token");
  const page = await connector.handle(request("GET", "/chat", new URLSearchParams()));
  assert.equal(page?.status, 200);
  assert.equal(String(page?.body).includes("cowoker"), true);
  const denied = await connector.handle(request("GET", "/api/chat/poll", new URLSearchParams({ clientId: "client-1", after: "0" }), "", false));
  assert.equal(denied?.status, 401);
});

test("web chat dispatches messages and polls replies", async () => {
  let received: InboundMessage | undefined;
  const connector = new WebChatConnector(async (message) => {
    received = message;
  }, "test-token");
  const sent = await connector.handle(request(
    "POST",
    "/api/chat/message",
    new URLSearchParams(),
    JSON.stringify({ clientId: "client-1", text: "/whoami" }),
  ));
  assert.equal(sent?.status, 200);
  assert.equal(received?.platform, "web");
  assert.equal(received?.senderId, "web-user");
  await received?.reply("权限：admin");

  const poll = await connector.handle(request(
    "GET",
    "/api/chat/poll",
    new URLSearchParams({ clientId: "client-1", after: "0" }),
  ));
  const payload = JSON.parse(String(poll?.body)) as { events: Array<{ text: string }> };
  assert.equal(payload.events[0]?.text, "权限：admin");
});
