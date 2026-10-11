import type { CoworkerConfig } from "../config.js";
import type { Connector, ConnectorRequest, ConnectorResponse, MessageDispatcher } from "../types.js";
import { QqApiClient } from "../platform/qq-api.js";

interface QqGatewayConfig {
  appId: string;
  appSecret: string;
  maxFileBytes?: number;
}

interface GatewayPayload {
  op: number;
  d?: unknown;
  t?: string;
  s?: number;
}

interface QqGatewayMessage {
  id: string;
  content?: string;
  group_openid?: string;
  timestamp?: string;
  message_type?: number;
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

function attachmentKind(contentType?: string): "image" | "video" | "audio" | "file" | "other" {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("audio/")) return "audio";
  return contentType ? "file" : "other";
}

export class QqGatewayConnector implements Connector {
  readonly name = "qq" as const;
  private running = false;
  private socket?: WebSocket | undefined;
  private heartbeat?: NodeJS.Timeout | undefined;
  private reconnectTimer?: NodeJS.Timeout | undefined;
  private sessionId?: string | undefined;
  private sequence?: number | undefined;
  private reconnectAttempts = 0;
  private readonly api: QqApiClient;

  constructor(
    private readonly config: QqGatewayConfig,
    private readonly dispatch: MessageDispatcher,
  ) {
    this.api = new QqApiClient({
      appId: config.appId,
      appSecret: config.appSecret,
      ...(config.maxFileBytes ? { maxFileBytes: config.maxFileBytes } : {}),
    });
  }

  static fromConfig(config: CoworkerConfig, dispatch: MessageDispatcher): QqGatewayConnector | undefined {
    const qq = config.connectors.qq;
    if (!qq.enabled || qq.mode !== "gateway") return undefined;
    if (!qq.appId || !qq.appSecret) throw new Error("QQ gateway configuration is incomplete");
    return new QqGatewayConnector({
      appId: qq.appId,
      appSecret: qq.appSecret,
      maxFileBytes: config.attachments.maxOutboundBytes,
    }, dispatch);
  }

  async handle(_request: ConnectorRequest): Promise<ConnectorResponse | null> {
    return null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log("QQ gateway connecting...");
    void this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private async connect(): Promise<void> {
    try {
      const token = await this.api.getAccessToken();
      const response = await fetch("https://api.bot.qq.com/gateway", {
        headers: { authorization: `QQBot ${token}` },
      });
      const result = await response.json() as { url?: string; code?: number; message?: string };
      if (!response.ok || !result.url) throw new Error(`QQ gateway lookup failed: ${result.code ?? response.status} ${result.message ?? ""}`);

      const socket = new WebSocket(result.url);
      this.socket = socket;
      socket.addEventListener("message", (event) => {
        void this.handlePayload(token, String(event.data));
      });
      socket.addEventListener("close", () => {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.scheduleReconnect();
      });
      socket.addEventListener("error", (event) => {
        console.error("QQ gateway socket error", event);
      });
    } catch (error) {
      console.error("QQ gateway connect failed", error);
      this.scheduleReconnect();
    }
  }

  private async handlePayload(token: string, raw: string): Promise<void> {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw) as GatewayPayload;
    } catch {
      console.error("Invalid QQ gateway payload");
      return;
    }

    if (payload.op === 10) {
      const hello = payload.d as { heartbeat_interval?: number } | undefined;
      this.heartbeat = setInterval(() => {
        this.send({ op: 1, d: this.sequence ?? null });
      }, hello?.heartbeat_interval ?? 45_000);
      this.send(this.sessionId
        ? { op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.sequence ?? 0 } }
        : {
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: 1 << 25,
              shard: [0, 1],
              properties: { $os: "windows", $browser: "cowoker", $device: "cowoker" },
            },
          });
      return;
    }

    if (payload.op === 11) return;
    if (payload.op === 7) {
      this.socket?.close();
      return;
    }
    if (payload.op === 9) {
      this.sessionId = undefined;
      this.sequence = undefined;
      this.socket?.close();
      return;
    }
    if (payload.op !== 0) return;

    if (payload.s !== undefined) this.sequence = payload.s;
    if (payload.t === "READY") {
      const ready = payload.d as { session_id?: string } | undefined;
      if (ready?.session_id) this.sessionId = ready.session_id;
      this.reconnectAttempts = 0;
      console.log("QQ gateway connected");
      return;
    }

    if (payload.t === "C2C_MESSAGE_CREATE" || payload.t === "GROUP_AT_MESSAGE_CREATE") {
      const isGroup = payload.t === "GROUP_AT_MESSAGE_CREATE";
      const message = payload.d as QqGatewayMessage | undefined;
      if (!message?.id) return;
      const senderId = isGroup ? message.author?.member_openid : message.author?.user_openid;
      const chatId = isGroup ? message.group_openid : message.author?.user_openid;
      if (!senderId || !chatId) return;
      console.log(`QQ gateway event ${payload.t} sender=${senderId}`);
      const target = { isGroup, chatId, messageId: message.id };
      const attachments = (message.attachments ?? []).flatMap((attachment) => {
        if (!attachment.url) return [];
        return [{
          url: attachment.url,
          kind: attachmentKind(attachment.content_type),
          ...(attachment.filename ? { filename: attachment.filename } : {}),
          ...(attachment.content_type ? { contentType: attachment.content_type } : {}),
          ...(attachment.size ? { size: attachment.size } : {}),
        }];
      });

      await this.dispatch({
        platform: "qq",
        messageId: message.id,
        senderId,
        chatId,
        chatType: isGroup ? "group" : "direct",
        text: message.content ?? "",
        timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
        ...(attachments.length ? { attachments } : {}),
        reply: (text) => this.api.sendText(target, text),
        sendFile: (file) => this.api.sendFile(target, file),
      });
    }
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }
}


