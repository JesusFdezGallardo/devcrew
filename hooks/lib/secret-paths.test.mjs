import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSecretPath, globToRegExp, loadAllowlist, isAllowed } from './secret-paths.mjs';

const SECRET = [
  '.env', '.env.local', '.env.production', 'C:\\proj\\.ENV', 'server.pem', '.\\certs\\server.PEM',
  'tls.key', 'cert.p12', 'cert.pfx', 'id_rsa', 'id_ed25519', 'id_ecdsa_work', 'credentials.json',
  'credentials-prod.json', 'vision-credentials.json', 'config\\Credentials.json', 'service-account.json',
  'service-account-ci.json', 'tokens/StoredCredential',
];
const NOT_SECRET = [
  '.env.example', '.env.sample', '.env.template', 'id_rsa.pub', 'README.md', 'env.ts', 'credentials.ts',
  'keys.json', 'src/.environment.ts', 'monkey.java',
];

for (const p of SECRET) test(`secret: ${p}`, () => assert.equal(isSecretPath(p), true));
for (const p of NOT_SECRET) test(`not secret: ${p}`, () => assert.equal(isSecretPath(p), false));

test('globToRegExp', () => {
  assert.equal(globToRegExp('.env.production').test('.env.production'), true);
  assert.equal(globToRegExp('config/**/*.json').test('config/a/b/x.json'), true);
  assert.equal(globToRegExp('config/**/*.json').test('config.json'), false);
  assert.equal(globToRegExp('*.json').test('a/b.json'), false);
  assert.equal(globToRegExp('a?.txt').test('ab.txt'), true);
  assert.equal(globToRegExp('.ENV').test('.env'), true);
});

test('isAllowed', () => {
  assert.equal(isAllowed('C:\\p\\.env.production', 'C:\\p', ['.env.production']), true);
  assert.equal(isAllowed('C:\\p\\.env.production', 'C:\\p', ['.env.dev']), false);
  assert.equal(isAllowed('C:\\other\\.env.production', 'C:\\p', ['.env.production']), false);
  assert.equal(isAllowed('C:\\p\\..\\q\\.env', 'C:\\p', ['**']), false);
  assert.equal(isAllowed('config/.env.production', 'C:\\p', ['config/*']), true);
});

test('isAllowed with posix paths', () => {
  assert.equal(isAllowed('/r/app/.env.production', '/r/app', ['.env.production']), true);
  assert.equal(isAllowed('/r/app2/.env.production', '/r/app', ['**']), false);
});

test('loadAllowlist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devcrew-'));
  try {
    assert.deepEqual(loadAllowlist(dir), []);
    fs.writeFileSync(path.join(dir, '.devcrew.json'), '{"secretsGuard":{"allow":["a"]}}');
    assert.deepEqual(loadAllowlist(dir), ['a']);
    fs.writeFileSync(path.join(dir, '.devcrew.json'), '{not json');
    assert.deepEqual(loadAllowlist(dir), []);
    fs.writeFileSync(path.join(dir, '.devcrew.json'), '{"secretsGuard":{"allow":"x"}}');
    assert.deepEqual(loadAllowlist(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
