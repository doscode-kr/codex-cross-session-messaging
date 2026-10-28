# Update and diagnostics

[한국어](OPERATIONS.ko.md)

## Check Codex compatibility before an update

This release is experimental.
The recorded CI baseline used Codex CLI 0.161.0 on Windows and macOS with Node.js 20 and 22.
The verification record identifies each tested commit and its results.
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

## Inspect the message broker

Run this command from the source directory:

```text
node plugins/cross-session/src/cli.mjs broker-status
```

This command only reads the existing broker state.
It does not create files or start the broker.
It does not query or restart the Codex daemon.

| Result | Meaning |
|---|---|
| `offline`, `STATE_MISSING` | The state directory or saved token is absent. |
| `offline`, `BROKER_OFFLINE` | No broker accepted the connection. |
| `running` | The broker returned a valid health response. |
| `degraded` | The broker recorded a journal failure. New writes are blocked. |
| `stopping` | The broker is stopping. |
| `diagnostics: null` | The running broker does not provide these metrics. Its journal condition is unknown. |

Offline results use exit code 0.
Authentication, access, and response errors use exit code 1.
These errors are not reported as offline.
The command does not repair failures or resend messages.

`journal.committedBytes` is the last confirmed journal position in memory.
It is not the current file size.
A partial write can leave an unconfirmed file tail.
`counts.registeredSessions` counts stored registrations, not live sessions.
Other counts show stored messages, active idle subscriptions, pending deliveries, and pending idle checks.
Metrics can change after the response.
The metric output excludes message bodies, tokens, paths, and raw storage error messages.
Use `doctor` separately to check access to the Codex daemon.

## Inspect and cancel idle notifications

Use `list_idle_notifications` from the session that requested the notifications.
The result contains only that session's pending subscriptions.
Each item has a `subscriptionId` that you can pass to `cancel_idle_notification`.
Successful `send_message` calls with `notify_when_idle: true` also return the saved subscription ID.

The default page contains at most 20 items.
Use `limit` from 1 to 100 and pass `nextCursor` as `after_subscription_id` for the next page.
The cursor is an exclusive ID boundary in character order.
It still works after that subscription is canceled.
Pages are not a fixed snapshot.
New subscriptions before the cursor can be absent from later pages.
Start again at the first page to inspect the current set.

This query requires a loaded session and access to the Codex daemon.
The query does not save leader cleanup or change subscriptions.
Normal client startup can start the broker and recover its journal.
Use `broker-status` for inspection that must not start the broker.
See [the tool reference](MANUAL.md) for arguments and results.

## Update from the same source directory

1. Save the release tag or commit you currently use.
2. Get the new release in the registered source directory.
3. Read [CHANGELOG.md](../CHANGELOG.md).
4. If the journal is healthy, cancel outstanding idle subscriptions from their original sessions.
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

10. Resume your saved Codex CLI sessions.
11. Review the new hooks in `/hooks`.
12. Run `npm run doctor`.

