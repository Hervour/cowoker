import { stat } from "node:fs/promises";
import path from "node:path";
import type { CoworkerConfig, ProjectConfig } from "../config.js";
import { projectByAlias } from "../config.js";
import type { ExecutionBackend, InboundMessage, RunMode } from "../types.js";
import { AttachmentStore } from "./attachment-store.js";
import { AppServerRunner } from "./app-server-runner.js";
import { Authorizer } from "./authorizer.js";
import { CodexRunner } from "./codex-runner.js";
import { parseCommand } from "./command-parser.js";
import type { ApprovalDecision, ApprovalRequest, CodexExecutor, RunProgressEvent } from "./executor.js";
import { RunLog } from "./run-log.js";
import { SessionStore } from "./session-store.js";

interface ActiveRun {
  runId: string;
  conversationId: string;
  controller: AbortController;
  timeout: NodeJS.Timeout;
  startedAt: number;
  project: ProjectConfig;
  mode: RunMode;
  message: InboundMessage;
  threadId?: string;
  progressCount: number;
  lastProgressAt: number;
  lastProgressText: string;
}

interface PendingApproval {
  id: string;
  key: string;
  timer: NodeJS.Timeout;
  resolve: (decision: ApprovalDecision) => void;
}

interface QueuedRun {
  message: InboundMessage;
  prompt: string;
  mode: RunMode;
}

