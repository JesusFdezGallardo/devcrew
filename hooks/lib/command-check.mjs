import { isSecretPath, isAllowed } from './secret-paths.mjs';

// Commands whose non-option operands are all files that get read.
const READ_COMMANDS = new Set([
  'cat', 'type', 'head', 'tail', 'less', 'more', 'get-content', 'gc',
  'base64', 'xxd', 'strings', 'sed', 'awk', 'nl', 'bat', 'od', 'hexdump',
]);
// Search commands: the pattern operand is skipped, only file operands are checked.
const UNIX_SEARCH = new Set(['grep', 'rg']);
const PS_SEARCH = new Set(['select-string', 'sls']);
// Copy commands: only sources are checked (a secret-looking destination is written, not read).
const COPY_COMMANDS = new Set(['cp', 'copy', 'copy-item']);

// Short options that take a value (attached, or the next token) for each search tool. `e` and `f` are
// handled separately: `-e` gives the pattern, `-f` names a pattern file (which is read, so it is checked).
const SEARCH_SHORT_WITH_VALUE = {
  grep: new Set(['A', 'B', 'C', 'm', 'd', 'D']),
  rg: new Set(['A', 'B', 'C', 'm', 'g', 't', 'T', 'M', 'j', 'r', 'E']),
};
const SEARCH_LONG_WITH_VALUE = new Set([
  '--include', '--exclude', '--exclude-dir', '--max-count', '--context', '--after-context', '--before-context',
  '--glob', '--iglob', '--type', '--type-not', '--replace', '--max-depth', '--encoding', '--threads', '--label',
]);

// PowerShell parameters (lowercase) that take a value, with their aliases and positional order.
const SELECT_STRING_PARAMS = {
  pattern: { position: 0 },
  path: { position: 1 },
  literalpath: { aliases: ['lp', 'pspath'] },
  encoding: {}, context: {}, include: {}, exclude: {}, culture: {}, inputobject: {},
};
const COPY_ITEM_PARAMS = {
  path: { position: 0 },
  destination: { position: 1 },
  literalpath: { aliases: ['lp', 'pspath'] },
  filter: {}, include: {}, exclude: {}, credential: {}, tosession: {}, fromsession: {},
};
const PS_COPY_PARAM = /^-(path|literalpath|lp|pspath|destination)(:|$)/i;

// Git global options that consume the next token as their value.
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
// Short `git commit` options whose value is the rest of the token or, if nothing follows, the next token.
const COMMIT_SHORT_WITH_VALUE = new Set(['m', 'F', 'C', 'c', 't']);
// Short `git commit` options with an optional value that can only be attached (`-uno`, `-S<keyid>`).
const COMMIT_SHORT_OPTIONAL_VALUE = new Set(['u', 'S']);
const COMMIT_LONG_WITH_VALUE = new Set([
  '--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date',
  '--template', '--cleanup', '--trailer', '--pathspec-from-file',
]);

/**
 * Split a command into segments (on && || ; | ( ) newline) of whitespace-separated, unquoted tokens.
 * Parentheses split too, so `(cat .env)` and `$(cat .env)` expose the inner command.
 */
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
    } else if ('&|;()\n\r'.includes(c)) {
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

/** Drop a PowerShell assignment prefix: `$x = Get-Content .env` / `$x=Get-Content .env` -> `Get-Content .env`. */
function stripAssignment(tokens) {
  const m = /^\$[\w:]+=(.*)$/.exec(tokens[0]);
  if (m) return m[1] ? [m[1], ...tokens.slice(1)] : tokens.slice(1);
  if (tokens.length >= 2 && /^\$[\w:]+$/.test(tokens[0]) && tokens[1] === '=') return tokens.slice(2);
  return tokens;
}

function stripExe(name) {
  return name.toLowerCase().replace(/\.exe$/, '');
}

/** Operands of grep / rg that name files: the positionals after the pattern, plus `-f` pattern files. */
function unixSearchFiles(tool, args) {
  const valueShort = SEARCH_SHORT_WITH_VALUE[tool];
  const files = [];
  const positional = [];
  let patternGiven = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const takeValue = () => (eq === -1 ? args[++i] : a.slice(eq + 1));
      if (name === '--regexp') {
        patternGiven = true;
        takeValue();
      } else if (name === '--file') {
        patternGiven = true;
        const v = takeValue();
        if (v) files.push(v);
      } else if (eq === -1 && SEARCH_LONG_WITH_VALUE.has(name)) {
        i++;
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === 'e' || ch === 'f' || valueShort.has(ch)) {
          const v = a.slice(j + 1) || args[++i];
          if (ch === 'e') patternGiven = true;
          if (ch === 'f') {
            patternGiven = true;
            if (v) files.push(v);
          }
          break;
        }
      }
      continue;
    }
    positional.push(a);
  }
  return [...files, ...(patternGiven ? positional : positional.slice(1))];
}

