import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

function platformCandidates(): string[] {
  const candidates: string[] = [];
  const arch = process.arch;
  if (process.platform === "win32") {
    const packageName = arch === "arm64" ? "@openai/codex-win32-arm64" : "@openai/codex-win32-x64";
    const vendorDir = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    try {
      const packagePath = requireFromHere.resolve(`${packageName}/package.json`);
      candidates.push(path.join(path.dirname(packagePath), "vendor", vendorDir, "bin", "codex.exe"));
    } catch {
      // Fall through to PATH lookup.
    }
  }
  return candidates;
}

function pathCandidates(): string[] {
  const candidates = platformCandidates();
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat"] : ["codex"]) {
      candidates.push(path.join(directory, name));
    }
  }
  return candidates;
}

export function resolveCodexBinary(): string | undefined {
  const configured = process.env.CODEX_BIN;
  if (configured && existsSync(configured)) return configured;
  return pathCandidates().find((candidate) => existsSync(candidate));
}
