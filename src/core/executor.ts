import type { ProjectConfig } from "../config.js";
import type { RunMode } from "../types.js";

export type ApprovalKind = "command" | "file-change" | "permissions";
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface ApprovalRequest {
  kind: ApprovalKind;
  title: string;
  details: string;
  command?: string;
  cwd?: string;
  reason?: string;
}

export interface RunProgressEvent {
  kind: "status" | "plan" | "command" | "file" | "message";
  text: string;
}

export interface CodexRunInput {
  project: ProjectConfig;
  mode: RunMode;
  prompt: string;
  approvalsReviewer: "user" | "auto_review";
  threadId?: string;
  signal: AbortSignal;
  onThreadId: (threadId: string) => void;
  onProgress?: (event: RunProgressEvent) => void;
  onApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface CodexRunUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CodexRunResult {
  threadId: string;
  finalResponse: string;
  usage: CodexRunUsage | null;
}

export interface CodexExecutor {
  run(input: CodexRunInput): Promise<CodexRunResult>;
}
