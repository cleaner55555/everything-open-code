// everything-open-code — hooks plugin (OpenCode V2)
//
// Port of WorldFlowAI/everything-claude-code hooks.json + scripts/hooks/*.js
// to the OpenCode V2 plugin API.
//
// Loads from: ~/.opencode/plugins/ (auto) or "plugins" array in opencode.json.
// Reference for the working V2 hook shape: graphify.js in the same folder.
//
// Mapping Claude Code -> OpenCode V2:
//   PreToolUse (Bash/Write/Edit)  -> ctx.tool.hook("execute.before", ...)
//   PostToolUse                   -> ctx.tool.hook("execute.after", ...)
//   SessionStart                  -> setup(ctx) (runs when plugin loads)
//   PreCompact                    -> ctx.session.hook("compaction", ...)
//   Stop / SessionEnd             -> event stream (session.idle / session.end)
//
// NOTE: the tool name for shell commands in OpenCode V2 is "shell"
// (it was "bash" in V1). Write/Edit tools are "write" and "edit".

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import { execSync } from "child_process";
import os from "os";

// ---------------------------------------------------------------------------
// Shared state (one server process serves many sessions)
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const OPENCODE_DIR = join(HOME, ".opencode");
const SESSIONS_DIR = join(OPENCODE_DIR, "sessions");
const LEARNED_DIR = join(OPENCODE_DIR, "skills", "learned");
const COMPACTION_LOG = join(SESSIONS_DIR, "compaction-log.txt");

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const ensureDir = (dir) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};

const sessionFile = () => join(SESSIONS_DIR, `${today()}-session.tmp`);

// ---------------------------------------------------------------------------
// SessionStart — load previous context, report package manager
// ---------------------------------------------------------------------------

function detectPackageManager(dir) {
  const locks = [
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["Cargo.toml", "cargo"],
    ["Makefile", "make"],
  ];
  for (const [file, pm] of locks) {
    if (existsSync(join(dir, file))) return { name: pm, source: "lockfile" };
  }
  return { name: "npm", source: "default" };
}

