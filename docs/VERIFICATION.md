# Verification and compatibility

## Recorded implementation baseline

The previous project record reports these checks on 2026-10-08.
They describe the initial implementation, not a new execution of each check for the current release candidate.

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

These commands are instructions.
They do not establish a successful run on either OS.

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
- The Windows and macOS GitHub Actions jobs are configured, but no CI execution result is recorded here.
- The mock model test does not establish real model understanding or task completion.
- The original record does not verify hook-trusted use across multiple terminals.
- The final integrated candidate needs its own tests and removal checks.

Use [RELEASE.md](RELEASE.md) for the candidate checks.
Report an OS, version, command, result, and skipped checks for each new validation.
