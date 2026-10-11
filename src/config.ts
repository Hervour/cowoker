import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const EnvMapSchema = z.record(z.string(), z.array(z.string())).default({});

const ProjectSchema = z.object({
  alias: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "alias may only contain letters, numbers, _ and -"),
  path: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  networkAccess: z.boolean().default(false),
  webSearch: z.enum(["disabled", "cached", "live"]).default("disabled"),
  executionBackend: z.enum(["sdk", "app-server"]).default("sdk"),
  approvalPolicy: z.enum(["never", "on-request", "untrusted"]).default("never"),
});

const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(8787),
    maxBodyBytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
  }),
  authorization: z.object({
    allowedUsers: EnvMapSchema,
    allowedChats: EnvMapSchema,
    admins: EnvMapSchema,
    operators: EnvMapSchema,
  }),
  codex: z.object({
    defaultMode: z.enum(["read-only", "workspace-write"]).default("read-only"),
    runTimeoutMs: z.number().int().min(30_000).max(24 * 60 * 60 * 1000).default(30 * 60 * 1000),
    maxConcurrentRuns: z.number().int().min(1).max(32).default(2),
    maxPromptChars: z.number().int().min(100).max(100_000).default(20_000),
    maxReplyChars: z.number().int().min(500).max(20_000).default(4_000),
    approvalTimeoutMs: z.number().int().min(30_000).max(24 * 60 * 60 * 1000).default(5 * 60 * 1000),
    approvalsReviewer: z.enum(["user", "auto_review"]).default("user"),
    progress: z.object({
      enabled: z.boolean().default(false),
      minIntervalMs: z.number().int().min(1_000).max(5 * 60 * 1000).default(15_000),
      maxMessagesPerRun: z.number().int().min(1).max(100).default(8),
    }).default({ enabled: false, minIntervalMs: 15_000, maxMessagesPerRun: 8 }),
  }),
  attachments: z.object({
    enabled: z.boolean().default(true),
    maxInboundBytes: z.number().int().min(1_024).max(200 * 1024 * 1024).default(50 * 1024 * 1024),
    maxOutboundBytes: z.number().int().min(1_024).max(200 * 1024 * 1024).default(200 * 1024 * 1024),
    maxFilesPerMessage: z.number().int().min(1).max(20).default(5),
    allowedHosts: z.array(z.string().min(1)).default(["qq.com", "qq.com.cn"]),
    intakeDirName: z.string().min(1).default(".cowoker-inbox"),
  }).default({
    enabled: true,
    maxInboundBytes: 50 * 1024 * 1024,
    maxOutboundBytes: 200 * 1024 * 1024,
    maxFilesPerMessage: 5,
    allowedHosts: ["qq.com", "qq.com.cn"],
    intakeDirName: ".cowoker-inbox",
  }),
  projects: z.array(ProjectSchema).min(1),
  defaultProject: z.string().min(1),
  sessionStorePath: z.string().default("data/sessions.json"),
  runLogPath: z.string().default("data/runs.jsonl"),
  eventStorePath: z.string().default("data/events.json"),
  connectors: z.object({
    dev: z.object({
      enabled: z.boolean().default(true),
      token: z.string().optional(),
    }).default({ enabled: true }),
    wecom: z.object({
      enabled: z.boolean().default(false),
      corpId: z.string().optional(),
      agentId: z.number().int().optional(),
      secret: z.string().optional(),
      token: z.string().optional(),
      encodingAesKey: z.string().optional(),
    }).default({ enabled: false }),
    web: z.object({
      enabled: z.boolean().default(false),
      token: z.string().optional(),
    }).default({ enabled: false }),
    wechatMp: z.object({
      enabled: z.boolean().default(false),
      appId: z.string().optional(),
      appSecret: z.string().optional(),
      token: z.string().optional(),
      encodingAesKey: z.string().optional(),
    }).default({ enabled: false }),
    qq: z.object({
      enabled: z.boolean().default(false),
      mode: z.enum(["webhook", "gateway"]).default("webhook"),
      appId: z.string().optional(),
      appSecret: z.string().optional(),
      enforceSignature: z.boolean().default(true),
    }).default({ enabled: false, mode: "webhook", enforceSignature: true }),
  }).default({
    dev: { enabled: true },
    wecom: { enabled: false },
    web: { enabled: false },
    wechatMp: { enabled: false },
    qq: { enabled: false, mode: "webhook", enforceSignature: true },
  }),
});

