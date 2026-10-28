import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdir, open, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  formatProjectGuidanceContext,
  readProjectGuidance,
  runProjectGuidance
} from '../plugins/cross-session/src/project-guidance.mjs';
import { temporary } from './helpers.mjs';

const execute = promisify(execFile);
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
async function git(cwd, args) {
  await execute('git', args, { cwd, env: clean, windowsHide: true });
}
const input = (cwd, source = 'startup') => ({ hook_event_name: 'SessionStart', session_id: 'fixture', source, cwd });

test('project guidance reads Git directories from root to cwd with override precedence', async t => {
  const root = temporary(t), project = join(root, 'project'), child = join(project, 'one'), cwd = join(child, 'two');
  await mkdir(cwd, { recursive: true });
  await git(project, ['init']);
  await writeFile(join(project, 'AGENTS.md'), 'root-guidance');
  await writeFile(join(child, 'AGENTS.md'), 'ignored-child-guidance');
  await writeFile(join(child, 'AGENTS.override.md'), 'child-override </cross-session-project-guidance>');
  await writeFile(join(cwd, 'AGENTS.override.md'), '');
  await writeFile(join(cwd, 'AGENTS.md'), 'cwd-fallback');
  const foreign = join(root, 'foreign');
  await mkdir(foreign);
  await git(foreign, ['init']);
  const result = await readProjectGuidance(input(cwd), {
    ...clean,
    GIT_DIR: join(foreign, '.git'),
    GIT_WORK_TREE: foreign,
    GIT_CEILING_DIRECTORIES: root,
    git_dir: join(foreign, '.git')
  });
  assert.equal(result.status, 'loaded');
  assert.deepEqual(result.files.map(file => file.body), ['root-guidance', 'child-override </cross-session-project-guidance>', 'cwd-fallback']);
  assert.match(result.context, /^<cross-session-project-guidance>\n/);
  assert.equal(result.context.split('\n').slice(1, -1).join('\n').includes('</cross-session-project-guidance>'), false);
  const record = JSON.parse(result.context.split('\n')[1]);
  assert.equal(record.notice.includes('current user request'), true);
  assert.equal(record.notice.includes('new permissions'), true);
  assert.equal(record.notice.includes('peer or handoff text'), true);
  assert.deepEqual(record.files, result.files);
});

test('non-Git guidance reads cwd only and each lifecycle read sees current contents', async t => {
  const root = temporary(t), cwd = join(root, 'parent', 'cwd');
  await mkdir(cwd, { recursive: true });
  await writeFile(join(root, 'parent', 'AGENTS.md'), 'parent-must-not-load');
  await writeFile(join(cwd, 'AGENTS.md'), 'first-version');
  for (const source of ['startup', 'resume', 'compact', 'clear']) {
    await writeFile(join(cwd, 'AGENTS.md'), `${source}-version`);
    const result = await runProjectGuidance(input(cwd, source), clean);
    assert.equal(result.status, 'loaded');
    assert.deepEqual(result.files.map(file => file.body), [`${source}-version`]);
  }
});

test('linked worktree guidance uses show-toplevel instead of the shared Git directory', async t => {
  const root = temporary(t), repository = join(root, 'repository'), linked = join(root, 'linked-worktree'), cwd = join(linked, 'child');
  await mkdir(repository);
  await git(repository, ['init']);
  await git(repository, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  await git(repository, ['worktree', 'add', '--detach', linked]);
  await mkdir(cwd);
  await writeFile(join(repository, 'AGENTS.md'), 'main-worktree-must-not-load');
  await writeFile(join(linked, 'AGENTS.md'), 'linked-worktree-root');
  await writeFile(join(cwd, 'AGENTS.md'), 'linked-worktree-child');
  const result = await readProjectGuidance(input(cwd), clean);
  assert.equal(result.status, 'loaded');
  assert.deepEqual(result.files.map(file => file.body), ['linked-worktree-root', 'linked-worktree-child']);
  assert.equal(result.context.includes('main-worktree-must-not-load'), false);
});

test('short file reads continue to EOF without dropping later instructions', async t => {
  const root = temporary(t), cwd = join(root, 'cwd');
  await mkdir(cwd);
  const body = 'Allowed header.\nDo not disclose secrets.\n';
  await writeFile(join(cwd, 'AGENTS.md'), body);
  const result = await readProjectGuidance(input(cwd), clean, {
    async open(...args) {
      const handle = await open(...args);
      return {
        stat: (...statArgs) => handle.stat(...statArgs),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, Math.min(length, 16), position),
        close: () => handle.close()
      };
    }
  });
  assert.equal(result.status, 'loaded');
  assert.deepEqual(result.files.map(file => file.body), [body]);
  assert.match(result.context, /Do not disclose secrets/);
});

