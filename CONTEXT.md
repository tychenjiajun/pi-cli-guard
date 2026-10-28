# pi-cli-guard

A pi extension that canonicalizes the agent's bash commands to the preferred
modern toolchain — `grep` → `rg` and a conservative `find` → `fd` — by rewriting
`event.input.command` in the `tool_call` event.

## Language

**Rule**:
A pure translator that receives the argument tokens of one command (after the
command name) and returns a **Rewrite**, a **No-op**, or a **Refusal**. Rules
live in `src/rules/` and never touch I/O, `PATH`, or pi state.

**Rewrite**:
A rule decision that replaces the command name and arguments. The **Engine**
turns it into a positional splice over the command's name…args span.

**Refusal**:
A rule decision that declines to translate because no faithful mapping exists
(e.g. a BRE pattern whose meaning changes under Rust regex). The **Engine** then
leaves the original command byte-for-byte untouched. Refusing is always safe.

**Engine**:
The pure `rewriteCommand` function in `engine.ts`: parses with `unbash`, walks
the `Command` nodes, applies the enabled **Rules**, and splices replacements
back-to-front. It does not descend into command/process substitutions, and it
skips a command whose name…args span contains an interleaved redirect.

**Enabled Rule**:
A **Rule** paired with the resolved binary name to emit (`rg`, `fd`, or the
Debian alias `fdfind`). Built by `config.ts` from the environment and `PATH`;
a rule whose binary is missing is not enabled.

**Notice**:
The trailing text appended to a rewritten bash result so the model sees what
changed. Controlled by `PI_CLI_GUARD_NOTICE`.

**Contract**:
The versioned `details.piCliGuard` record published on the result
(`contract.ts`, currently v2), carrying the original command, the rewritten
command, and the list of changes. Each change carries the rule's `notes` for
that command, which is also what the **Notice** prints.

**Dialect Gate** (`grep` only):
The check that a **basic** (BRE) pattern means the same under Rust regex before
allowing a rewrite. BRE treats `+ ? ( ) { } |` as literals and `\+ \? \( \) …`
as operators; Rust regex does the opposite. Only plain literals, a small set of
safe escapes, and BRE alternation (`a\|b` → `a|b`) pass; a pattern that also uses
an untranslatable operator refuses.

## Design decisions

- **`tool_call`, not `registerTool("bash")`.** pi's registry is
  first-registration-per-name-wins, so a second bash override silently disables
  `pi-tool-guard`. Mutating the input composes with it instead.
- **One package, two rules.** Both rewrite the same way, at the same seam, for
  the same audience; only the translation table and risk differ. Risk is a
  per-rule concern (a conservative whitelist and refusals), not a package
  boundary.
- **Refuse rather than guess.** The value is speed without silent correctness
  bugs. When a faithful mapping is not obvious, the legacy command stays.
- **Capability-aware.** No binary on `PATH` means no rewrite, so a rewritten
  command can never fail for a missing tool.
- **Report every observable change.** Skipping `.gitignore`, the `-r` ⇒
  `--with-filename` fixup, and fd's directory format all appear in the
  **Notice** so the model can reason about a changed result.

## Known deviations

- `rg`/`fd` respect `.gitignore` and skip hidden files; `grep`/`find` do not.
- fd prints directories with a trailing `/` and omits the search root itself.
- `grep PATTERN DIR` without `-r` errors in grep, searches recursively in rg.
- `grep -r` with no path prints `./`-prefixed names; `rg` without a path prints
  bare names.

_Avoid_: calling this a "shell alias" or "wrapper" — it rewrites the model's
command text, not the shell environment.