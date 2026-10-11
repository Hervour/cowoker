import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { AppServerRunner } from "../src/core/app-server-runner.js";

test("app-server runner handles approval requests and completes a turn", async () => {
  const controller = new AbortController();
  const progress: Array<{ kind: string; text: string }> = [];
  let approved = false;
  const runner = new AppServerRunner({
    bin: process.execPath,
    args: [path.resolve("test/fixtures/fake-app-server.mjs")],
  });

  const result = await runner.run({
    project: {
      alias: "cowoker",
      path: process.cwd(),
      networkAccess: false,
      webSearch: "disabled",
      executionBackend: "app-server",
      approvalPolicy: "on-request",
    },
    mode: "workspace-write",
    prompt: "run the fake turn",
    approvalsReviewer: "auto_review",
    signal: controller.signal,
    onThreadId: () => undefined,
    onProgress: (event) => progress.push(event),
    onApproval: async () => {
      approved = true;
      return "accept";
    },
  });

  assert.equal(approved, true);
  assert.equal(result.threadId, "thr_fake");
  assert.equal(result.finalResponse, "fake response:accept:auto_review");
  assert.equal(progress.some((event) => event.kind === "command"), true);
});