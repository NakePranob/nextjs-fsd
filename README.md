# @nakedev/nextjs-fsd

@nakedev/nextjs-fsd is an npm CLI for keeping a Next.js App Router project on
Feature-Sliced Design: it shapes the layer structure once, then generates
pages, slices and layouts that all have the same shape, plus the two pieces of
wiring every project ends up rewriting by hand — API error handling and
authentication.

Next.js already creates projects, so this CLI has no `create`. The normal
workflow is: `create-next-app`, then `nextjs-fsd init` once, then run the same
CLI from the project whenever the frontend grows.

Sibling to [@nakedev/go-scaffold](https://www.npmjs.com/package/@nakedev/go-scaffold),
which generates the Go backend these templates are written against.

## Install with npm

Install the CLI globally when you expect to use it repeatedly:

~~~bash
npm install --global @nakedev/nextjs-fsd

nextjs-fsd --version
nextjs-fsd --help
~~~

npx and bunx are also supported when you do not want a global installation:

~~~bash
npx @nakedev/nextjs-fsd init
bunx @nakedev/nextjs-fsd generate page dashboard
~~~

### Requirements

- Node.js >=20.9 to run the CLI. npm and npx are included with Node.js.
- A Next.js 15 or 16 **App Router** project in TypeScript, created by
  `create-next-app`. Both layouts it produces are supported as they are:
  `app/` at the root, and `src/app/` when "use src directory" was chosen. FSD's
  own app layer is `src/_app`, so it never collides with either.
- The project's package manager — npm, pnpm, yarn or bun. It is detected from
  the lockfile, and the CLI installs the dependencies its templates need.
- An HTTP API for `add auth` and `add error-handling` to talk to. Both are
  written against the shape go-scaffold produces; see their sections below for
  what to change if yours differs.

The legacy `pages/` router is not supported. The FSD guide covers it, but every
generator here targets the App Router — route files, layouts and handlers are
all App Router shapes.

## Quick start

~~~bash
npm install --global @nakedev/nextjs-fsd
npx create-next-app@latest my-app --ts --app --tailwind --eslint

cd my-app
nextjs-fsd init                # once: FSD layers, both linters, docs
nextjs-fsd add auth            # shared/auth + a login page (pulls in error handling)
nextjs-fsd add prettier        # formatting, with Tailwind class sorting
nextjs-fsd generate page dashboard --auth
~~~

That gives a project with `/login` and `/dashboard`, a session guard, and an
API client that normalises every failure into one error type. Then:

~~~bash
npm run dev
npm run lint                   # eslint (import boundary) + steiger (whole tree)
~~~

`init` creates no empty layer directories. `features/` and `entities/` appear
when a slice actually needs them, which is FSD's own advice rather than a
shortcut.

## How the wizard works

### Start with the top-level wizard

The command name is the thing people forget, so running the CLI bare asks what
to do and then delegates:

~~~bash
nextjs-fsd            # menu: generate / add / show config
nextjs-fsd generate   # menu: page / slice / layout
nextjs-fsd add        # menu: error handling / auth
~~~

Outside an initialised project only `init` can run, and the bare command says
so instead of offering choices that would fail.

### Answer only what is missing

Every command prompts for what you leave out and takes what you pass as final.
`nextjs-fsd generate page` asks for the name; `nextjs-fsd generate page
dashboard --auth` asks for nothing it already knows.

Prompts also disappear when they cannot apply. The "client leaf behind a
session guard" choice is disabled until `add auth` has run, and the error
catalog question is not asked at all without `add error-handling` — the menu
says which prerequisite is missing rather than letting you walk three steps to
reach an error.

### Non-interactive usage

`--defaults` answers every remaining question, which is what CI and scripts
should pass:

~~~bash
nextjs-fsd init --locale en --defaults
nextjs-fsd add auth -y
nextjs-fsd generate page dashboard --auth --route "(admin)/dashboard" --defaults
nextjs-fsd generate slice features checkout --segments ui,model --defaults
~~~

With no TTY, a command that still needs an answer exits 1 without writing
anything, and names every missing flag at once instead of failing on the first.

## Command overview

| Command | Purpose | Alias |
|---|---|---|
| init | Shape an existing App Router project into FSD layers | — |
| generate | Open the page/slice/layout/API-route wizard | g |
| generate page [name] | Add a `_pages` slice and its route file | g p |
| generate slice [layer] [name] | Add a features/entities/widgets slice | g s |
| generate layout [name] | Add shared chrome for a group of routes | g l |
| generate api-route [name] | Add a Route Handler in `_app/api-routes` and its `route.ts` | g r |
| add | Open the infrastructure wizard | — |
| add error-handling | Add `shared/api`: error type, catalogs, client | add errors |
| add auth | Add `shared/auth` and a login page | — |
| add prettier | Add prettier + Tailwind class sorting, a `format` script, and a check on `lint` | — |
| config show | Print the resolved project configuration | — |
| config set locale \<th\|en\> | Change the language of future generated copy | — |

Every command except `init` expects to run from an initialised project, which
is any directory with a `nextjs-fsd.config.json` at its root.

## init — shape a project into FSD layers

~~~bash
nextjs-fsd init                       # interactive: asks for the copy language
nextjs-fsd init --defaults            # Thai copy, no confirmation
nextjs-fsd init --locale en --defaults
nextjs-fsd init --no-install          # write files, install later
~~~

Run this once, in a project `create-next-app` already made. A second run
refuses rather than re-writing, and points at `generate` and `add`.

### Options

| Option | Effect |
|---|---|
| --locale \<th\|en\> | Language for generated user-facing copy; Thai is the default |
| --no-install | Write everything but do not run the package manager |
| --no-hooks | Write no `commit-msg` hook and leave `core.hooksPath` alone |
| --defaults | Skip every question, including the confirmation summary |
| -y, --yes | Skip only the confirmation summary |

### What init changes in your project

- moves `app/globals.css` to `src/_app/styles/globals.css`, names the trees
  Tailwind now has to scan with `@source`, and repoints the import in
  `layout.tsx`. Moving it out of the route directory is what takes it out of
  Tailwind's auto-detection, which is why the `@source` lines are not optional
- puts `./src/*` **in front of** whatever the tsconfig `@/*` alias mapped to,
  so `@/_pages/login` resolves while any existing `@/…` import keeps working
- spreads the generated ESLint rules into `eslint.config.mjs` and appends
  `steiger ./src` to the `lint` script
- writes a `commit-msg` hook and points `core.hooksPath` at it, unless the
  repository has husky (which owns that setting — the hook goes to `.husky/`
  and nothing is configured), the setting already points somewhere else, or
  there is no repository yet. The hook checks the **shape** of the subject and
  nothing else: language, ticket numbers and emoji stay your project's call,
  and the AGENTS.md section it adds says so. `--no-hooks` skips all of it

`init` is the one command that runs on work you already have, so it writes
what is missing and leaves what is there, naming each file it left alone.
A `steiger.config.ts`, a `docs/fsd.md` or a `components.json` you wrote is
yours; it is not a reason to refuse the rest.

One case is a decision rather than a skip: **if your ESLint config already
contains `no-restricted-imports`, the FSD boundary rules are not added at
all** — not the file, not the spread. Flat config *replaces* a rule's options
when a later block matches the same file instead of merging them, so two sets
of import rules do not add up; the last block to match wins, in silence.
Compare the boundary in `docs/fsd.md` with the rules you have and keep one.

### What init writes

~~~text
src/_app/styles/globals.css            # moved, with @source lines added
eslint.fsd.mjs                         # the import boundary as ESLint rules
steiger.config.ts                      # the whole-tree FSD checks
components.json                        # aims `shadcn add` at src/shared/ui
docs/fsd.md                            # the convention, in full
<repo>/.agents/skills/nextjs-fsd/      # the same contract, as a skill
<repo>/.claude/skills/nextjs-fsd       # symlink to it, for Claude Code
AGENTS.md                              # an FSD section appended, or created
<repo>/.githooks/commit-msg            # subject must be a Conventional Commit
CLAUDE.md                              # created if absent, includes AGENTS.md
nextjs-fsd.config.json                 # layers, appDir, alias, locale, features
~~~

`components.json` is written **before** anyone runs `shadcn init`, because
shadcn's own defaults put components in `./components/ui` and a `utils.ts` at
the project root — outside the layers entirely. An existing `components.json`
is left alone.

The skill goes to the **repository root**, not to the project directory. Agent
tooling reads `.claude/` and `.agents/` from the root of the repository, so in
a monorepo — a `web/` beside an `api/` — a skill written next to `package.json`
is a file that exists, reads correctly, and is never loaded. The real file
lives under `.agents/skills/` with `.claude/skills/` symlinked to it, so Claude
Code and anything following the AGENTS.md convention read one file rather than
two copies to keep in sync. Where symlinks are refused (Windows without
developer mode) a real copy is written instead.

`nextjs-fsd.config.json` records where the App Router lives, the import alias,
the copy language, and which features are installed, so later commands
continue from the same choices. Missing feature keys are filled in by looking
at the tree rather than assumed false.

## generate page [name] — add a route

~~~bash
nextjs-fsd generate page settings
nextjs-fsd generate page dashboard --auth
nextjs-fsd generate page dashboard --route "(admin)/dashboard" --errors
nextjs-fsd generate page dealers --client --model
nextjs-fsd generate page loans --route "loans/[id]" --client
nextjs-fsd g p settings --defaults
~~~

### Options

| Option | Effect |
|---|---|
| --title \<title\> | Heading and browser title; defaults to the Title Case of the name |
| --route \<path\> | App Router path; defaults to the page name |
| --no-route | Write the slice only, no route file |
| --client | Also create a `"use client"` leaf component |
| --auth | The client leaf sits behind `useRequireSession` (needs `add auth`) |
| --model | Add this page's TanStack Query hooks (needs `add error-handling`) |
| --errors | Add this page's own error catalog (needs `add error-handling`) |
| --defaults | Skip every question: server component only, route = the page name |

`--route` takes the App Router's own shapes: a route group `(admin)`, a
dynamic segment `[id]`, a catch-all `[...slug]`, or a plain path. Route groups
contribute nothing to the URL, so `--route "(admin)/dashboard"` serves
`/dashboard`, and the command prints the real URL rather than the path.

### What it generates

~~~text
src/_pages/dashboard/index.ts                     # client-safe public API (the leaf) — or the page, when server-only
src/_pages/dashboard/index.server.ts              # --client / --auth: the page + metadata (the server-only entry)
src/_pages/dashboard/ui/dashboard-page.tsx        # server component + `metadata`
src/_pages/dashboard/ui/dashboard-content.tsx     # --client / --auth: the "use client" leaf
src/_pages/dashboard/model/dashboard.ts           # --model: query key, hooks, the record type
src/_pages/dashboard/model/dashboard-errors.ts    # --errors: this page's error catalog
app/(admin)/dashboard/page.tsx                    # re-exports the page and its metadata (from index.server when there is a leaf)
~~~

The route file re-exports **both** the component and `metadata`. A route file
that re-exports `default` alone silently drops the page title, with no error
anywhere.

`"use client"` goes on the leaf, never on the page: a page component that
needs the browser ships its whole tree to it.

A page with a leaf has **two public API entries**. `index.ts` carries only the
client-safe leaf, so a Client Component importing the slice never pulls the
server module into the client graph (a build error); the server component and
`metadata` live in `index.server.ts`, which is what the route file imports.

`--model` writes the same file a slice's `api` segment gets — a query key, a
record type, a list query and a mutation that invalidates the key — into
`model/`, because a page keeps what it knows about its own data in one
segment. It stays internal to the slice: the page's `index.ts` exports the
page, not its hooks.

## generate slice [layer] [name] — add a features/entities slice

~~~bash
nextjs-fsd generate slice features checkout --segments ui,model
nextjs-fsd generate slice entities loan --segments ui,api,lib --errors
nextjs-fsd g s entities loan --defaults
~~~

Layers are `features`, `entities` and `widgets`. `_pages` slices come from
`generate page`; `_app` and `shared` are written by `init` and `add`.

`init` writes a `docs/fsd.md` that leaves `widgets/` closed and says so as a
project choice. FSD v2.1 itself has it as an ordinary layer — the spec's only
caution is that a UI block which is most of a page's content and is never
reused should not be one. The generator takes `widgets` because the
methodology has it; prefer `features/` unless you have decided otherwise, and
record that decision in `docs/fsd.md`.

### Options

| Option | Effect |
|---|---|
| --segments \<list\> | Comma-separated: `ui,model,api,lib`; defaults to `ui` |
| --errors | Add this slice's own error catalog (needs `add error-handling`) |
| --defaults | Skip every question: the `ui` segment only |

### Segments

A slice gets only the segments it has code for; an empty segment folder is
noise. `ui/` alone is the common case.

| Segment | Holds | Generated shape |
|---|---|---|
| ui | Components | A component, `"use client"` only when it uses the slice's own hook |
| model | State and hooks | A `use<Name>` hook |
| api | Requests | A TanStack Query hook, a mutation that invalidates its key, and the record type |
| lib | Pure helpers | A formatting function |

The `api` segment requires `add error-handling`, and says so rather than
generating a bare `fetch` — which would skip the bearer token, the
single-flight 401 refresh, and the conversion into `ApiError`.

### What it generates

~~~text
src/entities/loan/index.ts             # public API
src/entities/loan/ui/loan.tsx          # ui
src/entities/loan/model/loan.ts        # model
src/entities/loan/api/loan.ts          # api — LoanRecord, loanKey, useLoanQuery, useCreateLoan
src/entities/loan/lib/loan.ts          # lib
src/entities/loan/model/loan-errors.ts # --errors
~~~

The record type is `LoanRecord`, not `Loan`: the `ui` segment already exports
a `Loan` component, and one `index.ts` cannot re-export two different things
under one name. A type that cannot be imported through the slice's public API
is a type nothing can annotate against without breaking the import boundary.

## generate layout [name] — shared chrome for a group of routes

~~~bash
nextjs-fsd generate layout admin                  # applies at app/(admin)/
nextjs-fsd generate layout auth --route "(auth)"
nextjs-fsd generate layout admin --guard           # every route under it needs a session
nextjs-fsd generate layout admin --route reports   # reuse it at another path
nextjs-fsd g l admin --defaults
~~~

### Options

| Option | Effect |
|---|---|
| --route \<path\> | Where it applies; defaults to the route group `(<name>)` |
| --no-route | Write the component only, no `layout.tsx` |
| --guard | Every route under it sits behind the session, in one component (needs `add auth`) |
| --defaults | Skip every question: route = the `(<name>)` group, no guard |

### What it generates

~~~text
src/_app/layouts/admin-layout.tsx   # the shell component
src/_app/layouts/admin-guard.tsx    # --guard only: the one useRequireSession caller
src/_app/layouts/index.ts           # public API of the layouts segment
app/(admin)/layout.tsx              # re-exports it as default
~~~

A guard belongs to the shell, not to each page under it. One page checking for
itself is fine; the second one is a race, because two components redirecting
on the same failed session fight over the same navigation. With `--guard` the
pages below call `useSession()` and trust what it says — so do not also
generate them with `generate page --auth`, which the CLI warns about when it
finds a guarded layout.

Layouts live in `_app`, not `_pages`: a layout is not one route's content, it
is what several routes have in common, and cross-page composition is the app
layer's job. The default route is a route group because that is a layout's
usual reason to exist — shared chrome for a set of pages, adding nothing to
the URL.

The component takes a plain `{ children }` rather than `LayoutProps<…>`, since
Next emits no route-props type for a route group.

## generate api-route [name] — a Route Handler with its logic in `_app`

~~~bash
nextjs-fsd generate api-route health                 # served at /api/health
nextjs-fsd generate api-route health --route v1/health
nextjs-fsd generate api-route health --no-route      # logic only, serve it later
nextjs-fsd g r health --defaults
~~~

### Options

| Option | Effect |
|---|---|
| --route \<path\> | Where it is served; defaults to `api/<name>` (served at `/api/<name>`) |
| --no-route | Write the handler only, no `route.ts` |
| --defaults | Skip every question: route = `api/<name>` |

### What it generates

~~~text
src/_app/api-routes/health.ts       # the handler logic (getHealth)
src/_app/api-routes/index.ts        # public API of the api-routes segment
app/api/health/route.ts             # re-exports it as GET, nothing else
~~~

The route file names the HTTP method, the logic module names the function:
`export { getHealth as GET } from "@/_app/api-routes"`. Next.js maps the URL
to the file, so the file stays a re-export and the work lives in the segment —
where it can be imported and tested without a request. To serve another method
from the same URL, export it from the same logic module and add it to the
route file. One handler may answer two URLs (`--route v1/health` on an
existing handler), but only when asked — re-running otherwise reports it is
already served and writes nothing.

Handlers live in `_app`, not `_pages`: a handler is not one route's content,
it is backend composition shared the way a layout is, and cross-route
composition is the app layer's job.

## Re-running a generate command extends it

Nothing is ever overwritten. Re-running a command on something that exists
writes only what is missing, appends the new exports to the slice's
`index.ts`, and leaves every existing file exactly as it is:

~~~bash
nextjs-fsd generate slice features checkout --segments ui           # ui/ only
nextjs-fsd generate slice features checkout --segments ui,model     # adds model/
nextjs-fsd generate page dashboard --errors --defaults              # adds the catalog
~~~

Adding a segment later is the normal path, not a rewrite — which is the whole
point of "a slice gets only the segments it has code for". When there is
nothing new to add, the command says so and writes nothing.

Two consequences worth knowing:

- the page component is one of those existing files, so a leaf added later is
  not rendered yet. The command prints the one import line to add
- a page already routed from elsewhere does not get a second route file. Two
  `page.tsx` resolving to one URL is a Next.js build error, and a page
  generated with `--route "(admin)/dashboard"` is not where the default would
  look

## add prettier — formatting, with Tailwind class sorting

~~~bash
nextjs-fsd add prettier
nextjs-fsd add prettier --no-install
~~~

Prettier is three lines of config in any other project. It is a command here
because of one of them: Tailwind v4 has no config file for
`prettier-plugin-tailwindcss` to find, so the plugin has to be handed the
stylesheet through `tailwindStylesheet` — and `init` is what moved that
stylesheet out of the route directory to `src/_app/styles/globals.css`. This
CLI is the only thing that knows both facts.

~~~text
.prettierrc            # prettier defaults + the plugin, pointed at globals.css
.prettierignore        # *.md only — prettier 3 already reads .gitignore
package.json           # a `format` script, and `prettier --check .` on `lint`
~~~

Prettier's own defaults are left alone. Indent width and print width are
taste, they are the first thing anyone changes, and a generator picking them
would only be picking a fight.

`tailwindFunctions: ["cn", "cva"]` sorts the classes inside those calls too,
not only the ones in a `className` attribute — `cn()` and `cva()` are where
most of them live in a shadcn project.

The check goes on `lint` rather than into a pre-commit hook: the project may
not have a hook, and whatever already runs lint — CI, husky, an editor task —
picks it up with no further wiring.

**It formats the project once, immediately.** Adding `prettier --check .` to
lint without that pass would hand back a project whose lint fails on every
file. That pass is a large diff and worth its own commit; with `--no-install`
it is skipped and the CLI says so instead.

Every `generate` after this one formats what it writes with **the project's**
prettier, at whatever settings the project chose. Templates are not
hand-maintained to one particular printWidth.

## add error-handling — the API boundary

~~~bash
nextjs-fsd add error-handling
nextjs-fsd add errors -y
nextjs-fsd add error-handling --no-install
~~~

### Options

| Option | Effect |
|---|---|
| --no-install | Write the files but do not run the package manager |
| -y, --yes | Skip the confirmation summary |

### What it generates

~~~text
src/shared/api/api-error.ts       # ApiError + toApiError: one failure type at the boundary
src/shared/api/error-catalog.ts   # the codes every endpoint can answer with
src/shared/api/error-resolver.ts  # code -> one sentence, from the caller's catalogs
src/shared/api/client.ts          # axios instance: bearer token in, ApiError out
src/shared/api/query-client.ts    # QueryClient + sessionKey; a 401 anywhere ends the session
src/shared/api/client.test.ts     # bun projects only: the two silent refresh rules
src/shared/api/index.ts
src/shared/auth/access-token.ts   # the in-memory token the interceptor reads
src/shared/config/env.ts          # NEXT_PUBLIC_API_URL
src/shared/ui/form-error.tsx      # renders a failure, owning no copy of its own
src/_app/providers/index.tsx      # created if absent, and wired into layout.tsx
.env.example                      # NEXT_PUBLIC_API_URL, appended
~~~

Adds `axios` and `@tanstack/react-query`, plus `@types/bun` and a `test`
script on a bun project.

### The rules this encodes

- **One error type at the boundary.** The response interceptor converts every
  failure to `ApiError` (`code`, `status`, `fieldErrors`), so hooks and
  components branch on a stable machine code instead of axios internals.
- **The 401 refresh is single-flight.** A backend that rotates the refresh
  token on use would see two concurrent refreshes race, and one would
  invalidate the other's cookie — logging the user out mid-session.
- **A 401 from `/auth/*` is not refreshed.** It means wrong password, not
  expired token; refreshing would spend the cookie of whoever is already
  signed in on that browser.
- **A 401 that survives the refresh ends the session, whichever request found
  it.** The refresh cookie is gone by then — revoked, expired, or logged out
  everywhere — so the QueryClient **resets** `sessionKey` and
  `useRequireSession` redirects. Without it the session query stays fresh for
  its whole `staleTime` while every other request 401s: a page that looks
  signed in and does nothing. Mutations count too; the save that will never
  submit is the one that matters. `resetQueries`, not `removeQueries`:
  removing an entry does not notify the observers mounted on it, so a sidebar
  or a guard that was not re-rendering anyway keeps drawing the session it had
  already read, and nothing ever sees `isError`.
- **Signing out leaves the page, from one place.** `useLogout` redirects to
  `/login` inside the function that ends the session, not from each button's
  `onSettled` — for the same reason: clearing the cache does not re-render a
  component that is not otherwise re-rendering, and a call site that forgets
  the line looks signed in until something else happens to refetch.
- **Copy lives in a per-domain catalog, never one global map.** The domain that
  raises a code is the only place that knows what it means to a user, and a
  single map becomes a merge-conflict magnet as soon as two features grow at
  once. `generate page`/`generate slice` with `--errors` creates one.
- **`error.message` is never rendered.** A backend message is written for a
  log and changes without anyone here noticing; an unmapped code falls through
  to a fallback that names the action that failed.

Render a failure with `<FormError error={mutation.error} catalogs={…} />`.

If your API words its error envelope differently, `api-error.ts` is the only
file that reads the wire format.

## add auth — password login

~~~bash
nextjs-fsd add auth
nextjs-fsd add auth -y --no-install
~~~

Installs `add error-handling` first if it is missing. That is not a
prerequisite to satisfy by hand — auth cannot work without the client at all,
so there is no choice to offer.

### Options

| Option | Effect |
|---|---|
| --no-install | Write the files but do not run the package manager |
| -y, --yes | Skip the confirmation summary |

### What it generates

~~~text
src/shared/auth/session.ts          # useSession, useLogin, useLogout
src/shared/auth/require-session.ts  # useRequireSession + safeNext — UX, not the gate
src/shared/auth/require-session.test.ts  # bun projects only: the ?next= guard
src/shared/auth/auth-errors.ts      # the auth surface's own catalog
src/shared/auth/index.ts
src/_pages/login/index.ts
src/_pages/login/ui/login-page.tsx  # server component
src/_pages/login/ui/login-form.tsx  # "use client" leaf, native HTML validation
app/login/page.tsx
~~~

### What it assumes about your API

- `POST /auth/login` answers an access token in the body
- `POST /auth/refresh` trades an httpOnly cookie for a new access token
- `POST /auth/logout` revokes the refresh token and clears the cookie
- `GET /users/me` returns the signed-in user

Each is one line in one file if yours differ, and the `Session` type carries a
TODO for the same reason.

The access token lives in a module variable and nowhere else. The API returns
it in the body and keeps the refresh token in an httpOnly cookie, so there is
nothing to persist: a reload starts with no token and the first 401 spends the
cookie on a new one. `localStorage` would only make the token readable by any
injected script.

A deep link survives the round trip: `useRequireSession` sends people to
`/login?next=<path>` and the login form picks that back up. `safeNext` is
what makes it safe to follow — it resolves the value against a sentinel origin
and keeps it only if it lands on the same site, because a hand-rolled
`startsWith("/")` check is bypassed by `/<TAB>/evil.example` (browsers strip
tab, CR and LF *before* parsing, so it becomes `//evil.example`) and your
login screen turns into a redirector wearing your own domain. Path only, no
query string: reading that would mean `useSearchParams()`, and a Suspense
boundary on every page behind the guard.

`useRequireSession` redirects anonymous visitors, but treat it as UX only —
the API's own middleware is the actual gate and runs on every request no
matter what the browser rendered. It cannot move into `proxy.ts` (Next 16's
renamed middleware) either: the refresh cookie belongs to the API's origin, so
the Next server never sees it.

**Password login only.** MFA, OAuth providers and RBAC are not scaffolded.

## config — inspect and change project settings

~~~bash
nextjs-fsd config show
nextjs-fsd config set locale en
~~~

`show` prints the resolved configuration — where the layers and the App Router
live, the import alias, the copy language, the package manager, and which
features are installed. It also warns when the CLI version differs from the
one that scaffolded the project, since the templates may have moved on.

`set locale` changes the language of **future** generated copy. It rewrites
nothing already on disk: the catalogs and titles there are meant to be edited,
and replacing them would throw away the wording someone chose.

## Generated project structure

After `init`, `add auth`, and a few generate commands:

~~~text
app/                                   # Next.js App Router — routing only
├── layout.tsx                         # composition root: fonts, <Providers>, global CSS
├── login/page.tsx                     # re-exports an FSD page + its metadata
└── (admin)/
    ├── layout.tsx                     # re-exports an FSD layout
    └── dashboard/page.tsx
src/
├── _app/                              # FSD app layer
│   ├── layouts/                       # shells shared by a group of routes
│   ├── api-routes/                    # Route Handler logic, re-exported as GET from app/api/
│   ├── providers/                     # QueryClientProvider and friends
│   └── styles/globals.css             # Tailwind @theme + @source
├── _pages/<page>/                     # one slice per route
│   ├── ui/<page>-page.tsx             # server component + metadata
│   ├── ui/<thing>.tsx                 # "use client" only on the leaves
│   ├── model/<page>-errors.ts         # this page's error catalog
│   ├── index.ts                       # client-safe public API (the leaf, or the page when server-only)
│   └── index.server.ts                # with a leaf: the page + metadata, what the route imports
├── features/<slice>/                  # a whole user action, once two pages need it
├── entities/<slice>/                  # a business object, once two features need it
└── shared/                            # infrastructure only
    ├── api/                           # ApiError, catalogs, client, QueryClient
    ├── auth/                          # token, session hooks, route guard
    ├── config/                        # env
    └── ui/                            # primitives, FormError
~~~

The FSD `app` and `pages` layers are named `_app` and `_pages` because Next.js
owns those names at the root.

Imports point downwards only — `_app → _pages → widgets → features → entities
→ shared` — two slices on the same layer never import each other, and a slice
is always entered through its `index.ts`.

## Two linters, on purpose

`npm run lint` runs both, and they are not redundant:

| | Catches | When |
|---|---|---|
| ESLint (`eslint.fsd.mjs`) | This import points the wrong way, or reaches past a slice's `index.ts` | As you type, per file, in the editor |
| steiger (`steiger.config.ts`) | A slice with no references, a layer sliced too finely, a segment named after its type | On demand, whole tree |

A bad import is visible in one file, so that check belongs where it is
instant. Nothing in one file can show that a slice has no consumers.

`eslint.fsd.mjs` adds no dependency: the boundary is expressed with the core
`no-restricted-imports` rule, and the layer order is the whole of it. One trap
if you edit it — flat config **replaces** a rule's options when a later block
matches the same file rather than merging them, so all of a layer's patterns
have to stay in that layer's single block.

steiger's `insignificant-slice` is configured as a **warning**. At its default
severity it fails `lint` on the structure FSD's own guidance recommends
starting from — a slice extracted for its first consumer — and a fresh slice
failing CI teaches people to delete the rule rather than the slice. Read the
message anyway: a slice that stays at one consumer for good probably belongs
inside it.

## Generated copy and locale

`init` asks whether the user-facing strings should be Thai or English
(`--locale th|en`, Thai by default). It only decides what the first draft reads
like — the catalogs are meant to be edited.

There is no runtime i18n here, and adding one needs nothing from this CLI: a
catalog is a plain `Record<code, string>`, so a project with a translator
builds it where it is rendered — `catalogs={[{ CONFLICT: t("conflict") }]}` —
and the codes stay the keys, because they are the API's contract rather than
copy.

For a Thai project, `generate page` also asks for the page title, because the
Title Case of a kebab-case name is the right answer in English and the wrong
one in Thai. `--title` skips the question.

Thai copy also needs a Thai face, and `init` says so: `create-next-app` leaves
`font-family: Arial, Helvetica, sans-serif` on `body`, and none of those faces
carries Thai, so the browser falls back per glyph. The warning names the
`next/font` fix. It does not rewrite your font stack — that choice is yours.

## What to edit after generation

The CLI gives you a compiling structure and explicit TODOs. Your application
still owns:

- the record type and request paths in a slice's `api/<name>.ts`
- the `Session` type and auth endpoint paths in `shared/auth/session.ts`
- the machine codes and their sentences in every `*-errors.ts` catalog
- the markup in each page and leaf component
- the state a `model/` hook actually holds, and the helpers in `lib/`
- `NEXT_PUBLIC_API_URL` in `.env`, and the API's CORS allowlist on the other
  side — the browser drops the refresh cookie otherwise

Use the CLI for the repetitive shape, then fill in the TODOs before treating a
screen as production behaviour.

## Developing the CLI

~~~bash
pnpm install
pnpm run verify            # tsc + unit tests + smoke test — fast, offline
pnpm run test:integration  # real create-next-app + install + next build
~~~

Three checks, three different failures, none subsuming another:

- `tests/patch.test.mjs` covers the patchers that edit files this CLI did not
  write, in isolation, where the fiddly cases live
- `scripts/smoke-test.mjs` drives the real binary over three fixtures (root
  `app/`, `src/app/`, and a bun-shaped one), asserts no `{{…}}` template syntax
  or CRLF leaked, and **type-checks the generated project** by symlinking this
  repo's `node_modules` into the fixture. That is why `next` and `react` are
  devDependencies here; they are never shipped
- `scripts/integration-test.mjs` catches what the smoke test structurally
  cannot: a dependency range that does not resolve — the fixture borrows
  packages it never installed — and Next.js behaviour drift

CI runs `verify` on Ubuntu and Windows, and `test:integration` on Ubuntu.
Windows is in the matrix because every path this CLI writes is built by hand,
and a path that becomes a glob has to stay posix.

`AGENTS.md` carries the conventions for changing the CLI itself.

## License

MIT
