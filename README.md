# pi-cli-guard

English | [简体中文](./docs/README.zh-CN.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/tychenjiajun/pi-cli-guard/main/assets/preview.png" alt="pi-cli-guard rewrites the model's bash commands to the modern toolchain — grep → rg and a conservative find → fd subset" width="880">
</p>

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/pi-cli-guard.svg)](https://www.npmjs.com/package/pi-cli-guard)
[![Release](https://img.shields.io/github/v/release/tychenjiajun/pi-cli-guard)](https://github.com/tychenjiajun/pi-cli-guard/releases/latest)
[![pi extension](https://img.shields.io/badge/pi-extension-7c3aed.svg)](https://pi.dev/docs/latest/extensions)
[![pi package](https://img.shields.io/badge/pi-package-7c3aed.svg)](https://pi.dev/docs/latest/packages)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](./tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-169%20passing-brightgreen.svg)](./package.json)
[![CI](https://github.com/tychenjiajun/pi-cli-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/tychenjiajun/pi-cli-guard/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/pi-cli-guard.svg)](https://www.npmjs.com/package/pi-cli-guard)
[![pnpm](https://img.shields.io/badge/package%20manager-pnpm-f69220.svg)](https://pnpm.io)

> **In one sentence:** *pi-cli-guard rewrites the model's legacy bash to the
> modern toolchain the harness already ships — `grep` → `rg` and a conservative
> `find` → `fd` — at the `tool_call` seam, so it composes with other bash
> extensions instead of overriding the tool.*

**pi-cli-guard** is an open-source (MIT), TypeScript extension for the
[pi](https://github.com/earendil-works/pi) AI coding agent that canonicalizes the
agent's bash commands to the preferred modern toolchain:

- **`grep`/`egrep`/`fgrep` → `rg`** ([ripgrep](https://github.com/BurntSushi/ripgrep))
- **`find` → `fd`** ([fd](https://github.com/sharkdp/fd)) — a conservative,
  whitelisted subset only

It does **not** override the `bash` tool. It mutates `event.input.command` in
the `tool_call` event, so it composes with other bash extensions (notably
[`pi-tool-guard`](https://github.com/tychenjiajun/pi-tool-guard)) instead of
colliding with them.

> Why this exists: pi's system prompt already recommends `rg`, but real
> sessions show the model reaching for legacy tools anyway. Measured across
> three repositories: **6,888 `grep` bash calls vs 1,648 `rg`**, and **899
> `find` vs 1 `fd`** — plus the user repeatedly interrupting to say *"grep so
> slow, use rg"*. A prompt line is not enough; the harness has to fix it.

**Install:** `pi install npm:pi-cli-guard` · see the
[pi.dev gallery page](https://pi.dev/packages/pi-cli-guard) and the
[packages documentation](https://pi.dev/docs/latest/packages).

## Install

```bash
pi install npm:pi-cli-guard
# or load this checkout for one session:
pi -e .
```

`rg` and `fd` must be on `PATH`. A rule is skipped when its binary is missing,
so the original command is never rewritten to something that would fail.
(`fd` is `fdfind` on Debian/Ubuntu; both are detected.)

## Configuration

Read from the environment — no settings plumbing:

| Variable | Default | Meaning |
|---|---|---|
| `PI_CLI_GUARD` | on | `off`/`0`/`false` disables the extension entirely |
| `PI_CLI_GUARD_RULES` | all | comma list of short names (`rg`, `egrep`, `fgrep`, `fd`) or full ids (`grep-to-rg`, `find-to-fd`) |
| `PI_CLI_GUARD_NOTICE` | on | `off` stops appending the rewrite note to the result |

## What it rewrites

![Demo: pi-cli-guard rewrites the model's legacy grep/find bash to rg and fd](https://raw.githubusercontent.com/tychenjiajun/pi-cli-guard/main/assets/demo.gif)

### `grep` → `rg`

`egrep` and `fgrep` share this translator: they are just `grep` with an implicit
`-E`/`-F`, and the injected flag is dropped when it matches rg's default dialect.

Option letters collide between the two tools, so a naive rename is unsafe. The
collisions are mapped:

| grep | rg | why |
|---|---|---|
| `-r` | `--with-filename` | `grep -r` always prints the filename; rg does not for a single file |
| `-R` | `-L --with-filename` | rg's `-R` does not exist; its `-L` follows symlinks |
| `-h` | `--no-filename` | rg's `-h` is *help* |
| `-H` | `--with-filename` | rg's `-H` is *hidden* |
| `-s` | `--no-messages` | rg's `-s` is *case-sensitive* |
| `-L` | `--files-without-match` | rg's `-L` follows symlinks |
| `-E` | *(dropped)* | grep's ERE ≈ rg's default regex |
| `-I` | *(dropped)* | rg ignores binary files by default |
| `--include=G` | `-g G` | |
| `--exclude=G` | `-g '!G'` | |
| `--exclude-dir=D` | `-g '!D/**'` | |

Everything else common (`-i -v -w -x -c -l -n -o -q -a -F -P -A/-B/-C -e -f -m`,
`--color`, …) passes through.

**The dialect gate.** grep's default dialect is BRE; rg uses Rust regex, where
`a+` means one-or-more `a` instead of a literal `a+`. A BRE pattern is rewritten
only when it is provably equivalent in both dialects: plain literals, safe
escapes such as `\.`, and BRE alternation, rewritten `a\|b` → `a|b` (by far the
most common real-world pattern — `grep "FAIL\|Test Files"`). Anything else
(unescaped `+ ? ( ) { }`, `\+`, `\s`, `\|` inside a bracket expression, a
pattern carrying a shell expansion, …) **refuses** and leaves the command
untouched. `-E`, `-F` and `-P` are dialect-compatible and always allowed.

### `find` → `fd`

Only these forms are translated; anything else is refused:

| find | fd |
|---|---|
| `find [path] -name GLOB` | `fd -g -s GLOB [path]` (explicit `-s` beats fd's smart case) |
| `-iname GLOB` | `-g -i GLOB` |
| `-type f/d/l` | `-t f/d/l` |
| `-maxdepth N` / `-mindepth N` | `-d N` / `--min-depth N` |
| `-name A -o -name B` | `-g '{A,B}'` |
| `-path GLOB` (leading `*`) | `-p -s REGEX` (glob → full-path regex) |
| `-path GLOB -name GLOB` | `-p -s REGEX --and '(^\|/)BASENAME$'` |
| `\( … \)` with no `-o` inside | *(parentheses dropped)* |
| leading `-L` | `-L` (follow symlinks) |

`-path`'s glob becomes a Rust regex where `*` still crosses `/`; only globs that
start with `*` are accepted, because that is what makes find's whole-path match
and fd's unanchored `--full-path` match agree.

Refused (left as `find`): `-exec`, `-delete`, `-prune`, `-newer`, `-perm`,
`-size`, `-regex`, `!`/`-not`, boolean `-o` that is not between name globs,
implicit-AND name globs, name globs containing `/`, an anchored `-path` glob,
`-path` mixed with `-iname` or an `-o` chain, a group that contains `-o` (real
precedence), and an `-o` name chain combined with `-type` (find's AND binds
tighter than `-o`, so `-type f -name a -o -name b` cannot be expressed by one fd
call).

## Fidelity guarantees and known deviations

The engine parses the command with [`unbash`](https://github.com/webpro-nl/unbash)
and splices only the command-name…args span, so redirects, pipelines,
`&&`/`||` chains, environment prefixes and comments outside that span are
preserved byte-for-byte. Commands containing command/process substitutions, or
with a redirect interleaved inside the argument span, are skipped entirely. The
engine is idempotent.

Accepted, documented deviations (surfaced to the model in the notice):

- **rg respects `.gitignore` and skips hidden files**; `grep -r` does not. This
  is the intended speed win; `-u`/`--no-ignore` restores exhaustive search.
- **fd skips hidden and `.gitignore`d paths**, and prints directories with a
  trailing `/` and without the search root itself.
- **`grep PATTERN DIR` without `-r`** errors in grep but searches recursively in
  rg — this turns a common model mistake into working behaviour.
- **BRE patterns** that would change meaning are refused, not guessed.

Each change carries the `notes` the rule attached to that command — the same
lines the notice prints — so a caveat that only applies to this invocation
(e.g. `--include` turning ripgrep's ignore rules off) is not lost behind a
rule-level paragraph.

A command a rule recognises but declines to translate is left byte-for-byte
untouched and only reported (`refusals`), so the model can tell "the guard had
no faithful equivalent" from "the guard never looked".

The rewrite is reported back to the model (a trailing note on the bash result)
and recorded in `details.piCliGuard`:

```ts
import { readPiCliGuardDetails } from "pi-cli-guard/contract";

const guard = readPiCliGuardDetails(result.details);
if (guard) {
  guard.originalCommand; // "grep -rn foo ."
  guard.command;         // "rg --with-filename -n foo ."
  guard.changes;         // [{ rule: "grep-to-rg", before, after, notes }]
  guard.refusals;        // [{ rule: "find-to-fd", before, reason }] — declined rewrites
}
```

## Composability with `pi-tool-guard`

pi's tool registry is *first registration per name wins*. `pi-tool-guard` already
overrides `bash`, so a second `registerTool("bash")` would silently disable it.
This extension therefore never registers a tool; it rewrites the input in the
`tool_call` event. `pi-tool-guard` sees the rewritten command and can still
strip/re-apply a trailing `rg`/`fd` view extractor.

## FAQ

### Does pi-cli-guard override or replace the bash tool?

No. It mutates `event.input.command` in the `tool_call` event; the tool itself
is never re-registered, so the first-registered `bash` (e.g. `pi-tool-guard`)
keeps winning.

### How is this different from just telling the model to use rg in a prompt?

Prompts are advisory — across real sessions the model still wrote 6,888
`grep` calls vs 1,648 `rg`. pi-cli-guard enforces the mapping in the harness
and refuses any rewrite that would change behaviour (BRE, find edge cases).

### Does pi-cli-guard work with pi-tool-guard and other bash extensions?

Yes — composition is the design goal. It never registers a tool, so other bash
extensions see the already-rewritten command and can act on it afterwards.

### What happens if rg or fd is not installed?

The rule is skipped and the original command runs byte-for-byte untouched —
the guard never rewrites a command into one that would fail.

## Related pi extensions

- [pi-tool-guard](https://github.com/tychenjiajun/pi-tool-guard) — runs an
  expensive bash command once, keeps its full log, and repairs broken tool-call
  arguments. `pi-cli-guard` was written to compose with its `bash` override.
- [pi-codemode-guard](https://github.com/tychenjiajun/pi-codemode-guard) —
  compiles LLM-written codemode scripts before they reach the sandbox.
- [pi-codemode-snippets](https://github.com/tychenjiajun/pi-codemode-snippets) —
  turns a `// @snippet:` `.js` file into a named, composable pi tool.
- [pi-skill-guard](https://github.com/tychenjiajun/pi-skill-guard) —
  guards skill loading and invocation.
- [pi-voice](https://github.com/tychenjiajun/pi-voice) — speech input for pi.

## Development

```bash
pnpm install
pnpm test        # 169 unit + real-binary equivalence tests
pnpm typecheck
pi -e .          # load this checkout as an extension for one session
```

The equivalence tests run the *original* and the *rewritten* command through the
real `rg`/`fd` and compare stdout; they skip when the binaries are absent.

Design notes live in [`AGENTS.md`](./AGENTS.md) and [`CONTEXT.md`](./CONTEXT.md).
Pi's own documentation:
[Extensions](https://pi.dev/docs/latest/extensions) ·
[Pi packages](https://pi.dev/docs/latest/packages) ·
[Package gallery](https://pi.dev/packages/pi-cli-guard).

## License

MIT