import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/core/command-parser.js";

test("plain text becomes a prompt in the session default mode", () => {
  assert.deepEqual(parseCommand("inspect the repository"), { kind: "prompt", prompt: "inspect the repository" });
});

test("ask and code commands set one-turn modes", () => {
  assert.deepEqual(parseCommand("/ask review auth"), { kind: "prompt", prompt: "review auth", mode: "read-only" });
  assert.deepEqual(parseCommand("/code fix tests"), { kind: "prompt", prompt: "fix tests", mode: "workspace-write" });
});

test("project and session commands parse", () => {
  assert.deepEqual(parseCommand("/use cowoker"), { kind: "use", projectAlias: "cowoker" });
  assert.deepEqual(parseCommand("/new"), { kind: "new" });
  assert.deepEqual(parseCommand("/cancel"), { kind: "cancel" });
});

test("approval commands parse", () => {
  assert.deepEqual(parseCommand("/approve A1B2C3 once"), { kind: "approval", approvalId: "A1B2C3", decision: "accept" });
  assert.deepEqual(parseCommand("/approve a1b2c3 session"), { kind: "approval", approvalId: "A1B2C3", decision: "acceptForSession" });
  assert.deepEqual(parseCommand("/deny a1b2c3"), { kind: "approval", approvalId: "A1B2C3", decision: "decline" });
});

test("send command parses a project file path", () => {
  assert.deepEqual(parseCommand("/send output/report.pdf"), { kind: "send", path: "output/report.pdf" });
});
