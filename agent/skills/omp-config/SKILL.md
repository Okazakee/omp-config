---
name: omp-config
description: Back up and restore omp configuration through a public GitHub repo without leaking secrets. Use when the user asks to back up, sync, snapshot, restore or reinstall their omp setup, to set up a new machine from the saved config, to check what omp config is safe to publish, or to audit a config directory for credentials before it goes public.
---

# omp config backup and restore

Two scripts live in `bin/` beside this file. Run them from a session when asked —
there is no timer, nothing pushes on its own.

| Task | Command |
| --- | --- |
| back up current config into the repo | `bin/omp-config-sync` |
| bootstrap a machine from the repo | `bin/omp-config-restore` |

Default repo: `git@github.com:Okazakee/omp-config.git`, local clone at
`~/omp-config`. Override with `--repo=PATH` or `OMP_CONFIG_REPO`.

## What is backed up

An **allowlist** is copied out of the agent dir — deny-by-default, because a
gitignore denylist fails the moment a new file type appears:

- files: `config.yml`, `models.yml`, `keybindings.*`, `RULES.md`, `SYSTEM.md`,
  `APPEND_SYSTEM.md`, `TITLE_SYSTEM.md`, `.mcp.json`
- directories: `pack/`, `skills/`, `extensions/`, `tools/`, `commands/`,
  `rules/`, `prompts/`, `instructions/`, `hooks/`

## What is never backed up

| Excluded | Why |
| --- | --- |
| `agent.db` (mode 0600) | holds `auth_credentials` — OAuth tokens and stored API keys |
| `history.db`, `models.db`, `stats.db`, `autoqa.db`, `skill-descriptions.db` | machine-local state and derived metrics |
| `*.db-wal`, `*.db-shm` | write-ahead logs of the above |
| `sessions/` | full conversation transcripts — private content, not configuration |
| `blobs/`, `cache/`, `predict/`, `logs/`, `run/`, `puppeteer/` | machine-local |
| `secrets.yml` | literal secret values by design |
| `secret-placeholder.key`, `install-id` | per-install identity |
| `marketplaces.json`, `plugins/` | install state, rebuilt by `omp plugin` |

## Secrets policy for a public repo

The databases are the easy part. The real leak risk is inside files we *want* to
publish, so sync sanitizes before staging:

1. literal `apiKey:` values in `models.yml` → commented out, count recorded in
   `agent/.sanitized.txt`
2. `auth.broker.token` in `config.yml` → commented out, recorded the same way
3. absolute `$HOME` paths → rewritten to `~/` (a public repo should not publish
   the username and directory layout)

Then three gates, all of which must pass before anything is staged:

- **shape grep** — `apiKey|token|secret|password|authorization` followed by an
  8+ character value in any staged text file
- **private-key grep** — `-----BEGIN … PRIVATE KEY-----`, `ssh-rsa`/`ssh-ed25519`
  key bodies
- **trufflehog** — `trufflehog filesystem` over the staged tree; run
  `trufflehog git file://<repo>` to rescan history after a bad commit

`git diff --cached` is reviewed before every commit and confirmed before push.
Machines catch shapes, not intent.

Rules for anything added to the backed-up tree:

- never write a credential into a hook, extension, skill or config file — read
  it from `omp token <provider>`, the environment, or a usage provider's
  normalized credential
- prefer `apiKey: env:VAR_NAME` over literal values in `models.yml`
- if a value must be literal, add it to `secrets.yml` (never backed up) instead

## Restore / new machine

One command installs everything, in dependency order:

```bash
# from any machine with bash + curl
curl -fsSL https://raw.githubusercontent.com/Okazakee/omp-config/main/agent/skills/omp-config/bin/omp-config-restore \
  | bash -s -- --repo=git@github.com:Okazakee/omp-config.git
```

It performs, in order:

1. **bun** — present: report version. Missing: `npm install -g bun`, falling back
   to the official install script.
2. **repo** — clone (or reuse a local path), then read `versions.env`.
3. **omp** — `omp --version` compared against the pin; mismatched or missing →
   `bun install -g @oh-my-pi/pi-coding-agent@<pinned>`.
4. **config** — copies the allowlist into the agent dir, skipping existing files
   unless `--force`, backing up anything it overwrites as `<name>.bak-<ts>`.
   Databases, sessions and caches are never touched.
5. **manual steps** — prints the env vars stripped at backup time and the
   `/login` commands per provider, because credentials never travel in the repo.

Useful flags: `--dry-run` (prints every step, changes nothing), `--target=DIR`
(restore into a scratch dir instead of the live agent dir), `--repo=PATH|URL`.

Named profiles are respected on both sides: `OMP_PROFILE=x` resolves to
`~/.omp/profiles/x/agent/` for both sync and restore.

## Sync workflow

```bash
bin/omp-config-sync            # copy, sanitize, gate, show diff, confirm, commit
bin/omp-config-sync --yes      # same, no commit prompt (still no push)
bin/omp-config-sync --push     # also pushes, after its own confirmation
```

Sync always rewrites `versions.env` with the live `omp` and `bun` versions, so
"pinned" means *whatever was running when the last backup ran*.

## Verification recipes

```bash
bin/omp-config-sync --repo=/tmp/omp-config-test --yes      # gates + commit into a scratch repo
bin/omp-config-restore --repo=/tmp/omp-config-test --target=/tmp/omp-agent-test --dry-run
trufflehog git file://$HOME/omp-config                     # rescan history
```

Both scripts are plain bash: `bash -n` them after any edit.

## Open risks

- `agent/` holds ~80M of sessions and databases, which is why the repo mirrors an
  allowlist instead of being a git repo in place. Editing `~/.omp/agent/` directly
  and forgetting to sync is the expected failure mode — run sync after any config
  change.
- A public repo publishes config structure even with no secrets: model ids, role
  names and provider names are visible. That is acceptable for a personal
  dotfiles repo; do not put anything about other people or clients in it.
- `trufflehog` is installed at `~/.local/bin/trufflehog`; the sync script skips
  gate 3 when it is missing rather than failing silently — check the output says
  "trufflehog clean", not "skipped".