import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProjectConfig } from "../config.js";
import { resolveCodexBinary } from "../platform/codex-binary.js";
import type { RunMode } from "../types.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  CodexExecutor,
  CodexRunInput,
  CodexRunResult,
  RunProgressEvent,
} from "./executor.js";

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

interface AppServerCommand {
  bin: string;
  args: string[];
}

interface TurnCompletion {
  status: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function compactText(value: string, maxLength = 350): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

class AppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;
  private notificationHandler?: (message: JsonRpcMessage) => void;
  private serverRequestHandler?: (message: JsonRpcMessage) => Promise<unknown>;

  constructor(command: AppServerCommand) {
    this.child = spawn(command.bin, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-16_000);
    });
    this.child.on("error", (error) => this.closeWithError(error));
    this.child.on("exit", (code, signal) => {
      const detail = compactText(this.stderrBuffer.trim(), 1_000);
      this.closeWithError(new Error(`Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})${detail ? `: ${detail}` : ""}`));
    });
  }

  onNotification(handler: (message: JsonRpcMessage) => void): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: (message: JsonRpcMessage) => Promise<unknown>): void {
    this.serverRequestHandler = handler;
  }

  async request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) throw new Error("Codex app-server is closed");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Codex app-server request timed out: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      this.write({ method, id, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server connection closed"));
    }
    this.pending.clear();
    this.child.kill();
  }

  private write(message: unknown): void {
    if (this.closed || !this.child.stdin.writable) throw new Error("Codex app-server stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line) as JsonRpcMessage);
      } catch (error) {
        this.closeWithError(new Error(`Invalid app-server JSONL: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = Number.isFinite(id) ? this.pending.get(id) : undefined;
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message);
      return;
    }

    this.notificationHandler?.(message);
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    if (message.id === undefined) return;
    try {
      const result = this.serverRequestHandler ? await this.serverRequestHandler(message) : undefined;
      this.respond(message.id, result ?? {});
    } catch (error) {
      this.respondError(message.id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  private closeWithError(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function sandboxFor(project: ProjectConfig, mode: RunMode): unknown {
  if (mode === "read-only") return { type: "readOnly", networkAccess: project.networkAccess };
  return {
    type: "workspaceWrite",
    writableRoots: [project.path],
    networkAccess: project.networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function approvalRequestFor(message: JsonRpcMessage): ApprovalRequest | undefined {
  const params = isRecord(message.params) ? message.params : {};
  if (message.method === "item/commandExecution/requestApproval") {
    const command = stringValue(params, "command");
    const cwd = stringValue(params, "cwd");
    const reason = stringValue(params, "reason");
    return {
      kind: "command",
      title: "Codex 请求执行命令",
      details: command ?? reason ?? "需要额外执行权限",
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  if (message.method === "item/fileChange/requestApproval") {
    const reason = stringValue(params, "reason");
    return {
      kind: "file-change",
      title: "Codex 请求修改文件",
      details: reason ?? "需要工作区外写入权限",
      ...(reason ? { reason } : {}),
    };
  }
  if (message.method === "item/permissions/requestApproval") {
    const reason = stringValue(params, "reason");
    return {
      kind: "permissions",
      title: "Codex 请求扩展权限",
      details: reason ?? "请求网络或文件系统额外权限",
      ...(reason ? { reason } : {}),
    };
  }
  return undefined;
}

export class AppServerRunner implements CodexExecutor {
  constructor(
    private readonly command: AppServerCommand = {
      bin: resolveCodexBinary() ?? "codex",
      args: ["app-server", "--listen", "stdio://"],
    },
  ) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    if (input.signal.aborted) throw input.signal.reason ?? new Error("Run cancelled");
    const connection = new AppServerConnection(this.command);
    let turnId: string | undefined;
    let threadId: string | undefined;
    let finalResponse = "";
    let streamedResponse = "";
    let completion: TurnCompletion | undefined;
    let resolveCompletion: (value: TurnCompletion) => void = () => undefined;
    const completed = new Promise<TurnCompletion>((resolve) => {
      resolveCompletion = resolve;
    });

    const emitProgress = (event: RunProgressEvent) => input.onProgress?.(event);
    connection.onNotification((message) => {
      const params = isRecord(message.params) ? message.params : {};
      const eventTurnId = stringValue(params, "turnId");
      if (turnId && eventTurnId && eventTurnId !== turnId) return;

      if (message.method === "item/agentMessage/delta") {
        streamedResponse += stringValue(params, "delta") ?? "";
        return;
      }
      if (message.method === "item/started") {
        const item = nestedRecord(params, "item");
        const itemType = item ? stringValue(item, "type") : undefined;
        if (itemType === "commandExecution") {
          emitProgress({ kind: "command", text: stringValue(item ?? {}, "command") ?? "执行命令" });
        } else if (itemType === "fileChange") {
          const changes = item?.changes;
          const count = Array.isArray(changes) ? changes.length : 0;
          emitProgress({ kind: "file", text: `准备修改 ${count} 个文件` });
        }
        return;
      }
      if (message.method === "turn/plan/updated") {
        const plan = params.plan;
        if (Array.isArray(plan)) {
          const text = plan
            .map((entry) => (isRecord(entry) ? stringValue(entry, "step") : undefined))
            .filter((entry): entry is string => Boolean(entry))
            .join("；");
          if (text) emitProgress({ kind: "plan", text });
        }
        return;
      }
      if (message.method === "item/completed") {
        const item = nestedRecord(params, "item");
        if (item && stringValue(item, "type") === "agentMessage") {
          const text = stringValue(item, "text");
          if (text) finalResponse = text;
        }
        return;
      }
      if (message.method === "turn/completed") {
        const turn = nestedRecord(params, "turn");
        const status = turn ? stringValue(turn, "status") : undefined;
        const errorRecord = turn ? nestedRecord(turn, "error") : undefined;
        const error = errorRecord ? stringValue(errorRecord, "message") : undefined;
        completion = { status: status ?? "failed", ...(error ? { error } : {}) };
        resolveCompletion(completion);
      }
    });

    connection.onServerRequest(async (message) => {
      if (message.method === "item/commandExecution/requestApproval") {
        const request = approvalRequestFor(message);
        const decision = request && input.onApproval ? await input.onApproval(request) : "decline";
        return { decision: decision ?? "decline" };
      }
      if (message.method === "item/fileChange/requestApproval") {
        const request = approvalRequestFor(message);
        const decision = request && input.onApproval ? await input.onApproval(request) : "decline";
        return { decision: decision === "acceptForSession" ? "acceptForSession" : decision };
      }
      if (message.method === "item/permissions/requestApproval") {
        const request = approvalRequestFor(message);
        const decision = request && input.onApproval ? await input.onApproval(request) : "decline";
        if (decision !== "accept" && decision !== "acceptForSession") {
          return { permissions: {}, scope: "turn" };
        }
        const params = isRecord(message.params) ? message.params : {};
        const permissions = isRecord(params.permissions) ? params.permissions : {};
        return {
          permissions: {
            ...(permissions.network !== undefined ? { network: permissions.network } : {}),
            ...(permissions.fileSystem !== undefined ? { fileSystem: permissions.fileSystem } : {}),
          },
          scope: decision === "acceptForSession" ? "session" : "turn",
        };
      }
      if (message.method === "item/tool/requestUserInput") {
        emitProgress({ kind: "status", text: "Codex 请求交互输入；cowoker 当前无法在非交互模式中回答。" });
        return { answers: {} };
      }
      if (message.method === "mcpServer/elicitation/request") {
        return { action: "decline", content: null, _meta: null };
      }
      throw new Error(`Unsupported app-server request: ${message.method ?? "unknown"}`);
    });

    try {
      await connection.request("initialize", {
        clientInfo: { name: "cowoker", title: "cowoker", version: "0.1.0" },
        capabilities: null,
      });
      connection.notify("initialized", {});

      const common = {
        cwd: input.project.path,
        approvalPolicy: input.project.approvalPolicy,
        approvalsReviewer: "user",
        sandbox: input.mode,
        ...(input.project.model ? { model: input.project.model } : {}),
        serviceName: "cowoker",
      };
      const threadResponse = input.threadId
        ? await connection.request("thread/resume", { threadId: input.threadId, ...common, serviceName: undefined })
        : await connection.request("thread/start", common);
      const threadRecord = nestedRecord(isRecord(threadResponse) ? threadResponse : {}, "thread");
      threadId = threadRecord ? stringValue(threadRecord, "id") : undefined;
      if (!threadId) throw new Error("Codex app-server did not return a thread id");
      input.onThreadId(threadId);

      const turnResponse = await connection.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: input.project.path,
        approvalPolicy: input.project.approvalPolicy,
        approvalsReviewer: "user",
        sandboxPolicy: sandboxFor(input.project, input.mode),
        ...(input.project.model ? { model: input.project.model } : {}),
        ...(input.project.reasoningEffort ? { effort: input.project.reasoningEffort } : {}),
      });
      const turnRecord = nestedRecord(isRecord(turnResponse) ? turnResponse : {}, "turn");
      turnId = turnRecord ? stringValue(turnRecord, "id") : undefined;
      if (!turnId) throw new Error("Codex app-server did not return a turn id");

      const abortHandler = () => {
        void connection.request("turn/interrupt", { threadId, turnId }, 10_000).catch(() => undefined);
      };
      input.signal.addEventListener("abort", abortHandler, { once: true });
      const aborted = new Promise<TurnCompletion>((_resolve, reject) => {
        const rejectAbort = () => reject(input.signal.reason ?? new Error("Run cancelled"));
        if (input.signal.aborted) rejectAbort();
        else input.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      completion = await Promise.race([completed, aborted]);
      input.signal.removeEventListener("abort", abortHandler);

      if (completion.status === "failed") throw new Error(completion.error ?? "Codex turn failed");
      if (completion.status === "interrupted") throw new Error("Codex turn interrupted");
      return {
        threadId,
        finalResponse: finalResponse || streamedResponse,
        usage: null,
      };
    } finally {
      connection.close();
    }
  }
}