/** Operands of findstr that name files: the positionals after the search string, plus /G: and /F: files. */
function findstrFiles(args) {
  const files = [];
  const positional = [];
  let patternGiven = false;
  for (const a of args) {
    const m = /^\/([A-Za-z]+)(?::(.*))?$/.exec(a);
    if (!m) {
      positional.push(a);
      continue;
    }
    const opt = m[1].toUpperCase();
    if (opt === 'C' || opt === 'G') patternGiven = true;
    if ((opt === 'G' || opt === 'F') && m[2]) files.push(m[2]);
  }
  return [...files, ...(patternGiven ? positional : positional.slice(1))];
}

/**
 * Bind PowerShell-style arguments to the given parameters (lowercase names, matched exactly, by alias or by
 * unique prefix). Unknown parameters are treated as switches. Positional arguments fill the unbound positional
 * parameters in order; any left over end up in `rest`. Comma-separated lists are split.
 */
function bindPowerShell(args, params) {
  const names = Object.keys(params);
  const resolve = (raw) => {
    const n = raw.toLowerCase();
    for (const name of names) {
      if (name === n || (params[name].aliases ?? []).includes(n)) return name;
    }
    const matches = names.filter((name) => name.startsWith(n));
    return matches.length === 1 ? matches[0] : null;
  };
  const bound = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^-([A-Za-z]\w*)(?::(.*))?$/.exec(a);
    if (!m) {
      positional.push(a);
      continue;
    }
    const name = resolve(m[1]);
    if (!name) continue;
    const value = m[2] !== undefined ? m[2] : args[++i];
    if (value !== undefined) (bound[name] ??= []).push(value);
  }
  const slots = names
    .filter((name) => params[name].position !== undefined && !bound[name])
    .sort((x, y) => params[x].position - params[y].position);
  for (const name of slots) {
    if (!positional.length) break;
    bound[name] = [positional.shift()];
  }
  const split = (list) => (list ?? []).flatMap((v) => v.split(',')).filter(Boolean);
  const result = { rest: split(positional) };
  for (const name of names) result[name] = split(bound[name]);
  return result;
}

/** Source operands of cp / copy / Copy-Item (in PowerShell, cp and copy are aliases of Copy-Item). */
function copySources(tool, args) {
  if (tool === 'copy-item' || args.some((a) => PS_COPY_PARAM.test(a))) {
    const b = bindPowerShell(args, COPY_ITEM_PARAMS);
    return [...b.path, ...b.literalpath];
  }
  const positional = [];
  let targetGiven = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-t' || a === '--target-directory') {
      targetGiven = true;
      i++;
    } else if (a === '-S' || a === '--suffix') {
      i++;
    } else if (a.startsWith('--target-directory=') || /^-t./.test(a)) {
      targetGiven = true;
    } else if (!a.startsWith('-') && !/^\/-?[A-Za-z]$/.test(a)) {
      // Not an option (cmd `copy` uses /Y, /B, ...).
      positional.push(a);
    }
  }
  if (targetGiven || positional.length < 2) return positional;
  return positional.slice(0, -1);
}

