# Everything OpenCode - WorldFlowAI Setup Guide

Quick reference for using the everything-open-code toolkit with synapse and arbiter projects.

## Installed Components

| Type | Items |
|------|-------|
| **Agents** | architect, build-error-resolver, code-reviewer, planner, refactor-cleaner, security-reviewer, tdd-guide |
| **Commands** | /build-fix, /checkpoint, /code-review, /learn, /plan, /refactor-clean, /tdd, /verify |
| **Skills** | backend-patterns, coding-standards, continuous-learning, eval-harness, security-review, verification-loop |
| **Rules** | coding-style, git-workflow, security, testing |
| **Hooks** | memory-persistence, strategic-compact, continuous-learning-activator |

## Quick Start Workflows

### Starting a New Feature

```
1. /plan              # Plan the implementation approach
2. /tdd               # Write tests first
3. /verify            # Validate changes work
4. /code-review       # Self-review before PR
5. /checkpoint        # Save progress state
```

### Debugging Build Errors (Synapse/Rust)

```
/build-fix            # Analyzes cargo errors and suggests fixes
```

### Code Quality Review

```
/code-review          # Comprehensive code review
/refactor-clean       # Identify refactoring opportunities
```

### Learning & Memory

```
/learn                # Extract reusable knowledge from current session
/checkpoint           # Save session state for later resumption
```

## Project-Specific Guidance

### Synapse (Rust Workspace)

**Best agents for synapse:**
- `build-error-resolver` - Rust compile errors can be cryptic
- `architect` - Multi-crate workspace decisions
- `security-reviewer` - LLM data handling requires scrutiny

**Typical workflow:**
```bash
# In synapse directory
claude

# Plan feature
> /plan

# After implementation
> cargo build 2>&1 | head -50  # If errors...
> /build-fix

# Before PR
> /code-review
> cargo +nightly fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

**Key synapse patterns:**
- Use `parking_lot::{Mutex,RwLock}` not std
- Max 100 char line width
- Clippy pedantic + nursery enabled
- Conventional commits required

### Arbiter (ML/Python)

**Best agents for arbiter:**
- `tdd-guide` - ML code benefits from test-driven approach
- `architect` - Pipeline architecture decisions
- `eval-harness` - Model evaluation patterns

**Typical workflow:**
```bash
# In arbiter directory
claude

# Plan experiment/feature
> /plan

# Test-driven development
> /tdd

# Validate
> /verify
```

**Key arbiter patterns:**
- Recall-focused metrics (safety critical)
- PII/Org sensitivity handling
- Model lifecycle management

## Hooks (Automatic)

These run automatically - no action needed:

| Hook | When | What it does |
|------|------|--------------|
| SessionStart | New session | Loads recent session context |
| PreCompact | Before /compact | Saves state before context reduction |
| Stop | Session end | Persists learnings, runs continuous-learning |
| PreToolUse (Edit/Write) | Every ~50 edits | Suggests running /compact |

### Memory Persistence

Sessions automatically save state to `~/.opencode/sessions/`. To resume:
```
# Start new session, previous context loads automatically
claude

# Or explicitly reference a session file
> @~/.opencode/sessions/2026-01-23-feature-x.tmp
```

### Strategic Compaction

After ~50 tool calls, you'll see a suggestion to run `/compact`. This helps maintain context quality during long sessions.

## When to Use Each Agent

| Situation | Agent/Command |
|-----------|---------------|
| Planning new feature | `/plan` → planner agent |
| Designing system architecture | architect agent |
| Fixing Rust compile errors | `/build-fix` → build-error-resolver |
| Pre-PR quality check | `/code-review` → code-reviewer |
| Security-sensitive changes | security-reviewer agent |
| Writing tests first | `/tdd` → tdd-guide agent |
| Cleaning up code | `/refactor-clean` → refactor-cleaner |
| Validating changes | `/verify` → verification-loop skill |

## Updating

```bash
cd ~/dev/worldflowai/everything-open-code
git pull

# Symlinks auto-update, but hooks need re-copy if changed:
cp -r hooks/memory-persistence ~/.opencode/hooks/
cp -r hooks/strategic-compact ~/.opencode/hooks/
chmod +x ~/.opencode/hooks/*/*.sh
```

## File Locations

```
~/dev/worldflowai/everything-open-code/   # Source repo
~/.opencode/agents/                            # Agent symlinks
~/.opencode/commands/                          # Command symlinks
~/.opencode/skills/                            # Skill symlinks
~/.opencode/rules/                             # Rule symlinks
~/.opencode/hooks/                             # Hook scripts (copied)
~/.opencode/hooks.json                         # Hook configuration
~/.opencode/sessions/                          # Session memory files
```

## Troubleshooting

**Commands not working:**
```bash
ls -la ~/.opencode/commands/  # Check symlinks exist and point correctly
```

**Hooks not firing:**
```bash
cat ~/.opencode/hooks.json    # Verify config is valid JSON
ls -la ~/.opencode/hooks/     # Check scripts are executable
```

**To reset installation:**
```bash
rm -rf ~/.opencode/agents ~/.opencode/commands ~/.opencode/rules
rm -rf ~/.opencode/hooks/memory-persistence ~/.opencode/hooks/strategic-compact
rm ~/.opencode/hooks.json
# Then re-run installation
```
