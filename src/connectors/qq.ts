import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { CoworkerConfig } from "../config.js";
import { QqApiClient } from "../platform/qq-api.js";
import type { Connector, ConnectorRequest, ConnectorResponse, InboundAttachment, MessageDispatcher } from "../types.js";

interface QqConfig {
  appId: string;
  appSecret: string;
  enforceSignature: boolean;
  maxFileBytes?: number;
}

interface QqPayload {
  id?: string;
  op: number;
  d?: unknown;
  t?: string;
}

interface QqMessageData {
  id: string;
  content?: string;
  group_openid?: string;
  timestamp?: string;
  author?: {
    id?: string;
    user_openid?: string;
    member_openid?: string;
  };
  attachments?: Array<{
    url?: string;
    filename?: string;
    content_type?: string;
    size?: number;
  }>;
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function deriveSeed(secret: string): Buffer {
  let seed = Buffer.from(secret, "utf8");
  while (seed.length < 32) seed = Buffer.concat([seed, seed]);
  return seed.subarray(0, 32);
}

function deriveKeys(secret: string) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, deriveSeed(secret)]),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

function attachmentKind(contentType?: string): InboundAttachment["kind"] {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("audio/")) return "audio";
  return contentType ? "file" : "other";
}

export class QqConnector implements Connector {
  readonly name = "qq" as const;
  private readonly validationPrivateKey;
  private readonly validationPublicKey;
  private readonly api: QqApiClient;

  constructor(
    private readonly config: QqConfig,
    private readonly dispatch: MessageDispatcher,
  ) {
    const keys = deriveKeys(config.appSecret);
    this.validationPrivateKey = keys.privateKey;
    this.validationPublicKey = keys.publicKey;
    this.api = new QqApiClient({
      appId: config.appId,
      appSecret: config.appSecret,
      ...(config.maxFileBytes ? { maxFileBytes: config.maxFileBytes } : {}),
    });
  }

  static fromConfig(config: CoworkerConfig, dispatch: MessageDispatcher): QqConnector | undefined {
    const qq = config.connectors.qq;
    if (!qq.enabled || qq.mode !== "webhook") return undefined;
    if (!qq.appId || !qq.appSecret) throw new Error("QQ webhook configuration is incomplete");
    return new QqConnector({
      appId: qq.appId,
      appSecret: qq.appSecret,
      enforceSignature: qq.enforceSignature,
      maxFileBytes: config.attachments.maxOutboundBytes,
    }, dispatch);
  }

  async handle(request: ConnectorRequest): Promise<ConnectorResponse | null> {
    if (request.pathname !== "/webhooks/qq") return null;
    if (request.method !== "POST") return { status: 405, body: "Method Not Allowed" };
    if (this.config.enforceSignature && !this.verifyWebhookSignature(request)) return { status: 401, body: "Invalid signature" };

    let payload: QqPayload;
    try {
      payload = JSON.parse(request.rawBody.toString("utf8")) as QqPayload;
    } catch {
      return { status: 400, body: "Invalid JSON" };
    }

    if (payload.op === 13) return this.validationResponse(payload);
    if (payload.op !== 0 || !["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE"].includes(payload.t ?? "")) {
      return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ op: 12, d: {} }) };
    }

    const message = payload.d as QqMessageData | undefined;
    if (!message?.id) return { status: 400, body: "Missing message id" };
    const isGroup = payload.t === "GROUP_AT_MESSAGE_CREATE";
    const senderId = isGroup ? message.author?.member_openid : message.author?.user_openid;
    const chatId = isGroup ? message.group_openid : message.author?.user_openid;
    if (!senderId || !chatId) return { status: 400, body: "Missing OpenID" };
    const attachments = this.attachments(message);

    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ op: 12, d: {} }),
      afterSend: () => {
        void this.dispatch({
          platform: "qq",
          messageId: message.id,
          senderId,
          chatId,
          chatType: isGroup ? "group" : "direct",
          text: message.content ?? "",
          timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
          ...(attachments.length ? { attachments } : {}),
          reply: (text) => this.api.sendText({ isGroup, chatId, messageId: message.id }, text),
          sendFile: (file) => this.api.sendFile({ isGroup, chatId, messageId: message.id }, file),
        });
      },
    };
  }

  private attachments(message: QqMessageData): InboundAttachment[] {
    return (message.attachments ?? []).flatMap((attachment) => {
      if (!attachment.url) return [];
      return [{
        url: attachment.url,
        kind: attachmentKind(attachment.content_type),
        ...(attachment.filename ? { filename: attachment.filename } : {}),
        ...(attachment.content_type ? { contentType: attachment.content_type } : {}),
        ...(attachment.size ? { size: attachment.size } : {}),
      }];
    });
  }

  private verifyWebhookSignature(request: ConnectorRequest): boolean {
    const signature = request.headers["x-signature-ed25519"];
    const timestamp = request.headers["x-signature-timestamp"];
    if (!signature || !timestamp || !/^[0-9a-fA-F]{128}$/.test(signature)) return false;
    return verify(null, Buffer.concat([Buffer.from(timestamp), request.rawBody]), this.validationPublicKey, Buffer.from(signature, "hex"));
  }

  private validationResponse(payload: QqPayload): ConnectorResponse {
    const data = payload.d as { plain_token?: string; event_ts?: string } | undefined;
    if (!data?.plain_token || !data.event_ts) return { status: 400, body: "Invalid validation payload" };
    const signature = sign(null, Buffer.from(`${data.event_ts}${data.plain_token}`), this.validationPrivateKey).toString("hex");
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ plain_token: data.plain_token, signature }),
    };
  }
}

export const qqCrypto = {
  deriveSeed,
  deriveKeys,
};