const helpText = [
  "cowoker 远程 Codex",
  "",
  "普通消息：按当前模式执行",
  "/ask <任务>：只读分析",
  "/code <任务>：允许修改项目文件（仅管理员）",
  "/send <项目内文件路径>：把电脑上的文件发回聊天",
  "/new：清空当前 Codex 会话",
  "/use <项目>：切换项目并新建会话",
  "/projects：列出项目",
  "/status：查看会话、队列和审批状态",
  "/cancel：取消当前任务并清空队列",
  "/approve <编号> [once|session]：批准一次或本轮",
  "/deny <编号>：拒绝审批",
  "/whoami：查看身份",
  "",
  "安全边界：远程任务始终受 Codex 沙箱约束；sdk 后端不支持交互审批，app-server 后端支持。",
].join("\n");

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 32))}\n\n[输出已截断 ${text.length - maxLength + 32} 字]`;
}

function replyChunks(text: string, maxChunk = 1_500): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChunk) {
    let splitAt = remaining.lastIndexOf("\n", maxChunk);
    if (splitAt < maxChunk / 2) splitAt = remaining.lastIndexOf(" ", maxChunk);
    if (splitAt < maxChunk / 2) splitAt = maxChunk;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function describeProject(project: ProjectConfig): string {
  const flags = [
    project.executionBackend,
    project.approvalPolicy === "never" ? "无审批" : `审批:${project.approvalPolicy}`,
    project.networkAccess ? "网络开" : "网络关",
    `搜索:${project.webSearch}`,
  ];
  return `${project.alias} -> ${project.path} (${flags.join(", ")})`;
}

function preview(text: string, maxLength = 300): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function defaultRunners(): Record<ExecutionBackend, CodexExecutor> {
  return {
    sdk: new CodexRunner(),
    "app-server": new AppServerRunner(),
  };
}

export class CoworkerService {
  private readonly authorizer: Authorizer;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly queues = new Map<string, QueuedRun[]>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly runners: Record<ExecutionBackend, CodexExecutor>;
  private readonly runLog: RunLog;

  constructor(
    private readonly config: CoworkerConfig,
    private readonly sessions: SessionStore,
    runners?: Record<ExecutionBackend, CodexExecutor>,
    runLog = new RunLog(config.runLogPath),
  ) {
    this.authorizer = new Authorizer(config);
    this.runners = runners ?? defaultRunners();
    this.runLog = runLog;
  }

  async dispatch(message: InboundMessage): Promise<void> {
    if (!this.authorizer.isAuthorized(message)) {
      await this.safeReply(message, `拒绝访问：${this.authorizer.denialReason(message)}`);
      return;
    }

    const text = message.text.trim();
    if (!text && !message.attachments?.length) return;
    if (text.length > this.config.codex.maxPromptChars) {
      await message.reply(`消息过长，最多 ${this.config.codex.maxPromptChars} 字。`);
      return;
    }

    const command = parseCommand(text);
    const adminOnlyCommands = new Set(["projects", "use", "new", "mode", "send"]);
    const operatorOnlyCommands = new Set(["cancel", "approval"]);
    if (adminOnlyCommands.has(command.kind) && !this.authorizer.isAdmin(message)) {
      await message.reply("该命令仅管理员可用。授权用户可以使用 /ask、/status 和 /whoami。");
      return;
    }
    try {
      switch (command.kind) {
        case "help":
          await message.reply(helpText);
          return;
        case "projects":
          await message.reply(this.projectsText(message));
          return;
        case "use":
          await this.switchProject(message, command.projectAlias);
          return;
        case "new":
          if (this.isConversationBusy(message)) {
            await message.reply("当前会话有任务运行或排队，请先 /cancel 再清空会话。");
            return;
          }
          this.sessions.update(message.platform, message.chatId, { threadId: null, threadBackend: null });
          await message.reply("已清空当前 Codex 会话。下一条任务会新建 thread。");
          return;
        case "status":
          await message.reply(this.statusText(message));
          return;
        case "cancel":
          await this.cancel(message);
          return;
        case "send":
          await this.handleSendFile(message, command.path, command.caption);
          return;
        case "approval":
          await this.handleApprovalCommand(message, command.approvalId, command.decision);
          return;
        case "mode":
          await this.setMode(message, command.mode);
          return;
        case "whoami":
          await message.reply(this.whoamiText(message));
          return;
        case "prompt": {
          const requestedMode = command.mode ?? this.session(message).mode;
          const mode = this.authorizeMode(message, requestedMode);
          await this.enqueueRun(message, command.prompt, mode);
          return;
        }
      }
    } catch (error) {
      await this.safeReply(message, `❌ ${this.errorMessage(error)}`);
    }
  }

  async waitForIdle(platform: InboundMessage["platform"], chatId: string, timeoutMs = 24 * 60 * 60 * 1_000): Promise<void> {
    const key = `${platform}:${chatId}`;
    const deadline = Date.now() + timeoutMs;
    while (this.activeRuns.has(key) || (this.queues.get(key)?.length ?? 0) > 0) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for conversation to become idle");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async flush(): Promise<void> {
    await Promise.all([this.sessions.flush(), this.runLog.flush()]);
  }

  private session(message: InboundMessage) {
    return this.sessions.getOrCreate(
      message.platform,
      message.chatId,
      this.config.defaultProject,
      this.config.codex.defaultMode,
    );
  }

  private authorizeMode(message: InboundMessage, mode: RunMode): RunMode {
    if (mode === "workspace-write" && !this.authorizer.isOperator(message)) {
      throw new Error("当前用户没有 /code 权限，请使用 /ask 或联系管理员加入 operators 白名单。");
    }
    return mode;
  }

  private projectForSession(message: InboundMessage): ProjectConfig {
    const session = this.session(message);
    const project = projectByAlias(this.config, session.projectAlias);
    if (!project) throw new Error(`项目不存在: ${session.projectAlias}`);
    return project;
  }

  private async switchProject(message: InboundMessage, alias: string): Promise<void> {
    if (this.isConversationBusy(message)) {
      await message.reply("当前会话有任务运行或排队，请先 /cancel 再切换项目。");
      return;
    }
    const normalized = alias.trim();
    const project = projectByAlias(this.config, normalized);
    if (!project) {
      await message.reply(`项目不存在：${normalized}\n\n${this.projectsText(message)}`);
      return;
    }
    this.session(message);
    this.sessions.update(message.platform, message.chatId, {
      projectAlias: project.alias,
      threadId: null,
      threadBackend: null,
    });
    await message.reply(`已切换到项目 ${project.alias}，并清空当前 Codex 会话。`);
  }

  private async setMode(message: InboundMessage, mode: RunMode): Promise<void> {
    if (this.isConversationBusy(message)) {
      await message.reply("当前会话有任务运行或排队，请先 /cancel 再切换模式。");
      return;
    }
    const authorizedMode = this.authorizeMode(message, mode);
    this.session(message);
    this.sessions.update(message.platform, message.chatId, { mode: authorizedMode });
    await message.reply(`当前模式已切换为 ${authorizedMode}。`);
  }

  private async cancel(message: InboundMessage): Promise<void> {
    const key = this.conversationKey(message);
    const active = this.activeRuns.get(key);
    const queued = this.queues.get(key) ?? [];
    this.queues.delete(key);
    this.cancelPendingApprovals(key, "cancel");
    if (!active) {
      await message.reply(queued.length ? `已清空 ${queued.length} 个排队任务。` : "当前没有正在执行的任务。");
      return;
    }
    active.controller.abort(new Error("Cancelled by remote user"));
    await message.reply(`已取消当前任务${queued.length ? `并清空 ${queued.length} 个排队任务` : ""}。`);
  }

  private async enqueueRun(message: InboundMessage, prompt: string, mode: RunMode): Promise<void> {
    const key = this.conversationKey(message);
    const project = this.projectForSession(message);
    if (this.activeRuns.has(key) || this.activeRuns.size >= this.config.codex.maxConcurrentRuns) {
      const queue = this.queues.get(key) ?? [];
      if (queue.length >= 16) {
        await message.reply("当前会话排队任务过多，请稍后重试。");
        return;
      }
      queue.push({ message, prompt, mode });
      this.queues.set(key, queue);
      await message.reply(`已加入队列，当前前方 ${queue.length - 1} 个任务。项目：${project.alias}`);
      return;
    }
    this.startRun(message, prompt, mode, project);
  }

  private startRun(message: InboundMessage, prompt: string, mode: RunMode, project?: ProjectConfig): void {
    const key = this.conversationKey(message);
    if (this.activeRuns.has(key) || this.activeRuns.size >= this.config.codex.maxConcurrentRuns) return;
    const selectedProject = project ?? this.projectForSession(message);
    const controller = new AbortController();
    const startedAt = Date.now();
    const runId = crypto.randomUUID();
    const timeout = setTimeout(() => controller.abort(new Error("Remote run timed out")), this.config.codex.runTimeoutMs);
    const active: ActiveRun = {
      runId,
      conversationId: this.session(message).conversationId,
      controller,
      timeout,
      startedAt,
      project: selectedProject,
      mode,
      message,
      progressCount: 0,
      lastProgressAt: 0,
      lastProgressText: "",
    };
    this.activeRuns.set(key, active);
    void this.executeRun(key, active, prompt);
  }

  private async executeRun(key: string, active: ActiveRun, prompt: string): Promise<void> {
    const { message, project, mode } = active;
    const session = this.session(message);
    const backend = project.executionBackend;
    const threadId = session.threadId && (session.threadBackend ?? "sdk") === backend ? session.threadId : undefined;
    if (threadId) active.threadId = threadId;
    else delete active.threadId;
    this.runLog.append({
      timestamp: new Date().toISOString(),
      runId: active.runId,
      event: "started",
      conversationId: session.conversationId,
      platform: message.platform,
      chatId: message.chatId,
      projectAlias: project.alias,
      backend,
      mode,
      promptPreview: preview(prompt),
      ...(threadId ? { threadId } : {}),
    });

    await this.safeReply(message, `已接收 ${active.runId.slice(0, 8)}：${project.alias} · ${mode} · ${backend}`);
    const effectivePrompt = await this.promptWithAttachments(active.message, prompt, project);
    try {
      const result = await this.runners[backend].run({
        project,
        mode,
        prompt: effectivePrompt,
        ...(threadId ? { threadId } : {}),
        signal: active.controller.signal,
        onThreadId: (newThreadId) => {
          active.threadId = newThreadId;
          this.sessions.update(message.platform, message.chatId, {
            threadId: newThreadId,
            threadBackend: backend,
          });
        },
        onProgress: (event) => this.reportProgress(active, event),
        onApproval: (request) => this.requestApproval(key, active, request),
      });
      this.sessions.update(message.platform, message.chatId, {
        threadId: result.threadId,
        threadBackend: backend,
        incrementTurns: true,
      });
      this.runLog.append({
        timestamp: new Date().toISOString(),
        runId: active.runId,
        event: "completed",
        conversationId: active.conversationId,
        platform: message.platform,
        chatId: message.chatId,
        projectAlias: project.alias,
        backend,
        mode,
        promptPreview: preview(prompt),
        threadId: result.threadId,
        durationMs: Date.now() - active.startedAt,
        ...(result.usage ? { usage: result.usage } : {}),
        resultPreview: preview(result.finalResponse),
      });
      const response = result.finalResponse.trim() || "Codex 已完成，但没有返回文本结果。";
      const body = truncate(response, this.config.codex.maxReplyChars);
      const usage = result.usage
        ? `\n\n[token in=${result.usage.inputTokens} out=${result.usage.outputTokens}]`
        : "";
      for (const chunk of replyChunks(`${body}${usage}`)) await message.reply(chunk);
    } catch (error) {
      const cancelled = active.controller.signal.aborted && !this.isTimeout(active.controller.signal.reason);
      const messageText = this.errorMessage(error);
      this.runLog.append({
        timestamp: new Date().toISOString(),
        runId: active.runId,
        event: cancelled ? "cancelled" : "failed",
        conversationId: active.conversationId,
        platform: message.platform,
        chatId: message.chatId,
        projectAlias: project.alias,
        backend,
        mode,
        promptPreview: preview(prompt),
        durationMs: Date.now() - active.startedAt,
        error: messageText,
      });
      if (cancelled) await this.safeReply(message, "任务已取消。");
      else if (this.isTimeout(active.controller.signal.reason)) await this.safeReply(message, "任务超时，已停止。 ");
      else await this.safeReply(message, `❌ 执行失败：${messageText}`);
    } finally {
      clearTimeout(active.timeout);
      this.cancelPendingApprovals(key, "cancel");
      this.activeRuns.delete(key);
      this.drainQueues();
    }
  }

  private reportProgress(active: ActiveRun, event: RunProgressEvent): void {
    const progress = this.config.codex.progress;
    if (!progress.enabled || active.progressCount >= progress.maxMessagesPerRun) return;
    const now = Date.now();
    const text = preview(event.text, 500);
    if (!text || text === active.lastProgressText) return;
    if (event.kind !== "status" && now - active.lastProgressAt < progress.minIntervalMs) return;
    active.progressCount += 1;
    active.lastProgressAt = now;
    active.lastProgressText = text;
    const label = event.kind === "plan" ? "计划" : event.kind === "file" ? "文件" : event.kind === "command" ? "命令" : "进度";
    void this.safeReply(active.message, `⏳ ${label}：${text}`);
  }

  private async requestApproval(key: string, active: ActiveRun, request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!this.authorizer.isOperator(active.message)) {
      await this.safeReply(active.message, `自动拒绝审批：当前用户不是管理员或操作员。`);
      return "decline";
    }
    const id = crypto.randomUUID().slice(0, 6).toUpperCase();
    const mapKey = `${key}:${id}`;
    const prompt = [
      `⚠️ 审批 ${id}：${request.title}`,
      request.command ? `命令：${preview(request.command, 700)}` : "",
      request.cwd ? `目录：${request.cwd}` : "",
      request.reason ? `原因：${preview(request.reason, 500)}` : `详情：${preview(request.details, 700)}`,
      "",
      `批准一次：/approve ${id} once`,
      `批准本轮：/approve ${id} session`,
      `拒绝：/deny ${id}`,
    ].filter(Boolean).join("\n");
    await active.message.reply(prompt);

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(mapKey);
        void this.safeReply(active.message, `审批 ${id} 超时，已拒绝。`);
        resolve("decline");
      }, this.config.codex.approvalTimeoutMs);
      this.pendingApprovals.set(mapKey, { id, key, timer, resolve });
    });
  }

  private async handleApprovalCommand(
    message: InboundMessage,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    if (!approvalId) {
      await message.reply("用法：/approve <编号> [once|session] 或 /deny <编号>");
      return;
    }
    const mapKey = `${this.conversationKey(message)}:${approvalId}`;
    const pending = this.pendingApprovals.get(mapKey);
    if (!pending) {
      await message.reply(`审批 ${approvalId} 不存在或已过期。`);
      return;
    }
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(mapKey);
    pending.resolve(decision);
    const label = decision === "accept" ? "已批准一次" : decision === "acceptForSession" ? "已批准本轮" : "已拒绝";
    await message.reply(`审批 ${approvalId}：${label}。`);
  }

  private cancelPendingApprovals(key: string, decision: ApprovalDecision): void {
    for (const [mapKey, pending] of this.pendingApprovals) {
      if (pending.key !== key) continue;
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(mapKey);
      pending.resolve(decision);
    }
  }

  private drainQueues(): void {
    if (this.activeRuns.size >= this.config.codex.maxConcurrentRuns) return;
    for (const [key, queue] of this.queues) {
      if (this.activeRuns.has(key)) continue;
      const next = queue.shift();
      if (!next) {
        this.queues.delete(key);
        continue;
      }
      if (!queue.length) this.queues.delete(key);
      const project = projectByAlias(this.config, this.session(next.message).projectAlias);
      if (!project) {
        void this.safeReply(next.message, "排队任务对应的项目已不存在，任务已丢弃。");
        continue;
      }
      this.startRun(next.message, next.prompt, next.mode, project);
      if (this.activeRuns.size >= this.config.codex.maxConcurrentRuns) break;
    }
  }

  private async promptWithAttachments(message: InboundMessage, prompt: string, project: ProjectConfig): Promise<string> {
    if (!this.config.attachments.enabled || !message.attachments?.length) return prompt;
    const store = new AttachmentStore(
      path.join(project.path, this.config.attachments.intakeDirName),
      this.config.attachments.maxInboundBytes,
      this.config.attachments.maxFilesPerMessage,
      this.config.attachments.allowedHosts,
    );
    const files = await store.materialize(message.messageId, message.attachments);
    if (!files.length) return prompt;
    const lines = files.map((file) => `- ${file.path} (${file.filename}, ${file.contentType}, ${file.size} bytes)`);
    return `${prompt || "请处理用户发送的附件。"}\n\n[用户发送的附件]\n${lines.join("\n")}`;
  }

  private async handleSendFile(message: InboundMessage, requestedPath: string, caption?: string): Promise<void> {
    if (!this.authorizer.isAdmin(message)) {
      await message.reply("只有管理员可以发送文件。");
      return;
    }
    if (!message.sendFile) {
      await message.reply("当前聊天连接器不支持发送文件。");
      return;
    }
    const project = this.projectForSession(message);
    const target = path.resolve(project.path, requestedPath);
    const relative = path.relative(project.path, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      await message.reply("只能发送当前项目目录内的文件。");
      return;
    }
    const info = await stat(target);
    if (!info.isFile()) {
      await message.reply("指定路径不是文件。");
      return;
    }
    if (info.size > this.config.attachments.maxOutboundBytes) {
      await message.reply(`文件过大：${info.size} bytes。`);
      return;
    }
    await message.sendFile({ path: target, ...(caption ? { caption } : {}) });
    await this.safeReply(message, `已发送文件：${path.basename(target)}`);
  }

  private projectsText(message: InboundMessage): string {
    const current = this.session(message).projectAlias;
    return [
      "可用项目：",
      ...this.config.projects.map((project) => `${project.alias === current ? "*" : " "} ${describeProject(project)}`),
    ].join("\n");
  }

  private statusText(message: InboundMessage): string {
    const key = this.conversationKey(message);
    const session = this.session(message);
    const active = this.activeRuns.get(key);
    const queued = this.queues.get(key)?.length ?? 0;
    const pending = [...this.pendingApprovals.values()].filter((approval) => approval.key === key);
    const elapsed = active ? `${Math.round((Date.now() - active.startedAt) / 1000)}s` : "无";
    return [
      `平台：${message.platform}`,
      `会话：${message.chatId}`,
      `项目：${session.projectAlias}`,
      `模式：${session.mode}`,
      `Codex thread：${session.threadId ?? "尚未创建"}`,
      `thread 后端：${session.threadBackend ?? "未记录"}`,
      `已完成轮次：${session.turns}`,
      `运行中：${active ? `${active.runId.slice(0, 8)} (${elapsed})` : "否"}`,
      `排队任务：${queued}`,
      `待审批：${pending.length ? pending.map((approval) => approval.id).join(", ") : "无"}`,
    ].join("\n");
  }

  private whoamiText(message: InboundMessage): string {
    return [
      `平台：${message.platform}`,
      `发送者：${message.senderId}`,
      `会话：${message.chatId}`,
      `权限：${this.authorizer.isAdmin(message) ? "admin" : this.authorizer.isOperator(message) ? "operator" : "user"}`,
    ].join("\n");
  }

  private isConversationBusy(message: InboundMessage): boolean {
    const key = this.conversationKey(message);
    return this.activeRuns.has(key) || (this.queues.get(key)?.length ?? 0) > 0;
  }
  private conversationKey(message: InboundMessage): string {
    return `${message.platform}:${message.chatId}`;
  }

  private isTimeout(reason: unknown): boolean {
    return reason instanceof Error && /timed out/i.test(reason.message);
  }

  private async safeReply(message: InboundMessage, text: string): Promise<void> {
    try {
      await message.reply(text);
    } catch (error) {
      console.error("Failed to send reply", error);
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}






