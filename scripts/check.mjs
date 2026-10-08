import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkDocuments } from './documents.mjs';

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
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const requireCheck = (condition, message) => { if (!condition) throw new Error(message); };
const marketplace = json('.agents/plugins/marketplace.json');
const plugin = json(join(root, '.codex-plugin/plugin.json'));
const pkg = json(join(root, 'package.json'));
const lock = json(join(root, 'package-lock.json'));
const project = json('package.json');
requireCheck([project.version, lock.version, lock.packages[''].version, plugin.version].every(version => version === pkg.version), 'Product versions must match.');
requireCheck(project.private === true && pkg.private === true, 'These packages use Codex source installation. Keep them private.');
requireCheck(project.license === 'MIT' && pkg.license === 'MIT' && lock.packages[''].license === 'MIT', 'Package license fields must be MIT.');
requireCheck(readFileSync('LICENSE', 'utf8') === readFileSync(join(root, 'LICENSE'), 'utf8'), 'Product license copies must match.');
requireCheck(marketplace.name === 'cross-session-local' && marketplace.plugins.some(entry => entry.name === plugin.name && resolve(entry.source) === root), 'Marketplace source must point to the product.');
for (const path of [plugin.skills, plugin.mcpServers, plugin.hooks, './src/mcp.mjs', './src/hooks.mjs', './skills/cross-session/SKILL.md', './package-lock.json']) {
  requireCheck(typeof path === 'string' && existsSync(resolve(root, path)), `Missing plugin file: ${path}`);
}
const documents = checkDocuments();
requireCheck(documents.passed, documents.errors.join('\n'));
console.log(`Plugin syntax, versions, licenses, source files, and bilingual documents passed (${documents.pairs} language pairs, ${documents.links} local links).`);
