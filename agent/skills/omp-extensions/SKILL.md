---
name: omp-extensions
description: "Authoring omp extensions: layout, ExtensionAPI, TUI seams, rules that don't break core."
---

# Authoring custom omp extensions

Verified against the installed `@oh-my-pi/pi-coding-agent` / `@oh-my-pi/pi-tui`
sources (`~/.bun/install/global/node_modules/@oh-my-pi/`). Claims name the file
they came from; re-check after an omp upgrade.

## The layout: one directory, referenced once

Everything you own lives in a single extension-package directory, and that one
directory is registered in `config.yml`. It is the only layout where one root
carries code *and* skills, hooks, tools, commands, rules, prompts and MCP config
together.

```text
~/.omp/agent/pack/                 # one dir, yours
  package.json                     # { "omp": { "extensions": ["./src/index.ts"] } }
  src/
    index.ts                       # one factory; imports the rest
    quota-status.ts
    thinking-badge.ts
    lib/                           # shared helpers — never scanned as plugins
      usage.ts
      format.ts
  skills/<name>/SKILL.md
  hooks/pre/*.ts  hooks/post/*.ts
  tools/*.ts  tools/<name>/index.ts
  commands/*.md  rules/*.md  prompts/*.md
  .mcp.json
```

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/.omp/agent/pack
```

`package.json` is what makes it a package:

```json
{
  "name": "my-pack",
  "version": "1.0.0",
  "type": "module",
  "files": ["src", "skills", "hooks", "tools", "commands", "rules", "prompts"],
  "omp": { "extensions": ["./src/index.ts"] }
}
```

Three ways to wire the same directory, in order of preference:

```bash
omp plugin link ~/.omp/agent/pack   # register once; survives config edits
omp install ~/.omp/agent/pack       # equivalent local symlink install
omp --extension ~/.omp/agent/pack   # one-off dev session
```

`omp plugin link` puts the package into the plugin set
(`~/.omp/plugins/node_modules/` + `omp-plugins.lock.json`), managed by
`omp plugin list` / `omp plugin doctor` like any installed plugin. `extensions:`
in `config.yml` is the no-install alternative. A **relative** configured path
resolves from the directory omp starts in, not from the config file — use an
absolute path.

`bun add --dev @oh-my-pi/pi-coding-agent` in the package for current types and
editor completion.

Evidence: `src/discovery/omp-extension-roots.ts` turns every directory in
`extensions:` into an `OmpExtensionRoot`; `src/discovery/omp-plugins.ts`
(priority 90) scans that root's `skills/`, `commands/`, `rules/`, `prompts/`,
`hooks/pre|post/`, `tools/`, and `.mcp.json` / `mcp.json`.

Why not just `~/.omp/agent/extensions/*.ts`: it works (native provider, priority
100) but it only loads *modules*. Shared helper files placed beside them either
load as bogus plugins (`lib/index.ts` → plugin `lib`) or sit outside every scan
root. The package layout keeps `src/lib/` invisible to discovery.

### Adding the next thing

The pack is the single drop point. A new capability is a new entry in
`omp.extensions` (or a new subfolder), never a new top-level config root:

| Adding | Do this |
| --- | --- |
| a second extension module | append to `omp.extensions`: `["./src/index.ts", "./src/quota-status.ts"]` |
| a tool | `pack/tools/<name>/index.ts` |
| a skill | `pack/skills/<name>/SKILL.md` with `name` + `description` frontmatter |
| a slash command | `pack/commands/<name>.md` |
| a hook | `pack/hooks/pre/<tool>.<name>.ts` (must be inside `pre/` or `post/`) |
| MCP servers | `pack/.mcp.json` |
| a settings toggle for the pack | a JSON/YAML file beside the module; validate it with an omptype schema |

Restart omp after changing a factory, installing, or adding a tool/hook — those
do not hot-reload. `/reload-plugins` refreshes skills, commands and MCP only.

## Where omp loads things from

| Capability | User root | Project root | Notes |
| --- | --- | --- | --- |
| extension modules | `~/.omp/agent/extensions/` | `<cwd>/.omp/extensions/` | `.ts`/`.js` only, one level |
| hooks | `~/.omp/agent/hooks/pre|post/` | `<cwd>/.omp/hooks/pre|post/` | factory must sit *inside* `pre/`/`post/` |
| tools | `~/.omp/agent/tools/` | `<cwd>/.omp/tools/` | `.ts/.js/.sh/.py/.md/.json`, plus `tools/<name>/index.ts` |
| commands | `~/.omp/agent/commands/*.md` | `<cwd>/.omp/commands/*.md` | |
| skills | `~/.omp/agent/skills/<name>/SKILL.md` | `<cwd>/.omp/skills/<name>/SKILL.md` | non-recursive, `description` required |
| rules | `~/.omp/agent/rules/*.md` | `<cwd>/.omp/rules/` | plus top-level `RULES.md` (always-on) |
| prompts / instructions | `~/.omp/agent/prompts/`, `instructions/` | `<cwd>/.omp/…` | |
| settings | `~/.omp/agent/config.yml` | `<cwd>/.omp/config.yml` | `settings.json` still read, lower priority |
| models / auth | `~/.omp/agent/models.yml`, `/login` | — | |

Path resolution: a named profile (`omp --profile x`, `OMP_PROFILE`) moves every
user root to `~/.omp/profiles/x/agent/…`; `PI_CODING_AGENT_DIR` overrides the
agent dir in the default profile only; `PI_CONFIG_DIR` moves the config root;
initialized XDG data/state/cache roots relocate `sessions/`, blobs, `agent.db`.
Native discovery is cwd-only for the project side (no ancestor walk) except
`SYSTEM.md`/`RULES.md`/`AGENTS.md`, which do walk up.

## Extension module discovery, precisely

`discoverExtensionModulePaths()` (`src/discovery/helpers.ts:837`):

1. direct `extensions/*.ts` / `*.js`
2. `extensions/<name>/index.ts` / `index.js`
3. `extensions/<name>/package.json` with a non-empty `omp.extensions` (or legacy
   `pi.extensions`) → declared entries only
4. linked extension files discovered by the same manifest rules

No recursion past one subdirectory. Native scanning uses a glob with
`gitignore: true, hidden: false`; explicitly configured directories use `readdir`
and do **not** apply gitignore. Symlinks are eligible; dedupe is by absolute
path, first occurrence wins, and dedupe does not resolve realpaths.

Load order: native modules → hook factories → installed plugin entries →
explicit `-e`/`extensions:` paths. Modules import concurrently (top-level side
effects have no order guarantee); factories then run sequentially in that order.
The factory is the module itself if it is a function, else `module.default`.

## Runtime model (what omp isolates, and what it does not)

- **Not a sandbox.** Same process, shared `EventBus`, one `ExtensionRuntime`.
- Per-path import/factory failures become `{ path, error }` and never abort the
  other modules. A failed factory's pending provider registrations roll back.
- `withHostGuard()` makes load-time `process.exit` throw `ExtensionExitError`.
- Handler budget: 30 s for most events (`extensionHandlers.toolCallTimeoutMs`),
  paused while an extension dialog is open, **fail-closed** for `tool_call`;
  `session_shutdown` runs concurrently with a 2 s budget.
- Timers must go through `ctx.setInterval` / `ctx.setTimeout` and be cleared on
  `session_shutdown`; detached timers survive the session.
- Restricted children (task/eval) rebind the parent's imported factories instead
  of rediscovering, so they keep hooks/providers but gain no new authority.
- `--no-extensions` keeps only explicit `-e` paths (plus sibling roots those
  packages own). `--trusted-extension <abs file>` loads *only* those files and
  aborts startup on failure — the cleanest way to bisect a broken extension.
- `disabledExtensions` disables live without restart; ids look like
  `extension-module:<derivedName>` (from the entry path), and also
  `skill:<name>`, `context-file:<level>:<basename>`, etc.

## ExtensionAPI surface

Events (all `pi.on(...)`): `resources_discover`, `session_start`,
`session_before_switch`, `session_switch`, `session_before_branch`,
`session_branch`, `session_before_compact`, `session.compacting`,
`session_compact`, `session_shutdown`, `session_before_tree`, `session_tree`,
`cache_warming_decision`, `context`, `before_provider_request`,
`after_provider_response`, `before_agent_start`, `before_subagent_spawn`,
`agent_start`, `agent_end`, `session_stop`, `turn_start`, `turn_end`,
`message_start`, `message_update`, `message_end`, `assistant_message`,
`tool_execution_start/update/end`, `auto_compaction_start/end`,
`auto_retry_start/end`, `retry_fallback_applied/succeeded`, `ttsr_triggered`,
`todo_reminder`, `goal_updated`, `credential_disabled`, `input`,
`tool_approval_requested/resolved`, `tool_call`, `tool_result`, `user_bash`,
`user_python`, `mcp_notification`.

Registration: `registerTool`, `registerCommand`, `registerShortcut`,
`registerFlag`, `registerMessageRenderer`, `registerAssistantThinkingRenderer`,
`registerComposerShape`, `registerProvider` / `unregisterProvider`,
`registerFileWriteFallback`, `registerFileDeleteFallback`.
Session control: `sendMessage`, `sendUserMessage`, `appendEntry`, `exec`,
`setActiveTools`, `setModel`, `getThinkingLevel`, `setThinkingLevel`,
`getServiceTiers`, `setServiceTier`, `shutdown`.
Context: `logger`, `hasUI`, `cwd`, `models`, `model`, `getContextUsage`,
`sessionManager`, `modelRegistry`, `agent`, `memory`.

Schema helpers ship on the API object: `pi.zod` and `pi.arktype` for new tool
schemas, `pi.typebox` for compatibility with older extensions. Command handlers
receive the larger `ExtensionCommandContext` with `waitForIdle()`,
`newSession()`, `switchSession()`, `branch()`, `navigateTree()`, `reload()`.

Tool definitions require `name`, `label`, `description`, `parameters`, `execute`;
optional `hidden`, `defaultInactive`, `loadMode`, `approval` (default `exec`),
`deferrable`, `strict`. `execute(toolCallId, params, signal, onUpdate, ctx)`
must honor `signal` and use `onUpdate` for streamed progress.

**All `register*` calls belong in the factory body.** Registration happens when
`ExtensionRunner.initialize()` runs; anything registered later never takes
effect (documented for the file-write/delete fallbacks; holds for the rest of the
`register*` family).

`registerProvider(name, { usage })` supplies a normalized `UsageProvider` whose
`fetchUsage(params, ctx)` feeds the same cache, history and `omp usage` display
as built-ins. Set a `cacheVersion` distinct from any built-in you shadow.
`UsageReport` / `UsageLimit` / `UsageProvider` / `UsageAmount` are the contract
types, all exported from `@oh-my-pi/pi-ai`.

## UI matrix

| Capability | Interactive TUI | RPC | Print / headless / subagent |
| --- | --- | --- | --- |
| dialogs (`select`/`confirm`/`input`/`editor`) | yes | round-trip | no-op |
| `setStatus`, `setWidget`, `notify`, `setEditorText` | yes | emitted as requests | no-op |
| `custom()` component | yes (editor slot or overlay) | **no-op** | no-op |
| `setEditorComponent` | yes (`CustomEditor` subclass) | no-op | no-op |
| `addAutocompleteProvider` | yes | no-op | no-op |
| `setHeader`, `setFooter` | **no-op** | no-op | no-op |
| `setTheme`, `setWorkingMessage` | yes | failure | no-op |
| `getEditorText` | yes | `""` | `""` |

`ctx.hasUI` is false in print mode but can be true over RPC while `custom()` is
still unsupported. For terminal UI, `ctx.mode === "tui"` is the stricter guard.
There is no `setHeader`/`setFooter` seam; the upstream-pi footer/header providers
were replaced by `StatusLineComponent` when omp was ported
(`docs/porting-from-pi-mono.md`). `setWidget(key, string[] | factory, { placement })`
renders above or below the editor (string arrays cap at 10 lines plus a
truncation notice).

Components are strict: `render(width)` must be width-safe (`visibleWidth`,
`truncateToWidth`, `replaceTabs`), should return the *same array reference* when
unchanged (reference equality drives memoization), and `dispose()` must be
idempotent when you own timers/sockets.

## Status line: the only real TUI seam

Segments render in configured order. Built-in ids (`schema.ts`): `pi`, `status`,
`model`, `mode`, `path`, `git`, `pr`, `subagents`, `session`, `session_name`,
`hostname`, `context_pct`, `context_total`, `cost`, `token_in`, `token_out`,
`token_total`, `token_rate`, `cache_hit`, `cache_read`, `cache_write`, `usage`,
`time`, `time_spent`, `collab`, `stream`, `vim`.

Preview them without starting a session:

```bash
omp gallery --surface=segment --plain
omp gallery --segment=usage --plain
```

- `statusLine.preset: default|minimal|compact|full|nerd|ascii|custom`; the custom
  preset is the only one that reads `leftSegments`/`rightSegments`
  (`component.ts`, `useCustomSegments`). Defaults when set to custom:
  left `["vim","model","mode","path","git","pr"]`,
  right `["session_name","token_total","cost","context_pct"]`.
- Adding the `status` segment to a list makes extension statuses render there,
  in that position, joined with `theme.sep.dot`.
- Statuses are sorted by key (`localeCompare`), so key prefixes control order
  among several statuses.
- `sanitizeStatusText` = `sanitizeDisplaySingleLine(text)` + collapse runs of
  spaces + trim. **Column padding with spaces is impossible**, and the whole
  status renders in one accent colour — no per-window red/amber thresholds, and
  no ANSI from the extension survives.
- `statusLine.showHookStatus: false` also suppresses them in the footer.
- The built-in `usage` segment renders only the *active* account:
  `🕐 5h 0% (4h 59m) · 7d 18% (5d 23h)`, coloured muted / warning ≥50 % /
  error ≥80 %, with `mo` for monthly-only subscription providers and `✦` for
  banked Codex reset credits. `SegmentContext.usage` exposes `fiveHour`, `daily`,
  `sevenDay`, `monthly`, `resetCredits`, `tier` — extensions cannot set it, only
  read it indirectly.

## Worked example A — quota monitor (in progress)

`~/.omp/agent/extensions/quota-status.ts` renders one status entry per
provider: `gpt+ ◷ 0% · 📅 18%`, `cc ◷ 0% · 📅 31% · 36.3`.

Design decisions worth keeping:

- Data source is `omp usage --json` (`pi.exec`), i.e. the same normalized
  `UsageReport[]` the built-in segment reads, so omp's 5-minute cache
  (`USAGE_REPORT_TTL_MS`) and 24-hour last-good retention apply. Polling faster
  than the TTL only re-reads cache.
- Headless guard `if (!ctx.hasUI) return;` — `omp usage --json` loads extensions
  too, and without the guard the extension spawns itself forever.
- Only labels/order/icons come from config; window ids, units and reset times are
  derived from the report. Provider data is validated with an
  `@oh-my-pi/omptype` schema at the process boundary, never cast.
- Staleness is a `?` on the label (spaces are collapsed, colour is unavailable).
- Refresh interval must be ≥ the usage cache TTL.
- Migrate it into `pack/src/` once the layout is in use.

## Worked example B — thinking level after the model

Mostly **already built in**: the `model` segment appends `· high` / `⟳ auto`
after the model name, and `statusLine.segmentOptions.model.showThinkingLevel:
false` turns it off. `statusLine.compactThinkingLevel: true` swaps the model icon
for the level glyph instead.

So "current thinking level between the model name and the dir label" is a config
change, not an extension:

```yaml
statusLine:
  preset: custom
  leftSegments: ["pi", "vim", "model", "mode", "collab", "stream", "path", "git", "pr", "context_pct", "cost"]
  rightSegments: ["usage", "status", "session_name", "token_total", "cost", "context_pct"]
```

An extension is only needed for something the model segment cannot show —
`pi.getThinkingLevel()` gives the level, `pi.setThinkingLevel()` changes it, and
`ctx.ui.setStatus("thinking", …)` renders a value in whatever slot `status`
occupies.

## Diagnosing a package that misbehaves

| Symptom | Cause / fix |
| --- | --- |
| package does not load | `omp --extension <abs path>` removes config + cwd ambiguity; the entry must default-export a function |
| load error detail | `/extensions` shows discovery state; structured logs under `~/.omp/logs/` name the failing path |
| capability missing | restart after editing a factory or installing; `/reload-plugins` refreshes skills, commands and MCP only — tools, hooks and extension modules need a new session |
| item disabled | `/extensions`, or `disabledExtensions` with `extension-module:<name>` (an `index.ts` entry uses its parent directory name) |
| works in TUI, fails elsewhere | in-process and unsandboxed: catch detached-promise failures, use `ctx.setInterval` / `ctx.setTimeout`, honor abort signals, release on `session_shutdown` |

## Non-negotiables (each of these has bitten someone)

1. Never edit anything under the omp install tree. It is replaced on upgrade.
2. Import only published packages: `@oh-my-pi/pi-tui`, `@oh-my-pi/pi-coding-agent`,
   `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, `@oh-my-pi/pi-utils`,
   `@oh-my-pi/omptype`. Avoid `dist/src/...` deep paths even though the sources
   ship — they are not a stability contract.
3. Register in the factory body, not in an event handler.
4. Clear every timer/socket on `session_shutdown`; `dispose()` must be idempotent.
5. Guard UI with `hasUI`, and again for `custom()` in RPC hosts.
6. Assume no colours and no space padding in status text.
7. Validate external data (CLI JSON, config files, network) with an omptype
   schema; never cast it.
8. Keep handlers under the 30 s budget — `tool_call` fails closed on timeout.
9. Prefer `omp <cmd> --json` over poking `agent.db`; the CLI is the contract.
10. Never hardcode a credential in an extension. Read it from the auth store
    (`omp token <provider>`), an env var, or a usage provider's normalized
    credential — the pack directory is a candidate for public backup.
11. Test with `-e <file>` and `--no-extensions` before blaming the user's setup.

## Distributing what you built

```bash
omp install @acme/my-pack                 # published to npm
omp install github:acme/my-pack#v1.0.0   # public git repo, immutable ref
omp plugin marketplace add acme/omp-extensions
omp plugin install my-pack@acme-extensions
```

Marketplace catalogs live at `.omp-plugin/marketplace.json`
(`.claude-plugin/marketplace.json` is the Claude-compatible fallback) and require
`name`, `owner.name`, and `plugins[]` entries with `name` + `source`. Sources may
be a relative path, git URL, `github`, or `git-subdir`; `npm` sources are parsed
but the installer rejects them. Installs are scoped `user` (default,
`~/.omp/plugins/`) or `project` (`<project>/.omp/plugins/`), and project installs
shadow user installs of the same plugin.

## Verification recipes

```bash
omp --extension ~/.omp/agent/pack            # load the pack, ambient discovery off
omp -e ~/.omp/agent/pack/src/quota-status.ts  # one module
omp usage --json -e <file>                    # exercise a headless path
omp config list | grep statusLine             # effective settings
omp gallery --segment=usage --plain           # preview a segment
```

Interactive behaviour (status line, widgets, editors) must be checked in a real
pty — headless runs are no-ops by design.

## Open risks

- The `pi-tui` and `coding-agent` packages ship TypeScript sources; that is
  convenience, not an API promise. Re-verify every claim in this file after
  `omp update`.
- `sanitizeStatusText` collapsing whitespace is an implementation detail in
  `chrome/shared.ts`; a future release could preserve padding and invalidate the
  "no column alignment" constraint (which would only ever help).
- OpenRouter has no built-in usage provider, so a credits row needs a
  `registerProvider("openrouter", { usage })` reading `GET /api/v1/key`
  (`limit`, `limit_remaining`, `usage_daily/weekly/monthly`). Registering an
  existing provider id also replaces its base URL/api config unless they are
  re-declared — verify `omp models --provider openrouter` still resolves after
  adding it.