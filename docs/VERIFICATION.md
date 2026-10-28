# Verification and compatibility

[한국어](VERIFICATION.ko.md)

## Version 0.2.0 session continuity

On 2026-10-28, an independent Windows check used Node.js 20.19.4 and Codex 0.164.0.
With `CROSS_SESSION_REAL_CODEX_TEST=1`, `node scripts/test.mjs --test-concurrency=1` passed 388 of 389 tests.
One existing Windows path-alias safety case was skipped. No test failed or was canceled.
All seven real Codex tests ran with temporary homes and local mock model servers.

The A/B/C test opened two sessions in one project and a third in another project without linking them.
All three sessions compacted automatically.
The first normal request after each compaction contained its own original-request field, completed-item reports, and remaining items in plugin developer context.
That same request contained the updated AGENTS body. Other sessions' work markers were absent.
The test recorded nine model requests and 15 completed hooks.
Closing each session saved its final checkpoint and left only those three UUIDs in continuity storage.
These tests verify context delivery, not model compliance or the truth of completion reports.

Review found and resolved project-root redirection, old work after clear, built-in AGENTS records selected as work requests, early Node 20 signal compatibility, and long Unicode context loss.
Regression tests check these cases and retain the saved checkpoint when its display copy is shortened.
A delayed broker test reproduced two separate 1.6-second requests exceeding the old three-second host limit.
The new full-operation deadline stopped that sequence without resending it.
The reported live timeout could not be matched to a specific event in available local logs.

## Historical results

The checks below describe earlier candidates.
Cross-session links and launch are not part of the 0.2.0 behavior.
Current continuity restores only the same session's records. See [session continuity](CHAINING.md).

## Earlier project guidance verification

On 2026-10-28, an independent Windows check used Node.js 20.19.4 and Codex 0.164.0.
With `CROSS_SESSION_REAL_CODEX_TEST=1`, `node scripts/test.mjs --test-concurrency=1` passed 386 of 387 tests.
One existing Windows path alias safety test was skipped. No test failed or was canceled.
Earlier parallel runs had timeouts. The serial run kept the product time limits unchanged.

The real host test changed the AGENTS body before startup, compaction, and resume.
The first normal model request after each event contained that event's new body in plugin developer context.
The test used a temporary Codex home and a local mock model server.
It checked delivery of the text, not model compliance with the text.
File tests include short reads, damaged Git settings, worktree boundaries, UTF-8, size limits, and links.
Guidance errors do not stop messaging registration or handoff restore.

## Receipt and handoff recovery checks

On 2026-10-28, Windows checks used Node.js 20.19.4 and isolated Codex hosts.
The full suite with `CROSS_SESSION_REAL_CODEX_TEST=1` and `--test-concurrency=1` passed 371 of 372 tests.
One runtime-purge test was skipped by the existing Windows path-alias safety check.
An earlier parallel run exceeded the existing SessionEnd three-second process limit at 3.229 seconds.
The focused rerun and the full serial run passed without increasing that limit.

Codex 0.161.0 and 0.164.0 accepted an empty input array for idle delivery.
Both versions accepted one empty text input for busy delivery.
The delivered body appeared once in its first model input, without the old lookup notice.
Later model requests can still include that body as conversation history.
CLI terminal checks did not show an extra blank input row or lookup notice.
The model inputs retained the receiving session's read-only sandbox and approval policy.
These checks used a local mock model, not a test of model understanding.

Repeating `clientUserMessageId` alone started another turn in both host versions.
The broker now prevents another submission for a saved `request_id`.
Unit checks cover concurrent repeats, lost responses, lost acknowledgment responses, restart, ID conflicts, and ambiguous recipients.
They also cover the two-RPC limit and the notice fallback after an explicit rejection before acceptance.
Timeouts and unknown outcomes did not cause a fallback or automatic resend.

The final expanded `tests/real-codex.test.mjs` also passed independently after the full suite.
It delivered between different project directories by exact UUID.
It archived a target after message storage but before native submission, then recovered the same saved failure ID with zero input submissions.
It discarded an adapter result after real host acceptance, then recovered `uncertain` with one input submission in total.
An acknowledgment reply discarded at the MCP boundary did not change the first receipt timestamp on retry.
A controlled duplicate-name adapter view returned `AMBIGUOUS_RECIPIENT`.
Response loss was injected at API boundaries; the test did not drop a network frame.

