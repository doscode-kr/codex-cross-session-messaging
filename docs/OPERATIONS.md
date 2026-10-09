# Update and diagnostics

[한국어](OPERATIONS.ko.md)

## Check Codex compatibility before an update

This release is experimental.
The recorded CI baseline used Codex CLI 0.161.0 on Windows and macOS with Node.js 20 and 22.
That result applies to commit `c4c1b1f`.
Earlier Windows records also include a Codex 0.159.3 shared daemon.
Other Codex versions are unverified by those records.
The plugin enables `experimentalApi` when it connects to Codex.
Protocol changes can affect session lookup and direct input.
See [the verification record](VERIFICATION.md) for evidence and limits.

1. Read your CLI version with `codex --version`.
2. Compare it with the verification record.
3. Run `npm run doctor` to check daemon access and the session list.

A successful diagnostic does not prove message delivery or task completion.
You can use the isolated integration procedure in the verification record to check an unverified version.
An isolated integration check uses a mock model server.
It does not prove that a live model will understand or complete a peer request.
The installer does not upgrade or restart the running Codex daemon.

## Update from the same source directory

1. Save the release tag or commit you currently use.
2. Get the new release in the registered source directory.
3. Read [CHANGELOG.md](../CHANGELOG.md).
4. Cancel outstanding idle notification subscriptions from their original sessions.
5. Close sessions that loaded the old plugin.
6. Stop the message broker from an external shell.

   ```text
   node plugins/cross-session/src/cli.mjs broker-stop
   ```

7. Examine the installer commands.

   ```text
   node scripts/install.mjs --dry-run
   ```

8. Remove the installed plugin cache.

   ```text
   codex plugin remove cross-session@cross-session-local
   ```

9. Install the new source.

   ```text
   npm run install:global
   ```

10. Open new Codex CLI sessions.
11. Review the new hooks in `/hooks`.
12. Run `npm run doctor`.

The source directory and the installed cache are separate.
Changing the source alone does not confirm a cache update.
This procedure keeps the message data.
The installer does not restart the running daemon.
Stopping the message broker lets the next plugin call load the new broker code.
If `broker-stop` returns `BROKER_OFFLINE`, no broker is running for that message directory.
Close plugin sessions before broker shutdown because their exit hooks can start the broker again.

## Change the source directory

A marketplace name can already point to another source.
The installer returns an error in that case.

1. Read the installed plugin list with `codex plugin list --json`.
2. Check whether another installed plugin uses `cross-session-local`.
3. Cancel outstanding idle notification subscriptions from their original sessions.
4. Close sessions that loaded the old plugin.
5. Stop the old broker from an external shell with `node plugins/cross-session/src/cli.mjs broker-stop`.
6. Remove `cross-session@cross-session-local` with `codex plugin remove`.
7. Remove the old source with `codex plugin marketplace remove cross-session-local` only if no other installed plugin uses it.
8. Run `npm run install:global` in the new source directory.
9. Open new Codex CLI sessions.
10. Review the hooks in `/hooks`.

If another installed plugin uses that marketplace, stop this source-change procedure after step 2.
Keep its registration and source.
Use a separate `CODEX_HOME` if you need the new source without changing that registration.

Use the same `CODEX_HOME` for each command.
Keep the old source until the new installation passes your checks.
To go back, install the saved release from that source.

## Recover an unavailable source directory

Codex can fail to read the plugin list after a registered source directory moves or is removed.
The installed cache can still exist.
The installer and removal script stop when that list cannot be read.
If the installation record contains an unavailable source path, the error includes that path and the Codex home.
The error also includes the original Codex failure.
The record supplies diagnostic information only.
It does not confirm the current marketplace owner or authorize registration removal.
An unavailable recorded path does not prove that the source caused the failure.
Without a usable record, the scripts keep the original error.

1. Read the original Codex error.
2. Check `sourceRoot` in `<CODEX_HOME>/.cross-session-install.json`, if that file exists.
3. Restore the original source checkout at its recorded path from your saved copy or release.
4. Run `codex plugin marketplace list --json` with the same `CODEX_HOME`.
5. Run `codex plugin list --json` with the same `CODEX_HOME`.
6. Check whether another installed plugin uses `cross-session-local`.
7. Use the source change procedure above if you need to move the source.

If the lists still fail, keep the restored source and inspect the original error.
If the record is missing, use your installation records to find the registered path.
Do not create an empty source directory or change the record to bypass the error.
Do not delete Codex settings, plugin registrations, caches, or message data to repair this failure.
If another installed plugin uses the marketplace, keep its registration and source.
Use a separate `CODEX_HOME` when you cannot safely change the existing registration.

Before you change or remove the plugin, cancel idle notifications from their original sessions.
Close sessions that loaded the old plugin before you stop its broker.
If the old checkout is unavailable, you can run `node plugins/cross-session/src/cli.mjs broker-stop` from a restored or new checkout.
Use the same `CODEX_HOME` and `CROSS_SESSION_HOME` settings that the old broker used.
The shutdown command does not repair marketplace registration.
It does not restart the Codex daemon.
If shutdown fails, keep the message data and follow [the removal guide](UNINSTALL.md).
After restoration, you can also retry the installation or removal script with the same `--home` directory.
The installer checks the plugin list before it installs dependencies.
The dry run shows planned commands only.
It does not check the Codex plugin list or confirm that source recovery succeeded.

## Diagnostics

| Problem | Check |
|---|---|
| Codex executable not found | Set `CROSS_SESSION_CODEX_BIN` to an absolute executable path. |
| Shared daemon unavailable | Start a normal Codex CLI session without `--no-daemon`. |
| Session missing | Confirm that the session is a loaded independent root session. |
| Name or project information missing | Review hook trust and register the session name. |
| Delivery uncertain | Read the outbox before another send. |
| Broker stop refused | Cancel your idle notifications before shutdown. |
| Marketplace source conflict | Use the source change procedure above. |
| Plugin list fails after a source directory moves | Restore the recorded source path with the recovery procedure above. |

`npm run doctor` reads the daemon and the session list.
Its output can contain session IDs and project paths.
Remove private information before you share the output.

The broker shutdown command is `node plugins/cross-session/src/cli.mjs broker-stop`.
It does not stop the Codex daemon.
It refuses shutdown while idle notification subscriptions remain.
Use [the removal guide](UNINSTALL.md) for removal and data cleanup.

If `broker-stop` returns `DELIVERIES_ACTIVE`:

1. Wait for the current message delivery results.
2. Run `broker-stop` again.

A request that returns `BROKER_STOPPING` was not accepted.
This error does not change the result of an earlier accepted or uncertain delivery.
