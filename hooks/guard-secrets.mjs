import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isSecretPath, isAllowed, loadAllowlist } from './lib/secret-paths.mjs';
import { checkCommand } from './lib/command-check.mjs';

const FILE_TOOLS = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', Grep: 'path' };
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function findProjectRoot(cwd) {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd).trim() || cwd;
  } catch {
    return cwd;
  }
}

function decide(input) {
  const tool = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const cwd = input.cwd || process.cwd();
  // Root and allowlist cost a git spawn and file I/O: resolve them at most once, only when needed.
  let ctx;
  const context = () => (ctx ??= (() => {
    const projectRoot = findProjectRoot(cwd);
    return { projectRoot, allow: loadAllowlist(projectRoot) };
  })());

  if (tool in FILE_TOOLS) {
    const filePath = toolInput[FILE_TOOLS[tool]];
    if (typeof filePath !== 'string' || !filePath) return null;
    if (!isSecretPath(filePath)) return null;
    const { projectRoot, allow } = context();
    if (!isAllowed(filePath, projectRoot, allow)) {
      return {
        decision: 'ask',
        reason: `${filePath} looks like a secrets file. Allow it only if intended; to silence this for a file that is not secret, add it to the secretsGuard.allow list in .devcrew.json.`,
      };
    }
    return null;
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = toolInput.command;
    if (typeof command !== 'string' || !command) return null;
    // Cheap pre-check: only commands mentioning git or a secret-looking token can matter.
    const relevant = /\bgit\b/i.test(command) || command.split(/[\s"'|&;<>()]+/).some((t) => t && isSecretPath(t));
    if (!relevant) return null;
    const { projectRoot, allow } = context();
    // Run git where the command runs, so pathspecs such as `.` mean the same thing. Callers pass -z: NUL-separated
    // output is never quoted, so core.quotepath cannot hide a non-ASCII path.
    const gitFiles = (args) => {
      try {
        return git(args, cwd).split('\0').filter(Boolean);
      } catch {
        return [];
      }
    };
    const result = checkCommand(command, { projectRoot, allow, gitFiles });
    return result.decision === 'allow' ? null : result;
  }

  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (err) {
    process.stderr.write(`[devcrew] could not parse hook input, allowing: ${err.message}\n`);
    return;
  }
  const result = decide(input ?? {});
  if (result) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: result.decision,
        permissionDecisionReason: result.reason,
      },
    }));
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`[devcrew] internal error, allowing: ${err.message}\n`);
}
// Set the exit code and let the process end on its own: exiting right after stdout.write could cut off the
// decision when stdout is a pipe.
process.exitCode = 0;
