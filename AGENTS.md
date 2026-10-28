# Agent Instructions

## Package Manager
- Use **pnpm**: `pnpm install`

## Commands
| Task | Command |
|------|---------|
| Run all tests | `pnpm test` |
| Type check | `pnpm typecheck` |
| Run one test file | `pnpm vitest run src/rules/grep.test.ts` |

## Key Conventions
- This is a **pi extension** — entry point is `src/index.ts` (declared in `package.json` under `pi.extensions`)
- **Never `pi.registerTool("bash")`.** pi's registry is first-registration-wins, so a second bash override silently disables `pi-tool-guard`. Rewrite the command in the `tool_call` event instead (`event.input.command = ...`).
- Rules in `src/rules/` are **pure** `ArgToken[] -> RuleDecision` translators. No I/O, no `PATH`, no pi state. Resolving binaries and reading config belongs to `src/config.ts`; parsing and splicing belongs to `src/engine.ts`.
- **Refusing is free, guessing is not.** When a flag/pattern/expression has no provably faithful translation, return `{ kind: "refuse", reason }`. The engine leaves the original command untouched.
- Rewrites must be **idempotent**: `rewrite(rewrite(x)) === rewrite(x)`. Already-modern commands (`rg`, `fd`) must be untouched.
- Preserve the model's raw shell text for words it wrote (`word.text`); use `token()` only for synthesized words. Quote globs and braces so bash never expands them (see `src/shell.ts`).
- Every behaviour change that a model could notice (skip `.gitignore`, trailing `/` on directories, `--with-filename`) must appear in the trailing notice and in `details.piCliGuard`.
- Tests: `*.test.ts` beside the module. `src/equivalence.test.ts` runs the real `rg`/`fd` and compares stdout — extend it whenever you add a translation, and gate new binaries with `installed()`/`skipIf`.

## Architecture
- `src/index.ts` — Extension entry: `tool_call` (rewrite) + `tool_result` (notice + contract)
- `src/config.ts` — Environment config + binary resolution into `EnabledRule[]`
- `src/engine.ts` — `unbash` parse, command walk, positional splice; pure. Skips the parse entirely when the source contains none of the enabled rule command names (substring test, so it only over-approximates)
- `src/rules.ts` — `CommandRule` type + curated registry (`grep-to-rg`, `egrep-to-rg`, `fgrep-to-rg`, `find-to-fd`); `egrep`/`fgrep` are thin wrappers that prepend a synthetic `-E`/`-F` to `translateGrep`
- `src/rules/grep.ts` — grep → rg translator + BRE/Rust dialect gate
- `src/rules/find.ts` — find → fd translator (conservative whitelist)
- `src/shell.ts` — `ArgToken`, `shellQuote`, `joinTokens`
- `src/path.ts` — `PATH` executable lookup (no `which` spawn)
- `src/contract.ts` — `details.piCliGuard` interop contract (v2); each change carries the rule's `notes`, which `src/notice.ts` prints
- `src/notice.ts` — model notice text + transient footer status

## Reference data
- ripgrep: https://github.com/BurntSushi/ripgrep
- fd: https://github.com/sharkdp/fd
- fd's `--glob`/`-g` is a **boolean** flag; the glob is the single positional after it. `-g` is not an option-with-value, so passing it twice makes fd treat the second value as a search path — combine multiple globs into one brace glob `{a,b}`.
- `fd` default is a **regex**, `-g` switches the positional to a glob.
- `fd -p/--full-path` matches the **full path as a regex**, so `find -path GLOB` maps to `-p -s REGEX` only when the glob starts with `*` (unanchored) and `*` becomes `.*` (may cross `/`). A `-name` alongside it becomes `--and '(^|/)BASENAME$'`, because `--and` also sees the full path.
- `rg` prints line numbers, headings and filenames differently from `grep` depending on tty/multi-file; `--with-filename`/`-n`/`--no-heading` pin the format.

## Commit Attribution
AI commits MUST include:
```
Co-Authored-By: MiMo <mimo@xiaomi.com>
```