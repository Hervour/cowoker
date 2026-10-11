import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionBackend, Platform, RunMode, SessionRecord } from "../types.js";

interface StoredState {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly conversationByKey = new Map<string, string>();
  private saveQueue: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private key(platform: Platform, chatId: string): string {
    return `${platform}:${chatId}`;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const source = JSON.parse(await readFile(this.filePath, "utf8")) as StoredState;
      for (const session of Object.values(source.sessions ?? {})) {
        this.sessions.set(session.conversationId, session);
        this.conversationByKey.set(this.key(session.platform, session.chatId), session.conversationId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  getOrCreate(platform: Platform, chatId: string, defaultProject: string, defaultMode: RunMode): SessionRecord {
    const key = this.key(platform, chatId);
    const existingId = this.conversationByKey.get(key);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing) return existing;
    }

    const now = new Date().toISOString();
    const conversationId = crypto.randomUUID();
    const created: SessionRecord = {
      conversationId,
      platform,
      chatId,
      projectAlias: defaultProject,
      mode: defaultMode,
      turns: 0,
      updatedAt: now,
    };
    this.sessions.set(conversationId, created);
    this.conversationByKey.set(key, conversationId);
    void this.persist();
    return created;
  }

  get(platform: Platform, chatId: string): SessionRecord | undefined {
    const conversationId = this.conversationByKey.get(this.key(platform, chatId));
    return conversationId ? this.sessions.get(conversationId) : undefined;
  }

  update(
    platform: Platform,
    chatId: string,
    patch: {
      projectAlias?: string;
      mode?: RunMode;
      threadId?: string | null;
      threadBackend?: ExecutionBackend | null;
      incrementTurns?: boolean;
    },
  ): SessionRecord {
    const existing = this.get(platform, chatId);
    if (!existing) throw new Error("Session does not exist");
    const updated: SessionRecord = {
      ...existing,
      ...(patch.projectAlias ? { projectAlias: patch.projectAlias } : {}),
      ...(patch.mode ? { mode: patch.mode } : {}),
      turns: existing.turns + (patch.incrementTurns ? 1 : 0),
      updatedAt: new Date().toISOString(),
    };
    if (patch.threadId === null) delete updated.threadId;
    if (typeof patch.threadId === "string") updated.threadId = patch.threadId;
    if (patch.threadBackend === null) delete updated.threadBackend;
    if (typeof patch.threadBackend === "string") updated.threadBackend = patch.threadBackend;

    this.sessions.set(existing.conversationId, updated);
    void this.persist();
    return updated;
  }

  all(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  async flush(): Promise<void> {
    await this.saveQueue;
  }

  private persist(): void {
    const snapshot: StoredState = {
      version: 1,
      sessions: Object.fromEntries([...this.sessions].map(([id, session]) => [id, session])),
    };
    const body = `${JSON.stringify(snapshot, null, 2)}\n`;
    this.saveQueue = this.saveQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, body, "utf8");
      await rename(temporaryPath, this.filePath);
    });
  }
}




