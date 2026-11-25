import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSecretPath, isAllowed, loadAllowlist } from '../hooks/lib/secret-paths.mjs';

const QUALITY_SCRIPTS = ['test', 'lint', 'typecheck', 'build'];

export function finding(level, code, message, detail) {
  return { level, code, message, ...(detail === undefined ? {} : { detail }) };
}

/** Never emit a credential, even inside a captured command output. */
export function maskOutput(text) {
  return String(text ?? '')
    .replace(/\b(sk|pk|ghp|gho|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{6,}/g, (m) => `${m.slice(0, 4)}…`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1<redacted>')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1<redacted>@');
}

export function checkSecretFiles({ changedFiles = [], trackedFiles = [], allow = [], root = process.cwd() }) {
  const findings = [];
  const changed = new Set(changedFiles.filter(isSecretPath).filter((f) => !isAllowed(f, root, allow)));
  const tracked = new Set(trackedFiles.filter(isSecretPath).filter((f) => !isAllowed(f, root, allow)));
  for (const file of tracked) {
    findings.push(finding('fail', 'secret-tracked', `Secret-like file is tracked by git: ${file}`));
  }
  for (const file of changed) {
    if (tracked.has(file)) continue;
    findings.push(finding('fail', 'secret-changed', `Secret-like file is in the change set: ${file}`));
  }
  return findings;
}

export function checkDocs({ rootFiles = [], claudeMd = '', changedFiles = [], config = {} }) {
  const findings = [];
  const hasClaudeMd = rootFiles.some((f) => f.toLowerCase() === 'claude.md');
  if (!hasClaudeMd) {
    findings.push(finding('warn', 'claude-md-missing', 'No CLAUDE.md at the project root; run devcrew:init-project.'));
  } else if (!/^##\s+Production\s*$/im.test(claudeMd)) {
    findings.push(finding('warn', 'production-section-missing', 'CLAUDE.md has no ## Production section; devcrew:production-investigator will ask for it.'));
  }

  const changelog = config.changelogFile
    || ['CHANGELOG.md', 'CAMBIOS.md'].find((name) => rootFiles.some((f) => f.toLowerCase() === name.toLowerCase()));
  if (!changelog) {
    findings.push(finding('warn', 'changelog-missing', 'No changelog found; run devcrew:init-project.'));
  } else if (changedFiles.length > 0 && !changedFiles.some((f) => f.toLowerCase() === changelog.toLowerCase())) {
    findings.push(finding('warn', 'changelog-not-updated', `No entry for this change set in ${changelog}.`));
  }
  return findings;
}

export function checkQualityScripts({ scripts = {}, results = {}, skip = false }) {
  if (skip) return [];
  const available = QUALITY_SCRIPTS.filter((name) => typeof scripts[name] === 'string');
  if (available.length === 0) {
    return [finding('warn', 'no-quality-scripts', 'No test/lint/typecheck/build script in package.json.')];
  }
  const findings = [];
  for (const name of available) {
    const result = results[name];
    if (!result) {
      findings.push(finding('warn', `script-not-run-${name}`, `${name} is declared but was not run.`));
    } else if (result.ok) {
      findings.push(finding('pass', `script-${name}`, `npm run ${name} passed.`));
    } else {
      findings.push(finding('fail', `script-${name}`, `npm run ${name} failed.`, maskOutput(result.output)));
    }
  }
  return findings;
}

export function summarize(findings, root) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const f of findings) counts[f.level] += 1;
  const verdict = counts.fail > 0 ? 'FAIL' : counts.warn > 0 ? 'PASS WITH WARNINGS' : 'PASS';
  return {
    tool: 'devcrew ship-check',
    root,
    verdict,
    counts,
    findings,
    ok: counts.fail === 0,
  };
}

export function formatText(report) {
  const lines = [`devcrew ship-check — ${report.root}`, ''];
  for (const f of report.findings) {
    lines.push(`[${f.level.toUpperCase()}] ${f.code}: ${f.message}`);
    if (f.detail) lines.push(`         ${f.detail.split('\n').filter(Boolean).slice(-3).join('\n         ')}`);
  }
  lines.push('', `RESULT: ${report.verdict} (${report.counts.pass} pass, ${report.counts.warn} warn, ${report.counts.fail} fail)`);
  return lines.join('\n');
}

function gitFiles(args, root) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (r.error || r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\0').filter(Boolean);
}

function readConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.devcrew.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readPackage(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function runNpmScript(name, root) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', name], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 5 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

export function runShipCheck({ root = process.cwd(), json = false, skipScripts = false } = {}) {
  const safeRoot = path.resolve(root);
  const config = readConfig(safeRoot);
  const allow = loadAllowlist(safeRoot);
  const isRepo = spawnSync('git', ['-C', safeRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).status === 0;

  const changedFiles = isRepo
    ? [
      ...gitFiles(['diff', '--cached', '--name-only', '-z'], safeRoot),
      ...gitFiles(['diff', '--name-only', '-z'], safeRoot),
      ...gitFiles(['ls-files', '--others', '--exclude-standard', '-z'], safeRoot),
    ]
    : [];
  const trackedFiles = isRepo ? gitFiles(['ls-files', '-z'], safeRoot) : [];

  let rootFiles = [];
  try {
    rootFiles = fs.readdirSync(safeRoot);
  } catch { /* checked below as missing docs */ }
  const claudePath = path.join(safeRoot, 'CLAUDE.md');
  const claudeMd = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf8') : '';

  const findings = [
    ...(isRepo ? [] : [finding('warn', 'not-a-git-repo', 'Not a git repository; change detection skipped.')]),
    ...checkSecretFiles({ changedFiles, trackedFiles, allow, root: safeRoot }),
    ...checkDocs({ rootFiles, claudeMd, changedFiles, config }),
  ];

  const scripts = readPackage(safeRoot).scripts || {};
  const toRun = skipScripts ? [] : QUALITY_SCRIPTS.filter((name) => typeof scripts[name] === 'string');
  const results = {};
  for (const name of toRun) results[name] = runNpmScript(name, safeRoot);
  findings.push(...checkQualityScripts({ scripts, results, skip: skipScripts }));

  const report = summarize(findings, safeRoot);
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatText(report)}\n`);
  return report.ok ? 0 : 1;
}

function parseArgs(argv) {
  const opts = { root: process.cwd(), json: false, skipScripts: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--no-scripts') opts.skipScripts = true;
    else if (argv[i] === '--root' && argv[i + 1]) opts.root = argv[++i];
    else if (argv[i] === '--help') {
      process.stdout.write('Usage: node ship-check.mjs [--root <path>] [--json] [--no-scripts]\n');
      process.exit(0);
    }
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runShipCheck(parseArgs(process.argv.slice(2)));
}
