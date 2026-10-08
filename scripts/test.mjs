import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const files = readdirSync(join(root, 'tests'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => join(root, 'tests', entry.name))
    .sort();
  if (!files.length) throw new Error('No test files were found.');
  const child = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
    cwd: root, windowsHide: true, stdio: 'inherit'
  });
  if (child.error) throw child.error;
  if (child.signal) throw new Error(`The test process stopped with signal ${child.signal}.`);
  process.exitCode = child.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