The source directory and the installed cache are separate.
If the journal has failed, use [storage recovery](#recover-from-a-journal-failure) before continuing the update.
Changing the source alone does not confirm a cache update.
This procedure keeps the message data.
The installer does not restart the running daemon.
Stopping the message broker lets the next plugin call load the new broker code.
If `broker-stop` returns `BROKER_OFFLINE`, no broker is running for that message directory.
Close plugin sessions before broker shutdown to prevent later plugin calls from starting it again.
The SessionEnd hook does not start a broker.

## Change the source directory

A marketplace name can already point to another source.
The installer returns an error in that case.

1. Read the installed plugin list with `codex plugin list --json`.
2. Check whether another installed plugin uses `cross-session-local`.
3. If the journal is healthy, cancel outstanding idle subscriptions from their original sessions.
4. Close sessions that loaded the old plugin.
5. Stop the old broker from an external shell with `node plugins/cross-session/src/cli.mjs broker-stop`.
6. Remove `cross-session@cross-session-local` with `codex plugin remove`.
7. Remove the old source with `codex plugin marketplace remove cross-session-local` only if no other installed plugin uses it.
8. Run `npm run install:global` in the new source directory.
9. Resume your saved Codex CLI sessions.
10. Review the hooks in `/hooks`.

If another installed plugin uses that marketplace, stop this source-change procedure after step 2.
Keep its registration and source.
Use a separate `CODEX_HOME` if you need the new source without changing that registration.

Use the same `CODEX_HOME` for each command.
Keep the old source until the new installation passes your checks.
To go back, use the saved release with the [same-source update procedure](#update-from-the-same-source-directory).
If you use another source directory, follow the source-change procedure above.
These procedures remove the installed cache before installation.

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

With a healthy journal, cancel idle notifications from their original sessions before you change or remove the plugin.
If the journal has failed, use the storage recovery procedure below.
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

## Journal memory and growth

The broker restores complete journal lines one at a time.
It keeps message metadata in memory.
It reads message bodies from `events.jsonl` when a response needs them.
It does not keep a body cache.
Existing messages and complete event history are retained.
State writes with identical metadata do not add another event.
A changed session timestamp or acknowledgment timestamp still adds an event.
Repeated writes are therefore not a complete audit of every attempt.

An invalid complete event stops startup.
An incomplete last line is removed only after all earlier complete events are checked.
A body read failure stops later writes.
Keep the journal and correct the storage problem before restarting the broker.

The broker does not compact the journal or expire messages automatically.
Disk use and restart time still increase with stored events.
Metadata memory still increases with message count.
One very large event can still require substantial memory.
Message reads can use more disk I/O because bodies are read on demand.
Use [the removal guide](UNINSTALL.md) for an explicit data removal procedure.

## Recover from a journal failure

A failed journal blocks cancellation because cancellation is a saved change.
Do not repeat cancellation as a prerequisite for stopping a failed broker.
Before recovery, stop new plugin calls in all sessions that share the message directory.
Wait for existing calls to return.
Keep the original subscribing sessions loaded for the checks after recovery.
Do not close those sessions or trigger plugin hooks during recovery.
Calls and hooks can start an offline broker before the storage problem is corrected.
Resume plugin calls only after the explicit start in step 5.

1. Inspect the broker with `node plugins/cross-session/src/cli.mjs broker-status`.
2. Stop it with `node plugins/cross-session/src/cli.mjs broker-stop`.
3. Keep the journal for recovery.
4. Correct the storage problem.
5. Start the broker from an external terminal with `node plugins/cross-session/src/broker.mjs`.
6. Inspect pending notifications with `list_idle_notifications` from their original subscribing sessions.
7. Cancel unwanted subscriptions with `cancel_idle_notification`.

If stop returns `DELIVERIES_ACTIVE`, wait for those delivery results before repeating step 2.
Use the same message directory throughout this procedure.
Stopping the broker does not cancel saved subscriptions or mark messages complete.
Do not remove complete journal events to bypass a startup error.
This procedure does not restart the Codex daemon.

## Delivery result storage errors

Codex can accept a message before the broker saves its result.
A storage error does not cancel that delivery.
Use the returned `messageId` to check the same message after storage recovery.

| Error or detail | Meaning and action |
|---|---|
| `STORE_UNAVAILABLE`, `requestOutcome: not_submitted` | This waiting delivery did not start. Keep its message ID. |
| `DELIVERY_UNCERTAIN`, `requestOutcome: unknown` | The broker cannot confirm the saved result. Do not resend automatically. |
| `DELIVERY_FAILED`, `requestOutcome: rejected` | A known rejection or delivery precondition failure occurred. A failed journal update does not remove that known result. |
| `IDLE_SUBSCRIPTION_UNCERTAIN` | Message acceptance was saved. Only the idle subscription result is unknown. Do not resend the message. |

`IDLE_SUBSCRIPTION_UNCERTAIN` includes the subscription ID and `idleNotificationOutcome: unknown`.
A failed sync can still leave a complete subscription event on disk.
Check the subscription after recovery before creating another one.
The response preserves any saved acknowledgment.
Neither acceptance nor an acknowledgment proves task completion.

Storage diagnostics include an error code, not the storage error's raw text.
An initial message write failure can occur before the broker returns a message ID.
Keep the journal in that case too.
Recovery can mark an unfinished saved message as `uncertain`.
Recovery does not resend that message.

## Broker response errors

`BROKER_TIMEOUT` means the client did not receive a complete response.
This includes a timeout during the response body and a detected connection failure.
`BROKER_RESPONSE_INVALID` means the response has invalid JSON or an invalid structure.
It also covers HTTP redirects. The client does not follow redirects or repeat the request at another address.
Neither error confirms whether the broker processed the request.
The client does not repeat message, hook, or shutdown requests after these errors.
The client uses one timeout for the connection and response body.
Error details identify the request path and mark the result as unknown.
They do not include the invalid response body or authentication token.

1. Read the outbox before another message send.
2. Check the broker status before another shutdown request.
3. Keep the message journal if the result remains unknown.

An invalid health response does not cause an automatic broker start.
A valid broker rejection keeps its original error code and message.
Success responses must be JSON objects.
The health response must identify the requested message directory.
The shutdown response must confirm `stopped: true`.

## Diagnostics

| Problem | Check |
|---|---|
| Codex executable not found | Set `CROSS_SESSION_CODEX_BIN` to an absolute executable path. |
| Shared daemon unavailable | Start a normal Codex CLI session without `--no-daemon`. |
| Session missing | Confirm that the session is a loaded independent root session. |
| Name or project information missing | Review hook trust and register the session name. |
| Delivery uncertain | Read the outbox before another send. |
| Broker stop refused | Wait for active deliveries. Cancel your idle notifications if the journal is healthy. |
| Marketplace source conflict | Use the source change procedure above. |
| Plugin list fails after a source directory moves | Restore the recorded source path with the recovery procedure above. |

`npm run doctor` reads the daemon and the session list.
Its output can contain session IDs and project paths.
Remove private information before you share the output.

The broker shutdown command is `node plugins/cross-session/src/cli.mjs broker-stop`.
It does not stop the Codex daemon.
With a healthy journal, it refuses shutdown while idle notification subscriptions remain.
After a recorded journal failure, an explicit stop preserves those subscriptions and permits shutdown.
It does not cancel subscriptions or delete journal events.
Pending deliveries still block shutdown.
Late idle checks cannot start a delivery after shutdown begins.
Preserved subscriptions can resume their checks after storage recovery and broker restart.
The broker does not automatically stop or restart itself to repair a storage failure.
Use [the removal guide](UNINSTALL.md) for removal and data cleanup.

If `broker-stop` returns `DELIVERIES_ACTIVE`:

1. Wait for the current message delivery results.
2. Run `broker-stop` again.

A request that returns `BROKER_STOPPING` was not accepted.
This error does not change the result of an earlier accepted or uncertain delivery.
