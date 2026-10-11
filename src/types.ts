export type Platform = "dev" | "web" | "qq" | "wecom" | "wechat-mp";
export type ChatType = "direct" | "group";
export type RunMode = "read-only" | "workspace-write";
export type ExecutionBackend = "sdk" | "app-server";
export type AttachmentKind = "image" | "video" | "audio" | "file" | "other";

export interface InboundAttachment {
  url: string;
  kind: AttachmentKind;
  filename?: string;
  contentType?: string;
  size?: number;
}

export interface OutboundFile {
  path: string;
  filename?: string;
  caption?: string;
}

export interface InboundMessage {
  platform: Platform;
  messageId: string;
  senderId: string;
  chatId: string;
  chatType: ChatType;
  text: string;
  timestamp: Date;
  attachments?: InboundAttachment[];
  reply: (text: string) => Promise<void>;
  sendFile?: (file: OutboundFile) => Promise<void>;
}

export interface ConnectorRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  rawBody: Buffer;
}

export interface ConnectorResponse {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
  afterSend?: () => void;
}

export interface Connector {
  readonly name: Platform;
  handle(request: ConnectorRequest): Promise<ConnectorResponse | null>;
}

export type MessageDispatcher = (message: InboundMessage) => Promise<void>;

export interface SessionRecord {
  conversationId: string;
  platform: Platform;
  chatId: string;
  projectAlias: string;
  mode: RunMode;
  threadId?: string;
  threadBackend?: ExecutionBackend;
  turns: number;
  updatedAt: string;
}
