import { isSecretPath, isAllowed } from './secret-paths.mjs';

const READ_COMMANDS = new Set([
  'cat', 'type', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'findstr',
  'get-content', 'gc', 'select-string', 'sls', 'cp', 'copy', 'copy-item',
  'base64', 'xxd', 'strings',
]);

// Git global options that consume the next token as their value.
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
// Short `git commit` options that take a value (the rest of the token, or the next one).
const COMMIT_VALUE_FLAGS = new Set(['m', 'F', 'C', 'c', 'S', 'u']);

/** Split a command into segments (on && || ; | newline) of whitespace-separated, unquoted tokens. */
function parse(command) {
  const segments = [];
  let tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  const endToken = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '&' || c === '|' || c === ';' || c === '\n' || c === '\r') {
      endSegment();
    } else if (c === ' ' || c === '\t') {
      endToken();
    } else {
      cur += c;
      has = true;
    }
  }
  endSegment();
  return segments;
}

function stripExe(name) {
  return name.toLowerCase().replace(/\.exe$/, '');
}

function isCommitAll(args) {
  for (const a of args) {
    if (a === '--all') return true;
    if (/^-[A-Za-z]+$/.test(a)) {
      for (const ch of a.slice(1)) {
        if (ch === 'a') return true;
        if (COMMIT_VALUE_FLAGS.has(ch)) break;
      }
    }
  }
  return false;
}

export function checkCommand(command, ctx) {
  const { projectRoot, allow, gitFiles } = ctx;
  const isSecret = (p) => isSecretPath(p) && !isAllowed(p, projectRoot, allow);
  const asked = [];
  const denied = [];

  for (const tokens of parse(String(command ?? ''))) {
    const first = stripExe(tokens[0]);
    const rest = tokens.slice(1);

    if (first === 'git') {
      let i = 0;
      while (i < rest.length && rest[i].startsWith('-')) {
        i += GIT_OPTS_WITH_VALUE.has(rest[i]) ? 2 : 1;
      }
      const sub = rest[i];
      const args = rest.slice(i + 1);
      if (sub === 'add') {
        for (const a of args) {
          if (!a.startsWith('-') && isSecret(a)) denied.push(a);
        }
      } else if (sub === 'commit') {
        const files = [...gitFiles(['diff', '--cached', '--name-only'])];
        if (isCommitAll(args)) files.push(...gitFiles(['diff', '--name-only']));
        for (const f of files) {
          if (isSecret(f)) denied.push(f);
        }
      }
    } else if (READ_COMMANDS.has(first)) {
      for (const a of rest) {
        if (!a.startsWith('-') && isSecret(a)) asked.push(a);
      }
    }
  }

  if (denied.length) {
    const files = [...new Set(denied)].join(', ');
    return {
      decision: 'deny',
      reason: `Refusing to stage or commit ${files}: secrets must not be committed. Unstage it or add it to .gitignore.`,
    };
  }
  if (asked.length) {
    const files = [...new Set(asked)].join(', ');
    return {
      decision: 'ask',
      reason: `This command reads ${files}, which looks like a secrets file. Allow it only if intended; to silence this for a file that is not secret, add it to the secretsGuard.allow list in .devcrew.json.`,
    };
  }
  return { decision: 'allow' };
}
