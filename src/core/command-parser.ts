import type { RunMode } from "../types.js";

export type ApprovalCommandDecision = "accept" | "acceptForSession" | "decline";

export type ParsedCommand =
  | { kind: "prompt"; prompt: string; mode?: RunMode }
  | { kind: "help" }
  | { kind: "projects" }
  | { kind: "use"; projectAlias: string }
  | { kind: "new" }
  | { kind: "status" }
  | { kind: "cancel" }
  | { kind: "mode"; mode: RunMode }
  | { kind: "approval"; approvalId: string; decision: ApprovalCommandDecision }
  | { kind: "send"; path: string; caption?: string }
  | { kind: "whoami" };

const commandAliases: Record<string, string> = {
  start: "help",
  h: "help",
  "?": "help",
  list: "projects",
  project: "use",
  switch: "use",
  read: "ask",
  run: "code",
  stop: "cancel",
};

export function parseCommand(input: string): ParsedCommand {
  const text = input.trim();
  if (!text.startsWith("/")) return { kind: "prompt", prompt: text };
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { kind: "prompt", prompt: text };

  const rawName = match[1]?.toLowerCase() ?? "";
  const name = commandAliases[rawName] ?? rawName;
  const rest = (match[2] ?? "").trim();

  switch (name) {
    case "help":
      return { kind: "help" };
    case "projects":
      return { kind: "projects" };
    case "use":
      return rest ? { kind: "use", projectAlias: rest.split(/\s+/)[0] ?? rest } : { kind: "projects" };
    case "new":
    case "reset":
      return { kind: "new" };
    case "status":
      return { kind: "status" };
    case "cancel":
      return { kind: "cancel" };
    case "whoami":
      return { kind: "whoami" };
    case "ask":
      return rest ? { kind: "prompt", prompt: rest, mode: "read-only" } : { kind: "mode", mode: "read-only" };
    case "code":
      return rest ? { kind: "prompt", prompt: rest, mode: "workspace-write" } : { kind: "mode", mode: "workspace-write" };
    case "send":
      return rest ? { kind: "send", path: rest.split(/\s+/)[0] ?? "" } : { kind: "status" };
    case "deny":
      return { kind: "approval", approvalId: (rest.split(/\s+/)[0] ?? "").toUpperCase(), decision: "decline" };
    case "approve": {
      const [rawId = "", rawDecision = "once"] = rest.split(/\s+/);
      const normalized = rawDecision.toLowerCase();
      const decision: ApprovalCommandDecision = normalized === "session"
        ? "acceptForSession"
        : ["no", "deny", "decline", "false"].includes(normalized)
          ? "decline"
          : "accept";
      return { kind: "approval", approvalId: rawId.toUpperCase(), decision };
    }
    case "mode": {
      const normalized = rest.toLowerCase();
      if (normalized === "read" || normalized === "read-only") return { kind: "mode", mode: "read-only" };
      if (normalized === "code" || normalized === "write" || normalized === "workspace-write") {
        return { kind: "mode", mode: "workspace-write" };
      }
      return { kind: "status" };
    }
    default:
      return { kind: "prompt", prompt: text };
  }
}