/**
 * What a `git add` would stage, as far as the secrets check cares: the explicit pathspecs, plus (for -A, -u, `.`,
 * directories and globs) the untracked, non-ignored files and modified tracked files those pathspecs cover.
 * The hook runs before git does, so the index cannot tell us yet.
 */
function gitAddCandidates(args, gitFiles) {
  let all = false;
  let update = false;
  let force = false;
  let dryRun = false;
  const specs = [];
  let endOpts = false;
  for (const a of args) {
    if (!endOpts && a === '--') {
      endOpts = true;
    } else if (!endOpts && a.startsWith('--')) {
      if (a === '--all' || a === '--no-ignore-removal') all = true;
      else if (a === '--update') update = true;
      else if (a === '--force') force = true;
      else if (a === '--dry-run') dryRun = true;
    } else if (!endOpts && a.startsWith('-') && a.length > 1) {
      if (a.includes('A')) all = true;
      if (a.includes('u')) update = true;
      if (a.includes('f')) force = true;
      if (a.includes('n')) dryRun = true;
    } else {
      specs.push(a);
    }
  }
  if (dryRun) return [];
  const candidates = [...specs];
  if (all || update || specs.length) {
    const tail = specs.length ? ['--', ...specs] : [];
    if (all || !update) {
      const ls = ['ls-files', '--others', ...(force ? [] : ['--exclude-standard']), '--full-name', '-z'];
      candidates.push(...gitFiles([...ls, ...tail]));
    }
    candidates.push(...gitFiles(['diff', '--name-only', '-z', '--diff-filter=d', ...tail]));
  }
  return candidates;
}

/** Parse `git commit` arguments into the -a/--all flag and the pathspecs (option values are skipped). */
function parseCommit(args) {
  let all = false;
  const specs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      specs.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      if (a === '--all') all = true;
      else if (COMMIT_LONG_WITH_VALUE.has(a)) i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === 'a') all = true;
        if (COMMIT_SHORT_OPTIONAL_VALUE.has(ch)) break;
        if (COMMIT_SHORT_WITH_VALUE.has(ch)) {
          if (j === a.length - 1) i++;
          break;
        }
      }
      continue;
    }
    specs.push(a);
  }
  return { all, specs };
}

export function checkCommand(command, ctx) {
  const { projectRoot, allow, gitFiles } = ctx;
  const isSecret = (p) => isSecretPath(p) && !isAllowed(p, projectRoot, allow);
  const asked = [];
  const denied = [];
  const ask = (files) => asked.push(...files.filter(isSecret));
  const deny = (files) => denied.push(...files.filter(isSecret));

  for (const segment of parse(String(command ?? ''))) {
    const tokens = stripAssignment(segment);
    if (!tokens.length) continue;
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
        deny(gitAddCandidates(args, gitFiles));
      } else if (sub === 'commit') {
        const { all, specs } = parseCommit(args);
        deny(specs);
        deny(gitFiles(['diff', '--cached', '--name-only', '-z']));
        if (all) deny(gitFiles(['diff', '--name-only', '-z', '--diff-filter=d']));
        if (specs.length) deny(gitFiles(['diff', '--name-only', '-z', '--diff-filter=d', '--', ...specs]));
      }
    } else if (READ_COMMANDS.has(first)) {
      ask(rest.filter((a) => !a.startsWith('-')));
    } else if (UNIX_SEARCH.has(first)) {
      ask(unixSearchFiles(first, rest));
    } else if (first === 'findstr') {
      ask(findstrFiles(rest));
    } else if (PS_SEARCH.has(first)) {
      const b = bindPowerShell(rest, SELECT_STRING_PARAMS);
      ask([...b.path, ...b.literalpath, ...b.rest]);
    } else if (COPY_COMMANDS.has(first)) {
      ask(copySources(first, rest));
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
