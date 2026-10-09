# Verification and compatibility

[한국어](VERIFICATION.ko.md)

## Recorded CI baseline

[GitHub Actions run 37936551603](https://github.com/doscode-kr/codex-cross-session-messaging/actions/runs/37936551603) passed on 2026-10-09.
The tested commit was `b99924862b81bcf687b36ff902253b7f86e72c6e`.
It includes journal memory changes, peer display labels, nonblocking state queries, input validation, and broker restart fixes.

| Runner | Node.js | Passed | Skipped | Failed |
|---|---|---:|---:|---:|
| Windows | 20 | 125 | 1 | 0 |
| Windows | 22 | 125 | 1 | 0 |
| macOS | 20 | 123 | 3 | 0 |
| macOS | 22 | 123 | 3 | 0 |

Each job ran 126 tests with Codex CLI 0.161.0 and `CROSS_SESSION_REAL_CODEX_TEST=1`.
Each job passed `npm run check`.
The Windows skip concerns the broker inventory timing test after a path alias check.
The macOS skips are Windows-only path tests.
These skipped cases are not counted as passed.
The real Codex test uses a local mock model and three isolated root sessions.
It verifies direct peer questions, replies, leader reports, and message access boundaries.
It does not prove that a live model completes a task.
The dependency audit on 2026-10-09 reported zero vulnerabilities.
That audit is not a complete security review.

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

The test starts a real Codex App Server with two independent sessions.
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
