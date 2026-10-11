import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { OutboundFile } from "../types.js";

export interface QqApiConfig {
  appId: string;
  appSecret: string;
  maxFileBytes?: number;
}

export interface QqSendTarget {
  isGroup: boolean;
  chatId: string;
  messageId?: string;
}

interface AccessToken {
  value: string;
  expiresAt: number;
}

interface UploadPrepare {
  upload_id: string;
  block_size: string;
  parts: Array<{ index: number; presigned_url: string; block_size?: string }>;
}

interface UploadedFile {
  file_info: string;
}

function chunkText(text: string, maxLength = 3_800): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength / 2) splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function hash(value: Buffer, algorithm: "md5" | "sha1"): string {
  return createHash(algorithm).update(value).digest("hex");
}

function fileTypeFor(fileName: string): number {
  const extension = path.extname(fileName).toLowerCase();
  if ([".png", ".jpg", ".jpeg"].includes(extension)) return 1;
  if (extension === ".mp4") return 2;
  if (extension === ".silk") return 3;
  return 4;
}

async function fetchWithRetry(url: string, init?: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.status < 500 || attempt === attempts - 1) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
export class QqApiClient {
  private accessToken?: AccessToken;
  private readonly messageSequences = new Map<string, { value: number; expiresAt: number }>();

  constructor(private readonly config: QqApiConfig) {}

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const response = await fetchWithRetry("https://api.bot.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.appSecret }),
    });
    const result = await response.json() as { access_token?: string; expires_in?: string | number; code?: number; message?: string };
    if (!response.ok || !result.access_token) {
      throw new Error(`QQ getAppAccessToken failed: ${result.code ?? response.status} ${result.message ?? ""}`);
    }
    this.accessToken = {
      value: result.access_token,
      expiresAt: Date.now() + Number(result.expires_in ?? 7_200) * 1_000,
    };
    return this.accessToken.value;
  }

  async sendText(target: QqSendTarget, text: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      await this.sendMessage(target, {
        content: chunk,
        msg_type: 0,
        ...this.sequenceFields(target),
      });
    }
  }

  async sendFile(target: QqSendTarget, file: OutboundFile): Promise<void> {
    const filePath = path.resolve(file.path);
    const info = await stat(filePath);
    const maxBytes = this.config.maxFileBytes ?? 200 * 1024 * 1024;
    if (info.size > maxBytes) throw new Error(`File exceeds QQ limit: ${info.size} > ${maxBytes}`);
    const bytes = await readFile(filePath);
    const fileName = file.filename ?? path.basename(filePath);
    const uploaded = await this.uploadFile(target, fileName, bytes);
    await this.sendMessage(target, {
      msg_type: 7,
      media: { file_info: uploaded.file_info },
      ...this.sequenceFields(target),
    });
    if (file.caption) await this.sendText(target, file.caption);
  }

  private async uploadFile(target: QqSendTarget, fileName: string, bytes: Buffer): Promise<UploadedFile> {
    const token = await this.getAccessToken();
    const prefix = target.isGroup
      ? `https://api.bot.qq.com/v2/groups/${encodeURIComponent(target.chatId)}`
      : `https://api.bot.qq.com/v2/users/${encodeURIComponent(target.chatId)}`;
    const fileType = fileTypeFor(fileName);
    const firstChunk = bytes.subarray(0, Math.min(bytes.length, 10_002_432));
    const prepare = await this.request<UploadPrepare>(`${prefix}/upload_prepare`, token, {
      method: "POST",
      body: JSON.stringify({
        file_type: fileType,
        file_size: String(bytes.length),
        file_name: fileName,
        md5: hash(bytes, "md5"),
        sha1: hash(bytes, "sha1"),
        md5_10m: hash(firstChunk, "md5"),
      }),
    });

    let offset = 0;
    for (const part of prepare.parts) {
      const size = Number(part.block_size ?? prepare.block_size);
      const chunk = bytes.subarray(offset, Math.min(offset + size, bytes.length));
      offset += chunk.length;
      const uploadResponse = await fetch(part.presigned_url, { method: "PUT", body: new Uint8Array(chunk) });
      if (!uploadResponse.ok) throw new Error(`QQ part upload failed: HTTP ${uploadResponse.status}`);
      await this.request(`${prefix}/upload_part_finish`, token, {
        method: "POST",
        body: JSON.stringify({
          upload_id: prepare.upload_id,
          part_index: part.index,
          block_size: String(chunk.length),
          md5: hash(chunk, "md5"),
        }),
      });
    }

    return this.request<UploadedFile>(`${prefix}/files`, token, {
      method: "POST",
      body: JSON.stringify({
        file_type: fileType,
        srv_send_msg: false,
        file_name: fileName,
        upload_id: prepare.upload_id,
      }),
    });
  }

  private sequenceFields(target: QqSendTarget): Record<string, unknown> {
    if (!target.messageId) return {};
    const now = Date.now();
    for (const [key, entry] of this.messageSequences) {
      if (entry.expiresAt <= now) this.messageSequences.delete(key);
    }
    const current = this.messageSequences.get(target.messageId)?.value ?? 0;
    const sequence = current + 1;
    this.messageSequences.set(target.messageId, { value: sequence, expiresAt: now + 5 * 60 * 1000 });
    return { msg_id: target.messageId, msg_seq: sequence };
  }

  private async sendMessage(target: QqSendTarget, body: Record<string, unknown>): Promise<void> {
    const token = await this.getAccessToken();
    const endpoint = target.isGroup
      ? `https://api.bot.qq.com/v2/groups/${encodeURIComponent(target.chatId)}/messages`
      : `https://api.bot.qq.com/v2/users/${encodeURIComponent(target.chatId)}/messages`;
    await this.request(endpoint, token, { method: "POST", body: JSON.stringify(body) });
  }

  private async request<T = unknown>(url: string, token: string, init: RequestInit): Promise<T> {
    const response = await fetchWithRetry(url, {
      ...init,
      headers: {
        authorization: `QQBot ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const result = await response.json() as T & { code?: number; message?: string };
    if (!response.ok || result.code) {
      throw new Error(`QQ API failed: ${result.code ?? response.status} ${result.message ?? ""}`);
    }
    return result;
  }
}




