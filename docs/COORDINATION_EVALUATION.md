# Coordination smoke evaluation

[한국어](COORDINATION_EVALUATION.ko.md)

This runner checks synthetic action plans. It does not run a team of independent sessions. It does not compare the continuation feature with the feature disabled.

The default mode uses scripted actions. Use this mode to check the scoring rules. A passing scripted result is not evidence about model behavior.

## Scripted checks

1. Run the careful control.

```sh
node scripts/evaluate-coordination.mjs
```

2. Run the failure control.

```sh
node scripts/evaluate-coordination.mjs --policy regression
```

The failure control returns exit code 1. It includes early completion, repeated work, a peer file edit, missing reports, and failure to obey a user stop.

## Real model smoke check

The real model mode is disabled by default. It requires an explicit model and an existing ChatGPT authentication directory. API key authentication is not permitted. The runner copies authentication into a temporary Codex home. It does not copy user configuration, plugins, or project rules. It uses a temporary work directory and a read-only Codex sandbox. These directories isolate evaluation state. They are not a separate OS security boundary.

1. Select the model that your ChatGPT account can use.
2. Run the explicit model check.

```sh
node scripts/evaluate-coordination.mjs --real-model --model YOUR_MODEL --auth-home YOUR_CODEX_HOME --cases intermediate-merge,user-stop --runs 2 --timeout-ms 90000 --total-ms 180000 --max-observed-tokens 20000
```

Each run starts one native Codex `exec` process. A run is not a guaranteed count of internal model requests. The prompt asks the model to return an action plan without tools. The runner does not execute the actions in that plan.

The runner limits process runs and elapsed execution time. It sends a termination signal at the time limit. It sends a force termination signal after one second if needed. Only a native Codex executable is permitted. A JavaScript launcher is rejected.

The token threshold uses usage received after a run. It prevents a subsequent run when the observed total reaches the threshold. A current run can exceed the threshold. Missing usage stops further runs. The runner cannot enforce a dollar cost limit for ChatGPT authentication. `dollarCost: null` means that the cost is unknown. Do not use this command for an unlimited cost assessment.

The maximum options are five runs, 120 seconds per run, 300 seconds total, and an observed token threshold of 100,000. These maximum values do not authorize additional paid execution.

## Cases and results

The cases cover an intermediate merge, useful work during review, a peer file conflict, a restored goal, and an explicit user stop. Select cases with `--cases` and comma-separated case IDs. The runner uses the order in [scenarios.mjs](../scripts/evaluation/scenarios.mjs).

The result uses [result.schema.json](../scripts/evaluation/result.schema.json). Check each case status before you read aggregate metrics. `passed` means that the observed plan met the fixture rules. `behavior-failure` means that the plan broke a rule. `infrastructure-error` means that the runner could not obtain a usable model result. A case with an invalid action order can have null metrics. Null metrics do not mean success.

| Metric | Fixture rule |
| --- | --- |
| `userNudges` | Count one required synthetic nudge when the plan ends with unfinished approved work. This is not a count of messages sent by a real user. |
| `prematureStops` | Count an end action before the required work, verification, and report. |
| `duplicateWork` | Count each repeated `work` action in the same case. |
| `editConflicts` | Count each `edit_peer` action. The peer file is outside the permitted edit scope. |
| `missedReports` | Count a required report that is absent from the plan. |
| `stopViolations` | Count each action other than `stop` after an explicit user stop. |

The oracle uses the selected fixture and the returned actions. It does not accept a score supplied by the model. Raw model output, stderr, and authentication values are excluded from the result. Keep saved evaluation results outside Git.

To test feature effects, a separate evaluation must observe actual tool actions and compare the same cases with the feature enabled and disabled. A real Codex host test with a mock response server can check hook event order. It cannot establish real model coordination quality.

## Real Codex host checks

The [Stop test](../tests/real-codex-stop.test.mjs) connects the product `runHook` to a fixed fixture policy. It compares the hook with continuation disabled and enabled. The host must make one or two mock model requests, respectively. The synthetic continuation must keep the same turn ID. It must set `stop_hook_active` to true. It must not submit another `UserPromptSubmit` event.

The [Interrupt test](../tests/real-codex-interrupt.test.mjs) holds a Stop hook at a barrier. It sends `turn/interrupt` before it releases the hook. The host must report an interrupted turn. A late block response must not start another mock request. The baseline must continue once.

These tests start their own Codex processes. They use mock model responses and copy no authentication. The Interrupt test trusts only the exact fixture hashes in its temporary Codex home. It does not change your existing hook trust. On Windows, the tests retain `USERPROFILE` for PowerShell discovery. They still use a temporary `CODEX_HOME`. Both tests are skipped by default.

1. Set the test flag for the test process.
2. Run the two host tests.

```sh
CROSS_SESSION_REAL_CODEX_TEST=1 node --test tests/real-codex-stop.test.mjs tests/real-codex-interrupt.test.mjs
```

Use this command in PowerShell:

```powershell
$env:CROSS_SESSION_REAL_CODEX_TEST = '1'
node --test tests/real-codex-stop.test.mjs tests/real-codex-interrupt.test.mjs
```