An isolated Codex 0.164.0 restart restored a new receiving session linked by exact UUID.
Model input kept the prior request, one reported completed checklist item, one pending item, and the current authority boundary.
The output included source, receiving, and checkpoint UUIDs.
The source report did not become independent completion evidence or new user approval.
The manual shared-daemon launch limit remains unchanged.
These new checks do not add macOS or Node.js 22 evidence.

## Session chaining candidate checks

The integrated code candidate `18d7385` passed an independent Windows check on 2026-10-27.
With the real Codex opt-in enabled, 347 of 348 tests passed, one Windows path-alias case was skipped, and none failed.
All 64 focused chaining and hook tests passed.
The source, document, whitespace, and public-scope checks also passed.
This candidate includes first-restore protection and the unsupported-launch guard.

On 2026-10-27, an independent Windows run checked candidate `d35fb1c` with Node.js 20.19.4.
The full suite used `CROSS_SESSION_REAL_CODEX_TEST=1`: 338 tests passed, one was skipped, and none failed.
The skipped runtime-purge test hit the existing Windows path-alias safety condition.
The document check passed 14 language pairs and 192 local links.
These results did not verify the real CLI launch transport.

Separate CLI tests found a blocking host limit.
With Codex 0.164.0, the new CLI's environment-only ticket did not reach SessionStart on the shared daemon.
The hook UUID was present in that daemon's loaded-session list, so the test checked the correct daemon.
A session config override made the ticket visible in both 0.161.0 and 0.164.0, but those CLI sessions were absent from the shared daemon.
Creating a thread through the daemon and then running CLI resume also failed in both versions: the new thread had no saved rollout.
The product now rejects launch before creating a ticket or process.
The CLI and integration checks for this guard passed all nine tests.

The isolated automatic-compaction test passed with Codex 0.161.0 and 0.164.0.
Each trusted run made two local mock model requests, one compaction, and five hook calls.
The restored marker and attachment line reached model input after compaction.
The untrusted run made no hook calls and had neither marker nor attachment line.
These are transport checks with a local mock, not measurements of model answer quality.

The Windows counterfactual checks used the same assertions for each changed and normal implementation:

| Check | Changed implementation | Normal implementation |
|---|---|---|
| Exact UUID source selection | Prefix match failed | Passed |
| Unconnected session isolation | Automatic fallback failed | Passed |
| Subagent exclusion | Removed exclusion failed | Passed |
| Single ticket owner | Ticket reuse failed | Passed |
| Ticket first-use expiry | Removed expiry failed | Passed |
| Stop, PreCompact, SessionEnd saves | Removed PreCompact save failed | Passed |
| Valid bounded JSON context | Removed cap failed | Passed |
| Message delivery with corrupt chaining state | Coupled storage check failed | Passed |
| Unlink blocks automatic reconnect | Ignored tombstone failed | Passed |
| Concurrent checkpoint writes | Replaced exclusive lock failed | Passed |

Actual compaction and hook trust used the trusted/untrusted host comparison above instead of a code mutation.
The ticket checks verify storage and claim rules; they do not make CLI launch available.
The initial hook suite had a deadline failure at 3,206 ms.
After reducing the optional child budget to 1,700 ms, the independent full rerun passed.
That earlier failure remains part of the record.

These local candidate checks did not include macOS or Node.js 22.
The later push CI run `40522047965` passed all four Windows/macOS and Node.js 20/22 jobs on `e8db714`.
PR CI run `40522187384` then found a concurrent checkpoint failure on Windows 20 and macOS 22.
A competing writer could delete its temporary lock file between directory listing and inspection.
The fix ignores only a missing lock temporary file during that inspection.
The new regression test failed before the fix and passed after it.
Missing durable files and other file errors still reject the write.

A separate shared-daemon test with Codex 0.164.0 verified the closed-session procedure.
The receiving CLI exited before the external CLI linked its exact UUID to the source.
A delayed SessionEnd ran after the link and did not replace the pending source.
On resume, the same UUID was loaded in the daemon and the first model input contained the source marker.
After output confirmation, Stop saved the receiving session's own checkpoint.
The 0.161.0 closed-session probe timed out while waiting for a TUI completion marker before the link step.
It did not test link or resume, so that version's manual CLI flow remains unverified.

## Checklist candidate checks

On 2026-10-10, an independent Windows run tested candidate `1c168b5` with `CROSS_SESSION_REAL_CODEX_TEST=1`.
The first full run had one `EADDRINUSE` failure in an existing shutdown test.
Its temporary-directory hash selected a port already used by another local process.
That process was not changed or stopped.
The isolated shutdown file then passed all four tests.
The first full retry passed 282 of 283 tests, skipped one existing Windows path-alias case, and failed none.
The product candidate did not change between runs.
The failed run is preserved as a failure.

