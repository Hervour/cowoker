import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type { CoworkerConfig } from "../config.js";
import type { Connector, ConnectorRequest, ConnectorResponse, MessageDispatcher } from "../types.js";

export interface WechatMpConfig {
  appId: string;
  appSecret: string;
  token: string;
  encodingAesKey?: string;
}

interface AccessToken {
  value: string;
  expiresAt: number;
}

function xmlValue(xml: string, tag: string): string | undefined {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(xml);
  if (cdata?.[1] !== undefined) return cdata[1];
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return plain?.[1];
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function wechatSignature(token: string, timestamp: string, nonce: string, encrypted = ""): string {
  const values = encrypted ? [token, timestamp, nonce, encrypted] : [token, timestamp, nonce];
  return createHash("sha1").update(values.sort().join("")).digest("hex");
}

function decryptPayload(encrypted: string, encodingAesKey: string): string {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new Error("Invalid WeChat MP encodingAesKey");
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
  const padding = plain.at(-1);
  if (!padding || padding < 1 || padding > 32 || padding > plain.length) throw new Error("Invalid WeChat MP padding");
  const content = plain.subarray(0, plain.length - padding);
  if (content.length < 20) throw new Error("Invalid WeChat MP payload");
  const messageLength = content.readUInt32BE(16);
  return content.subarray(20, 20 + messageLength).toString("utf8");
}

function chunkUtf8(text: string, maxBytes = 1_800): string[] {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes && current) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

export class WechatMpConnector implements Connector {
  readonly name = "wechat-mp" as const;
  private accessToken?: AccessToken;

  constructor(
    private readonly config: WechatMpConfig,
    private readonly dispatch: MessageDispatcher,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromConfig(config: CoworkerConfig, dispatch: MessageDispatcher): WechatMpConnector | undefined {
    const mp = config.connectors.wechatMp;
    if (!mp.enabled) return undefined;
    if (!mp.appId || !mp.appSecret || !mp.token) {
      throw new Error("WeChat MP connector configuration is incomplete");
    }
    return new WechatMpConnector({
      appId: mp.appId,
      appSecret: mp.appSecret,
      token: mp.token,
      ...(mp.encodingAesKey ? { encodingAesKey: mp.encodingAesKey } : {}),
    }, dispatch);
  }

  async handle(request: ConnectorRequest): Promise<ConnectorResponse | null> {
    if (request.pathname !== "/webhooks/wechat-mp") return null;
    if (request.method === "GET") return this.handleVerification(request);
    if (request.method !== "POST") return { status: 405, body: "Method Not Allowed" };
    return this.handleMessage(request);
  }

  private handleVerification(request: ConnectorRequest): ConnectorResponse {
    const signature = request.query.get("signature") ?? "";
    const timestamp = request.query.get("timestamp") ?? "";
    const nonce = request.query.get("nonce") ?? "";
    const echo = request.query.get("echostr") ?? "";
    if (!secureEqual(signature, wechatSignature(this.config.token, timestamp, nonce))) {
      return { status: 403, body: "Invalid signature" };
    }
    return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: echo };
  }

  private handleMessage(request: ConnectorRequest): ConnectorResponse {
    const timestamp = request.query.get("timestamp") ?? "";
    const nonce = request.query.get("nonce") ?? "";
    const msgSignature = request.query.get("msg_signature") ?? "";
    const outerXml = request.rawBody.toString("utf8");
    let xml = outerXml;

    if (msgSignature) {
      const encrypted = xmlValue(outerXml, "Encrypt") ?? "";
      if (!encrypted || !secureEqual(msgSignature, wechatSignature(this.config.token, timestamp, nonce, encrypted))) {
        return { status: 403, body: "Invalid message signature" };
      }
      if (!this.config.encodingAesKey) {
        return { status: 400, body: "EncodingAESKey is required for WeChat MP safe mode" };
      }
      try {
        xml = decryptPayload(encrypted, this.config.encodingAesKey);
      } catch (error) {
        return { status: 400, body: error instanceof Error ? error.message : "Invalid encrypted payload" };
      }
    }

    const senderId = xmlValue(xml, "FromUserName") ?? "";
    const messageId = xmlValue(xml, "MsgId") ?? crypto.randomUUID();
    const messageType = xmlValue(xml, "MsgType") ?? "";
    const text = messageType === "text" ? xmlValue(xml, "Content") ?? "" : "";
    if (!senderId) return { status: 400, body: "Missing FromUserName" };

    return {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "success",
      afterSend: () => {
        void this.dispatch({
          platform: "wechat-mp",
          messageId,
          senderId,
          chatId: senderId,
          chatType: "direct",
          text,
          timestamp: new Date(),
          reply: (replyText) => this.sendText(senderId, replyText),
        });
      },
    };
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set("appid", this.config.appId);
    url.searchParams.set("secret", this.config.appSecret);
    const response = await this.fetchImpl(url);
    const result = await response.json() as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number };
    if (!response.ok || result.errcode || !result.access_token) {
      throw new Error(`WeChat MP gettoken failed: ${result.errcode ?? response.status} ${result.errmsg ?? ""}`);
    }
    this.accessToken = {
      value: result.access_token,
      expiresAt: Date.now() + (result.expires_in ?? 7_200) * 1_000,
    };
    return this.accessToken.value;
  }

  private async sendText(openId: string, text: string): Promise<void> {
    const accessToken = await this.getAccessToken();
    for (const chunk of chunkUtf8(text)) {
      const url = new URL("https://api.weixin.qq.com/cgi-bin/message/custom/send");
      url.searchParams.set("access_token", accessToken);
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          touser: openId,
          msgtype: "text",
          text: { content: chunk },
        }),
      });
      const result = await response.json() as { errcode?: number; errmsg?: string };
      if (!response.ok || result.errcode) {
        throw new Error(`WeChat MP message send failed: ${result.errcode ?? response.status} ${result.errmsg ?? ""}`);
      }
    }
  }
}

export const wechatMpCrypto = {
  decryptPayload,
  wechatSignature,
};


