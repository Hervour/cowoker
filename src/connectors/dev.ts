import type { Connector, ConnectorRequest, ConnectorResponse, MessageDispatcher, Platform } from "../types.js";

interface DevMessageBody {
  userId?: string;
  chatId?: string;
  chatType?: "direct" | "group";
  text?: string;
  messageId?: string;
  wait?: boolean;
}

export class DevConnector implements Connector {
  readonly name = "dev" as const;

  constructor(
    private readonly dispatch: MessageDispatcher,
    private readonly token?: string,
    private readonly waitForIdle?: (platform: Platform, chatId: string) => Promise<void>,
  ) {}

  async handle(request: ConnectorRequest): Promise<ConnectorResponse | null> {
    if (request.pathname !== "/dev/message") return null;
    if (request.method !== "POST") return { status: 405, body: "Method Not Allowed" };
    if (this.token && request.headers.authorization !== `Bearer ${this.token}`) {
      return { status: 401, body: "Unauthorized" };
    }

    let body: DevMessageBody;
    try {
      body = JSON.parse(request.rawBody.toString("utf8")) as DevMessageBody;
    } catch {
      return { status: 400, body: "Invalid JSON" };
    }
    if (!body.text) return { status: 400, body: "text is required" };

    const replies: string[] = [];
    const userId = body.userId ?? "dev-user";
    const chatId = body.chatId ?? userId;
    await this.dispatch({
      platform: "dev",
      messageId: body.messageId ?? crypto.randomUUID(),
      senderId: userId,
      chatId,
      chatType: body.chatType ?? "direct",
      text: body.text,
      timestamp: new Date(),
      reply: async (text) => {
        replies.push(text);
      },
    });
    if (body.wait) await this.waitForIdle?.("dev", chatId);

    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ replies }),
    };
  }
}
