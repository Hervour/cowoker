import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import type { ExecutionBackend, InboundMessage } from "../src/types.js";
import type { CodexExecutor } from "../src/core/executor.js";
import { RunLog } from "../src/core/run-log.js";
import { CoworkerService } from "../src/core/service.js";
import { SessionStore } from "../src/core/session-store.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("service routes a remote approval command into the app-server executor", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cowoker-service-"));
  try {
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      server: { host: "127.0.0.1", port: 8787 },
      authorization: {
        allowedUsers: { dev: ["dev-user"] },
        allowedChats: { dev: ["dev-chat"] },
        admins: { dev: ["dev-user"] },
      },
      codex: {
        defaultMode: "read-only",
        approvalsReviewer: "auto_review",
        progress: { enabled: true, minIntervalMs: 1000, maxMessagesPerRun: 4 },
      },
      projects: [{
        alias: "cowoker",
        path: directory,
        executionBackend: "app-server",
        approvalPolicy: "on-request",
      }],
      defaultProject: "cowoker",
      sessionStorePath: path.join(directory, "sessions.json"),
      runLogPath: path.join(directory, "runs.jsonl"),
      eventStorePath: path.join(directory, "events.json"),
      connectors: { dev: { enabled: true } },
    }), "utf8");

    const config = loadConfig(configPath, {});
    const sessions = new SessionStore(path.join(directory, "sessions.json"));
    await sessions.load();
    const replies: string[] = [];
    let requestedReviewer: string | undefined = undefined;
    const runner: CodexExecutor = {
      async run(input) {
        requestedReviewer = input.approvalsReviewer;
        input.onThreadId("thread-service-test");
        input.onProgress?.({ kind: "plan", text: "run tests" });
        const decision = await input.onApproval?.({
          kind: "command",
          title: "Codex 请求执行命令",
          details: "npm test",
          command: "npm test",
        });
        return {
          threadId: "thread-service-test",
          finalResponse: `decision=${decision}`,
          usage: null,
        };
      },
    };
    const runners: Record<ExecutionBackend, CodexExecutor> = { sdk: runner, "app-server": runner };
    const service = new CoworkerService(config, sessions, runners, new RunLog(path.join(directory, "runs.jsonl")));
    const makeMessage = (text: string): InboundMessage => ({
      platform: "dev",
      messageId: crypto.randomUUID(),
      senderId: "dev-user",
      chatId: "dev-chat",
      chatType: "direct",
      text,
      timestamp: new Date(),
      reply: async (reply) => {
        replies.push(reply);
      },
    });

    await service.dispatch(makeMessage("/code run the tests"));
    await waitFor(() => replies.some((reply) => /审批 [A-F0-9]{6}/.test(reply)));
    const approvalReply = replies.find((reply) => /审批 [A-F0-9]{6}/.test(reply));
    const approvalId = /审批 ([A-F0-9]{6})/.exec(approvalReply ?? "")?.[1];
    assert.ok(approvalId);
    await service.dispatch(makeMessage(`/approve ${approvalId} once`));
    await waitFor(() => replies.some((reply) => reply.includes("decision=accept")));
    await service.flush();
    assert.equal(replies.some((reply) => reply.includes("⏳ 计划：run tests")), true);
    assert.equal(requestedReviewer, "auto_review");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});