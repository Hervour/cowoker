import type { CoworkerConfig } from "../config.js";
import type { InboundMessage } from "../types.js";

function listFor(values: Record<string, string[]>, platform: string): string[] {
  return values[platform] ?? [];
}

function matches(values: string[], candidate: string): boolean {
  return values.includes("*") || values.includes(candidate);
}

export class Authorizer {
  constructor(private readonly config: CoworkerConfig) {}

  isAuthorized(message: InboundMessage): boolean {
    const allowedUsers = listFor(this.config.authorization.allowedUsers, message.platform);
    const allowedChats = listFor(this.config.authorization.allowedChats, message.platform);
    return matches(allowedUsers, message.senderId) && matches(allowedChats, message.chatId);
  }

  isAdmin(message: InboundMessage): boolean {
    return matches(listFor(this.config.authorization.admins, message.platform), message.senderId);
  }

  isOperator(message: InboundMessage): boolean {
    return this.isAdmin(message) || matches(listFor(this.config.authorization.operators, message.platform), message.senderId);
  }

  denialReason(message: InboundMessage): string {
    const userAllowed = matches(listFor(this.config.authorization.allowedUsers, message.platform), message.senderId);
    if (!userAllowed) return `发送者不在允许列表: ${message.senderId}`;
    return `当前会话不在允许列表: ${message.chatId}`;
  }
}


