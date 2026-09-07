# Agent Guidance: nextjs-fsd

This repo is a CLI that shapes *other people's* Next.js projects. Every change
here is a change to code you will never see run — a template that renders
wrong produces a project that fails to build for someone else, hours later.
That asymmetry is what the rules below are about.

## Source of truth

- `templates/**/*.hbs` — the code this CLI emits. Editing generated output in a
  test project fixes nothing; fix the template.
- `src/commands/*.ts` — which templates run, in what order, with what context.
- `src/utils/project.ts` — the patchers that edit files this CLI did not write.
  The riskiest code in the repo; see below.
- `README.md` — the user-facing contract. Update it in the same change.
- Generated docs live in `templates/init/{fsd.md,agents-section.md,skill.md}.hbs`.
  A convention change touches all three plus `README.md`, or the four drift.

## Verification

```bash
pnpm run verify   # tsc + unit tests + smoke test
```

`tests/patch.test.mjs` covers the file patchers in isolation, where the fiddly
cases live. `scripts/smoke-test.mjs` drives the real binary through
init → add → generate → extend against a fixture and inspects the output; it
needs no network and no package install.

The smoke test also **type-checks its generated output**: it symlinks this
repo's `node_modules` into each fixture and runs `tsc`, which is why `next`,
`react` and the query/axios types are devDependencies here. They are never
shipped (`files` carries `dist`, `templates`, `bin`, `LICENSE`).

```bash
pnpm run test:integration   # slow, networked: real create-next-app + install + next build
```

Three checks, three different failures, none subsuming another:

| | catches | misses |
|---|---|---|
| assertions on generated text | a template that stopped emitting something | anything that only fails at compile time |
| `tsc` on the fixture | a template emitting broken TypeScript | a dependency the CLI forgot to declare — the fixture borrows this repo's `node_modules`, so the import resolves anyway |
| `test:integration` | a declared range that does not resolve, Next.js behaviour drift | speed; it needs minutes and a network |

That middle row is why `@types/bun` has an explicit dependency assertion of its
own: forgetting it broke a real `next build`, and only the assertion sees it.

Both npm-shaped and bun-shaped fixtures exist because the package manager
decides whether `client.test.ts` is generated at all — for a while that
template had no test coverage, since every fixture was npm-shaped.

## Patching someone else's files

`patchLayoutProviders`, `patchEslintConfig`, `patchLayoutStyleImport`,
`addTailwindSources` and `patchTsconfigPaths` edit files the user owns. Rules
learned the hard way, each now pinned by a test:

- **`match.index === 0` is a real position.** `if (!match.index)` treats the
  first line of a file as "not found". This put `@source` above
  `@import "tailwindcss"`, where Tailwind ignores it.
- **Anchor on the narrowest thing that is unambiguous.** `{ children }` appears
  twice in every App Router layout, and the first is the destructured
  parameter — patching it produced a file that no longer parses. Search after
  `<body`.
- **Compute both offsets from the original source, then edit the later one
  first.** Re-finding text with `indexOf` after an edit is how you patch the
  wrong occurrence.
- **Every miss returns a status, never a wrong edit.** `"manual"` plus printed
  instructions beats a mangled file. A command that reports success over a
  broken file is the worst outcome available.
- **Prepend, do not replace, in a shared value.** The tsconfig `@/*` alias gets
  `./src/*` in front of whatever was there, so existing imports keep resolving.

## Editing generated ESLint or Tailwind config

Flat ESLint config **replaces** a rule's options when a later block matches the
same file — it does not merge them. All of a layer's
`no-restricted-imports` patterns must stay in that layer's single block;
splitting them silently disables all but the last, and the config still reads
as though both applied. `tests/patch.test.mjs` asserts one block per file
group; keep that test passing rather than working around it.

## Templates

- No literal `{{` outside a Handlebars expression. JSX uses one brace; `{{` in
  a template is an expression whether you meant it or not. The smoke test
  asserts no `{{` survives into any generated file.
- `*/` inside a JSDoc comment closes it. Reword rather than reaching for an
  invisible character.
- Generated user-facing copy comes from `src/utils/copy.ts`, keyed by locale —
  not from `{{#if}}` branches in the template. One place to forget a language
  instead of six.
- Comments in generated code explain *why*, in the voice of the project that
  will own them. They are read far more often than this repo is.

## Scope discipline

This CLI has no `create` — Next.js owns that — and no `undo`. It writes no
empty layer directories, because "add a layer when a second consumer appears"
is the FSD advice, not a shortcut. Adding a command means arguing that the
alternative (a `mkdir`, an `rm -rf`, a linter that already reports it) is
genuinely worse. `steiger` and `tsc` already cover more than they look like
they do: an orphaned route file is a type error, not a missing feature.

## Before handing off

Run `pnpm run verify`, then `git diff --check`, `git diff` and
`git status -sb`. Report the exact output and say which limitations are still
there. If a template changed, say which generated file changed with it.
