#!/usr/bin/env node
/**
 * everything-open-code auto-port script
 *
 * Usage: node .opencode/scripts/port.js <source-dir> <target-dir>
 *
 * Copies new/changed files from everything-claude-code into this OpenCode
 * mirror, applies the OpenCode V2 conversion, and ensures the OpenCode
 * plugin + manifests are present.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const [, , srcArg, tgtArg] = process.argv;
if (!srcArg || !tgtArg) {
  console.error("Usage: node port.js <source-dir> <target-dir>");
  process.exit(2);
}

const SRC = path.resolve(srcArg);
const TGT = path.resolve(tgtArg);

if (!fs.existsSync(SRC)) {
  console.error("Source dir not found:", SRC);
  process.exit(1);
}

const SKIP_DIRS = new Set([".git", ".claude", ".claude-plugin", "examples", "node_modules"]);
const SKIP_FILES = new Set([".gitignore", ".DS_Store"]);

const REPLACEMENTS = [
  ["~/.claude/", "~/.opencode/"],
  ["CLAUDE.md", "AGENTS.md"],
  [".claude-plugin", ".opencode-plugin"],
  [".claude/", ".opencode/"],
  [".claude", ".opencode"],
  ["CLAUDE_TRANSCRIPT_PATH", "OPENCODE_TRANSCRIPT_PATH"],
  ["CLAUDE_PACKAGE_MANAGER", "OPENCODE_PACKAGE_MANAGER"],
  ["CLAUDE_PLUGIN_ROOT", "OPENCODE_PLUGIN_ROOT"],
  ["CLAUDE_SESSION_ID", "OPENCODE_SESSION_ID"],
  ["~/.claude.json", "~/.config/opencode/opencode.json"],
  ["getClaudeDir", "getOpenCodeDir"],
  ["Claude Code", "OpenCode"],
  ["everything-claude-code", "everything-open-code"],
];

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function convert(content) {
  let c = content;
  for (const [old, neu] of REPLACEMENTS) c = c.split(old).join(neu);
  return c;
}

function copyFile(rel) {
  const src = path.join(SRC, rel);
  const tgt = path.join(TGT, rel);
  let content;
  try {
    content = fs.readFileSync(src, "utf8");
  } catch {
    return false;
  }
  const converted = convert(content);
  fs.mkdirSync(path.dirname(tgt), { recursive: true });
  fs.writeFileSync(tgt, converted);
  return true;
}

// 1. Walk source, copy changed files
const srcFiles = walk(SRC);
let copied = 0;
for (const rel of srcFiles) {
  const src = path.join(SRC, rel);
  const tgt = path.join(TGT, rel);
  let needsCopy = true;
  if (fs.existsSync(tgt)) {
    try {
      const a = convert(fs.readFileSync(src, "utf8"));
      const b = fs.readFileSync(tgt, "utf8");
      if (a === b) needsCopy = false;
    } catch {}
  }
  if (needsCopy) {
    if (copyFile(rel)) copied++;
  }
}
console.log(`Copied/updated ${copied} files from source`);

// 2. Ensure OpenCode plugin exists
const pluginDir = path.join(TGT, "opencode", "plugins");
fs.mkdirSync(pluginDir, { recursive: true });
const pluginPath = path.join(pluginDir, "hooks.js");
if (!fs.existsSync(pluginPath)) {
  console.log("WARNING: opencode/plugins/hooks.js missing — create it manually");
}

// 3. Ensure .opencode-plugin manifests
const metaDir = path.join(TGT, ".opencode-plugin");
fs.mkdirSync(metaDir, { recursive: true });
if (!fs.existsSync(path.join(metaDir, "plugin.json"))) {
  fs.writeFileSync(path.join(metaDir, "plugin.json"), JSON.stringify({
    name: "everything-open-code",
    description: "OpenCode V2 port of everything-claude-code",
    version: "1.0.0-opencode",
    keywords: ["opencode", "agents", "skills", "hooks", "commands", "rules"],
    commands: "./commands",
    skills: "./skills",
    agents: "./agents",
    rules: "./rules",
    plugins: "./opencode/plugins",
  }, null, 2) + "\n");
  console.log("Created .opencode-plugin/plugin.json");
}
if (!fs.existsSync(path.join(metaDir, "marketplace.json"))) {
  fs.writeFileSync(path.join(metaDir, "marketplace.json"), JSON.stringify({
    name: "everything-open-code",
    owner: { name: "Affaan Mustafa", email: "affaan@example.com" },
    metadata: { description: "OpenCode V2 port of everything-claude-code" },
    plugins: [{
      name: "everything-open-code",
      source: "./",
      description: "OpenCode V2 port of everything-claude-code",
      author: { name: "Affaan Mustafa" },
      homepage: "https://github.com/WorldFlowAI/everything-open-code",
      repository: "https://github.com/WorldFlowAI/everything-open-code",
      license: "MIT",
      keywords: ["opencode", "agents", "skills", "hooks", "commands"],
      categories: ["Code Generation", "Code Review", "Security", "Testing", "Automation"],
    }],
  }, null, 2) + "\n");
  console.log("Created .opencode-plugin/marketplace.json");
}

// 4. Verify no Claude refs remain (excluding port.js itself)
let leftover = "";
try {
  leftover = execSync(
    `grep -rn "\\.claude\\b\\|CLAUDE_TRANSCRIPT\\|CLAUDE_PLUGIN_ROOT\\|getClaudeDir\\|Claude Code" "${TGT}" --include="*.md" --include="*.js" --include="*.json" --include="*.sh" 2>/dev/null | grep -v "\\.git/" | grep -v "scripts/port.js" || true`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
} catch {}
if (leftover) {
  console.log("WARNING: leftover refs:\n" + leftover.slice(0, 800));
} else {
  console.log("OK: no leftover refs");
}

console.log("Port complete.");