# Everything OpenCode — Setup Guide

Complete OpenCode V2 toolkit: agents, skills, hooks, commands, and rules.
Port of `WorldFlowAI/everything-claude-code`, rewritten for the OpenCode V2 plugin API.

## What's Inside

| Type | Items |
|------|-------|
| **Agents** | architect, build-error-resolver, code-reviewer, doc-updater, e2e-runner, planner, refactor-cleaner, security-reviewer, tdd-guide |
| **Skills** | backend-patterns, clickhouse-io, coding-standards, continuous-learning, eval-harness, frontend-patterns, project-guidelines-example, security-review, strategic-compact, tdd-workflow, verification-loop |
| **Commands** | /build-fix, /checkpoint, /code-review, /e2e, /eval, /learn, /orchestrate, /plan, /refactor-clean, /setup-pm, /tdd, /test-coverage, /update-codemaps, /update-docs, /verify |
| **Rules** | agents, coding-style, git-workflow, hooks, patterns, performance, security, testing |
| **Hooks** | memory-persistence, strategic-compact (V2 plugin) |
| **Plugins** | hooks.js — OpenCode V2 plugin (tool.execute.before/after, session hooks, event stream) |

## Install

```bash
# 1. Clone this repo
git clone https://github.com/cleaner55555/everything-open-code.git ~/Projects/everything-open-code
cd ~/Projects/everything-open-code

# 2. Copy the hooks plugin to OpenCode's auto-load directory
mkdir -p ~/.opencode/plugins
cp opencode/plugins/hooks.js ~/.opencode/plugins/hooks.js

# 3. (Optional) Add to your global opencode.json:
#    "plugin": ["~/.opencode/plugins/hooks.js"]
```

OpenCode auto-loads plugins from `~/.opencode/plugins/` — no config edit needed.

## Quick Start Workflows

### Starting a New Feature

```
1. /plan              # Plan the implementation approach
2. /tdd               # Write tests first
3. /verify            # Validate changes work
4. /code-review       # Self-review before PR
5. /checkpoint        # Save progress state
```

### Debugging Build Errors

```
/build-fix            # Analyzes build errors and suggests fixes
```

### Code Quality Review

```
/code-review          # Comprehensive code review
/refactor-clean       # Identify refactoring opportunities
```

### Learning & Memory

```
/learn               # Extract patterns mid-session
/checkpoint          # Save verification state
```

## Agent Routing

| Task | Agent |
|------|-------|
| Architecture decisions | `architect` |
| Feature planning | `planner` |
| Test-driven development | `tdd-guide` |
| Security-sensitive changes | `security-reviewer` |
| Writing tests first | `/tdd` → tdd-guide agent |
| Cleaning up code | `/refactor-clean` → refactor-cleaner |
| Validating changes | `/verify` → verification-loop skill |

## Hooks

The hooks plugin (`~/.opencode/plugins/hooks.js`) provides:

- **Session start** — loads previous context, reports package manager
- **Session end** — persists session state to `~/.opencode/sessions/`
- **Pre-tool-use** — blocks dev servers outside tmux, warns on `git push`
- **Post-tool-use** — logs PR URLs, warns on `console.log` in JS/TS
- **Pre-compact** — logs compaction events
- **Write guard** — blocks creation of stray `.md`/`.txt` files

## File Locations

```
~/Projects/everything-open-code/   # Source repo
~/.opencode/plugins/hooks.js      # Hooks plugin (auto-loaded)
~/.opencode/sessions/             # Session memory files
~/.opencode/skills/               # Skill directory
~/.config/opencode/opencode.json  # Global config
~/.local/share/opencode/opencode.db  # Session database (SQLite)
```

## Updating

```bash
cd ~/Projects/everything-open-code
git pull

# Re-copy the hooks plugin after changes:
cp opencode/plugins/hooks.js ~/.opencode/plugins/hooks.js
```

## Troubleshooting

**Plugin not loading:**
```bash
ls ~/.opencode/plugins/hooks.js  # Verify file exists
tail -50 ~/.local/share/opencode/log/opencode.log  # Check for errors
```

**Hooks not firing:**
```bash
grep -i "everything-open-code" ~/.local/share/opencode/log/opencode.log
```

**Commands not working:**
```bash
ls ~/.opencode/skills/  # Verify skills are present
```

**To reset:**
```bash
rm ~/.opencode/plugins/hooks.js
rm -rf ~/.opencode/sessions
```