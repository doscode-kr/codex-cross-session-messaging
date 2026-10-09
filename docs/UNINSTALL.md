# Remove the plugin

[한국어](UNINSTALL.ko.md)

Plugin files, marketplace registration, and message data are separate items.
The default removal keeps message data.
If the broker recorded a journal failure, it cannot save subscription cancellations.
Skip the cancellation step in that case.
An explicit broker stop preserves subscriptions and journal events after that failure.
Pending deliveries still block shutdown.
Keep the journal for recovery unless you explicitly choose data cleanup below.
Correct the storage problem before you restart the broker.
Preserved subscriptions can resume their checks after restart.
Use the same `CODEX_HOME` that you used for installation.

## Standard removal

1. Save any message records you need.
2. If the journal is healthy, cancel idle notification subscriptions from their original sessions.
3. Close Codex sessions that loaded the plugin.
4. Stop the message broker from an external shell.

   ```text
   node plugins/cross-session/src/cli.mjs broker-stop
   ```

5. Examine the removal plan.

   ```text
   node scripts/uninstall.mjs --dry-run
   ```

6. Remove the plugin and its dedicated marketplace.

   ```text
   node scripts/uninstall.mjs
   ```

7. Open a new Codex CLI session.
8. Check the plugin list with `codex plugin list --json`.

For a separate Codex home, use `node scripts/uninstall.mjs --home <directory>`.
Add `--dry-run` to examine that plan first.
Use the direct Node.js command for options in PowerShell.
The script does not remove Codex itself or restart the Codex daemon.
If `broker-stop` returns `BROKER_OFFLINE`, no broker is running for that message directory.
Close plugin sessions before broker shutdown because their exit hooks can start the broker again.
The script removes the dedicated marketplace only when it recognizes the source and no other installed plugin uses it.
The source must list only the cross-session plugin.
It keeps an unknown or shared marketplace.
It removes its recognized `.cross-session-install.json` installation record.
It stops if it finds an unrecognized plugin cache or an unsafe linked path.

## Remove default message data

Warning: Data cleanup removes saved messages and registrations.
The data cannot be recovered from the plugin after deletion.

1. Save any message records you need.
2. If the journal is healthy, cancel idle notification subscriptions from their original sessions.
3. Close sessions that can start the broker.
4. Stop the broker from an external shell with `node plugins/cross-session/src/cli.mjs broker-stop`.
5. Examine the data cleanup plan.

   ```text
   node scripts/uninstall.mjs --purge-runtime --dry-run
   ```

6. Run data cleanup after you check the target.

   ```text
   node scripts/uninstall.mjs --purge-runtime
   ```

Cleanup applies only to verified product files in the standard `<CODEX_HOME>/cross-session` directory.
The cleanup targets are `events.jsonl` and `auth-token`.
Other files remain in place.
It does not remove the whole Codex settings directory.
It does not automatically delete a custom `CROSS_SESSION_HOME` directory.
If a broker is active, cleanup stops with an error.
The script checks the broker again immediately before data deletion.
If that later check fails, the plugin can already be removed while message data remains.
The dry run does not test whether the broker is active.
Do not delete an active broker's journal or authentication token.

On Windows, automatic cleanup also checks the runtime directory's 8.3 short path.
It refuses cleanup when that short path differs from the native full path.
It also refuses cleanup when the short path cannot be checked.
A legacy broker can use a different port for the same directory under a short path.
A stopped broker at the full-path port does not establish that the short-path broker is stopped.
This path check applies to `--purge-runtime` and its dry run.
The first check occurs before plugin removal.
If it fails, the command keeps both the plugin and message data.
Run standard removal without `--purge-runtime` to remove the plugin while you keep the data.
Use the full `CODEX_HOME` directory path for standard removal.
Do not pass its 8.3 short path to `--home`.
Use the manual data procedure below only after you confirm that all related brokers have stopped.

The broker shutdown command is `node plugins/cross-session/src/cli.mjs broker-stop`.
With a healthy journal, it refuses shutdown while idle notification subscriptions remain.
Cancel your subscriptions from their original sessions in that case.
After a recorded journal failure, an explicit stop preserves those subscriptions and permits shutdown.
It does not cancel subscriptions or delete journal events.
Pending deliveries still block shutdown.
If the journal is healthy and another session owns a subscription, request that session's cancellation.
The next plugin call can start the broker again.
Close plugin sessions before you retry cleanup.

For a custom data directory, verify its resolved path and stop its users first.
Save the needed records before you remove the product files manually.
Do not remove unrelated files from a custom directory.

## Manual plugin removal

If the plugin list fails after the source checkout moves, restore the original source path first.
Follow [the source recovery procedure](OPERATIONS.md#recover-an-unavailable-source-directory).
The removal script cannot safely proceed without the plugin list.
An installation record does not replace that list or authorize registration removal.
The dry run does not read that list.

1. Read the installed plugin list with `codex plugin list --json`.
2. Check whether another installed plugin uses `cross-session-local`.
3. If the journal is healthy, cancel idle notification subscriptions from their original sessions.
4. Close sessions that loaded the plugin.
5. Stop the broker from an external shell with `node plugins/cross-session/src/cli.mjs broker-stop`.
6. Run `codex plugin remove cross-session@cross-session-local`.
7. Run `codex plugin marketplace remove cross-session-local` only if no other installed plugin uses it.
8. Open a new Codex CLI session.
9. Run `codex plugin list --json`.

These Codex commands remove the plugin cache and marketplace registration.
They do not remove the message directory.
Keep the marketplace registration when another installed plugin uses it.
Keep the source checkout until you have completed the checks.
You can remove that checkout as a separate file operation after removal.

## Manual Windows data removal after an alias refusal

Warning: Manual data removal permanently deletes saved messages and registrations.

1. Save the records you need from the runtime directory.
2. If the journal is healthy, cancel idle notification subscriptions from their original sessions.
3. Close all related Codex sessions.
4. Stop each broker that used the full path or a short path from an external shell.
5. Confirm with your OS process tools that all those broker processes have exited.
6. If still installed, remove the plugin with `node scripts/uninstall.mjs --home <full-home-path>`.
7. Check the runtime directory's resolved full path.
8. Confirm that `events.jsonl` and `auth-token` belong to this plugin.
9. Delete only `events.jsonl` from that directory.
10. Delete only `auth-token` from that directory.
11. Remove the runtime directory only if it is empty.

Use `node plugins/cross-session/src/cli.mjs broker-stop` with the same message environment that each broker used.
Set `CROSS_SESSION_HOME` to that broker's runtime path spelling when needed.
Restore your environment setting after the shutdown commands.
The token can be shared by brokers that use different ports for one directory.
Do not use `BROKER_OFFLINE` for one spelling as proof that all brokers have stopped.
If you cannot confirm every related broker has stopped, keep the data files.
Keep unrelated files and the parent Codex home.
This procedure does not require a Codex daemon restart.
