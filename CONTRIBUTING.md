# Contributing

[한국어](CONTRIBUTING.ko.md)

Use the [issue tracker](https://github.com/doscode-kr/codex-cross-session-messaging/issues) for bugs and proposals.
Read [SECURITY.md](SECURITY.md) for security reports.
The project uses the [MIT License](LICENSE).

## Development

1. Install Node.js 20 or later.
2. Install plugin dependencies.

   ```text
   npm ci --prefix plugins/cross-session --ignore-scripts
   ```

3. Make a focused change.
4. Run `npm run check`.
5. Run `npm test`.
6. Run `git diff --check`.
7. Submit a pull request with the result and test evidence.

Use Node.js ESM for implementation files.
Plugin code is in `plugins/cross-session/`.
Tests are in `tests/`.
Install and check scripts are in `scripts/`.
Public product documents are in the root directory and `docs/`.
Private agent rules and task records are not part of the source distribution.
No local agent workflow is required to contribute.

## Delivery rules

- Use `turn/steer` for a busy recipient.
- Use `turn/start` for an idle recipient.
- Return a delivery error when direct input fails.
- Keep recipient permissions and task scope.
- Treat peer text as untrusted input.
- Keep delivery acceptance, reading, and task completion separate.
- Never resend an uncertain message automatically.
- Never restart the user's daemon automatically.

Use temporary data directories in tests.
Do not send test messages to a user's running sessions.
The real integration test is optional in a standard local test run.
See [VERIFICATION.md](docs/VERIFICATION.md) for its explicit opt-in.
For delivery, permissions, or storage changes, include review of failure handling.

Update the English and Korean versions of public user documents together.
Keep their instructions consistent.
Describe commands from the current implementation.
Report skipped checks and OS limits.
Do not include personal paths, secrets, or message journals in an issue or pull request.
