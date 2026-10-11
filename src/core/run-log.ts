import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ExecutionBackend, Platform, RunMode } from "../types.js";
import type { CodexRunUsage } from "./executor.js";

export interface RunLogRecord {
  timestamp: string;
  runId: string;
  event: "started" | "completed" | "failed" | "cancelled";
  conversationId: string;
  platform: Platform;
  chatId: string;
  projectAlias: string;
  backend: ExecutionBackend;
  mode: RunMode;
  promptPreview?: string;
  threadId?: string;
  durationMs?: number;
  usage?: CodexRunUsage;
  resultPreview?: string;
  error?: string;
}

export class RunLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  append(record: RunLogRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    this.queue = this.queue
      .then(async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, line, "utf8");
      })
      .catch((error) => {
        console.error("Failed to append run log", error);
      });
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
