# Verification and compatibility

## Integrated Windows candidate results

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

These are integrated candidate results.
Run the release checks again after a code change.
Use [RELEASE.md](RELEASE.md) for the remaining platform and publication checks.

## Recorded implementation baseline

The previous project record reports these checks on 2026-10-08.
They describe the initial implementation.
Use the integrated candidate results above for the current Windows checks.

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

The tests cover delivery to busy and idle recipients, one leader, reply permissions, acknowledgments, uncertain results, journal recovery, broker authentication, startup races, hook paths with spaces, and one-time idle notifications.
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
No macOS run is recorded here.

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

- No macOS execution result is recorded here.
- Node.js 22 was not verified in the integrated candidate run.
- The Windows and macOS GitHub Actions jobs are configured, but no CI execution result is recorded here.
- The amount of visible UI output reduction was not measured.
- The mock model test does not establish real model understanding or task completion.
- Hook-trusted use across multiple interactive terminals is not verified by the isolated tests.
- The inventory timing test was skipped after it detected an 8.3 runtime path alias.

Use [RELEASE.md](RELEASE.md) for the candidate checks.
Report an OS, version, command, result, and skipped checks for each new validation.
