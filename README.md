# mend

One patch tool for every AI edit format. `mend` applies an edit that an AI model
wrote to a tree of text files, reading all four formats models use — unified
diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and
text-editor tool calls as JSON — exactly as `SPEC.md` in this repository says,
and changing every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- Node 22 and its standard library alone; nothing to install.
- Lines an edit names are found at the first of three matching tiers (exact,
  trailing-whitespace-insensitive, indentation-insensitive) unless `--strict`
  restricts matching to exact lines only.
- `--check` reports what would change and writes nothing.
- The exit code, the standard output, and the resulting files are the contract:
  see `SPEC.md` for the whole specification.

`runner.ts` is the make.fun trial runner, kept as the kit ships it: when
`MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it. `check.ts` runs
the public practice set against `main.ts` on your own machine.

Licence: MIT (see `LICENSE`).
