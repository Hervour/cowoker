# cowoker

cowoker 是一个把官方社交机器人入口接到本机 Codex 的远程控制服务。它把 QQ 官方机器人、企业微信自建应用和本地开发 Webhook 统一归一化成消息事件，再通过 Codex SDK 或 Codex app-server 驱动本机 Codex 会话。

目标不是复制 Codex，而是做一层安全、可审计、可替换的连接器和管理层：

```text
QQ 官方机器人 ─┐
企业微信自建应用 ─┼─> cowoker connectors -> 权限/命令路由 -> Codex SDK / app-server -> 项目沙箱
本地开发 Webhook ─┘
```

## 为什么不是“个人微信自动化”

个人微信没有面向第三方稳定开放的机器人协议。基于注入、Hook 或模拟点击的方案容易被封号，也不适合承载可修改代码的高权限工具。cowoker 只实现：

- QQ 官方机器人开放平台；
- 企业微信自建应用的加密回调与消息 API；
- 本机开发 Webhook。

微信公众号如需接入，应使用官方服务器回调和服务号消息接口，而不是复用个人微信。

## 当前能力

- 每个私聊/群聊绑定独立 Codex thread，并在下一轮继续上下文。
- 会话、thread 后端和运行状态持久化到 `data/sessions.json`。
- `sdk` 后端使用官方 `@openai/codex-sdk`，默认只读、无交互审批。
- `app-server` 后端支持聊天内审批：`/approve`、`/deny`，以及 `acceptForSession`。
- 每个会话任务串行执行，超过全局并发上限时进入队列。
- 可配置计划、命令和文件修改进度回传。
- Webhook 事件幂等，平台重复推送不会重复触发 Codex。
- 运行日志写入 `data/runs.jsonl`，包含耗时、thread、usage、结果摘要和错误。
- 用户、会话、管理员三级白名单。
- 默认只读；只有管理员可执行 `/code` 写入项目。
- 不开放 `danger-full-access`。
- 支持长回复分片、取消、超时和运行审计。
- QQ 使用官方 Ed25519 验签；企业微信和微信公众号使用 AES-256-CBC 加解密与 SHA-1 验签。

## 执行后端

### `sdk`

适用于不需要人工审批的自动化任务：

- 基于官方 `codex exec --json` 封装；
- 启动快、依赖少；
- 强制 `approvalPolicy = never`；
- 如果需要额外权限，Codex 只能失败，不会阻塞等待聊天审批。

### `app-server`

适用于需要写入、网络或审批的远程任务：

- 通过 `codex app-server --listen stdio://` 提供 JSON-RPC；
- 支持命令执行、文件修改和权限扩展审批；
- 聊天收到审批编号后，用户回复：
  - `/approve <编号> once`
  - `/approve <编号> session`
  - `/deny <编号>`
- app-server 仍属于 Codex 的实验性接口，生产部署应固定 Codex 版本并做回归测试。

## 快速开始

要求 Node.js 20 或更高版本，并且本机 Codex 已完成登录。

```bash
npm install
copy cowoker.config.example.json cowoker.config.json
copy .env.example .env
npm run build
npm start
```

服务默认只监听 `127.0.0.1:8787`。健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

开发入口模拟一条消息：

```bash
curl -X POST http://127.0.0.1:8787/dev/message ^
  -H "Authorization: Bearer dev-token" ^
  -H "Content-Type: application/json" ^
  -d "{\"userId\":\"dev-user\",\"text\":\"/ask 简要列出当前项目结构\",\"wait\":true}"
```

该请求会真实调用 Codex，并消耗账号额度。

## 消息命令

| 命令 | 作用 |
| --- | --- |
| 普通消息 | 使用会话当前模式执行 Codex |
| `/ask <任务>` | 只读分析，允许所有授权用户 |
| `/code <任务>` | 允许修改项目，仅管理员 |
| `/new` | 清空 Codex thread，保留项目与模式 |
| `/use <项目>` | 切换项目并新建 thread |
| `/projects` | 查看允许的项目和后端类型 |
| `/status` | 查看线程、后端、队列、审批和运行状态 |
| `/cancel` | 取消当前任务并清空该会话队列 |
| /approve <编号> [once|session] | 批准一次或本轮审批 |
| /send <项目内文件> | 把电脑上的文件发送到当前聊天 |
| `/deny <编号>` | 拒绝审批 |
| `/whoami` | 查看平台 ID、会话 ID 和权限 |
| `/help` | 查看帮助 |

群聊里只有被提及的 QQ 事件会进入 cowoker。会话键是 `platform + chatId`，因此群聊共享同一个 Codex thread；需要隔离时应按用户建群或扩展会话键策略。

## 接入个人微信：先用公众号测试号

这里必须区分四个字段：

| 字段 | 含义 | 你从哪里得到 |
| --- | --- | --- |
| `URL` | 腾讯服务器访问**你的 cowoker** 的回调地址 | 你的公网 HTTPS 地址，不是厂商 API |
| `Token` | 回调签名用的共享密钥，不是 API Key | **你自己生成**，公众号后台和 cowoker 填同一个值 |
| `EncodingAESKey` | 消息加密密钥 | 公众号后台生成，或自行生成 43 字符密钥 |
| `AppID` / `AppSecret` | 调用微信消息 API 的凭证 | 公众号测试号页面提供 |

