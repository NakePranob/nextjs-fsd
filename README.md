# @nakedev/nextjs-fsd

Keep a Next.js App Router project on [Feature-Sliced Design](https://feature-sliced.design/).

Next.js already creates the app, so this CLI does not. It shapes what is
inside one: `init` once, then `generate` for slices and `add` for the two
pieces of wiring every project rewrites by hand — API error handling and auth.

Sibling to [`go-scaffold`](https://github.com/NakePranob/go-scaffold), which
generates the Go backend these templates are written against.

```bash
bunx create-next-app@latest my-app --ts --app --tailwind
cd my-app

bunx @nakedev/nextjs-fsd init
bunx @nakedev/nextjs-fsd add auth
bunx @nakedev/nextjs-fsd generate page dashboard --auth
```

## Commands

| Command | What it does |
|---|---|
| `nextjs-fsd` | menu — asks what to do, then delegates |
| `init` | FSD layers in `src/`, the `@/*` alias, steiger + its config, `docs/fsd.md` |
| `generate page [name]` | a `_pages` slice plus the thin `app/<route>/page.tsx` that re-exports it |
| `generate slice [layer] [name]` | a `features`/`entities`/`widgets` slice with only the segments it needs |
| `generate layout [name]` | a shared route shell in `_app/layouts` plus the `layout.tsx` that re-exports it |
| `add error-handling` | `shared/api` — `ApiError`, per-domain error catalogs, axios client, `QueryClient` |
| `add auth` | `shared/auth` — in-memory access token, session hooks, route guard, login page |
| `config show` | the resolved config and which features are installed |
| `config set locale <th\|en>` | the language future generated copy is written in |

Every command asks for what you leave out. `--defaults` answers every
question, for CI.

**Nothing is ever overwritten.** Re-running a generate command on something
that exists *extends* it — `--segments ui,model` on a ui-only slice writes
`model/` and appends its exports to `index.ts`, leaving every existing file
alone. If there is nothing new to add, it says so rather than writing. Adding
a segment later is the normal path, which is the whole point of "a slice gets
only the segments it has code for".

It also will not add a second route file for a page that is already routed
from somewhere else — two `page.tsx` resolving to the same URL is a Next.js
build error, and a page generated with `--route "(admin)/dashboard"` is not
where the default would look.

## What `init` does to an existing project

- moves `app/globals.css` to `src/_app/styles/globals.css` and names the
  `@source` trees Tailwind now has to scan, then repoints the import in
  `layout.tsx`
- puts `./src/*` first in the tsconfig `@/*` alias, keeping whatever was there
  as a fallback so existing `@/…` imports keep resolving
- writes `eslint.fsd.mjs` and spreads it into `eslint.config.mjs`, so a
  wrong-way or slice-internal import is flagged per file in the editor — the
  core `no-restricted-imports` rule, no new dependency
- adds `steiger` and `steiger.config.ts` (with the `_app`/`_pages` layer-name
  rule turned off) and chains both into the `lint` script
- writes `components.json` so `shadcn add <name>` lands in `src/shared/ui`
  and its `utils.ts` in `src/shared/lib` — `shadcn init`'s own defaults put
  them in `./components/ui` and the project root, outside the layers entirely
- writes `docs/fsd.md`, a `.claude/skills/nextjs-fsd/SKILL.md` skill, and
  appends a section to `AGENTS.md` pointing at both — so an agent asked to "add
  a settings screen" reaches for the generator instead of hand-writing the
  files the linters then report

It creates no empty layer directories — `features/` and `entities/` appear
when a slice actually needs them, which is the FSD advice, not a shortcut.

## Two linters, on purpose

ESLint and steiger overlap on paper and not in practice:

| | catches | when |
|---|---|---|
| ESLint | this import points the wrong way, or reaches past a slice's `index.ts` | as you type, per file |
| steiger | a slice with no references, a layer sliced too finely, a segment named after its type | on demand, whole tree |

A bad import is visible in one file, so that check belongs where it is
instant. Nothing in one file shows that a slice has no consumers — that needs
the whole tree. `init` sets up both and chains them into `lint`.

The generated ESLint block has one trap worth knowing if you edit it: flat
config **replaces** a rule's options when a later block matches the same file
rather than merging them, so all of a layer's `no-restricted-imports` patterns
have to stay in that layer's single block. A test pins this down, because a
split config still reads as though both halves applied.

## The two `add` targets

`add error-handling` is the pattern rather than a library: one `ApiError` at
the boundary, an axios client whose 401 refresh is **single-flight** (a
backend that rotates refresh tokens logs the user out mid-session otherwise),
and error copy that lives in a per-domain catalog instead of one global map.
`error.message` is never rendered — a backend message is written for a log,
and an unmapped code falls through to a fallback that names the action that
failed.

Give each domain its own catalog with `--errors` on either generate command.

`add auth` needs that client, so it installs it first if it is missing. It
scaffolds password login only: access token in a module variable (never
`localStorage`), refresh token left to the API's httpOnly cookie,
`useRequireSession` as UX with the real gate still on the server. MFA, OAuth
providers and RBAC are not scaffolded.

Both assume the shape `go-scaffold` produces — `POST /auth/login`,
`POST /auth/refresh`, `GET /users/me`, and an `{ error: { code, message } }`
envelope. Adjust the paths and the `Session` type if yours differ; they are
one file each.

## Generated copy

`init` asks whether the user-facing strings should be Thai or English
(`--locale th|en`, Thai by default) and records it. It only decides what the
first draft reads like — the catalogs are meant to be edited, and
`config set locale` changes the setting for future generation without
rewriting anything already on disk.

For a Thai project, `generate page` also asks for the page title, because the
Title Case of a kebab name is the right answer in English and the wrong one in
Thai. `--title` skips the question.

Thai copy also needs a Thai face: `init` warns that create-next-app leaves
`font-family: Arial, Helvetica, sans-serif` on `body`, which has no Thai
coverage at all, and names the `next/font` fix. It does not rewrite your font
stack — that choice is yours.

## Requirements

Node 20.9+, a Next.js 15/16 App Router project in TypeScript. Both
create-next-app layouts work as-is (`app/` and `src/app/`) — FSD's own app
layer is `src/_app`, so it never collides with either.

The generated `client.test.ts` is written only for bun projects: `bun test`
resolves the `@/` alias with no config, while node and vitest need a runner
set up first, which is not this CLI's business.

## Development

```bash
pnpm install
pnpm run verify            # build + unit tests + smoke test — fast, offline
pnpm run test:integration  # real create-next-app + install + next build — slow, networked
```

`scripts/smoke-test.mjs` drives the actual binary through
init → add → generate → extend against three fixtures (root `app/`, `src/app/`,
and a bun-shaped one), checks what came out, asserts no `{{…}}` template
syntax leaked, and **type-checks the generated project** by symlinking this
repo's `node_modules` into the fixture. That last step is why `next` and
`react` are devDependencies here; they are never shipped.

`scripts/integration-test.mjs` is the layer that catches what the smoke test
structurally cannot — a dependency range that does not resolve (the fixture
borrows packages it never installed) and Next.js behaviour drift. It costs
minutes and a network, so it runs on demand and in CI.

The unit tests in `tests/` cover the file patchers in isolation, where the
fiddly cases live.

MIT.
