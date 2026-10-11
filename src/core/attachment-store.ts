import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InboundAttachment } from "../types.js";

export interface MaterializedAttachment {
  path: string;
  filename: string;
  contentType: string;
  size: number;
}

function safeSegment(value: string): string {
  const base = path.posix.basename(value.replaceAll("\\", "/"));
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 180);
  return cleaned || "attachment";
}

export class AttachmentStore {
  constructor(
    private readonly rootDir: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
    private readonly allowedHosts: string[],
  ) {}

  async materialize(messageId: string, attachments: InboundAttachment[] | undefined): Promise<MaterializedAttachment[]> {
    if (!attachments?.length) return [];
    const selected = attachments.slice(0, this.maxFiles);
    const messageDir = path.join(this.rootDir, safeSegment(messageId));
    await mkdir(messageDir, { recursive: true });
    const results: MaterializedAttachment[] = [];

    for (const [index, attachment] of selected.entries()) {
      if (!this.allowed(attachment.url)) continue;
      const response = await fetch(attachment.url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Attachment download failed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > this.maxBytes) throw new Error(`Attachment exceeds ${this.maxBytes} bytes`);
      const baseName = safeSegment(attachment.filename ?? `attachment-${index + 1}`);
      const filename = `${index + 1}-${baseName}`;
      const filePath = path.join(messageDir, filename);
      await writeFile(filePath, bytes);
      results.push({
        path: filePath,
        filename: baseName,
        contentType: attachment.contentType ?? "application/octet-stream",
        size: bytes.length,
      });
    }
    return results;
  }

  private allowed(rawUrl: string): boolean {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (url.protocol !== "https:") return false;
    return this.allowedHosts.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
  }
}

