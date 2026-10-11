import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

test("config expands environment variables and resolves project paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cowoker-config-"));
  try {
    const configPath = path.join(directory, "cowoker.config.json");
    await writeFile(configPath, JSON.stringify({
      server: { host: "127.0.0.1", port: 8787 },
      authorization: {
        allowedUsers: { dev: ["${DEV_USER}"] },
        allowedChats: { dev: ["${DEV_CHAT:-dev}"] },
        admins: { dev: ["${DEV_USER}"] },
      },
      codex: {},
      projects: [{ alias: "cowoker", path: "${PROJECT_PATH}" }],
      defaultProject: "cowoker",
      sessionStorePath: path.join(directory, "sessions.json"),
      connectors: { dev: { enabled: true } },
    }), "utf8");

    const config = loadConfig(configPath, {
      DEV_USER: "alice",
      PROJECT_PATH: directory,
    } as NodeJS.ProcessEnv);
    assert.equal(config.authorization.allowedUsers.dev?.[0], "alice");
    assert.equal(config.projects[0]?.path, directory);
    assert.equal(config.connectors.dev.enabled, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