Eight independent checklist integration tests passed through HTTP, CLI, and MCP.
They cover four-attempt limits, recorded evidence, revision races, restart recovery, owner isolation, and interrupt priority.
The actual Codex Stop and Interrupt tests also passed in the full retry.
The document check passed 13 language pairs and 166 local links.
These results verify state transitions and host behavior, not the truth of model reports or improved team efficiency.
No paid model trial was run for this checklist change.

## Work-state candidate checks

On 2026-10-10, an independent Windows run checked core commit `993d0a7` with the real Codex opt-in enabled.
It passed 249 of 250 tests, skipped one existing platform case, and failed none.
The author's earlier run had one local port conflict.
That earlier failure is not counted as a pass.
Integrated candidate `648c7d1` passed 11 independent hook and integration tests.
These tests cover revision conflicts, caller scope, the single-continuation limit, and interrupt revocation.
They do not establish that a real model completes project work.

Two isolated `gpt-6.1-sol` runs returned action plans for an intermediate merge and a user stop.
Both plans met the fixture rules.
The runs reported 29,509 tokens in total.
The 20,000-token threshold was checked between runs and was exceeded by the second run.
It was not a hard token or cost limit.
These observations are a small plan smoke check, not a team trial or a measurement of the Stop feature's effect.
No baseline-to-treatment improvement is claimed.
Historical CI and archive results below remain limited to their stated commits.

### Host Stop and Interrupt checks

Isolated Windows checks used Codex CLI 0.161.0 with a local mock model.
The CLI delivered `turn_id` and boolean `stop_hook_active` to Stop hooks.
A blocking Stop response caused one extra model request.
The event order was `UserPromptSubmit`, `Stop(false)`, then `Stop(true)` for the same turn.
The synthetic continuation did not produce another `UserPromptSubmit` event in this tested version.

An independent app-server check delayed the first Stop response behind a barrier.
With no interrupt, it made two model requests and completed the turn.
With `turn/interrupt` before barrier release, it made one request and ended with status `interrupted`.
An `Interrupt` hook event occurred and no continuation request followed.
The CLI check bypassed hook trust for that invocation in a temporary fixture home.
The app-server check registered only the three reviewed fixture keys and hashes in its temporary home.
Operating daemon settings were not changed.
These results establish host protocol behavior for the tested version, not model task quality.
Use the [evaluation guide](COORDINATION_EVALUATION.md) to repeat the public checks and interpret their limits.

## Recorded CI baseline

