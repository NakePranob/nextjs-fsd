<div align="center">
  <img src=".github/assets/readme/hero.png" alt="nextjs-fsd: Next.js that stays on Feature-Sliced Design" width="100%">
  <h1>nextjs-fsd</h1>
  <p><strong>Next.js that stays on Feature-Sliced Design.</strong></p>
  <p>
    <a href="https://www.npmjs.com/package/@nakedev/nextjs-fsd"><img src="https://img.shields.io/npm/v/@nakedev/nextjs-fsd.svg" alt="npm version"></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@nakedev/nextjs-fsd.svg" alt="Node.js version"></a>
    <a href="https://github.com/NakePranob/nextjs-fsd/actions/workflows/ci.yml"><img src="https://github.com/NakePranob/nextjs-fsd/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/npm/l/@nakedev/nextjs-fsd.svg" alt="license"></a>
  </p>
</div>

`nextjs-fsd` is an npm CLI for keeping a **Next.js App Router** project on
**Feature-Sliced Design**. It shapes the layers once, then generates pages,
slices, layouts, and API routes with the same shape — plus the two pieces every
project ends up rewriting by hand: API error handling and authentication.

Next.js already creates projects, so this CLI has no `create`. The workflow is
`create-next-app`, one `nextjs-fsd init`, then the same CLI from the project
whenever the frontend grows.

## Why nextjs-fsd

- **Stop re-deciding where files go.** Layers, public APIs, and import
  boundaries are set once and enforced by two linters.
- **Every slice has the same shape.** Pages, slices, layouts, and API routes are
  generated with the same segments and the same wiring.
- **The cross-cutting wiring is already done.** Auth, API error normalization,
  session handling, and formatting arrive as commands, not as a checklist.

## Quick start

```bash
npm install --global @nakedev/nextjs-fsd
npx create-next-app@latest my-app --ts --app --tailwind --eslint

cd my-app
nextjs-fsd init                # once: FSD layers, both linters, docs
nextjs-fsd add auth            # shared/auth + a login page
nextjs-fsd add prettier        # formatting, with Tailwind class sorting
nextjs-fsd generate page dashboard --auth
```

That gives you a project with `/login` and `/dashboard`, a session guard, and an
API client that normalises every failure into one error type. Then:

```bash
npm run dev
npm run lint                   # eslint (import boundary) + steiger (whole tree)
```

`init` creates no empty layer directories. `features/` and `entities/` appear
when a slice actually needs them — FSD's own advice, not a shortcut.

### Requirements

- **Node.js >=20.9** for the CLI.
- A **Next.js 15 or 16 App Router** project in TypeScript, created by
  `create-next-app`. Both `app/` at the root and `src/app/` are supported.
- npm, pnpm, yarn, or bun. The CLI detects the package manager from the lockfile.
- An HTTP API for `add auth` and `add error-handling`. Both are written against
  the shape `go-scaffold` produces; the full reference explains what to change
  if yours differs.

## What you get

| Area | What `nextjs-fsd` gives you |
| --- | --- |
| **Layers** | `app`, `pages`, `widgets`, `features`, `entities`, and `shared` in the FSD shape, with no empty directories. |
| **Boundaries** | ESLint import rules plus Steiger for the whole tree, so a cross-import fails before review. |
| **Generators** | Pages, slices, layouts, and API routes with consistent segments, public APIs, and tests. |
| **Auth** | A login page, session store, access token handling, route guard, and the API client it needs. |
| **Error handling** | One API error type, error catalogs, and the client boundary that normalises failures. |
| **Formatting** | Prettier with Tailwind class sorting. |
| **Agent guidance** | Repository-level `AGENTS.md`, `CLAUDE.md`, and a generated skill that knows the project's paths. |

## How it fits together

```mermaid
flowchart TB
  ROUTE[Next.js App Router routes] --> PAGE[pages]
  PAGE --> WIDGET[widgets]
  WIDGET --> FEATURE[features]
  FEATURE --> ENTITY[entities]
  ENTITY --> SHARED[shared]
  ROUTE --> APPF[src/_app: providers, layouts, styles]
```

Next.js owns routing. The FSD app layer (`src/_app`) owns providers, global
layouts, and styles. Pages compose widgets, widgets compose features, features
use entities, and everything may use shared. The linters enforce that direction.

## Generated project

```text
src/
├─ app/                      # Next.js App Router routes
├─ _app/                     # FSD app layer: providers, layouts, styles
├─ pages/                    # one folder per route screen
├─ widgets/                  # composed UI blocks
├─ features/                 # user actions
├─ entities/                 # business entities
└─ shared/                   # api, auth, config, ui, lib
```

`features/` and `entities/` are not created empty; they appear when a slice
needs them.

## Commands

| Command | What it does |
| --- | --- |
| `init` | Shape a Next.js project into FSD layers, add linters and docs. |
| `generate page [name]` | Add a route page with its slice and wiring. |
| `generate slice [layer] [name]` | Add a `features` or `entities` slice. |
| `generate layout [name]` | Add shared chrome for a route group. |
| `generate api-route [name]` | Add a Route Handler with its logic in `_app`. |
| `add auth` | Add password login, session handling, and a login page. |
| `add error-handling` | Add the API error boundary and error catalogs. |
| `add prettier` | Add formatting with Tailwind class sorting. |
| `config` | Inspect and change project settings. |

Run any command with `--help` for its current options. The full command
reference — wizard behavior, every option, generated output, and assumptions —
lives in [`REFERENCE.md`](REFERENCE.md).

## Learn more

- [Full command reference](REFERENCE.md)
- [Source, template, and test workflow](AGENTS.md)
- Sibling projects: [`go-scaffold`](https://www.npmjs.com/package/@nakedev/go-scaffold) and [`sveltekit-fsd`](https://www.npmjs.com/package/@nakedev/sveltekit-fsd)

## Development

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
```

See [`AGENTS.md`](AGENTS.md) for the source/template/test workflow and the
release contract.

## License

MIT — see [LICENSE](LICENSE).
