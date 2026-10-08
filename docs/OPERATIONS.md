# Update and diagnostics

[한국어](OPERATIONS.ko.md)

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

`npm run doctor` reads the daemon and the session list.
Its output can contain session IDs and project paths.
Remove private information before you share the output.

The broker shutdown command is `node plugins/cross-session/src/cli.mjs broker-stop`.
It does not stop the Codex daemon.
It refuses shutdown while idle notification subscriptions remain.
Use [the removal guide](UNINSTALL.md) for removal and data cleanup.
