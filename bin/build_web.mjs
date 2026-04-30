import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const isWindows = process.platform === 'win32';
const command = isWindows ? 'powershell' : 'sh';
const args = isWindows
  ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'bin', 'build.ps1')]
  : [path.join(projectRoot, 'bin', 'build.sh')];

const result = spawnSync(command, args, {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
