# Keep project instructions after compaction

[한국어](PROJECT_GUIDANCE.ko.md) · [Document list](README.md)

The plugin reads your project's instruction files when the SessionStart hook runs.
It puts the file contents directly in the next model context.
This also occurs when the same session resumes or its context is compacted.
You do not need a chain binding or a new session.

## Use

1. Install the updated plugin with the [update procedure](OPERATIONS.md).
2. Review its hooks in Codex `/hooks`.
3. Trust the hooks that you intend to use.
4. Keep your project instructions in `AGENTS.md`.
5. Continue work in the project.

The plugin includes the reader, not the maintainer's project instructions.
It does not create or change your instruction files.
It does not copy the files into the message journal or chaining checkpoints.
Codex can include the injected text in its conversation records and model requests.
Do not put secrets in these files.

## File selection

In a Git worktree, the reader starts at that worktree's root.
It reads each directory on the path to the hook's current working directory.
It does not read a different worktree or the common Git directory.
Outside Git, it checks only the current directory.

At each directory, a nonempty `AGENTS.override.md` takes priority over `AGENTS.md`.
An absent or empty override allows `AGENTS.md` in that directory.
An unreadable or invalid override causes an error instead of selecting another file.
The context lists the selected files in root-to-directory order.
Instructions closer to the working directory apply to that scope.

This reader does not load global Codex instructions, custom fallback filenames, or files linked from the instructions.
Codex still handles its own instruction discovery.
The plugin supplies another copy at SessionStart; it does not remove Codex's copy.

## Timing and limits

SessionStart includes startup, resume, clear, and compact events.
The reader reloads files at each event and uses no persistent content cache.
Ordinary UserPromptSubmit events do not add another copy.
If a file changes during an open conversation, the plugin loads that change at the next SessionStart event.
Subagents do not run this reader through a parent's hook.

The selected bodies have a combined limit of 32 KiB.
The reader requires regular files and valid UTF-8.
It rejects file links and paths outside the current project boundary.
If a read fails or the combined size exceeds the limit, the plugin omits the whole set.
It reports the reason instead of cutting an instruction in half.
This differs from Codex's own instruction-size truncation policy.
The reader also has a time limit and does not retry after a timeout.
Its failure does not disable messaging or handoff restoration.
No instruction files is a normal result.

Project guidance does not grant new approval or change session permissions.
Peer messages and saved handoffs remain separate untrusted data.
Text delivery does not prove that a model follows the instructions.

## Avoid duplicate project hooks

An existing project hook might already inject the same file contents.
Choose one hook to supply that copy.
Keep other project-hook functions, such as task tracking, separate.
The plugin does not disable or rewrite other hooks.

Set `CROSS_SESSION_PROJECT_GUIDANCE=0` in the plugin hook process environment to disable this reader.
The other plugin functions remain enabled.
For a shared daemon, a variable set only in a newly attached CLI process might not reach the hooks.
Set the environment through the host or hook launcher that actually runs the command.
The plugin does not restart the daemon or change hook trust to apply this setting.