`Token` 可以用：

```bash
openssl rand -hex 24
```

代码里对应：

```json
{
  "connectors": {
    "wechatMp": {
      "enabled": true,
      "appId": "${WECHAT_MP_APP_ID}",
      "appSecret": "${WECHAT_MP_APP_SECRET}",
      "token": "${WECHAT_MP_TOKEN}",
      "encodingAesKey": "${WECHAT_MP_ENCODING_AES_KEY}"
    }
  }
}
```

接入步骤：

1. 登录微信公众号测试号。
2. 把 `AppID`、`AppSecret`、`Token`、`EncodingAESKey` 放进 `.env`。
3. 启动 cowoker：`npm start`。
4. 通过 Cloudflare Tunnel 或 ngrok 暴露本地 `8787` 端口，得到公网 HTTPS 地址。
5. 在公众号测试号的接口配置中填写：`https://隧道域名/webhooks/wechat-mp`。
6. 用你的个人微信关注测试号，发送 `/whoami`。
7. 第一次会返回你的 OpenID。把该 OpenID 加入 `allowedUsers`、`allowedChats` 和 `admins` 后再测试。

没有公网 HTTPS 时，必须先建立隧道。QQ、企业微信和微信公众号都不会访问 `localhost` 或你的局域网地址。开发阶段免费临时隧道足够；正式运行再考虑域名、VPS 和固定 HTTPS。
## 接入 QQ 官方机器人：WebSocket 模式

远程控制电脑时推荐使用 WebSocket 网关模式。电脑主动连接 QQ，不需要公网 IP、域名、Cloudflare 或 Webhook。

1. 在 QQ 开放平台创建机器人，取得 `AppID` 和 `AppSecret`。
2. 在 `.env` 中填写：
   ```env
   QQ_BOT_APP_ID=...
   QQ_BOT_APP_SECRET=...
   ```
3. 在 `cowoker.config.json` 中设置：
   ```json
   {
     "connectors": {
       "qq": {
         "enabled": true,
         "mode": "gateway",
         "appId": "${QQ_BOT_APP_ID}",
         "appSecret": "${QQ_BOT_APP_SECRET}"
       }
     }
   }
   ```
4. 把 QQ `user_openid` 或 `group_openid` 加入 `allowedUsers`、`allowedChats` 和管理员列表。
5. 启动 cowoker。它会连接 `wss://api.bot.qq.com/websocket/`，断线自动重连。

如果仍然使用 Webhook 模式，则把 `mode` 设为 `"webhook"`，并配置 `/webhooks/qq` 公网回调。

### QQ 文件传输

支持双向文件：

- 手机 QQ 发给机器人：cowoker 下载附件到项目 `.cowoker-inbox/`，并把文件路径附加给 Codex。
- 电脑发给手机 QQ：
  ```text
  /send path/to/file.pdf
  ```
  cowoker 上传文件并发送 QQ 文件卡片。

文件能力受 QQ 平台限制：

- 单文件硬限制 200 MB；
- 文件类型 4 的软限制也是 200 MB；
- 图片、视频、语音和普通文件的每日容量、主动消息配额由 QQ 控制；
- 单聊和群聊上传接口相互隔离；
- 附件下载默认只允许 `qq.com` 和 `qq.com.cn` 域名。
## 接入企业微信

1. 在企业微信管理后台创建自建应用，取得 `CorpID`、`AgentID`、应用 `Secret`。
2. 配置回调 URL：`https://你的域名/webhooks/wecom`。
3. 保存后台生成的 `Token` 和 `EncodingAESKey`。
4. 启用 `connectors.wecom`，凭证只放在 `.env`。
5. 把企业微信成员 `UserID` 放入 `allowedUsers`、`allowedChats` 和管理员列表。

企业微信回调会立即返回成功，Codex 的实际结果和审批请求通过应用消息发送。

## 安全模型

- 不暴露 `danger-full-access`。
- `/code` 只允许管理员，审批默认按聊天会话隔离。
- 项目和网络访问在配置里显式声明，消息正文不能指定任意目录。
- 平台验签必须保持开启；开发入口只允许绑定 loopback。
- 幂等记录、会话和运行日志都落在 `data/`，不应提交到 Git。
- 服务不应直接暴露到公网。使用 Caddy、Nginx 或 Cloudflare Tunnel 终止 TLS。

## 当前限制

- app-server 是实验接口，字段可能随 Codex 版本变化。
- 文件通过 QQ 官方富媒体接口传输，受平台大小、容量和权限限制。
- 群聊共享线程，尚未实现“群内每个用户独立会话”。
- JSON 快照适合单进程部署，尚未切换 SQLite。
- QQ 超长任务仍受被动回复窗口限制。

## 开发

```bash
npm run typecheck
npm test
npm run build
```

当前测试覆盖：

- QQ 官方 Ed25519 验证向量；
- 企业微信加解密和签名；
- app-server JSON-RPC、审批请求和完成事件；
- 远程审批命令进入执行器；
- Webhook 幂等和会话持久化；
- 命令解析。

## Codex 官方参考

- [Codex SDK](https://developers.openai.com/codex/sdk)
- [Codex 非交互模式](https://developers.openai.com/codex/noninteractive)
- [Codex app-server](https://developers.openai.com/codex/app-server)



