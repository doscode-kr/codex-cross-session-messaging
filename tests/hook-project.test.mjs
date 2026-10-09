import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';

const execute = promisify(execFile);
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
const moduleUrl = new URL('../plugins/cross-session/src/hooks.mjs', import.meta.url).href;
async function git(cwd, args) {
  return (await execute('git', args, { cwd, env: clean, windowsHide: true })).stdout.trim();
}
async function probe(cwd, overrides) {
  const script = `
    import {runHook} from ${JSON.stringify(moduleUrl)};
    const before=JSON.stringify(process.env);
    let project;
    await runHook({hook_event_name:'SessionStart',session_id:'fixture',cwd:process.argv[1]},
      {async hook(input,root){project=root}});
    console.log(JSON.stringify({project,environmentUnchanged:before===JSON.stringify(process.env)}));
  `;
  return JSON.parse((await execute(process.execPath, ['--input-type=module', '-e', script, cwd],
    { env: { ...clean, ...overrides }, windowsHide: true })).stdout);
}

test('hook project lookup uses cwd despite inherited Git repository settings', async t => {
  const root = temporary(t);
  const repo = join(root, 'actual repo'), foreign = join(root, 'foreign repo'), linked = join(root, 'linked tree'), outside = join(root, 'outside');
  for (const dir of [repo, foreign, outside]) { mkdirSync(dir); }
  await git(repo, ['init']); await git(foreign, ['init']);
  await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  await git(repo, ['worktree', 'add', '--detach', linked]);
  const common = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const poison = {
    GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign, GIT_COMMON_DIR: join(foreign, '.git'),
    GIT_INDEX_FILE: join(foreign, 'other-index'), GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: foreign
  };
  for (const cwd of [repo, linked, outside]) {
    for (const overrides of [{}, poison, { git_dir: join(foreign, '.git'), git_work_tree: foreign, git_common_dir: join(foreign, '.git') }]) {
      const actual = await probe(cwd, overrides);
      assert.equal(actual.project, cwd === outside ? outside : common);
      assert.equal(actual.environmentUnchanged, true);
    }
  }
});