export type CoworkerConfig = z.infer<typeof ConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;

const envPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function expandEnvironment(value: unknown, environment: NodeJS.ProcessEnv): unknown {
  if (Array.isArray(value)) return value.map((entry) => expandEnvironment(entry, environment));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandEnvironment(entry, environment)]),
    );
  }
  if (typeof value !== "string") return value;

  return value.replace(envPattern, (_match, name: string, fallback: string | undefined) => {
    const resolved = environment[name] ?? fallback;
    if (resolved === undefined) throw new Error(`Missing environment variable ${name}`);
    return resolved;
  });
}

function loadEnvFileIfPresent(filePath: string, environment: NodeJS.ProcessEnv): void {
  if (!existsSync(filePath)) return;
  const source = readFileSync(filePath, "utf8");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    environment[key] ??= value;
  }
}

function assertEnabledConnector(name: string, values: Array<string | undefined>): void {
  if (values.some((value) => !value)) {
    throw new Error(`${name} connector is enabled but required credentials are missing`);
  }
}

export function loadConfig(configPath = "cowoker.config.json", environment = process.env): CoworkerConfig {
  loadEnvFileIfPresent(path.resolve(".env"), environment);
  const absoluteConfigPath = path.resolve(configPath);
  if (!existsSync(absoluteConfigPath)) {
    throw new Error(`Config not found: ${absoluteConfigPath}. Copy cowoker.config.example.json to cowoker.config.json.`);
  }

  const raw = JSON.parse(readFileSync(absoluteConfigPath, "utf8")) as unknown;
  const parsed = ConfigSchema.parse(expandEnvironment(raw, environment));

  const aliases = new Set<string>();
  parsed.projects = parsed.projects.map((project) => {
    if (aliases.has(project.alias)) throw new Error(`Duplicate project alias: ${project.alias}`);
    aliases.add(project.alias);
    return { ...project, path: path.resolve(project.path) };
  });
  if (!aliases.has(parsed.defaultProject)) throw new Error(`defaultProject ${parsed.defaultProject} is not present in projects`);

  for (const project of parsed.projects) {
    if (project.executionBackend === "sdk" && project.approvalPolicy !== "never") {
      throw new Error(`Project ${project.alias}: sdk backend only supports approvalPolicy=never`);
    }
  }

  if (parsed.connectors.wecom.enabled) {
    assertEnabledConnector("wecom", [
      parsed.connectors.wecom.corpId,
      parsed.connectors.wecom.secret,
      parsed.connectors.wecom.token,
      parsed.connectors.wecom.encodingAesKey,
    ]);
    if (!parsed.connectors.wecom.agentId) throw new Error("wecom.agentId is required when wecom is enabled");
  }
  if (parsed.connectors.web.enabled && !["127.0.0.1", "localhost", "::1"].includes(parsed.server.host) && !parsed.connectors.web.token) {
    throw new Error("Web connector requires a token when the server is not bound to loopback");
  }
  if (parsed.connectors.wechatMp.enabled) {
    assertEnabledConnector("wechatMp", [
      parsed.connectors.wechatMp.appId,
      parsed.connectors.wechatMp.appSecret,
      parsed.connectors.wechatMp.token,
    ]);
  }
  if (parsed.connectors.qq.enabled) {
    assertEnabledConnector("qq", [parsed.connectors.qq.appId, parsed.connectors.qq.appSecret]);
  }
  if (parsed.connectors.dev.enabled && !["127.0.0.1", "localhost", "::1"].includes(parsed.server.host)) {
    throw new Error("The dev connector may only be enabled on a loopback host");
  }

  return parsed;
}

export function projectByAlias(config: CoworkerConfig, alias: string): ProjectConfig | undefined {
  return config.projects.find((project) => project.alias === alias);
}

