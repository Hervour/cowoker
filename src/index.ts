import path from "node:path";
import { loadConfig } from "./config.js";
import { DevConnector } from "./connectors/dev.js";
import { QqConnector } from "./connectors/qq.js";
import { QqGatewayConnector } from "./connectors/qq-gateway.js";
import { WecomConnector } from "./connectors/wecom.js";
import { WechatMpConnector } from "./connectors/wechat-mp.js";
import { WebChatConnector } from "./connectors/web-chat.js";
import { MessageDeduplicator } from "./core/message-deduplicator.js";
import { CoworkerService } from "./core/service.js";
import { SessionStore } from "./core/session-store.js";
import { createCoworkerServer, listen } from "./server.js";
import type { Connector, InboundMessage } from "./types.js";

const config = loadConfig();
const sessions = new SessionStore(path.resolve(config.sessionStorePath));
const events = new MessageDeduplicator(path.resolve(config.eventStorePath));
await Promise.all([sessions.load(), events.load()]);

const service = new CoworkerService(config, sessions);
const dispatch = async (message: InboundMessage) => {
  if (!(await events.claim(message.platform, message.messageId))) {
    console.log(`ignored duplicate event ${message.platform}:${message.messageId}`);
    return;
  }
  await service.dispatch(message);
};

const connectors: Connector[] = [];
if (config.connectors.dev.enabled) {
  connectors.push(new DevConnector(dispatch, config.connectors.dev.token, (platform, chatId) => service.waitForIdle(platform, chatId)));
}
if (config.connectors.web.enabled) {
  connectors.push(new WebChatConnector(dispatch, config.connectors.web.token));
}
const wecom = WecomConnector.fromConfig(config, dispatch);
if (wecom) connectors.push(wecom);
const wechatMp = WechatMpConnector.fromConfig(config, dispatch);
if (wechatMp) connectors.push(wechatMp);
const qqGateway = QqGatewayConnector.fromConfig(config, dispatch);
if (qqGateway) connectors.push(qqGateway);
const qq = QqConnector.fromConfig(config, dispatch);
if (qq) connectors.push(qq);

const server = createCoworkerServer(config, connectors);
await listen(server, config.server.host, config.server.port);
console.log(`cowoker listening on http://${config.server.host}:${config.server.port}`);
console.log(`connectors: ${connectors.map((connector) => connector.name).join(", ") || "none"}`);
qqGateway?.start();

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  qqGateway?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([service.flush(), events.flush()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));




