import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSecretFiles,
  checkDocs,
  checkQualityScripts,
  summarize,
  maskOutput,
  formatText,
} from './ship-check.mjs';

test('checkSecretFiles flags tracked secrets, dedupes and honours the allowlist', () => {
  const findings = checkSecretFiles({
    root: 'C:/p',
    changedFiles: ['.env', '.env.example', 'config/.env.local'],
    trackedFiles: ['.env', 'credentials.json', 'src/a.ts'],
    allow: ['config/.env.local'],
  });
  // `.env` is both tracked and changed: reported once as tracked. The
  // allowlisted `config/.env.local` and `.env.example` are ignored.
  assert.deepEqual(findings.map((f) => f.code), ['secret-tracked', 'secret-tracked']);
  assert.ok(findings.some((f) => f.message.includes('.env')));
  assert.ok(findings.some((f) => f.message.includes('credentials.json')));
});

test('checkSecretFiles flags a changed secret that is not tracked', () => {
  const findings = checkSecretFiles({
    root: '/p',
    changedFiles: ['config/.env.local', 'src/a.ts'],
    trackedFiles: [],
    allow: [],
  });
  assert.deepEqual(findings.map((f) => f.code), ['secret-changed']);
  assert.ok(findings[0].message.includes('config/.env.local'));
});

test('checkSecretFiles returns nothing for a clean change set', () => {
  assert.deepEqual(checkSecretFiles({
    root: '/p', changedFiles: ['.env.example', 'src/a.ts'], trackedFiles: ['README.md'],
  }), []);
});

test('checkDocs warns about CLAUDE.md, Production section and changelog', () => {
  const warnings = checkDocs({ rootFiles: [], claudeMd: '', changedFiles: ['src/a.ts'] }).map((f) => f.code);
  assert.ok(warnings.includes('claude-md-missing'));
  assert.ok(warnings.includes('changelog-missing'));

  const withDocs = checkDocs({
    rootFiles: ['CLAUDE.md', 'CAMBIOS.md'],
    claudeMd: '## Overview\n\n...\n',
    changedFiles: ['src/a.ts'],
  }).map((f) => f.code);
  assert.ok(withDocs.includes('production-section-missing'));
  assert.ok(withDocs.includes('changelog-not-updated'));

  const updated = checkDocs({
    rootFiles: ['CLAUDE.md', 'CAMBIOS.md'],
    claudeMd: '## Production\n\n- Platform: Vercel\n',
    changedFiles: ['src/a.ts', 'CAMBIOS.md'],
  });
  assert.deepEqual(updated, []);
});

test('checkDocs honours a custom changelog file from .devcrew.json', () => {
  const findings = checkDocs({
    rootFiles: ['CLAUDE.md', 'NOTES.md'],
    claudeMd: '## Production\n',
    changedFiles: ['src/a.ts', 'NOTES.md'],
    config: { changelogFile: 'NOTES.md' },
  });
  assert.deepEqual(findings, []);
});

test('checkQualityScripts reports each declared script and failure details', () => {
  const findings = checkQualityScripts({
    scripts: { test: 'node --test', lint: 'eslint .', build: 'vite build' },
    results: { test: { ok: true, output: '' }, lint: { ok: false, output: 'error: unused var' }, build: { ok: true, output: '' } },
  });
  assert.equal(findings.filter((f) => f.level === 'pass').length, 2);
  const failed = findings.find((f) => f.code === 'script-lint');
  assert.equal(failed.level, 'fail');
  assert.equal(failed.detail, 'error: unused var');
});

test('checkQualityScripts skips execution and warns when no quality script exists', () => {
  assert.deepEqual(checkQualityScripts({ scripts: {}, skip: true }), []);
  assert.equal(checkQualityScripts({ scripts: {} })[0].code, 'no-quality-scripts');
});

test('summarize computes verdicts and ok flag', () => {
  assert.equal(summarize([finding('pass', 'a', 'a')], '/p').verdict, 'PASS');
  assert.equal(summarize([finding('warn', 'a', 'a')], '/p').verdict, 'PASS WITH WARNINGS');
  const failed = summarize([finding('fail', 'a', 'a')], '/p');
  assert.equal(failed.verdict, 'FAIL');
  assert.equal(failed.ok, false);
});

test('maskOutput redacts tokens and credentials in URLs', () => {
  const masked = maskOutput('key=sk_live_1234567890 Bearer abcdef123456 https://user:pass@example.com/x');
  assert.ok(!masked.includes('1234567890'));
  assert.ok(!masked.includes('abcdef123456'));
  assert.ok(!masked.includes('user:pass'));
  assert.ok(masked.includes('sk_l…'));
});

test('formatText prints levels and the final result line', () => {
  const text = formatText(summarize([finding('warn', 'x', 'message')], '/p'));
  assert.ok(text.includes('[WARN] x: message'));
  assert.ok(text.includes('RESULT: PASS WITH WARNINGS (0 pass, 1 warn, 0 fail)'));
});

function finding(level, code, message, detail) {
  return { level, code, message, ...(detail === undefined ? {} : { detail }) };
}
