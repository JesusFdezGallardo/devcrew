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
  assert.deepEqual(calls, ['diff --cached --name-only -z']);
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

// Search and copy commands: only file / source operands are checked, not patterns or destinations.
const searchCopyAllows = [
  'grep -n ".env" .gitignore',
  String.raw`grep -rn "\.env" src/`,
  'cat .gitignore | grep .env',
  'Select-String -Pattern ".env" -Path README.md',
  'sls .env README.md',
  'rg -n ".env" docs',
  'grep -e .env -e KEY README.md',
  'findstr /C:".env" README.md',
  'findstr .env .gitignore',
  'cp .env.example .env',
  'copy .env.example .env',
  'Copy-Item .env.example .env',
  'Copy-Item -Destination .env -Path .env.example',
];
for (const cmd of searchCopyAllows) {
  test(`allow (pattern or destination only): ${cmd}`, () => {
    assert.deepEqual(checkCommand(cmd, mk()), { decision: 'allow' });
  });
}

const moreAsks = [
  'grep -e KEY .env',
  'grep -A 2 KEY .env',
  'grep -f .env README.md',
  'rg -n TOKEN .env',
  'Select-String KEY .env',
  'Select-String -Pattern KEY -LiteralPath .env',
  'Select-String -Path README.md,.env -Pattern KEY',
  'findstr KEY .env',
  'cp -t /tmp .env',
  'Copy-Item -Path .env -Destination x.txt',
  'sed -n 1p .env',
  "awk -F= '{print $1}' .env",
  'nl .env',
  'bat .env',
  'od -c .env',
  'hexdump -C .env',
  '(cat .env)',
  '$(cat .env)',
  'echo $(cat .env)',
  '$x = Get-Content .env',
  '$x=Get-Content .env',
  '$env:SECRET = (Get-Content .env)',
];
for (const cmd of moreAsks) {
  test(`ask: ${cmd}`, () => {
    const r = checkCommand(cmd, mk());
    assert.equal(r.decision, 'ask');
    assert.match(r.reason, /\.env/);
  });
}

// A fake repository for `gitFiles`: answers the git queries the checker makes, honoring pathspecs.
function fakeRepo({ staged = [], modified = [], untracked = [], ignored = [] } = {}) {
  const calls = [];
  const gitFiles = (args) => {
    calls.push(args.join(' '));
    assert.ok(args.includes('-z'), `git called without -z: ${args.join(' ')}`);
    const sep = args.indexOf('--');
    const specs = sep === -1 ? [] : args.slice(sep + 1);
    const inSpec = (f) => specs.length === 0
      || specs.some((s) => s === '.' || f === s || f.startsWith(s.replace(/\/?$/, '/')));
    let files;
    if (args[0] === 'diff' && args.includes('--cached')) files = staged;
    else if (args[0] === 'diff') files = modified;
    else if (args[0] === 'ls-files') files = args.includes('--exclude-standard') ? untracked : [...untracked, ...ignored];
    else files = [];
    return files.filter(inSpec);
  };
  return { gitFiles, calls };
}

for (const cmd of ['git add -A && git commit -m x', 'git add . ; git commit -m x', 'git add --all', 'git add src/', 'git add -A src']) {
  test(`deny broad add with an untracked, un-ignored secret: ${cmd}`, () => {
    const { gitFiles } = fakeRepo({ untracked: ['src/a.ts', 'src/.env'] });
    const r = checkCommand(cmd, mk({ gitFiles }));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /src\/\.env/);
  });
}

test('broad add allows when the secret is gitignored', () => {
  const { gitFiles } = fakeRepo({ untracked: ['src/a.ts'], ignored: ['.env'] });
  assert.equal(checkCommand('git add -A && git commit -m x', mk({ gitFiles })).decision, 'allow');
  assert.equal(checkCommand('git add .', mk({ gitFiles })).decision, 'allow');
});

test('git add -f . also looks at ignored files', () => {
  const { gitFiles } = fakeRepo({ ignored: ['.env'] });
  assert.equal(checkCommand('git add -f .', mk({ gitFiles })).decision, 'deny');
});

test('git add -u checks modified tracked files only', () => {
  const tracked = fakeRepo({ modified: ['credentials.json'] });
  assert.equal(checkCommand('git add -u', mk({ gitFiles: tracked.gitFiles })).decision, 'deny');
  assert.ok(tracked.calls.every((c) => !c.startsWith('ls-files')));
  const untracked = fakeRepo({ untracked: ['.env'] });
  assert.equal(checkCommand('git add --update', mk({ gitFiles: untracked.gitFiles })).decision, 'allow');
});

test('broad add with an allowlisted secret is allowed', () => {
  const { gitFiles } = fakeRepo({ untracked: ['.env.production'] });
  assert.equal(checkCommand('git add -A', mk({ allow: ['.env.production'], gitFiles })).decision, 'allow');
});

test('broad add pathspec outside the secret is allowed', () => {
  const { gitFiles } = fakeRepo({ untracked: ['.env', 'src/a.ts'] });
  assert.equal(checkCommand('git add src/', mk({ gitFiles })).decision, 'allow');
});

for (const cmd of ['git commit -m x -- .env', 'git commit .env -m x', 'git commit -m x .env', 'git commit -a -m x credentials.json']) {
  test(`deny commit with a secret pathspec: ${cmd}`, () => {
    const r = checkCommand(cmd, mk());
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /\.env|credentials\.json/);
  });
}

test('commit pathspec directory with a modified tracked secret is denied', () => {
  const { gitFiles } = fakeRepo({ modified: ['config/.env'] });
  assert.equal(checkCommand('git commit -m x config/', mk({ gitFiles })).decision, 'deny');
});

for (const cmd of [
  'git commit -m "fix .env loading"',
  'git commit -m .env',
  'git commit --message .env',
  'git commit -F msg.txt',
  'git commit --author "A <a@example.com>" -m x',
]) {
  test(`allow commit whose option values only mention a secret: ${cmd}`, () => {
    assert.equal(checkCommand(cmd, mk()).decision, 'allow');
  });
}

test('every git query uses -z', () => {
  const { gitFiles, calls } = fakeRepo();
  checkCommand('git add -A && git commit -am x src/', mk({ gitFiles }));
  assert.ok(calls.length >= 3, calls.join('; '));
});
