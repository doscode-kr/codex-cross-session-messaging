import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runHook } from '../plugins/cross-session/src/hooks.mjs';
import { temporary } from './helpers.mjs';

const execute = promisify(execFile);
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
async function git(cwd, args) {
  return (await execute('git', args, { cwd, env: clean, windowsHide: true })).stdout.trim();
}
function chainingDependencies(extra = {}) {
  return {
    readTranscript: () => ({ sessionId: 'fixture' }),
    chaining: { restore: async () => ({ status: 'empty', relationship: { receiving_session_id: 'fixture' } }) },
    ...extra
  };
}
const input = (cwd, source = 'startup') => ({
  hook_event_name: 'SessionStart', session_id: 'fixture', permission_mode: 'never', source, cwd
});

test('SessionStart injects current project guidance for each supported lifecycle', async t => {
  const root = temporary(t), cwd = join(root, 'project');
  await mkdir(cwd);
  await git(cwd, ['init']);
  const projects = [];
  const client = { async hook(_input, project) { projects.push(project); return {}; } };
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  for (const source of ['startup', 'resume', 'compact', 'clear']) {
    await writeFile(join(cwd, 'AGENTS.md'), `${source}-hook-body`);
    const output = await runHook(input(cwd, source), client, clean, chainingDependencies());
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /<cross-session-project-guidance>/);
    assert.match(context, new RegExp(`${source}-hook-body`));
    assert.match(context, /current user request and current permissions/);
  }
  assert.deepEqual(projects, [common, common, common, common]);
});

test('subagents, other events, unknown sources, and opt-out do not read project guidance', async () => {
  let guidanceCalls = 0, brokerCalls = 0;
  const dependencies = chainingDependencies({
    runProjectGuidance() { guidanceCalls++; throw new Error('must not run'); }
  });
  const client = { async hook() { brokerCalls++; return {}; } };
  assert.deepEqual(await runHook({ ...input(process.cwd()), agent_id: 'child' }, client, process.env, dependencies), {});
  assert.deepEqual(await runHook({ ...input(process.cwd()), hook_event_name: 'UserPromptSubmit' }, client, process.env, dependencies), {});
  const unknown = await runHook(input(process.cwd(), 'unknown'), client, process.env, dependencies);
  const disabled = await runHook(input(process.cwd()), client, { ...process.env, CROSS_SESSION_PROJECT_GUIDANCE: '0' }, dependencies);
  assert.equal(guidanceCalls, 0);
  assert.equal(brokerCalls, 3);
  assert.equal(unknown.hookSpecificOutput.additionalContext.includes('<cross-session-project-guidance>'), false);
  assert.equal(disabled.hookSpecificOutput.additionalContext.includes('<cross-session-project-guidance>'), false);
});

test('guidance, chaining, and broker work start independently', async () => {
  let guidanceStarted = false, chainingStarted = false, brokerStarted = false;
  let releaseGuidance, releaseChaining;
  const guidance = new Promise(resolve => { releaseGuidance = resolve; });
  const chaining = new Promise(resolve => { releaseChaining = resolve; });
  const dependencies = chainingDependencies({
    runProjectGuidance() { guidanceStarted = true; return guidance; },
    chaining: { restore() { chainingStarted = true; return chaining; } }
  });
  const client = { async hook() {
    brokerStarted = true;
    assert.equal(guidanceStarted, true);
    assert.equal(chainingStarted, true);
    releaseGuidance({ status: 'empty' });
    releaseChaining({ status: 'empty', relationship: { receiving_session_id: 'fixture' } });
    return {};
  } };
  const output = await runHook(input(process.cwd()), client, process.env, dependencies);
  assert.equal(brokerStarted, true);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
});

test('guidance failures do not hide broker or chaining results', async () => {
  let brokerCalls = 0;
  const client = { async hook() { brokerCalls++; return {}; } };
  for (const runProjectGuidance of [
    () => ({ status: 'error', reason: 'PROJECT_GUIDANCE_INVALID_UTF8' }),
    () => { throw new Error('fixture failure'); },
    async () => { throw new Error('fixture rejection'); }
  ]) {
    const output = await runHook(input(process.cwd()), client, process.env, chainingDependencies({ runProjectGuidance }));
    assert.match(output.hookSpecificOutput.additionalContext, /Cross-session project guidance is unavailable: PROJECT_GUIDANCE_/);
    assert.match(output.hookSpecificOutput.additionalContext, /Cross-session chaining hook/);
  }
  assert.equal(brokerCalls, 3);

  const marker = '<cross-session-project-guidance>\n{"fixture":true}\n</cross-session-project-guidance>';
  const brokerFailure = await runHook(input(process.cwd()), { async hook() { throw new Error('broker unavailable'); } }, process.env,
    chainingDependencies({ runProjectGuidance: () => ({ status: 'loaded', context: marker }) }));
  assert.match(brokerFailure.hookSpecificOutput.additionalContext, /registration is unavailable/);
  assert.match(brokerFailure.hookSpecificOutput.additionalContext, /"fixture":true/);

  const chainingFailure = await runHook(input(process.cwd()), client, process.env, chainingDependencies({
    runProjectGuidance: () => ({ status: 'loaded', context: marker }),
    chaining: { async restore() { throw new Error('chaining unavailable'); } }
  }));
  assert.match(chainingFailure.hookSpecificOutput.additionalContext, /"fixture":true/);
  assert.match(chainingFailure.hookSpecificOutput.additionalContext, /CHAINING_UNAVAILABLE/);
});