function sessionStartInfo(dir) {
  const lines = [];
  ensureDir(SESSIONS_DIR);
  ensureDir(LEARNED_DIR);

  // Recent session files (last 7 days)
  let recent = 0;
  let latest = null;
  if (existsSync(SESSIONS_DIR)) {
    const cutoff = Date.now() - 7 * 86400000;
    for (const f of readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith("-session.tmp")) continue;
      const p = join(SESSIONS_DIR, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs >= cutoff) {
          recent++;
          if (!latest || st.mtimeMs > statSync(latest).mtimeMs) latest = p;
        }
      } catch {}
    }
  }
  if (recent > 0) {
    lines.push(`[SessionStart] ${recent} recent session file(s) available in ${SESSIONS_DIR}. Latest: ${latest}`);
    lines.push("[SessionStart] Read the latest one to restore context before asking the user anything.");
  }

  // Learned skills
  if (existsSync(LEARNED_DIR)) {
    const learned = readdirSync(LEARNED_DIR).filter((f) => f.endsWith(".md"));
    if (learned.length > 0) {
      lines.push(`[SessionStart] ${learned.length} learned skill(s) in ${LEARNED_DIR}: ${learned.join(", ")}`);
    }
  }

  // Package manager
  const pm = detectPackageManager(dir);
  lines.push(`[SessionStart] Package manager: ${pm.name} (${pm.source})`);
  if (pm.source === "default") {
    lines.push("[SessionStart] No lockfile detected — confirm the package manager before running install/test commands.");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// SessionEnd / Stop — persist session state
// ---------------------------------------------------------------------------

function persistSession() {
  try {
    ensureDir(SESSIONS_DIR);
    const file = sessionFile();
    const time = nowTime();

    if (existsSync(file)) {
      const content = readFileSync(file, "utf8");
      writeFileSync(
        file,
        content.replace(/\*\*Last Updated:\*\* .*/, `**Last Updated:** ${time}`)
      );
    } else {
      writeFileSync(
        file,
        `# Session: ${today()}
**Date:** ${today()}
**Started:** ${time}
**Last Updated:** ${time}

---

## Current State

[fill before ending the session — agent does this]

### Completed
- [ ]

### In Progress
- [ ]

### Notes for Next Session
-

### Context to Load
\`\`\`
[relevant files]
\`\`\`
`
      );
    }
  } catch (err) {
    // never block the user on bookkeeping
    console.error("[everything-open-code] session persist error:", err.message);
  }
}

// ---------------------------------------------------------------------------
// PreCompact — log compaction + flag the active session file
// ---------------------------------------------------------------------------

function logCompaction() {
  try {
    ensureDir(SESSIONS_DIR);
    appendFileSync(COMPACTION_LOG, `[${today()} ${nowTime()}] Context compaction triggered\n`);
    const file = sessionFile();
    if (existsSync(file)) {
      appendFileSync(file, `\n---\n**[Compaction occurred at ${nowTime()}]** - Context was summarized\n`);
    }
  } catch (err) {
    console.error("[everything-open-code] compaction log error:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(dir, cmd) {
  try {
    return execSync(cmd, { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function isGitRepo(dir) {
  return git(dir, "git rev-parse --git-dir") !== null;
}

// ---------------------------------------------------------------------------
// Command-pattern guards (from hooks.json PreToolUse)
// ---------------------------------------------------------------------------

const DEV_SERVER_RE = /(^|\s|;|&&|\|)(npm|pnpm run|yarn|bun run)\s+dev\b/;
const LONG_CMD_RE = /(^|\s|;|&&|\|)(npm (install|test|run test)|pnpm (install|test)|yarn (install|test)?|bun (install|test)|cargo build|make|docker|pytest|vitest|playwright)\b/;
const GIT_PUSH_RE = /\bgit\s+push\b/;

export default {
  id: "everything-open-code-hooks",

  async setup(ctx) {
    const dir = ctx.location.directory;

    // ---- SessionStart: remind once per session that context may exist ----
    const started = new Set();

    // ---- tool.execute.before (PreToolUse) ----
    await ctx.tool.hook("execute.before", (event) => {
      const tool = event.tool;
      const input = event.input || {};

      // Session-start reminder on first tool call
      if (!started.has(event.sessionID)) {
        started.add(event.sessionID);
        const info = sessionStartInfo(dir);
        if (info) {
          event.output = {
            ...event.output,
            messages: [
              ...(event.output?.messages || []),
              { type: "text", text: info },
            ],
          };
        }
      }

      // Bash/shell guards
      if (tool === "shell" && typeof input.command === "string") {
        const cmd = input.command;

        if (DEV_SERVER_RE.test(cmd)) {
          throw new Error(
            "[everything-open-code] BLOCKED: Dev server must run in tmux for log access.\n" +
            "Use: tmux new-session -d -s dev \"<your dev command>\"\n" +
            "Then: tmux attach -t dev"
          );
        }

        if (LONG_CMD_RE.test(cmd) && !process.env.TMUX) {
          console.error("[everything-open-code] Consider running in tmux for session persistence: tmux new -s dev | tmux attach -t dev");
        }

        if (GIT_PUSH_RE.test(cmd)) {
          console.error("[everything-open-code] Reminder: review changes before push (git diff --stat, git log).");
        }
      }

      // Write guard: block stray .md files (keep docs consolidated)
      if (tool === "write" && typeof input.filePath === "string") {
        const p = input.filePath;
        if (/\.(md|txt)$/.test(p) && !/(README|CLAUDE|AGENTS|CONTRIBUTING|SKILL)\.md$/i.test(basename(p))) {
          throw new Error(
            `[everything-open-code] BLOCKED: unnecessary documentation file creation.\nFile: ${p}\nUse README.md (or the existing doc file) instead of creating new .md/.txt files.`
          );
        }
      }
    });

    // ---- tool.execute.after (PostToolUse) ----
    await ctx.tool.hook("execute.after", (event) => {
      const tool = event.tool;
      const input = event.input || {};

      // shell: log PR URL after `gh pr create`
      if (tool === "shell" && typeof input.command === "string" && /gh\s+pr\s+create/.test(input.command)) {
        const out = JSON.stringify(event.output || {});
        const m = out.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
        if (m) {
          console.error(`[everything-open-code] PR created: ${m[0]}`);
        }
      }

      // write/edit: JS/TS hygiene — console.log + tsc (best-effort, non-blocking)
      const p = input.filePath;
      if ((tool === "write" || tool === "edit") && typeof p === "string" && existsSync(p)) {
        if (/\.(ts|tsx|js|jsx)$/.test(p)) {
          try {
            const content = readFileSync(p, "utf8");
            const found = content.split("\n").filter((l) => /console\.log/.test(l)).slice(0, 5);
            if (found.length) {
              console.error(`[everything-open-code] WARNING: console.log in ${p}:`);
              found.forEach((l) => console.error("  " + l.trim()));
            }
          } catch {}
        }
      }
    });

    // ---- compaction hook (PreCompact) ----
    try {
      await ctx.session.hook("compaction", () => {
        logCompaction();
      });
    } catch {
      // session.hook may not be available in every V2 build — degrade gracefully
    }

    // ---- event stream: persist on idle/end ----
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const t = event.type || "";
          if (t === "session.idle" || t === "session.end" || t === "session.end.v2") {
            persistSession();
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("[everything-open-code] event stream error:", err.message);
        }
      }
    })();

    return () => {
      controller.abort();
      persistSession();
    };
  },

  // OpenCode 1: the command tool is "bash", and the server lives as long as
  // the session. V1 plugin API expects `server({ directory })` returning an
  // object of hook handlers. V2 ignores this; V1 needs it.
  async server({ directory }) {
    const started = new Set();
    return {
      "tool.execute.before": async (input, output) => {
        const tool = input.tool;
        const cmd = tool === "bash" ? output.args?.command : null;

        if (!started.has(directory)) {
          started.add(directory);
          const info = sessionStartInfo(directory);
          if (info) console.error(info);
        }

        if (tool === "bash" && typeof cmd === "string") {
          if (DEV_SERVER_RE.test(cmd)) {
            throw new Error(
              "[everything-open-code] BLOCKED: Dev server must run in tmux for log access.\n" +
              "Use: tmux new-session -d -s dev \"<command>\"\nThen: tmux attach -t dev"
            );
          }
          if (LONG_CMD_RE.test(cmd) && !process.env.TMUX) {
            console.error("[everything-open-code] Consider running in tmux for session persistence: tmux new -s dev | tmux attach -t dev");
          }
          if (GIT_PUSH_RE.test(cmd)) {
            console.error("[everything-open-code] Reminder: review changes before push (git diff --stat).");
          }
        }

        if (tool === "write" && typeof input.file_path === "string") {
          const p = input.file_path;
          if (/\.(md|txt)$/.test(p) && !/(README|CLAUDE|AGENTS|CONTRIBUTING|SKILL)\.md$/i.test(p)) {
            throw new Error(
              `[everything-open-code] BLOCKED: unnecessary documentation file creation.\nFile: ${p}\nUse README.md (or the existing doc file) instead of creating new .md/.txt files.`
            );
          }
        }
      },

      "tool.execute.after": async (input, output) => {
        const tool = input.tool;
        const cmd = tool === "bash" ? output.args?.command : null;

        if (tool === "bash" && cmd && /gh\s+pr\s+create/.test(cmd)) {
          const out = JSON.stringify(output);
          const m = out.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
          if (m) console.error(`[everything-open-code] PR created: ${m[0]}`);
        }

        const p = input.file_path;
        if ((tool === "write" || tool === "edit") && typeof p === "string" && existsSync(p)) {
          if (/\.(ts|tsx|js|jsx)$/.test(p)) {
            try {
              const content = readFileSync(p, "utf8");
              const found = content.split("\n").filter((l) => /console\.log/.test(l)).slice(0, 5);
              if (found.length) {
                console.error(`[everything-open-code] WARNING: console.log in ${p}:`);
                found.forEach((l) => console.error("  " + l.trim()));
              }
            } catch {}
          }
        }
      },
    };
  },
};
