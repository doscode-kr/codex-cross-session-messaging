# Release checklist

[한국어](RELEASE.ko.md)

The current distribution is a Codex plugin in a local source marketplace.
The npm packages are private.
This repository does not publish an npm package or a hosted service.
This checklist does not claim that a release was published.

## Prepare the candidate

1. Match the root package, plugin package, lockfile root, and plugin manifest versions.
2. Include `LICENSE` and confirm the `MIT` package license fields.
3. Check relative links in both README files.
4. Check install, update, and removal instructions against the current scripts.
5. Install dependencies with `npm ci --prefix plugins/cross-session --ignore-scripts`.
6. Run `npm run check`.
7. Run `npm test`.
8. Run the isolated real Codex integration test from [VERIFICATION.md](VERIFICATION.md).
9. Test installation in a temporary `CODEX_HOME`.
10. Test removal in that temporary home.
11. Test the retention and cleanup options in that temporary home.
12. Confirm that unrelated Codex files remain unchanged.
13. Run the configured Windows and macOS CI jobs.
14. Record versions, results, skipped checks, and compatibility limits.
15. Check the candidate for private files, paths, tokens, and journals.
16. Obtain an independent review of the final diff.

Version values also appear in the broker and native client implementation.
Check those values when you change the product version.
The delivered files must contain the plugin manifest, MCP configuration, hooks, shipped skill, source, and dependency lockfile.
The marketplace source must resolve to `plugins/cross-session`.
The installed cache must contain runtime dependencies after source installation.
The plugin directory must include the same MIT license text as the repository root.
Windows cleanup checks must cover 8.3 path aliases and a failed alias query.
Both conditions must preserve runtime data.
An initial purge check failure must preserve the installed plugin.

## Prepare support

1. Enable GitHub private vulnerability reporting.
2. Verify the issue and security report links.
3. Update [CHANGELOG.md](../CHANGELOG.md) for the final candidate.
4. Document OS and Codex protocol limits.
5. Document the tested update and removal path.

The existing Windows results do not establish macOS support by execution.
A configured workflow is not evidence of a successful CI run.
The integration test uses a local mock model.
It does not prove that a real model completes a requested task.

## Publish after authorization

1. Confirm that all candidate checks passed or have an explicit documented limitation.
2. Create the approved version tag.
3. Push the approved commit and tag.
4. Publish release notes with the compatibility and removal links.

Repository edits and local commits do not imply authorization to push or publish.
No tag, push, GitHub release, or marketplace publication was performed as part of this document change.
