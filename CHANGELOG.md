# Changelog

Versions follow semantic versioning (https://semver.org). The current version is in VERSION and shows at the bottom of Settings.

## 1.0.0 - 2026-10-25

First release.

- One `claude remote-control` server per project, started and stopped from a phone over Tailscale. Each runs in its own tmux session with a clean environment.
- Only the configured Tailscale login can use the page, and start only accepts folders from the configured project groups.
- Machine-specific settings (login, project groups, accounts) live in an untracked config.local.json; see config.example.json.
- A page per project group with New project, Running, Recent and All projects. New project turns what you type into a folder name and starts a server in it.
- A Trust button for servers waiting at Claude's "trust this folder" prompt. The launcher never answers it on its own.
- Recent ranks projects by your last Claude use there, read from Claude Code's session logs, falling back to file changes.
- Activity: time with Claude per day and per project, sessions, output tokens, and projects not used in 14 days, over 7 or 30 days.
- Optional per-account project groups with an account switch in Settings.
- Toolbar tabs show running counts and a dot when a server needs Trust. The app opens on the last page used.
- Settings saved in the browser: rows before a list folds, the recent window and count, and the theme.
- Pull down to reload.