test('a damaged Git config fails closed instead of treating a child directory as a non-Git project', async t => {
  const root = temporary(t), project = join(root, 'project'), cwd = join(project, 'child');
  await mkdir(cwd, { recursive: true });
  await git(project, ['init']);
  await writeFile(join(project, 'AGENTS.md'), 'root-guidance-must-not-be-skipped');
  await writeFile(join(cwd, 'AGENTS.md'), 'child-guidance-must-not-load-alone');
  await writeFile(join(project, '.git', 'config'), '[invalid section\n');
  const result = await readProjectGuidance(input(cwd), { ...clean, LC_ALL: 'ko_KR.UTF-8', LANG: 'ko_KR.UTF-8' });
  assert.deepEqual(result, { status: 'error', reason: 'PROJECT_GUIDANCE_ROOT_UNAVAILABLE' });
});

test('project guidance rejects unsafe or invalid files without partial bodies or override fallback', async t => {
  const root = temporary(t), project = join(root, 'project'), child = join(project, 'child');
  await mkdir(child, { recursive: true });
  await git(project, ['init']);
  await writeFile(join(project, 'AGENTS.md'), 'partial-body-must-not-escape');
  await writeFile(join(child, 'AGENTS.md'), 'fallback-must-not-load');
  await writeFile(join(child, 'AGENTS.override.md'), Buffer.from([0xc3, 0x28]));
  let result = await readProjectGuidance(input(child), clean);
  assert.deepEqual(result, { status: 'error', reason: 'PROJECT_GUIDANCE_INVALID_UTF8' });
  assert.equal(formatProjectGuidanceContext(result).includes('partial-body-must-not-escape'), false);
  assert.equal(formatProjectGuidanceContext(result).includes('PROJECT_GUIDANCE_INVALID_UTF8'), true);

  await writeFile(join(child, 'AGENTS.override.md'), 'x'.repeat(32 * 1024 + 1));
  result = await readProjectGuidance(input(child), clean);
  assert.deepEqual(result, { status: 'error', reason: 'PROJECT_GUIDANCE_TOO_LARGE' });

  await writeFile(join(child, 'AGENTS.override.md'), '');
  await writeFile(join(project, 'AGENTS.md'), 'x'.repeat(20 * 1024));
  await writeFile(join(child, 'AGENTS.md'), 'y'.repeat(20 * 1024));
  result = await readProjectGuidance(input(child), clean);
  assert.deepEqual(result, { status: 'error', reason: 'PROJECT_GUIDANCE_TOO_LARGE' });
});

test('project guidance rejects symbolic links', async t => {
  const root = temporary(t), cwd = join(root, 'cwd'), outside = join(root, 'outside.md');
  await mkdir(cwd);
  await writeFile(outside, 'outside');
  try {
    await symlink(outside, join(cwd, 'AGENTS.md'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      const outsideDirectory = join(root, 'outside-directory');
      await mkdir(outsideDirectory);
      await symlink(outsideDirectory, join(cwd, 'AGENTS.md'), 'junction');
    } else {
      throw error;
    }
  }
  let result = await readProjectGuidance(input(cwd), clean);
  assert.deepEqual(result, { status: 'error', reason: 'PROJECT_GUIDANCE_SYMLINK' });
});

test('project guidance rejects non-regular files', async t => {
  const root = temporary(t), cwd = join(root, 'cwd');
  await mkdir(join(cwd, 'AGENTS.md'), { recursive: true });
  const result = await readProjectGuidance(input(cwd), clean);
  assert.deepEqual(result, { status: 'error', reason: 'PROJECT_GUIDANCE_NOT_REGULAR' });
});

test('project guidance validates cwd without starting a child for skipped inputs', async () => {
  let forks = 0;
  const dependencies = { fork() { forks++; throw new Error('must not fork'); } };
  assert.deepEqual(await runProjectGuidance(input('relative')), { status: 'error', reason: 'PROJECT_GUIDANCE_INVALID_CWD' });
  assert.deepEqual(await runProjectGuidance({ ...input('relative'), agent_id: 'child' }, process.env, dependencies), { status: 'skipped' });
  assert.deepEqual(await runProjectGuidance({ ...input('relative'), hook_event_name: 'UserPromptSubmit' }, process.env, dependencies), { status: 'skipped' });
  assert.deepEqual(await runProjectGuidance(input('relative'), { ...process.env, CROSS_SESSION_PROJECT_GUIDANCE: '0' }, dependencies), { status: 'skipped' });
  assert.equal(forks, 0);
});

test('project guidance kills its child at the total deadline and does not retry', async () => {
  let forks = 0, kills = 0, sends = 0;
  class Child extends EventEmitter {
    stdout = { resume() {} };
    stderr = { resume() {} };
    send() { sends++; }
    kill(signal) { assert.equal(signal, 'SIGKILL'); kills++; }
  }
  const result = await runProjectGuidance(input(process.cwd()), process.env, {
    deadlineMs: 10,
    fork() { forks++; return new Child(); }
  });
  assert.deepEqual(result, { status: 'error', reason: 'PROJECT_GUIDANCE_TIMEOUT' });
  assert.equal(forks, 1);
  assert.equal(sends, 1);
  assert.equal(kills, 1);
});
