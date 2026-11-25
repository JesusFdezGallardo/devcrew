import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseServers, resolveHeaders, probeRemote, performHandshake, formatText } from './mcp-check.mjs';

test('parseServers normalizes local and remote servers and flags invalid ones', () => {
  const servers = parseServers([
    {
      source: '.mcp.json',
      data: {
        mcpServers: {
          codegraph: { command: 'npx', args: ['-y', 'pkg'] },
          sentry: { type: 'http', url: 'https://mcp.example.com/mcp' },
          broken: {},
        },
      },
    },
  ]);
  assert.equal(servers.length, 3);
  assert.equal(servers.find((s) => s.name === 'codegraph').type, 'local');
  assert.deepEqual(servers.find((s) => s.name === 'codegraph').args, ['-y', 'pkg']);
  assert.equal(servers.find((s) => s.name === 'sentry').type, 'remote');
  assert.match(servers.find((s) => s.name === 'broken').invalid, /command or url/);
});

test('parseServers lets the project config override an earlier source by name', () => {
  const servers = parseServers([
    { source: 'global', data: { mcpServers: { sentry: { command: 'old' } } } },
    { source: '.mcp.json', data: { mcpServers: { sentry: { url: 'https://new.example.com/mcp' } } } },
  ]);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].url, 'https://new.example.com/mcp');
  assert.equal(servers[0].source, '.mcp.json');
});

test('resolveHeaders expands variables and never invents values', () => {
  const resolved = resolveHeaders(
    { Authorization: 'Bearer ${TOKEN}', 'X-Env': '$MISSING' },
    { TOKEN: 'abc123' },
  );
  assert.equal(resolved.Authorization, 'Bearer abc123');
  assert.equal(resolved['X-Env'], '');
});

test('probeRemote classifies reachable, auth-required, invalid and unreachable', async () => {
  const ok = await probeRemote({ url: 'https://mcp.example.com/mcp', fetchFn: async () => ({ status: 200 }) });
  assert.equal(ok.level, 'pass');

  const auth = await probeRemote({ url: 'https://mcp.example.com/mcp', fetchFn: async () => ({ status: 401 }) });
  assert.equal(auth.level, 'warn');

  const bad = await probeRemote({ url: 'not a url', fetchFn: async () => ({ status: 200 }) });
  assert.equal(bad.level, 'fail');

  const down = await probeRemote({ url: 'https://mcp.example.com/mcp', fetchFn: async () => { throw new Error('offline'); } });
  assert.equal(down.level, 'warn');
});

function fakeChild({ exitBeforeResponse = false } = {}) {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  child.stdout = stdout;
  child.stdin = {
    write(message) {
      if (exitBeforeResponse) {
        child.emit('exit', 1);
        return;
      }
      if (message.includes('"id":1')) {
        stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`));
      }
      if (message.includes('"id":2')) {
        stdout.emit('data', Buffer.from(`${JSON.stringify({
          jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'a' }, { name: 'b' }] },
        })}\n`));
      }
    },
  };
  child.kill = () => {};
  return child;
}

test('performHandshake completes initialize + tools/list and counts tools', async () => {
  const result = await performHandshake({ command: 'fake', spawnFn: () => fakeChild() });
  assert.deepEqual(result, { ok: true, tools: 2 });
});

test('performHandshake reports a server that exits before responding', async () => {
  const result = await performHandshake({ command: 'fake', spawnFn: () => fakeChild({ exitBeforeResponse: true }) });
  assert.equal(result.ok, false);
  assert.match(result.detail, /exited with code 1/);
});

test('formatText prints levels and the final result line', () => {
  const text = formatText([
    { level: 'pass', code: 'a', message: 'healthy' },
    { level: 'warn', code: 'b', message: 'needs auth', detail: 'HTTP 401' },
  ], '/p');
  assert.ok(text.includes('[PASS] a: healthy'));
  assert.ok(text.includes('HTTP 401'));
  assert.ok(text.includes('RESULT: PASS WITH WARNINGS (1 pass, 1 warn, 0 fail)'));
});
