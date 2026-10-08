import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve('plugins/cross-session');
function walk(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.json')) JSON.parse(readFileSync(file, 'utf8'));
    else if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', file], { windowsHide: true });
  }
}
walk(root);
walk(resolve('scripts'));
JSON.parse(readFileSync('.agents/plugins/marketplace.json', 'utf8'));
console.log('Plugin JSON and JavaScript checks passed.');
