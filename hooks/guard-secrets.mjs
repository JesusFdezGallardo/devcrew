import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isSecretPath, isAllowed, loadAllowlist } from './lib/secret-paths.mjs';
import { checkCommand } from './lib/command-check.mjs';

const FILE_TOOLS = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', Grep: 'path' };
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
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
  const projectRoot = findProjectRoot(cwd);
  const allow = loadAllowlist(projectRoot);

  if (tool in FILE_TOOLS) {
    const filePath = toolInput[FILE_TOOLS[tool]];
    if (typeof filePath !== 'string' || !filePath) return null;
    if (isSecretPath(filePath) && !isAllowed(filePath, projectRoot, allow)) {
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
    const gitFiles = (args) => {
      try {
        return git(args, projectRoot).split(/\r?\n/).filter(Boolean);
      } catch {
        return [];
      }
    };
    const result = checkCommand(command, { projectRoot, allow, gitFiles });
    return result.decision === 'allow' ? null : result;
  }

  return null;
}

try {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (err) {
    process.stderr.write(`[devcrew] could not parse hook input, allowing: ${err.message}\n`);
    process.exit(0);
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
} catch (err) {
  process.stderr.write(`[devcrew] internal error, allowing: ${err.message}\n`);
}
process.exit(0);
