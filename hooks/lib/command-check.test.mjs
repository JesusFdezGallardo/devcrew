import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommand } from './command-check.mjs';

const mk = (over = {}) => ({
  projectRoot: '/proj',
  allow: [],
  gitFiles: () => [],
  ...over,
});

const asks = [
  'cat .env',
  'head -n 5 config/.env.local',
  'type .env',
  String.raw`Get-Content .\.env`,
  'gc credentials.json',
  'Select-String -Path .env -Pattern X',
  'grep KEY .env',
  'npm test && cat .env',
  'type .env | findstr X',
  'cp .env /tmp/x',
  'Copy-Item .env x.txt',
  'less "server.pem"',
  "cat '.env'",
  String.raw`Get-Content -LiteralPath .\.env`,
];
for (const cmd of asks) {
  test(`ask: ${cmd}`, () => {
    const r = checkCommand(cmd, mk());
    assert.equal(r.decision, 'ask');
    assert.match(r.reason, /\.devcrew\.json/);
    assert.match(r.reason, /\.env|credentials\.json|server\.pem/);
  });
}

for (const cmd of ['git add .env', 'git add src/ .env', 'git add -- credentials.json', 'git -C sub add .env']) {
  test(`deny: ${cmd}`, () => {
    const r = checkCommand(cmd, mk());
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /\.env|credentials\.json/);
    assert.match(r.reason, /must not be committed/);
  });
}

test('deny commit with staged secret', () => {
  const calls = [];
  const gitFiles = (args) => {
    calls.push(args.join(' '));
    return ['src/a.ts', '.env'];
  };
  const r = checkCommand('git commit -m "x"', mk({ gitFiles }));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /\.env/);
  assert.deepEqual(calls, ['diff --cached --name-only']);
});

for (const flag of ['-am', '-a', '--all', '-av']) {
  test(`deny commit ${flag} with unstaged tracked secret`, () => {
    const gitFiles = (args) => (args.includes('--cached') ? [] : ['credentials.json']);
    const r = checkCommand(`git commit ${flag} "x"`, mk({ gitFiles }));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /credentials\.json/);
  });
}

test('commit without -a does not look at unstaged', () => {
  const gitFiles = (args) => (args.includes('--cached') ? [] : ['credentials.json']);
  assert.equal(checkCommand('git commit -m x', mk({ gitFiles })).decision, 'allow');
  assert.equal(checkCommand('git commit --amend -m x', mk({ gitFiles })).decision, 'allow');
});

test('allow commit with clean staged files', () => {
  const r = checkCommand('git commit -m "x"', mk({ gitFiles: () => ['src/a.ts'] }));
  assert.equal(r.decision, 'allow');
});

test('allowlisted staged secret is allowed', () => {
  const r = checkCommand('git commit -m x', mk({ allow: ['.env.production'], gitFiles: () => ['.env.production'] }));
  assert.equal(r.decision, 'allow');
});

const allows = [
  'echo "copy .env.example to .env"',
  'cat .env.example',
  'ls -la',
  'git status',
  'cat README.md',
  'git add src/ README.md',
];
for (const cmd of allows) {
  test(`allow: ${cmd}`, () => {
    assert.deepEqual(checkCommand(cmd, mk()), { decision: 'allow' });
  });
}

test('allowlist permits cat .env.production', () => {
  const r = checkCommand('cat .env.production', mk({ allow: ['.env.production'] }));
  assert.equal(r.decision, 'allow');
});

test('deny wins over ask in compound commands', () => {
  assert.equal(checkCommand('cat .env && git add .env', mk()).decision, 'deny');
});