[GitHub Actions run 37946075955](https://github.com/doscode-kr/codex-cross-session-messaging/actions/runs/37946075955) passed on 2026-10-09.
The tested commit was `9b0bebf83154dead6538ea59db52095059211323`.
It includes idle subscription pages, broker diagnostics, delivery storage errors, and strict journal validation.
It also includes strict HTTP request UTF-8 validation and installation path checks at external command boundaries.
Installation record and cached package JSON errors omit the file contents.
This result applies only to the stated commit.

| Runner | Node.js | Passed | Skipped | Failed |
|---|---|---:|---:|---:|
| Windows | 20 | 223 | 1 | 0 |
| Windows | 22 | 223 | 1 | 0 |
| macOS | 20 | 221 | 3 | 0 |
| macOS | 22 | 221 | 3 | 0 |

Each job ran 224 tests with Codex CLI 0.161.0 and `CROSS_SESSION_REAL_CODEX_TEST=1`.
Each job passed `npm run check`.
The Windows skip concerns the broker inventory timing test after a path alias check.
The macOS skips are Windows-only path tests.
These skipped cases are not counted as passed.
The real Codex test uses a local mock model and three isolated root sessions.
It verifies direct peer questions, replies, leader reports, and message access boundaries.
It does not prove that a live model completes a task.
The dependency audit on 2026-10-09 reported zero vulnerabilities.
That audit is not a complete security review.

## Clean archive installation at the latest CI baseline

An installation check used a clean archive of commit `9b0bebf83154dead6538ea59db52095059211323` in a temporary Codex home.
The check used Windows, Node.js 20.19.4, and Codex CLI 0.161.0.
The archive contained no installed dependencies or local development rules.
The default `npm run install:global` command passed without `--skip-deps`.
The 11 selected cache files matched their archive hashes.
The `ws` dependency resolved inside the installed cache.
The native runtime import passed.
MCP discovery from the installed cache returned the same 13 tools as the archive.

Uninstall removed the product cache and installation record.
It preserved the other plugin, its cache hashes, settings, message journal, and token.
Product commands exited with code 0.
The temporary-home PATH helper warning did not stop those commands.
No normal Codex home or running daemon was changed.
This archive check did not test macOS or live model delivery.
An independent reviewer checked the saved results without repeating the installation.

## Earlier CI baseline

[GitHub Actions run 37788462031](https://github.com/doscode-kr/codex-cross-session-messaging/actions/runs/37788462031) passed on 2026-10-08.
The tested commit was `c4c1b1f8e4fd6cad6c630125c5cdc07431502758`.

| Runner | Node.js | Result |
|---|---|---|
| Windows | 20 | Passed |
| Windows | 22 | Passed |
| macOS | 20 | Passed |
| macOS | 22 | Passed |

Each job ran dependency installation, `npm run check`, and `npm test`.
The jobs used Codex CLI 0.161.0 and enabled `CROSS_SESSION_REAL_CODEX_TEST=1`.
This result applies to the tested commit.
It does not verify later changes or all Codex versions.
A passing job can include skipped tests.
Use the linked job logs to check skips for each environment.

## Journal resource experiment

An independent verifier measured the journal change on Windows with Node.js 20 on 2026-10-09.
The fixture contained 6,000 messages with 16,000-byte bodies.
The journal contained 96,802,884 bytes.

| Measurement | Before the journal change | After the journal change |
|---|---:|---:|
| Heap increase during replay | 193,996,768 bytes | 11,317,736 bytes |
| RSS increase during replay | 321,150,976 bytes | 23,691,264 bytes |
| Replay time | 242 ms | 155 ms |

The earlier process used the default heap limit.
The changed process used `--max-old-space-size=48`.
The verifier read all 6,000 bodies and checked their SHA-256 against the fixture.
Interrupted messages recovered as `uncertain` without automatic delivery.
The resource regression tests are in `tests/store-resources.test.mjs`.

Each measurement used one run.
These values are observations, not capacity or speed guarantees.
The journal still retains its data.
Disk use, metadata memory, and restart work increase as data accumulates.
See [storage behavior](OPERATIONS.md) for the remaining resource limits.

## Repeated operation and installation checks

An independent verifier ran 300 operation cycles through the HTTP broker with three simulated sessions on 2026-10-09.
The exercise checked 780 messages, 300 replies, 600 acknowledgments, 150 idle notifications, and 150 cancellations.
The broker restarted 20 times on the same port.
All message bodies and metadata matched across restarts.
Thirty uncertain deliveries were not retried.
All tracked deliveries, recipient waits, idle checks, and subscriptions were empty at the end.
The exercise checked 900 rejected access attempts and 123 permission-label comparisons.
This short exercise used `FakeNative`; it was not a real model or a long-duration availability test.

A separate check used one client for 20 immediate restarts on one port.
Before the connection fix, ten first requests failed.
After the fix, all 20 first requests succeeded.
The client closes each HTTP connection after its request.
This adds connection work and does not retry a request with a lost response.

The release audit also installed a clean archive of commit `d321fff` into a temporary Codex home.
It used Windows, Node.js 20.19.4, and Codex CLI 0.161.0.
The default dependency installation path passed without `--skip-deps`.
The installed cache contained the runtime files and `ws` dependency.
Cache removal, source reinstallation, and uninstall passed.
The installed MCP file matched the source file hash after the update.
No normal Codex home or running daemon was changed.
The CLI reported a temporary-home PATH helper warning, but these commands exited with code 0.

## Earlier integrated Windows candidate results

An independent verifier ran the integrated candidate checks on 2026-10-08.
The candidate included the short MCP output, release documents, removal scripts, and release checker changes.

| Environment | Value |
|---|---|
| OS and shell | Windows PowerShell |
| Node.js | 20.19.4 |
| Python | 3.12.1 |

| Command | Exit code | Result |
|---|---|---|
| `npm run check` | 0 | Syntax, JSON, versions, licenses, required files, and document links passed. |
| `npm test` with `CROSS_SESSION_REAL_CODEX_TEST=1` for that process | 0 | 44 tests: 43 passed, 0 failed, 1 skipped. |
| `git diff --check` | 0 | No whitespace errors. |
| `npm audit --prefix plugins/cross-session --omit=dev --audit-level=high` | 0 | 0 vulnerabilities reported in the dependency audit. |

The maintainer ran the dependency audit on the same date.
Its result describes the dependency advisories available at that time.

The real Codex integration test passed for busy-recipient `turn/steer` and idle-recipient `turn/start`.
The installation and removal tests passed with temporary Codex homes.
Repeated removal and preservation of unrelated configuration, plugins, and caches passed.
The integration used a local mock model server.
It did not call a live model API.
It did not change the user's normal Codex home.

The test `a broker that starts during inventory prevents runtime purge` was skipped.
The test detected an 8.3 runtime path alias and skipped before the inventory timing barrier.
Automatic cleanup would reject that path.
The skipped test is not included in the 43 passed results.
This run therefore does not verify that timing case after inventory starts.

These are historical results for the earlier integrated candidate.
Run the release checks again after a code change.
Use [RELEASE.md](RELEASE.md) for the remaining platform and publication checks.

## Recorded implementation baseline

The previous project record reports these checks on 2026-10-08.
They describe the initial implementation.
Use the CI baseline above for the later Windows and macOS checks.

| Environment | Recorded value |
|---|---|
| OS | Windows |
| Node.js | 20.19.4 |
| Codex CLI | 0.161.0 |
| Running shared daemon | 0.159.3 |

| Check | Previous recorded result |
|---|---|
| Automated tests with real integration enabled | 24 passed, 0 failed, 0 skipped |
| JavaScript syntax and plugin JSON | Passed |
| Real shared daemon connection and session lookup | Passed |
| Installation in a separate settings directory | Passed |
| Installed MCP tool discovery by real Codex | Passed |
| Windows user installation | Installed and enabled |

The original record also reports delivery checks with separately started Codex 0.159.3.
The record does not establish support for all Codex versions.
Protocol changes can affect compatibility.

The tests cover delivery to busy and idle recipients.
They cover one leader, reply permissions, and acknowledgments.
They cover uncertain results, journal recovery, and broker authentication.
They cover startup races, hook paths with spaces, and one-time idle notifications.
The record reports no test messages to running user sessions.
Hook trust must still be reviewed by the user in `/hooks`.

## Standard checks

1. Install plugin dependencies.

   ```text
   npm ci --prefix plugins/cross-session --ignore-scripts
   ```

2. Run `npm run check`.
3. Run `npm test`.

The standard test command skips `tests/real-codex.test.mjs` unless its opt-in variable is set.
Do not report a skipped integration test as passed.

## Isolated real Codex integration

The test starts a real Codex App Server with three independent sessions.
It uses a temporary `CODEX_HOME` and a loopback mock model server.
It checks installed MCP tool discovery.
It checks that busy and idle peer bodies reach model requests.
It does not call a live model API.

PowerShell:

```powershell
$previousIntegrationSetting = $env:CROSS_SESSION_REAL_CODEX_TEST
try {
    $env:CROSS_SESSION_REAL_CODEX_TEST = '1'
    npm test
} finally {
    if ($null -eq $previousIntegrationSetting) {
        Remove-Item Env:CROSS_SESSION_REAL_CODEX_TEST -ErrorAction SilentlyContinue
    } else {
        $env:CROSS_SESSION_REAL_CODEX_TEST = $previousIntegrationSetting
    }
}
```

macOS shell:

```sh
CROSS_SESSION_REAL_CODEX_TEST=1 npm test
```

These commands are instructions for another run.
The recorded Windows result appears above.
The CI baseline above records macOS execution for the stated commit.

## Release candidate documentation checks

The documentation work on 2026-10-08 ran `npm run check` and `git diff --check` on Windows.
Those checks passed.
The independent relative link check found 38 valid local links across 15 Markdown files.
The YAML check parsed the CI workflow and bug report form.
The root and plugin license copies matched.
The direct command `node scripts/install.mjs --dry-run` passed.
It printed the expected dependency install, marketplace registration, and plugin install commands.
It did not execute those operations.

The npm PowerShell command `npm run install:global -- --dry-run` did not pass the option to the installer in this environment.
It installed local dependencies before marketplace registration failed with a source conflict.
Plugin installation did not run in that attempt.
Use the direct Node.js command for installer options.

## Limits

- CI verifies only the stated commit and tested environment combinations.
- The earlier local Windows candidate run did not verify Node.js 22.
- The amount of visible UI output reduction was not measured.
- The mock model test does not establish real model understanding or task completion.
- Hook-trusted use across multiple interactive terminals is not verified by the isolated tests.
- The inventory timing test was skipped after it detected an 8.3 runtime path alias.

Use [RELEASE.md](RELEASE.md) for the candidate checks.
Report an OS, version, command, result, and skipped checks for each new validation.
