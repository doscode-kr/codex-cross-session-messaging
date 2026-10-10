import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, evaluate, isolatedEnvironment, assessPlan, invoke } from '../scripts/evaluate-coordination.mjs';
import { scenarios, scoreTrace } from '../scripts/evaluation/scenarios.mjs';

test('scripted controls separate oracle checks from model evidence', async () => {
  const good = await evaluate(parseOptions([]));
  assert.equal(good.mode, 'scripted');
  assert.equal(good.cases.length, 5);
  assert.ok(good.cases.every(entry => entry.status === 'passed' && entry.usage === null));
  assert.ok(Object.values(good.metrics).every(value => value === 0));
  const bad = await evaluate(parseOptions(['--policy', 'regression']));
  assert.equal(bad.metrics.userNudges, 4);
  assert.equal(bad.metrics.prematureStops, 4);
  assert.equal(bad.metrics.duplicateWork, 5);
  assert.equal(bad.metrics.editConflicts, 5);
  assert.equal(bad.metrics.missedReports, 4);
  assert.equal(bad.metrics.stopViolations, 4);
});

test('oracle rejects invalid chronology and incomplete traces', () => {
  const scenario = scenarios[0];
  for (const trace of [[], ['work'], ['finish', 'work'], ['verify', 'work', 'report', 'finish'], ['report', 'finish'], ['invented']]) assert.throws(() => scoreTrace(scenario, trace));
  assert.equal(scoreTrace(scenario, ['wait']).prematureStops, 1);
  assert.equal(scoreTrace(scenarios.at(-1), ['stop']).stopViolations, 0);
});

test('model execution needs an explicit flag and finite budgets', () => {
  for (const argv of [['--model', 'x'], ['--real-model'], ['--runs', 'Infinity'], ['--runs', '0'], ['--runs', '6'], ['--total-ms', '300001'], ['--timeout-ms', '-1'], ['--cases', 'missing'], ['--cases', 'user-stop,user-stop'], ['--unknown']]) assert.throws(() => parseOptions(argv));
  const options = parseOptions(['--real-model', '--model', 'x', '--auth-home', '/tmp/auth', '--cases', 'intermediate-merge,user-stop']);
  assert.equal(options.runs, 2);
  assert.equal(options.totalMs, 180000);
});

test('isolated child cannot inherit API keys, user config, or daemon environment', () => {
  const env = isolatedEnvironment({ Path: 'bin', OPENAI_API_KEY: 'secret', CODEX_HOME: 'live', CODEX_THREAD_ID: 'live', HOME: 'live', USERPROFILE: 'live', CROSS_SESSION_CONTINUATION: '1', SYSTEMROOT: 'system' }, '/isolated');
  assert.deepEqual(env, { Path: 'bin', SYSTEMROOT: 'system', CODEX_HOME: '/isolated', HOME: '/isolated', USERPROFILE: '/isolated' });
});

test('observed invalid model plans are behavioral failures and omit arbitrary text', () => {
  const invalidOrder = assessPlan(scenarios[0], ['verify', 'work', 'report', 'finish']);
  assert.equal(invalidOrder.status, 'behavior-failure');
  assert.equal(invalidOrder.metrics, null);
  assert.equal(invalidOrder.error, 'INVALID_TRACE');
  const secret = assessPlan(scenarios[0], ['private-auth-value']);
  assert.equal(secret.actions, null);
  assert.ok(!JSON.stringify(secret).includes('private-auth-value'));
  assert.equal(assessPlan(scenarios[0], []).actions, null);
});

test('time limit terminates a stalled owned process without raw diagnostics', { timeout: 6000 }, async () => {
  const started = Date.now();
  const result = await invoke({ command: process.execPath, args: [] }, ['-e', "process.on('SIGTERM',()=>{}); process.stderr.write('private-diagnostic'); setInterval(()=>{},1000)"], isolatedEnvironment(process.env, '/unused'), process.cwd(), '', 250);
  assert.equal(result.failure, 'TIME_LIMIT');
  assert.ok(Date.now() - started < 4000);
  assert.ok(!JSON.stringify(result).includes('private-diagnostic'));
});
