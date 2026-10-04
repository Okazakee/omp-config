# omp-config

Personal [omp](https://omp.sh) configuration, published so a new machine can be
bootstrapped from a single command.

**No secrets are stored here.** API keys, OAuth tokens and SSH keys live only on
the machine that holds them. See [RESTORE.md](RESTORE.md) for what was stripped.

## What is in here

| Path | Contents |
| --- | --- |
| `agent/config.yml` | model roles, theme, composer, and every other setting |
| `agent/pack/` | the custom extension package referenced from `config.yml` |
| `agent/skills/` | user-level skills |
| `agent/extensions/` | loose extension modules |
| `agent/{tools,commands,rules,prompts,hooks,instructions}/` | the rest of the capability surface |
| `versions.env` | pinned `omp` and `bun` versions, written at each backup |
| `agent/.sanitized.txt` | which values were removed at backup time |
| `agent/skills/omp-config/bin/` | the backup and restore scripts |

## What is deliberately absent

`agent.db` (holds OAuth tokens and API keys), every other database, `sessions/`,
`blobs/`, `cache/`, `secrets.yml`, and the per-install identity. Those are
machine state, not configuration.

## Restoring on a new machine

Needs only bash and curl:

    curl -fsSL https://github.com/Okazakee/omp-config/raw/HEAD/agent/skills/omp-config/bin/omp-config-restore \
      | bash -s -- --repo=git@github.com:Okazakee/omp-config.git

The script installs bun if missing, installs the pinned omp version if it is
missing or off-pin, copies `agent/` into the active omp agent directory, then
prints the `/login` steps. Credentials are never restored from this repo.

Flags: `--dry-run`, `--target=DIR` (restore into a scratch directory),
`--repo=PATH|URL`, `--force` (overwrite existing files, keeping `.bak-<ts>`).

## Updating this repo

Sync runs on demand, never on a timer:

    agent/skills/omp-config/bin/omp-config-sync            # copy, sanitize, gate, diff, commit
    agent/skills/omp-config/bin/omp-config-sync --push     # commit, then push after confirming

The sync copies an allowlist out of the omp agent directory, strips literal
`apiKey:` and broker-token values, normalizes absolute home paths to `~/`, then
runs three gates before staging anything: a credential-shape grep, a
private-key grep, and `trufflehog filesystem`. Nothing is committed without a
diff review.

## Authoring extensions

The extension package and its house rules are documented in
[`agent/skills/omp-extensions/SKILL.md`](agent/skills/omp-extensions/SKILL.md).
