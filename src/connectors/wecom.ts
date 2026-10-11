import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type { CoworkerConfig } from "../config.js";
import type { Connector, ConnectorRequest, ConnectorResponse, MessageDispatcher } from "../types.js";

interface WecomConfig {
  corpId: string;
  agentId: number;
  secret: string;
  token: string;
  encodingAesKey: string;
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

function wecomSignature(token: string, timestamp: string, nonce: string, encrypted: string): string {
  return createHash("sha1")
    .update([token, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function decryptPayload(encrypted: string, encodingAesKey: string): string {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new Error("Invalid WeCom encodingAesKey");
  const iv = key.subarray(0, 16);
  const encryptedBuffer = Buffer.from(encrypted, "base64");
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  const padding = plain.at(-1);
  if (!padding || padding < 1 || padding > 32 || padding > plain.length) throw new Error("Invalid WeCom padding");
  const content = plain.subarray(0, plain.length - padding);
  if (content.length < 20) throw new Error("Invalid WeCom payload");
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

export class WecomConnector implements Connector {
  readonly name = "wecom" as const;
  private accessToken?: AccessToken;

  constructor(
    private readonly config: WecomConfig,
    private readonly dispatch: MessageDispatcher,
  ) {}

  static fromConfig(config: CoworkerConfig, dispatch: MessageDispatcher): WecomConnector | undefined {
    const wecom = config.connectors.wecom;
    if (!wecom.enabled) return undefined;
    if (!wecom.corpId || !wecom.agentId || !wecom.secret || !wecom.token || !wecom.encodingAesKey) {
      throw new Error("WeCom connector configuration is incomplete");
    }
    return new WecomConnector({
      corpId: wecom.corpId,
      agentId: wecom.agentId,
      secret: wecom.secret,
      token: wecom.token,
      encodingAesKey: wecom.encodingAesKey,
    }, dispatch);
  }

  async handle(request: ConnectorRequest): Promise<ConnectorResponse | null> {
    if (request.pathname !== "/webhooks/wecom") return null;
    if (request.method === "GET") return this.handleVerification(request);
    if (request.method !== "POST") return { status: 405, body: "Method Not Allowed" };
    return this.handleMessage(request);
  }

  private handleVerification(request: ConnectorRequest): ConnectorResponse {
    const signature = request.query.get("msg_signature") ?? "";
    const timestamp = request.query.get("timestamp") ?? "";
    const nonce = request.query.get("nonce") ?? "";
    const encrypted = request.query.get("echostr") ?? "";
    const expected = wecomSignature(this.config.token, timestamp, nonce, encrypted);
    if (!secureEqual(signature, expected)) return { status: 403, body: "Invalid signature" };
    try {
      return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: decryptPayload(encrypted, this.config.encodingAesKey) };
    } catch (error) {
      return { status: 400, body: error instanceof Error ? error.message : "Invalid encrypted payload" };
    }
  }

  private handleMessage(request: ConnectorRequest): ConnectorResponse {
    const signature = request.query.get("msg_signature") ?? "";
    const timestamp = request.query.get("timestamp") ?? "";
    const nonce = request.query.get("nonce") ?? "";
    const outerXml = request.rawBody.toString("utf8");
    const encrypted = xmlValue(outerXml, "Encrypt") ?? "";
    const expected = wecomSignature(this.config.token, timestamp, nonce, encrypted);
    if (!signature || !secureEqual(signature, expected)) return { status: 403, body: "Invalid signature" };

    let xml: string;
    try {
      xml = decryptPayload(encrypted, this.config.encodingAesKey);
    } catch (error) {
      return { status: 400, body: error instanceof Error ? error.message : "Invalid encrypted payload" };
    }

    const senderId = xmlValue(xml, "FromUserName") ?? "";
    const messageId = xmlValue(xml, "MsgId") ?? crypto.randomUUID();
    const messageType = xmlValue(xml, "MsgType") ?? "";
    const text = messageType === "text" ? xmlValue(xml, "Content") ?? "" : "";
    if (!senderId) return { status: 400, body: "Missing FromUserName" };

    return {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "",
      afterSend: () => {
        void this.dispatch({
          platform: "wecom",
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
    const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
    url.searchParams.set("corpid", this.config.corpId);
    url.searchParams.set("corpsecret", this.config.secret);
    const response = await fetch(url);
    const result = await response.json() as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number };
    if (!response.ok || result.errcode || !result.access_token) {
      throw new Error(`WeCom gettoken failed: ${result.errcode ?? response.status} ${result.errmsg ?? ""}`);
    }
    this.accessToken = {
      value: result.access_token,
      expiresAt: Date.now() + (result.expires_in ?? 7_200) * 1_000,
    };
    return this.accessToken.value;
  }

  private async sendText(toUser: string, text: string): Promise<void> {
    const accessToken = await this.getAccessToken();
    for (const chunk of chunkUtf8(text)) {
      const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/message/send");
      url.searchParams.set("access_token", accessToken);
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          touser: toUser,
          msgtype: "text",
          agentid: this.config.agentId,
          text: { content: chunk },
          safe: 0,
        }),
      });
      const result = await response.json() as { errcode?: number; errmsg?: string };
      if (!response.ok || result.errcode) {
        throw new Error(`WeCom message send failed: ${result.errcode ?? response.status} ${result.errmsg ?? ""}`);
      }
    }
  }
}

export const wecomCrypto = {
  decryptPayload,
  wecomSignature,
};
