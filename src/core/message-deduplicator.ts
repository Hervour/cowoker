import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "../types.js";

interface StoredEvents {
  version: 1;
  events: Record<string, number>;
}

export class MessageDeduplicator {
  private readonly events = new Map<string, number>();
  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly ttlMs = 7 * 24 * 60 * 60 * 1_000,
    private readonly maxEvents = 20_000,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8")) as StoredEvents;
      const now = Date.now();
      for (const [key, timestamp] of Object.entries(stored.events ?? {})) {
        if (typeof timestamp === "number" && now - timestamp <= this.ttlMs) this.events.set(key, timestamp);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async claim(platform: Platform, messageId: string): Promise<boolean> {
    await this.load();
    const key = `${platform}:${messageId}`;
    const now = Date.now();
    const prior = this.events.get(key);
    if (prior !== undefined && now - prior <= this.ttlMs) return false;
    this.events.set(key, now);
    this.prune(now);
    this.persist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saveQueue;
  }

  private prune(now: number): void {
    for (const [key, timestamp] of this.events) {
      if (now - timestamp > this.ttlMs) this.events.delete(key);
    }
    while (this.events.size > this.maxEvents) {
      const oldest = [...this.events.entries()].sort((left, right) => left[1] - right[1])[0];
      if (!oldest) break;
      this.events.delete(oldest[0]);
    }
  }

  private persist(): void {
    const snapshot: StoredEvents = {
      version: 1,
      events: Object.fromEntries(this.events),
    };
    const body = `${JSON.stringify(snapshot, null, 2)}\n`;
    this.saveQueue = this.saveQueue
      .then(async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, body, "utf8");
        try {
          await rename(temporaryPath, this.filePath);
        } catch (error) {
          if (!["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await rm(this.filePath, { force: true });
          await rename(temporaryPath, this.filePath);
        }
      })
      .catch((error) => {
        console.error("Failed to persist webhook deduplication state", error);
      });
  }
}

