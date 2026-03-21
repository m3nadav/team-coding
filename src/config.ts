import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface TeamClaudeConfig {
  name?: string;
  approvalMode?: boolean;
  port?: number;
  tunnel?: "localtunnel" | "cloudflare";
  relay?: string;
  permissionMode?: "auto" | "interactive";
  lastLocalSessionId?: string;
}

const CONFIG_KEYS: (keyof TeamClaudeConfig)[] = ["name", "approvalMode", "port", "tunnel", "relay", "permissionMode", "lastLocalSessionId"];

export function getUserConfigPath(): string {
  return join(homedir(), ".config", "team-claude", "config.json");
}

export function getProjectConfigPath(): string | null {
  // Walk up from cwd to find .team-claude.json (stop at git root or filesystem root)
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, ".team-claude.json");
    if (existsSync(candidate)) return candidate;
    // Stop at git root
    if (existsSync(join(dir, ".git"))) return join(dir, ".team-claude.json"); // return path even if doesn't exist (for save)
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

export function loadUserConfig(): Partial<TeamClaudeConfig> {
  try {
    const content = readFileSync(getUserConfigPath(), "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function loadProjectConfig(): Partial<TeamClaudeConfig> {
  const path = getProjectConfigPath();
  if (!path) return {};
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function loadConfig(): TeamClaudeConfig {
  const user = loadUserConfig();
  const project = loadProjectConfig();
  // Project overrides user
  return { ...user, ...project };
}

export function saveUserConfig(config: Partial<TeamClaudeConfig>): void {
  const path = getUserConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const existing = loadUserConfig();
  const merged = { ...existing, ...config };
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
}

export function saveProjectConfig(config: Partial<TeamClaudeConfig>): void {
  const path = getProjectConfigPath();
  if (!path) {
    // Create at cwd
    const fallback = join(process.cwd(), ".team-claude.json");
    writeFileSync(fallback, JSON.stringify(config, null, 2) + "\n");
    return;
  }
  let existing: Partial<TeamClaudeConfig> = {};
  try {
    existing = JSON.parse(readFileSync(path, "utf-8"));
  } catch {}
  const merged = { ...existing, ...config };
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
}

export function getConfigPaths(): { user: string; project: string | null } {
  return { user: getUserConfigPath(), project: getProjectConfigPath() };
}

export function isValidConfigKey(key: string): key is keyof TeamClaudeConfig {
  return CONFIG_KEYS.includes(key as keyof TeamClaudeConfig);
}

export function parseConfigValue(key: keyof TeamClaudeConfig, value: string): unknown {
  switch (key) {
    case "approvalMode":
      return value === "true" || value === "1";
    case "port":
      return parseInt(value, 10);
    case "permissionMode":
      return value === "interactive" ? "interactive" : "auto";
    default:
      return value;
  }
}
