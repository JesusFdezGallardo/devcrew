import fs from 'node:fs';
import path from 'node:path';

const ENV_SAFE_SUFFIXES = new Set(['example', 'sample', 'template']);

function toSlashes(p) {
  return String(p).replace(/\\/g, '/');
}

function basename(filePath) {
  const parts = toSlashes(filePath).split('/');
  return parts[parts.length - 1];
}

export function isSecretPath(filePath) {
  const name = basename(filePath).toLowerCase();
  if (name === '.env') return true;
  if (name.startsWith('.env.')) return !ENV_SAFE_SUFFIXES.has(name.slice(5));
  if (/\.(pem|key|p12|pfx)$/.test(name)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)/.test(name)) return !name.endsWith('.pub');
  if (/^credentials.*\.json$/.test(name)) return true;
  if (/-credentials\.json$/.test(name)) return true;
  if (/^service-account.*\.json$/.test(name)) return true;
  return name === 'storedcredential';
}

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

export function loadAllowlist(projectRoot) {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.devcrew.json'), 'utf8');
    const allow = JSON.parse(raw)?.secretsGuard?.allow;
    return Array.isArray(allow) ? allow.filter((g) => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

function isAbsolutePath(p) {
  return p.startsWith('/') || /^[a-zA-Z]:\//.test(p);
}

export function isAllowed(filePath, projectRoot, allow) {
  if (!Array.isArray(allow) || allow.length === 0) return false;
  const root = path.posix.normalize(toSlashes(projectRoot)).replace(/\/+$/, '');
  const rawFile = toSlashes(filePath);
  const file = path.posix.normalize(isAbsolutePath(rawFile) ? rawFile : `${root}/${rawFile}`);
  const prefix = `${root}/`;
  if (!file.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  const rel = file.slice(prefix.length);
  if (rel === '' || rel.split('/').includes('..')) return false;
  return allow.some((g) => globToRegExp(toSlashes(g)).test(rel));
}
