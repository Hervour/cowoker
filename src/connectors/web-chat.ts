import { timingSafeEqual } from "node:crypto";
import type { Connector, ConnectorRequest, ConnectorResponse, MessageDispatcher } from "../types.js";

interface ChatEvent {
  id: number;
  text: string;
  timestamp: string;
}

interface ClientQueue {
  nextId: number;
  events: ChatEvent[];
  updatedAt: number;
}

export class WebChatHub {
  private readonly clients = new Map<string, ClientQueue>();

  publish(clientId: string, text: string): void {
    const queue = this.get(clientId);
    queue.events.push({ id: queue.nextId++, text, timestamp: new Date().toISOString() });
    if (queue.events.length > 500) queue.events.splice(0, queue.events.length - 500);
    queue.updatedAt = Date.now();
    this.prune();
  }

  poll(clientId: string, after: number): ChatEvent[] {
    const queue = this.get(clientId);
    queue.updatedAt = Date.now();
    this.prune();
    return queue.events.filter((event) => event.id > after);
  }

  private get(clientId: string): ClientQueue {
    let queue = this.clients.get(clientId);
    if (!queue) {
      queue = { nextId: 1, events: [], updatedAt: Date.now() };
      this.clients.set(clientId, queue);
    }
    return queue;
  }

  private prune(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
    for (const [clientId, queue] of this.clients) {
      if (queue.updatedAt < cutoff) this.clients.delete(clientId);
    }
  }
}

function secureTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>cowoker chat</title>
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #0c1016; color: #e9eef7; }
    .app { max-width: 900px; height: 100vh; margin: 0 auto; display: grid; grid-template-rows: auto 1fr auto; }
    header { padding: 14px 18px; border-bottom: 1px solid #253044; display: flex; gap: 12px; align-items: center; }
    header strong { font-size: 18px; margin-right: auto; }
    input, button, textarea { font: inherit; }
    input, textarea { background: #111823; color: #e9eef7; border: 1px solid #2c3a50; border-radius: 10px; outline: none; }
    input:focus, textarea:focus { border-color: #4d8cff; }
    #token { width: 190px; padding: 8px 10px; }
    #messages { overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 82%; padding: 11px 13px; border-radius: 14px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
    .user { align-self: flex-end; background: #245fd3; }
    .bot { align-self: flex-start; background: #1b2431; border: 1px solid #29364a; }
    .status { text-align: center; color: #8390a5; font-size: 12px; }
    footer { padding: 14px 18px 18px; border-top: 1px solid #253044; display: grid; grid-template-columns: 1fr auto; gap: 10px; }
    textarea { resize: none; min-height: 52px; max-height: 180px; padding: 12px; }
    button { border: 0; border-radius: 10px; padding: 0 20px; background: #3478f6; color: white; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    @media (max-width: 640px) { #token { width: 120px; } .msg { max-width: 92%; } }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <strong>cowoker</strong>
      <input id="token" type="password" placeholder="Web token" autocomplete="off">
    </header>
    <main id="messages"><div class="status">发送 /whoami、/ask 或 /code 开始</div></main>
    <footer>
      <textarea id="input" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
      <button id="send">发送</button>
    </footer>
  </div>
  <script>
    const tokenEl = document.querySelector('#token');
    const messagesEl = document.querySelector('#messages');
    const inputEl = document.querySelector('#input');
    const sendEl = document.querySelector('#send');
    let clientId = localStorage.getItem('cowoker.clientId');
    if (!clientId) { clientId = crypto.randomUUID(); localStorage.setItem('cowoker.clientId', clientId); }
    tokenEl.value = localStorage.getItem('cowoker.webToken') || '';
    let after = 0;

    function addMessage(text, className) {
      const div = document.createElement('div');
      div.className = 'msg ' + className;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function sendMessage() {
      const text = inputEl.value.trim();
      if (!text) return;
      const token = tokenEl.value.trim();
      localStorage.setItem('cowoker.webToken', token);
      addMessage(text, 'user');
      inputEl.value = '';
      sendEl.disabled = true;
      try {
        const response = await fetch('/api/chat/message', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
          body: JSON.stringify({ clientId, text })
        });
        if (!response.ok) addMessage(await response.text(), 'bot');
      } catch (error) {
        addMessage('发送失败：' + error.message, 'bot');
      } finally {
        sendEl.disabled = false;
        inputEl.focus();
      }
    }

    async function poll() {
      const token = tokenEl.value.trim();
      try {
        const url = '/api/chat/poll?clientId=' + encodeURIComponent(clientId) + '&after=' + after + '&token=' + encodeURIComponent(token);
        const response = await fetch(url);
        if (response.status === 401) { setTimeout(poll, 1500); return; }
        if (!response.ok) { setTimeout(poll, 1500); return; }
        const payload = await response.json();
        for (const event of payload.events || []) {
          after = Math.max(after, event.id);
          addMessage(event.text, 'bot');
        }
      } catch {}
      setTimeout(poll, 750);
    }

    sendEl.addEventListener('click', sendMessage);
    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
    });
    tokenEl.addEventListener('change', () => localStorage.setItem('cowoker.webToken', tokenEl.value.trim()));
    poll();
  </script>
</body>
</html>`;
}

export class WebChatConnector implements Connector {
  readonly name = "web" as const;
  private readonly hub = new WebChatHub();

  constructor(
    private readonly dispatch: MessageDispatcher,
    private readonly token?: string,
  ) {}

  async handle(request: ConnectorRequest): Promise<ConnectorResponse | null> {
    if (!request.pathname.startsWith("/chat") && !request.pathname.startsWith("/api/chat/")) return null;

    if (request.pathname === "/chat" || request.pathname === "/chat/") {
      if (request.method !== "GET") return { status: 405, body: "Method Not Allowed" };
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        body: pageHtml(),
      };
    }

    if (!this.authorized(request)) return { status: 401, body: "Unauthorized" };

    if (request.pathname === "/api/chat/poll") {
      if (request.method !== "GET") return { status: 405, body: "Method Not Allowed" };
      const clientId = request.query.get("clientId") ?? "";
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(clientId)) return { status: 400, body: "Invalid clientId" };
      const after = Math.max(0, Number.parseInt(request.query.get("after") ?? "0", 10) || 0);
      return {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        body: JSON.stringify({ events: this.hub.poll(clientId, after) }),
      };
    }

    if (request.pathname === "/api/chat/message") {
      if (request.method !== "POST") return { status: 405, body: "Method Not Allowed" };
      let body: { clientId?: string; text?: string };
      try {
        body = JSON.parse(request.rawBody.toString("utf8")) as { clientId?: string; text?: string };
      } catch {
        return { status: 400, body: "Invalid JSON" };
      }
      const clientId = body.clientId ?? "";
      const text = body.text ?? "";
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(clientId)) return { status: 400, body: "Invalid clientId" };
      if (!text.trim()) return { status: 400, body: "text is required" };
      await this.dispatch({
        platform: "web",
        messageId: crypto.randomUUID(),
        senderId: "web-user",
        chatId: "web-user",
        chatType: "direct",
        text,
        timestamp: new Date(),
        reply: async (replyText) => this.hub.publish(clientId, replyText),
      });
      return {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        body: JSON.stringify({ ok: true }),
      };
    }

    return { status: 404, body: "Not Found" };
  }

  private authorized(request: ConnectorRequest): boolean {
    if (!this.token) return true;
    const authorization = request.headers.authorization ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const candidate = bearer || request.query.get("token") || "";
    return secureTokenEqual(candidate, this.token);
  }
}

export { pageHtml as webChatPageHtml, escapeHtml as escapeWebChatHtml };
