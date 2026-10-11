import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { WechatMpConnector, wechatMpCrypto } from "../src/connectors/wechat-mp.js";
import type { InboundMessage } from "../src/types.js";

const token = "cowoker-wechat-token";
const appId = "wx-test-app";
const appSecret = "wx-test-secret";
const encodingAesKey = Buffer.alloc(32, 11).toString("base64").replace(/=+$/, "");

function requestFor(method: string, query: URLSearchParams, xml = "") {
  return {
    method,
    pathname: "/webhooks/wechat-mp",
    query,
    headers: {},
    rawBody: Buffer.from(xml),
  };
}

function textXml(content: string, openId = "openid-1"): string {
  return `<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[${openId}]]></FromUserName><CreateTime>1725442341</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>message-1</MsgId></xml>`;
}

function encryptXml(xml: string): string {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  const message = Buffer.from(xml);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length);
  const body = Buffer.concat([randomBytes(16), length, message, Buffer.from(appId)]);
  const padLength = 32 - (body.length % 32 || 32);
  const padding = Buffer.alloc(padLength < 1 ? 32 : padLength, padLength < 1 ? 32 : padLength);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([body, padding])), cipher.final()]).toString("base64");
}

test("WeChat MP URL verification returns echostr", async () => {
  const query = new URLSearchParams({
    timestamp: "1725442341",
    nonce: "nonce",
    echostr: "echo-ok",
  });
  query.set("signature", wechatMpCrypto.wechatSignature(token, "1725442341", "nonce"));
  const connector = new WechatMpConnector({ appId, appSecret, token, encodingAesKey }, async () => undefined);
  const response = await connector.handle(requestFor("GET", query));
  assert.equal(response?.status, 200);
  assert.equal(response?.body, "echo-ok");
});

test("WeChat MP text message is normalized and replies through custom message API", async () => {
  let received: InboundMessage | undefined;
  const outbound: Array<Record<string, unknown>> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/cgi-bin/token")) {
      return new Response(JSON.stringify({ access_token: "access-token", expires_in: 7200 }), { status: 200 });
    }
    outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  }) as typeof fetch;

  const connector = new WechatMpConnector({ appId, appSecret, token, encodingAesKey }, async (message) => {
    received = message;
  }, fakeFetch);
  const response = await connector.handle(requestFor("POST", new URLSearchParams(), textXml("/whoami")));
  response?.afterSend?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received?.platform, "wechat-mp");
  assert.equal(received?.senderId, "openid-1");
  await received?.reply("hello");
  assert.deepEqual(outbound, [{ touser: "openid-1", msgtype: "text", text: { content: "hello" } }]);
});

test("WeChat MP safe-mode encrypted message decrypts", async () => {
  let received: InboundMessage | undefined;
  const encrypted = encryptXml(textXml("/status"));
  const query = new URLSearchParams({
    timestamp: "1725442341",
    nonce: "nonce",
    msg_signature: wechatMpCrypto.wechatSignature(token, "1725442341", "nonce", encrypted),
  });
  const connector = new WechatMpConnector({ appId, appSecret, token, encodingAesKey }, async (message) => {
    received = message;
  }, (async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 })) as typeof fetch);

  const response = await connector.handle(requestFor("POST", query, `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`));
  assert.equal(response?.status, 200);
  response?.afterSend?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received?.text, "/status");
});
