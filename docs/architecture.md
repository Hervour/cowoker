# Architecture

## Components

```text
QQ / WeCom / WeChat MP webhook
  -> Deduplication
  -> Connector
  -> InboundMessage
  -> Authorizer
  -> Command parser
  -> SessionStore + per-conversation queue
  -> CodexExecutor
     -> SDK backend: codex exec --json
     -> app-server backend: JSON-RPC, approvals, live events
  -> RunLog
```

### Connectors

Connectors own only platform-specific concerns:

- request signature verification;
- callback decryption;
- event-to-message normalization;
- outbound API calls;
- platform message chunk limits.

They never choose a project path, sandbox policy, model, or thread continuation rule.

### Deduplication

Every platform event is claimed by `MessageDeduplicator` before dispatch. The state stored in `data/events.json` prevents duplicate webhook deliveries from starting duplicate Codex turns.

### Session routing

A conversation key is `platform:chatId`. Each key maps to one persisted `SessionRecord`:

```json
{
  "conversationId": "uuid",
  "platform": "qq",
  "chatId": "OPENID",
  "projectAlias": "cowoker",
  "mode": "read-only",
  "threadId": "codex-thread-id",
  "threadBackend": "app-server",
  "turns": 2,
  "updatedAt": "ISO-8601"
}
```

Thread ids are scoped to their execution backend because SDK and app-server thread identifiers are not interchangeable.

### Queueing

Each conversation has a serial FIFO queue. The global `maxConcurrentRuns` limit is enforced across all conversations. `/cancel` aborts the active turn and clears that conversation's queue.

### Execution backends

#### SDK

The official TypeScript SDK wraps `codex exec --json`. It always uses `approvalPolicy: "never"` and is the default for read-only automation.

#### App-server

The app-server backend starts `codex app-server --listen stdio://` and speaks JSON-RPC 2.0 over stdio. It supports:

- `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`;
- `item/commandExecution/requestApproval`;
- `item/fileChange/requestApproval`;
- `item/permissions/requestApproval`;
- item, plan, diff and completion events.

When `codex.approvalsReviewer = "auto_review"`, the app-server routes eligible sandbox-boundary approval requests to a separate reviewer agent. The reviewer only decides whether to allow the requested escalation; it does not expand the sandbox or grant new permissions. Manual `/approve` and `/deny` remain the fallback path and expire after `approvalTimeoutMs`.

### Progress

`codex.progress` controls whether plan, command and file-change events are forwarded to the chat. Messages are throttled by `minIntervalMs` and capped by `maxMessagesPerRun`.

### Audit

`RunLog` appends started, completed, failed and cancelled records to `data/runs.jsonl`. Prompts and results are stored as bounded previews rather than full transcripts.

## Trust boundaries

1. **Platform -> HTTP server**: authenticity established by QQ Ed25519 or WeCom callback verification.
2. **Deduplication -> authorizer**: repeated event ids are ignored.
3. **HTTP server -> authorizer**: sender and chat must both be allowlisted.
4. **Authorizer -> command service**: write mode and approvals require platform admin.
5. **Command service -> Codex**: only configured project aliases and sandbox modes are accepted.
6. **Codex -> host**: Codex's filesystem sandbox is the final boundary.

There is no shell interpolation of remote text. Prompts are handed to SDK/app-server as data.

## Planned evolution

- Per-user conversation keys for group chats.
- Image, voice and file attachment download with size limits and malware scanning.
- SQLite for sessions, jobs and audit queries.
- Durable queue recovery after process restart.
- Active-message fallback for long-running QQ tasks.

