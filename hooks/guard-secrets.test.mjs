import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'guard-secrets.mjs');
let tmp;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'devcrew-hook-'));
  writeFileSync(join(tmp, '.devcrew.json'), JSON.stringify({ secretsGuard: { allow: ['.env.production'] } }));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function run(input) {
  const r = spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function decision(r) {
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  return out.hookSpecificOutput;
}

function assertAllow(r) {
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
}

test('Read of .env asks and mentions .devcrew.json', () => {
  const d = decision(run({ tool_name: 'Read', tool_input: { file_path: join(tmp, '.env') }, cwd: tmp }));
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /\.env/);
  assert.match(d.permissionDecisionReason, /\.devcrew\.json/);
});

test('Edit and Write of a .pem ask', () => {
  for (const tool_name of ['Edit', 'Write']) {
    const d = decision(run({ tool_name, tool_input: { file_path: join(tmp, 'server.pem') }, cwd: tmp }));
    assert.equal(d.permissionDecision, 'ask');
  }
});

test('Grep on a secret file asks; Grep on a folder or without path allows', () => {
  const d = decision(run({ tool_name: 'Grep', tool_input: { path: join(tmp, '.env'), pattern: 'x' }, cwd: tmp }));
  assert.equal(d.permissionDecision, 'ask');
  assertAllow(run({ tool_name: 'Grep', tool_input: { path: tmp, pattern: 'x' }, cwd: tmp }));
  assertAllow(run({ tool_name: 'Grep', tool_input: { pattern: 'x' }, cwd: tmp }));
});

test('Bash git add .env is denied', () => {
  const d = decision(run({ tool_name: 'Bash', tool_input: { command: 'git add .env' }, cwd: tmp }));
  assert.equal(d.permissionDecision, 'deny');
});

test('PowerShell Get-Content .env asks', () => {
  const d = decision(run({ tool_name: 'PowerShell', tool_input: { command: 'Get-Content .env' }, cwd: tmp }));
  assert.equal(d.permissionDecision, 'ask');
});

test('allowlisted .env.production is allowed silently', () => {
  assertAllow(run({ tool_name: 'Read', tool_input: { file_path: join(tmp, '.env.production') }, cwd: tmp }));
});

test('.env.example is allowed silently', () => {
  assertAllow(run({ tool_name: 'Read', tool_input: { file_path: join(tmp, '.env.example') }, cwd: tmp }));
});

test('malformed stdin fails open with a [devcrew] warning', () => {
  const r = run('not json {');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^\[devcrew\]/);
});

test('unknown tool allows silently', () => {
  assertAllow(run({ tool_name: 'Foo', tool_input: { file_path: join(tmp, '.env') }, cwd: tmp }));
});

test('git commit in a non-git directory allows silently', () => {
  assertAllow(run({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: tmp }));
});

test('internal error (tool_input missing) fails open with a warning', () => {
  const r = run({ tool_name: 'Read', cwd: tmp });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// A fake `git` (a copy of node) first on PATH; NODE_OPTIONS makes it drop a marker file when launched.
function runWithGitSpy(input) {
  const bin = join(tmp, 'spy-bin');
  const marker = join(tmp, 'git-called');
  const exe = process.platform === 'win32' ? 'git.exe' : 'git';
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, join(bin, exe));
  chmodSync(join(bin, exe), 0o755);
  const preload = join(tmp, 'spy.cjs');
  writeFileSync(preload, `if (/^git(\.exe)?$/i.test(require('path').basename(process.execPath))) require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
  rmSync(marker, { force: true });
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PATH: bin + delimiter + process.env.PATH, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
  });
  return { r, spawned: existsSync(marker) };
}

test('fast path: ordinary Read and Bash do not spawn git', () => {
  const read = runWithGitSpy({ tool_name: 'Read', tool_input: { file_path: join(tmp, 'src', 'app.ts') }, cwd: tmp });
  assert.equal(read.r.status, 0);
  assert.equal(read.r.stdout, '');
  assert.equal(read.spawned, false);
  const bash = runWithGitSpy({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: tmp });
  assert.equal(bash.r.stdout, '');
  assert.equal(bash.spawned, false);
});

test('spy sanity: a secret Read does spawn git', () => {
  const { r, spawned } = runWithGitSpy({ tool_name: 'Read', tool_input: { file_path: join(tmp, '.env') }, cwd: tmp });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(spawned, true);
});
