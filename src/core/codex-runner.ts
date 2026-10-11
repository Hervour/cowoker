import { Codex, type ThreadEvent, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import { resolveCodexBinary } from "../platform/codex-binary.js";
import type { ProjectConfig } from "../config.js";
import type { RunMode } from "../types.js";
import type { CodexExecutor, CodexRunInput, CodexRunResult, RunProgressEvent } from "./executor.js";

function threadOptions(project: ProjectConfig, mode: RunMode): ThreadOptions {
  const options: ThreadOptions = {
    workingDirectory: project.path,
    skipGitRepoCheck: true,
    sandboxMode: mode,
    approvalPolicy: "never",
    networkAccessEnabled: project.networkAccess,
    webSearchMode: project.webSearch,
  };
  if (project.model) options.model = project.model;
  if (project.reasoningEffort) options.modelReasoningEffort = project.reasoningEffort;
  return options;
}

function progressForEvent(event: ThreadEvent): RunProgressEvent | undefined {
  if (event.type === "item.started") {
    if (event.item.type === "command_execution") return { kind: "command", text: event.item.command };
    if (event.item.type === "file_change") return { kind: "file", text: `准备修改 ${event.item.changes.length} 个文件` };
    if (event.item.type === "todo_list") return { kind: "plan", text: event.item.items.map((item) => item.text).join("；") };
  }
  return undefined;
}

export class CodexRunner implements CodexExecutor {
  private readonly codex: Codex;

  constructor() {
    const codexPath = resolveCodexBinary();
    this.codex = codexPath ? new Codex({ codexPathOverride: codexPath }) : new Codex();
  }

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    const options = threadOptions(input.project, input.mode);
    const thread = input.threadId ? this.codex.resumeThread(input.threadId, options) : this.codex.startThread(options);
    const { events } = await thread.runStreamed(input.prompt, { signal: input.signal });

    let finalResponse = "";
    let usage: Usage | null = null;
    for await (const event of events) {
      const progress = progressForEvent(event);
      if (progress) input.onProgress?.(progress);
      if (event.type === "thread.started") input.onThreadId(event.thread_id);
      if (event.type === "item.completed" && event.item.type === "agent_message") finalResponse = event.item.text;
      if (event.type === "turn.completed") usage = event.usage;
      if (event.type === "turn.failed") throw new Error(event.error.message);
      if (event.type === "error") throw new Error(event.message);
    }

    const threadId = thread.id;
    if (!threadId) throw new Error("Codex did not return a thread id");
    input.onThreadId(threadId);
    return {
      threadId,
      finalResponse,
      usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : null,
    };
  }
}

