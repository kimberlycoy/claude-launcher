# Claude Launcher

A one-page web app that starts and stops a `claude remote-control` server per project, from an iPhone over Tailscale. See README.md for setup and security.

- server.mjs: Node standard library only, no npm dependencies. Keep it that way.
- Machine-specific settings (Tailscale login, project folders) live in config.local.json, which is gitignored. Never commit personal values (emails, hostnames, home paths); use config.example.json and placeholders.
- Runs under launchd on 127.0.0.1:8766; `tailscale serve --set-path /rc` exposes it. Tailscale strips the /rc prefix, so the page uses relative URLs only.
- Each server is a tmux session named rc-<group>-<project>, with @rc_path, @rc_name and @rc_mode=server session options. Stop sends Ctrl-C, then kills the tmux session. The launched claude gets a clean environment (`env -i`) so desktop app or Claude Code variables don't leak in.
- Don't loosen the Tailscale login check or the project allow-list in start().
- Local notes for this machine, if any, are in CLAUDE.local.md.
- Versioning: semver in VERSION, with an entry in CHANGELOG.md for each release. To release: retake the README screenshots (`node docs/screenshots.mjs`, sample data only) and look at both to check they match the current UI; bump VERSION, add the changelog entry, commit, tag vX.Y.Z, push the tag, and create a GitHub release from the changelog entry.
