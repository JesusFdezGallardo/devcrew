import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 8000;

export function item(level, code, message, detail) {
  return { level, code, message, ...(detail === undefined ? {} : { detail }) };
}

/** Read `.mcp.json` and `.claude/settings.json`, project root winning on name clashes. */
export function parseServers(configs) {
  const servers = new Map();
  for (const { source, data } of configs) {
    const list = data?.mcpServers;
    if (!list || typeof list !== 'object') continue;
    for (const [name, raw] of Object.entries(list)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const isLocal = typeof raw.command === 'string' && raw.command.length > 0;
      const isRemote = typeof raw.url === 'string' && raw.url.length > 0;
      if (!isLocal && !isRemote) {
        servers.set(name, { name, source, invalid: 'needs command or url' });
      } else {
        servers.set(name, {
          name,
          source,
          type: isLocal ? 'local' : 'remote',
          command: isLocal ? raw.command : undefined,
          args: Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string') : [],
          url: isRemote ? raw.url : undefined,
          headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
          env: raw.env && typeof raw.env === 'object' ? raw.env : {},
        });
      }
    }
  }
  return [...servers.values()];
}

/** Substitute ${VAR} / $VAR from process.env. Values are never returned for display. */
export function resolveHeaders(headers, env = process.env) {
  const resolved = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (typeof value !== 'string') continue;
    resolved[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_, a, b) => env[a || b] || '');
  }
  return resolved;
}

export function lookupBinary(command, lookup) {
  try {
    return lookup(command);
  } catch {
    return null;
  }
}

/** MCP stdio handshake: initialize -> notifications/initialized -> tools/list. */
export function performHandshake({ command, args = [], env = {}, spawnFn = spawn, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child;
    let done = false;
    let buffer = '';
    let timer;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* already gone */ }
      resolve(result);
    };

    try {
      child = spawnFn(command, args, {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return finish({ ok: false, detail: error.message });
    }

    timer = setTimeout(() => finish({ ok: false, detail: `no response after ${timeoutMs}ms` }), timeoutMs);
    child.on('error', (error) => finish({ ok: false, detail: error.message }));
    child.on('exit', (code) => {
      if (!done) finish({ ok: false, detail: `exited with code ${code} before responding` });
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
        } else if (msg.id === 2) {
          const tools = Array.isArray(msg.result?.tools) ? msg.result.tools.length : 0;
          finish({ ok: true, tools });
        }
      }
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'devcrew-mcp-check', version: '0.1.0' },
      },
    })}\n`);
  });
}

export async function probeRemote({ url, headers = {}, fetchFn = fetch }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, level: 'fail', detail: 'invalid URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, level: 'fail', detail: 'unsupported URL scheme' };
  }
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json, text/event-stream', ...resolveHeaders(headers) },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: true, level: 'warn', detail: `HTTP ${response.status}: authentication required (run /mcp)` };
    }
    if (response.status >= 500) {
      return { ok: true, level: 'warn', detail: `HTTP ${response.status}: server error` };
    }
    return { ok: true, level: 'pass', detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: true, level: 'warn', detail: `unreachable from this machine (${error.name || 'fetch error'})` };
  }
}

export function formatText(results, root) {
  const lines = [`devcrew mcp-check — ${root}`, ''];
  for (const r of results) {
    lines.push(`[${r.level.toUpperCase()}] ${r.code}: ${r.message}`);
    if (r.detail) lines.push(`         ${r.detail}`);
  }
  const fail = results.filter((r) => r.level === 'fail').length;
  const warn = results.filter((r) => r.level === 'warn').length;
  const pass = results.filter((r) => r.level === 'pass').length;
  lines.push('', `RESULT: ${fail ? 'FAIL' : warn ? 'PASS WITH WARNINGS' : 'PASS'} (${pass} pass, ${warn} warn, ${fail} fail)`);
  return lines.join('\n');
}

function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function defaultLookup(command) {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(tool, [command], { encoding: 'utf8' });
  return r.status === 0 && r.stdout?.trim() ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

export async function runMcpCheck({ root = process.cwd(), json = false } = {}) {
  const safeRoot = path.resolve(root);
  const configs = [
    { source: '.mcp.json', data: readConfig(path.join(safeRoot, '.mcp.json')) },
    { source: '.claude/settings.json', data: readConfig(path.join(safeRoot, '.claude', 'settings.json')) },
  ].filter((c) => c.data);
  const servers = parseServers(configs);
  const results = [];

  if (servers.length === 0) {
    results.push(item('warn', 'no-servers', 'No MCP servers configured in .mcp.json or .claude/settings.json.'));
  }

  for (const server of servers) {
    if (server.invalid) {
      results.push(item('fail', server.name, `Invalid config in ${server.source}: ${server.invalid}.`));
      continue;
    }
    if (server.type === 'local') {
      const binary = lookupBinary(server.command, defaultLookup);
      if (!binary) {
        results.push(item('fail', server.name, `Local binary not found on PATH: ${server.command}.`));
        continue;
      }
      const handshake = await performHandshake({ command: server.command, args: server.args, env: server.env });
      results.push(handshake.ok
        ? item('pass', server.name, `Local server healthy — ${handshake.tools} tools exposed.`)
        : item('fail', server.name, `Local server failed: ${handshake.detail}`));
    } else {
      const probe = await probeRemote({ url: server.url, headers: server.headers });
      results.push(item(probe.level, server.name,
        probe.level === 'pass' ? `Remote server reachable — ${probe.detail}.`
          : probe.level === 'warn' ? `Remote server needs attention — ${probe.detail}.`
            : `Remote server invalid — ${probe.detail}.`));
    }
  }

  const report = { tool: 'devcrew mcp-check', root: safeRoot, results };
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatText(results, safeRoot)}\n`);
  return results.some((r) => r.level === 'fail') ? 1 : 0;
}

function parseArgs(argv) {
  const opts = { root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--root' && argv[i + 1]) opts.root = argv[++i];
    else if (argv[i] === '--help') {
      process.stdout.write('Usage: node mcp-check.mjs [--root <path>] [--json]\n');
      process.exit(0);
    }
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runMcpCheck(parseArgs(process.argv.slice(2)));
}
