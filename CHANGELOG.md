# Changelog

## 0.2.0

- Extract a cancellable session state machine. Commands join an in-progress reconnect instead of revoking the running agents' token and terminals.
- Add a status bar actions menu, cancellable connection progress, actionable error notifications, settings shortcuts and a getting-started walkthrough.
- Localize command titles, settings and runtime UI for English and Simplified Chinese.
- Store SSH targets per workspace authority, migrate legacy mappings, and support manual SSH ports and bracketed IPv6 input.
- Harden network cancellation, HTTP/catalog error handling, authentication prompt concurrency and process cleanup.
- Add isolated lifecycle and command regression tests, model-import and localization checks, and a cross-platform CI matrix.

## 0.1.3

- Decode Remote-SSH workspace addresses instead of treating hex-encoded JSON as a DNS hostname; preserve the SSH user and explicit port.
- Automatically repair affected saved host mappings, prioritize the current workspace target, and retain intentional host overrides.
- Log the resolved target and connection stages to distinguish local gateway, SSH, and remote HTTP failures.

## 0.1.2

- Prepare Marketplace metadata, search keywords, icon and privacy documentation.
- Package with Microsoft's official vsce tool and exclude local reports and development files.

## 0.1.1

- macOS/Linux password and key-passphrase authentication through VS Code secure input.
- Private per-session SSH control socket reuses authentication for remote probes.
- No password persistence; cancelled prompts abort authentication.

## 0.1.0

- Local UI extension, loopback reverse SSH tunnel, authenticated model API proxy.
- End-to-end remote HTTP probe, bounded reconnect, session cleanup.
- Remote terminals and Claude Code / Codex CLI launchers; model picker.
- Local Claude model environment import; no provider credential copying.
