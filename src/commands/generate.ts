import path from "path";
import fs from "fs-extra";
import pc from "picocolors";

import { SLICE_LAYERS, SEGMENTS, Segment, SliceLayer } from "../types";
import { checkbox, confirm, input, select } from "../prompts";
import { readConfig } from "../utils/config";
import { copyFor } from "../utils/copy";
import { normalizeRoute, resolveNaming, resolveSliceNaming, validateRoute, validateSliceName, validateSlicePath } from "../utils/naming";
import { applyTemplates, renderTemplate, TemplateEntry, formatFiles } from "../utils/render";
import { appendExport } from "../utils/project";
import { report } from "./init";

export interface PageOptions {
  title?: string;
  route?: string;
  /** false when --no-route was passed; commander leaves it undefined otherwise. */
  routeFile?: boolean;
  /** FSD root relative to the project, defaulting to the configured srcDir. */
  root?: string;
  client?: boolean;
  auth?: boolean;
  api?: boolean;
  /** Legacy alias for api; keep it so existing scripts keep working. */
  model?: boolean;
  errors?: boolean;
  defaults?: boolean;
}

export async function generatePage(rawName: string | undefined, opts: PageOptions): Promise<void> {
  const config = readConfig(process.cwd());
  assertInputs("page", rawName, opts);
  const root = resolveFsdRoot(config.srcDir, opts.root);

  const name =
    rawName ??
    (await input({
      message: `Page name (kebab-case or group/name, becomes ${root}/_pages/<name>/):`,
      validate: validateSlicePath,
    }));
  const naming = resolveSliceNaming(name);

  let { client, auth, errors } = opts;
  // The canonical flag is --api; --model remains a legacy alias, but the
  // generated code is an API integration and belongs in api/.
  let api = opts.api ?? opts.model;
  let title = opts.title?.trim() || undefined;
  if (!opts.defaults) {
    if (auth === undefined && client === undefined) {
      const shape = await select({
        message: "What shape is this page?",
        choices: [
          { name: "Server component only", value: "server" },
          { name: "Server component + a \"use client\" leaf", value: "client" },
          {
            name: "Client leaf behind a session guard (useRequireSession)",
            value: "auth",
            disabled: config.features.auth ? false : "— needs `add auth` first",
          },
        ],
      });
      client = shape !== "server";
      auth = shape === "auth";
    }
    // Asked for `th`, not for `en`: the derived Title Case of a kebab name is
    // already the right answer in English, while a Thai project would
    // otherwise get an English heading and an English <title> on every page —
    // two hand edits per page, every page.
    if (opts.title === undefined && config.locale !== "en") {
      title = (
        await input({
          message: "Page title (shown as the heading and the browser title):",
          default: toTitleCase(naming.name),
        })
      ).trim();
    }
    if (api === undefined && config.features.errorHandling) {
      api = await confirm({
        message: `Add this page's query hooks (api/${naming.name}.ts)?`,
        default: false,
      });
    }
    if (errors === undefined && config.features.errorHandling) {
      errors = await confirm({
        message: `Add an error catalog (model/${naming.name}-errors.ts)?`,
        default: false,
      });
    }
  }

  if (auth && !config.features.auth) {
    throw new Error("--auth needs the auth feature — run `nextjs-fsd add auth` first");
  }
  if (errors && !config.features.errorHandling) {
    throw new Error("--errors needs the error-handling feature — run `nextjs-fsd add error-handling` first");
  }
  if (api && !config.features.errorHandling) {
    throw new Error(
      "--api (or legacy --model) needs the error-handling feature — run `nextjs-fsd add error-handling` first.\n" +
        "A bare fetch skips the bearer token, the single-flight 401 refresh, and the conversion into ApiError."
    );
  }

  const route = opts.route === undefined ? naming.name : normalizeRoute(opts.route);
  const routeCheck = validateRoute(route);
  if (routeCheck !== true) throw new Error(routeCheck);

  const slice = `${root}/_pages/${naming.directory}`;
  // A page that already exists is being extended, not recreated — `--errors`
  // or `--client` on a slice generated bare earlier is the normal way those
  // get added, so the existing files are not an error.
  const extending = fs.existsSync(path.join(process.cwd(), slice));

  // A page being extended may already be routed from somewhere else —
  // `--route "(admin)/dashboard"` the first time round. Writing the default
  // route file now would produce two page.tsx that resolve to the same URL,
  // which Next.js rejects at build time ("two parallel pages that resolve to
  // the same path") — a broken build from a command that printed success.
  const existingRoute = extending
    ? findRouteFor(process.cwd(), config.appDir, sliceImportPath(config.alias, config.srcDir, root, "_pages", naming.directory))
    : undefined;

  const hasContent = Boolean(client || auth);
  const context = {
    ...naming,
    ...config,
    copy: copyFor(config.locale),
    title: title || toTitleCase(naming.name),
    hasContent,
    auth: Boolean(auth),
    pageAlias: sliceImportPrefix(config.alias, config.srcDir, root),
  };

  const written = await applyTemplates(
    process.cwd(),
    [
      { template: "generate/page/index.ts.hbs", output: `${slice}/index.ts` },
      {
        // Server-only half of the public API, next to index.ts: a page with a
        // "use client" leaf cannot export its server component from index.ts
        // without breaking any Client Component that imports the slice.
        template: "generate/page/index.server.ts.hbs",
        output: `${slice}/index.server.ts`,
        when: () => hasContent,
      },
      { template: "generate/page/page.tsx.hbs", output: `${slice}/ui/${naming.name}-page.tsx` },
      {
        template: "generate/page/content.tsx.hbs",
        output: `${slice}/ui/${naming.name}-content.tsx`,
        when: () => hasContent,
      },
      {
        // The same template a slice's api segment gets: a page is a slice too,
        // and its requests have no reason to be shaped differently. The
        // canonical flag is `--api`; `--model` remains a legacy alias, but the
        // generated code is an API integration and belongs in api/.
        template: "generate/slice/api.ts.hbs",
        output: `${slice}/api/${naming.name}.ts`,
        when: () => Boolean(api),
      },
      {
        template: "generate/page/errors.ts.hbs",
        output: `${slice}/model/${naming.name}-errors.ts`,
        when: () => Boolean(errors),
      },
      {
        template: "generate/page/route.tsx.hbs",
        output: path.posix.join(config.appDir, route, "page.tsx"),
        when: () => opts.routeFile !== false && existingRoute === undefined,
      },
    ],
    context,
    { skipExisting: extending }
  );

  if (extending && written.length === 0) {
    throw new Error(
      `${slice} already has everything this would write.\n` +
        "Pass --client, --api (or legacy --model) or --errors to add a leaf component, the query hooks, or an error catalog to it."
    );
  }
  report(written);
  if (extending) {
    console.log(pc.dim(`\nextended the existing ${naming.name} page; untouched files were left alone.`));
    // The page component is one of those untouched files, so a leaf added now
    // is not rendered by anything yet. Say the one line that wires it.
    if (written.some((file) => file.endsWith(`${naming.name}-content.tsx`))) {
      console.log(
        pc.yellow(`ui/${naming.name}-page.tsx does not render it yet — add:`) +
          `\n  import { ${naming.pascal}Content } from "./${naming.name}-content";`
      );
    }
    // index.server.ts is new, but index.ts and the route file still carry the
    // old single-entry shape — both would keep working, and both would keep
    // the server module in the client's reach. Say the two lines that finish
    // the split.
    if (written.some((file) => file.endsWith("index.server.ts"))) {
      console.log(
        pc.yellow(`index.server.ts now carries the page and its metadata — finish the split by hand:`) +
          `\n  trim ${slice}/index.ts to the Content export, and repoint the route at "${config.alias}/_pages/${naming.name}/index.server".`
      );
    }
  }
  if (auth) {
    const layoutGuard = findLayoutGuard(process.cwd(), config.srcDir);
    if (layoutGuard !== undefined) {
      console.log(
        pc.yellow(`\n${layoutGuard} already guards the routes under it.`) +
          "\nIf this page routes under that layout, drop the useRequireSession call from" +
          ` ui/${naming.name}-content.tsx and use useSession() — two components redirecting on the same failed session race each other.`
      );
    }
  }
  if (existingRoute !== undefined) {
    console.log(
      pc.dim(`\nalready routed from ${existingRoute} — left alone rather than adding a second page.tsx for the same URL.`)
    );
  } else if (opts.routeFile === false) {
    console.log(pc.yellow(`\nno route file — add one that re-exports the page and its metadata when you want it routable.`));
  } else {
    // Route groups are directories Next.js reads and strips from the URL, so
    // printing the path verbatim would name a URL that never exists.
    const url = route
      .split("/")
      .filter((segment) => !segment.startsWith("(") && !segment.startsWith("@"))
      .join("/");
    console.log(`\n${pc.bold("Route:")} /${url}`);
  }
}

export async function generatePages(rawNames: string[] | undefined, opts: PageOptions): Promise<void> {
  const names = expandNames(rawNames);
  if (names.length > 1 && opts.route !== undefined) {
    throw new Error("--route can be used with only one page; omit it to use each page name as its route");
  }
  // One --title cannot describe several pages: leave it unset so each page
  // falls back to the Title Case of its own name instead of sharing one.
  const pageOpts = names.length > 1 && opts.title === undefined ? { ...opts, title: "" } : opts;
  for (const name of names.length > 0 ? names : [undefined]) {
    await generatePage(name, pageOpts);
  }
}

export interface SliceOptions {
  segments?: string;
  errors?: boolean;
  defaults?: boolean;
  /** FSD root relative to the project, defaulting to the configured srcDir. */
  root?: string;
}

export async function generateSlices(
  rawLayer: string | undefined,
  rawNames: string[] | undefined,
  opts: SliceOptions
): Promise<void> {
  const names = expandNames(rawNames);
  for (const name of names.length > 0 ? names : [undefined]) {
    await generateSlice(rawLayer, name, opts);
  }
}

export async function generateSlice(
  rawLayer: string | undefined,
  rawName: string | undefined,
  opts: SliceOptions
): Promise<void> {
  const config = readConfig(process.cwd());
  assertSliceInputs(rawLayer, rawName, opts);
  const root = resolveFsdRoot(config.srcDir, opts.root);

  const layer =
    parseLayer(rawLayer) ??
    ((await select({
      message: "Which layer?",
      choices: [
        { name: "features — a whole user action, reused by two or more pages", value: "features" },
        { name: "entities — a business object, reused by two or more features", value: "entities" },
        { name: "widgets — a composite UI block (prefer features; see docs/fsd.md)", value: "widgets" },
      ],
    })) as SliceLayer);

  const name =
    rawName ??
    (await input({
      message: `Slice name (kebab-case or group/name, becomes ${root}/${layer}/<name>/):`,
      validate: validateSlicePath,
    }));
  const naming = resolveSliceNaming(name);

  const chosen = opts.segments
    ? parseSegments(opts.segments)
    : opts.defaults
      ? (["ui"] as Segment[])
      : ((await checkbox({
          message: "Which segments? (a slice gets only the ones it has code for)",
          choices: [
            { name: "ui — components", value: "ui", checked: true },
            { name: "model — state and hooks", value: "model" },
            {
              name: "api — TanStack Query hooks",
              value: "api",
              disabled: config.features.errorHandling ? false : "— needs `add error-handling` first",
            },
            { name: "lib — pure helpers", value: "lib" },
            { name: "config — feature flags and slice settings", value: "config" },
          ],
        })) as Segment[]);

  if (chosen.length === 0) {
    throw new Error("pick at least one segment — a slice with no segments is an empty directory");
  }
  if (chosen.includes("api") && !config.features.errorHandling) {
    throw new Error(
      "the api segment needs the error-handling feature — run `nextjs-fsd add error-handling` first.\n" +
        "A bare fetch skips the bearer token, the single-flight 401 refresh, and the conversion into ApiError."
    );
  }

  let errors = opts.errors;
  if (errors === undefined) {
    errors = opts.defaults
      ? false
      : config.features.errorHandling &&
        (await confirm({ message: `Add an error catalog (model/${naming.name}-errors.ts)?`, default: false }));
  }
  if (errors && !config.features.errorHandling) {
    throw new Error("--errors needs the error-handling feature — run `nextjs-fsd add error-handling` first");
  }

  const segments = Object.fromEntries(
    [...SEGMENTS, "errors" as const].map((segment) => [
      segment,
      segment === "errors" ? Boolean(errors) : chosen.includes(segment as Segment),
    ])
  );

  // Only the segments that are not on disk yet. Drives both what gets written
  // and which export lines join an existing index.ts, so extending a slice
  // never re-announces a segment it already had.
  const onDisk = existingSegments(process.cwd(), slicePath(root, layer, naming.directory), naming.name);
  const added = Object.fromEntries(
    Object.entries(segments).map(([segment, wanted]) => [segment, wanted && !onDisk.includes(segment)])
  );

  const context = {
    ...naming,
    ...config,
    copy: copyFor(config.locale),
    layer,
    segments,
    // A ui component that calls the slice's own model hook needs the browser.
    needsClient: segments.model,
  };

  const slice = slicePath(root, layer, naming.directory);
  const extending = fs.existsSync(path.join(process.cwd(), slice));
  const entries: TemplateEntry[] = [
    // index.ts is handled separately when extending: it has to gain the new
    // segments' exports without losing whatever is already in it (including
    // lines someone edited by hand).
    { template: "generate/slice/index.ts.hbs", output: `${slice}/index.ts`, when: () => !extending },
    { template: "generate/slice/ui.tsx.hbs", output: `${slice}/ui/${naming.name}.tsx`, when: () => segments.ui },
    { template: "generate/slice/model.ts.hbs", output: `${slice}/model/${naming.name}.ts`, when: () => segments.model },
    { template: "generate/slice/api.ts.hbs", output: `${slice}/api/${naming.name}.ts`, when: () => segments.api },
    { template: "generate/slice/lib.ts.hbs", output: `${slice}/lib/${naming.name}.ts`, when: () => segments.lib },
    {
      template: "generate/slice/config.ts.hbs",
      output: `${slice}/config/${naming.name}.ts`,
      when: () => segments.config,
    },
    {
      template: "generate/slice/errors.ts.hbs",
      output: `${slice}/model/${naming.name}-errors.ts`,
      when: () => segments.errors,
    },
  ];

  const written = await applyTemplates(process.cwd(), entries, context, { skipExisting: extending });

  if (extending) {
    if (written.length === 0) {
      throw new Error(
        `${slice} already has every segment this would write.\n` +
          `It currently has: ${onDisk.join(", ") || "nothing"}.`
      );
    }
    // Rendered from the same template as a fresh index.ts, with only the new
    // segments switched on, so the export lines cannot drift from the files
    // they point at.
    for (const line of renderTemplate("generate/slice/index.ts.hbs", { ...context, segments: added }).split("\n")) {
      if (line.trim() !== "" && appendExport(process.cwd(), `${slice}/index.ts`, line)) {
        if (!written.includes(`${slice}/index.ts`)) written.push(`${slice}/index.ts`);
      }
    }
    // Appended as text rather than rendered, so applyTemplates never formatted
    // it — and `add prettier` puts a --check on lint.
    await formatFiles(process.cwd(), [`${slice}/index.ts`]);
  }

  report(written);
  if (extending) console.log(pc.dim(`\nextended the existing ${naming.name} slice; untouched files were left alone.`));
  console.log(
    `\n${pc.dim("imported as")} import { ${naming.pascal} } from "${sliceImportPath(config.alias, config.srcDir, root, layer, naming.directory)}";` +
      `\n${pc.dim("only through that index.ts — reaching into ui/ is the boundary violation steiger reports.")}` +
      `\n${pc.dim("until something imports it, steiger reports fsd/insignificant-slice — that is the linter working, not a mistake.")}`
  );
}

/**
 * The route file that already re-exports this page slice, if any.
 *
 * Found by reading the app directory rather than by guessing the path: a page
 * generated with `--route "(admin)/dashboard"` lives nowhere the slice name
 * would predict, and the whole point is to notice a route that is not where
 * the default would have put it.
 */
function findRouteFor(projectDir: string, appDir: string, importPath: string): string | undefined {
  const root = path.join(projectDir, appDir);
  if (!fs.existsSync(root)) return undefined;
  // Both public API entries: a page with a client leaf is routed from
  // "<slice>/index.server", a server-only one from "<slice>".
  const markers = [`${importPath}"`, `${importPath}/index.server"`];
  for (const entry of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (path.basename(entry) !== "page.tsx") continue;
    const file = path.join(root, entry);
    const source = fs.readFileSync(file, "utf8");
    if (markers.some((marker) => source.includes(marker))) {
      return path.posix.join(appDir, entry.split(path.sep).join("/"));
    }
  }
  return undefined;
}

/**
 * The layout guard that already calls useRequireSession, if there is one.
 *
 * Read from the file rather than the config, because what matters is whether a
 * shell guards its routes — not whether this CLI is what wrote it.
 */
function findLayoutGuard(projectDir: string, srcDir: string): string | undefined {
  const dir = path.join(projectDir, srcDir, "_app", "layouts");
  if (!fs.existsSync(dir)) return undefined;
  const file = fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".tsx"))
    .find((entry) => fs.readFileSync(path.join(dir, entry), "utf8").includes("useRequireSession"));
  return file === undefined ? undefined : `${srcDir}/_app/layouts/${file}`;
}

function slicePath(srcDir: string, layer: string, name: string): string {
  return `${srcDir}/${layer}/${name}`;
}

function sliceImportPrefix(alias: string, srcDir: string, root: string): string {
  const relativeRoot = path.posix.relative(srcDir, root);
  return relativeRoot === "" ? alias : `${alias}/${relativeRoot}`;
}

function sliceImportPath(alias: string, srcDir: string, root: string, layer: string, directory: string): string {
  return `${sliceImportPrefix(alias, srcDir, root)}/${layer}/${directory}`;
}

function resolveFsdRoot(srcDir: string, rawRoot: string | undefined): string {
  const configuredRoot = normalizeProjectRelativePath(srcDir, "configured srcDir");
  const root = rawRoot === undefined ? configuredRoot : normalizeProjectRelativePath(rawRoot, "--root");
  if (root !== configuredRoot && !root.startsWith(`${configuredRoot}/`)) {
    throw new Error(`--root must stay inside ${configuredRoot}/ so the @ alias can resolve generated imports`);
  }
  return root;
}

function normalizeProjectRelativePath(raw: string, label: string): string {
  const value = raw.trim().replaceAll("\\", "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`${label} must be a relative path, for example "src" or "src/domain"`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must stay inside the project, for example "src" or "src/domain"`);
  }
  return normalized;
}

function expandNames(rawNames: string[] | undefined): string[] {
  return (rawNames ?? [])
    .flatMap((name) => name.split(","))
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Where each segment's generated file lands, relative to the slice. */
function segmentFile(segment: string, name: string): string {
  return segment === "errors" ? `model/${name}-errors.ts` : `${segment}/${name}.${segment === "ui" ? "tsx" : "ts"}`;
}

/** Which segments a slice already has on disk. */
function existingSegments(projectDir: string, slice: string, name: string): string[] {
  return [...SEGMENTS, "errors"].filter((segment) =>
    fs.existsSync(path.join(projectDir, slice, segmentFile(segment, name)))
  );
}

/** Lists the page slices that exist, for the wizard-free error message. */
export function existingPages(projectDir: string, srcDir: string): string[] {
  const dir = path.join(projectDir, srcDir, "_pages");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function parseLayer(value: string | undefined): SliceLayer | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, SliceLayer> = {
    f: "features",
    feat: "features",
    feature: "features",
    features: "features",
    e: "entities",
    entity: "entities",
    entities: "entities",
    w: "widgets",
    widget: "widgets",
    widgets: "widgets",
  };
  const layer = aliases[normalized];
  if (layer === undefined) {
    throw new Error(
      `unknown layer "${value}" — use ${SLICE_LAYERS.join(", ")} (aliases: f/e/w).\n` +
        "`_pages` slices come from `generate page`, and `_app`/`shared` are written by `init` and `add`."
    );
  }
  return layer;
}

function parseSegments(value: string): Segment[] {
  const parsed = value
    .split(",")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  const unknown = parsed.filter((segment) => !SEGMENTS.includes(segment as Segment));
  if (unknown.length > 0) {
    throw new Error(`unknown segment${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — use ${SEGMENTS.join(", ")}`);
  }
  return [...new Set(parsed)] as Segment[];
}

/**
 * Whether the routes under a new layout should sit behind the session.
 *
 * Not asked without auth installed (there is nothing to guard with), and not
 * asked off a TTY — `generate layout <name>` has to keep working in CI, where
 * a prompt would turn a working command into an error.
 */
async function askGuard(hasAuth: boolean, defaults: boolean | undefined): Promise<boolean> {
  if (defaults || !hasAuth || !process.stdin.isTTY) return false;
  return confirm({
    message: "Put every route under this layout behind the session (useRequireSession)?",
    default: false,
  });
}

function toTitleCase(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// The no-TTY case reaches here only for values a prompt would have asked for.
// Listing all of them at once beats failing on the first one, then the second.
function assertInputs(what: string, name: string | undefined, opts: { defaults?: boolean }): void {
  if (process.stdin.isTTY || name !== undefined) return;
  throw new Error(
    `no interactive terminal to prompt on — \`generate ${what}\` needs <name> as an argument (flags cover the rest; see --help)`
  );
}

function assertSliceInputs(
  layer: string | undefined,
  name: string | undefined,
  opts: { segments?: string; defaults?: boolean }
): void {
  if (process.stdin.isTTY) return;
  const missing: string[] = [];
  if (layer === undefined) missing.push("<layer>");
  if (name === undefined) missing.push("<name>");
  if (opts.segments === undefined && !opts.defaults) missing.push("--segments (or --defaults for ui only)");
  if (missing.length > 0) {
    throw new Error(
      `no interactive terminal to prompt on — \`generate slice\` is missing: ${missing.join(", ")}. ` +
        "Pass them as arguments/flags, or add --defaults."
    );
  }
}

export interface LayoutOptions {
  route?: string;
  routeFile?: boolean;
  guard?: boolean;
  defaults?: boolean;
}

/**
 * A shared shell for a group of routes: the component in `_app/layouts` plus
 * the `layout.tsx` that re-exports it.
 *
 * `_app`, not `_pages`: a layout is not one route's content, it is what
 * several routes have in common, and the app layer is where cross-page
 * composition lives. The route file defaults to a route group — `(admin)` —
 * because that is a layout's usual reason to exist: shared chrome for a set of
 * pages, contributing nothing to the URL.
 *
 * `--guard` puts every route under it behind the session, in one component.
 * That is where a guard belongs: a page that checks for itself is fine alone
 * and races the shell as soon as both check, and "every signed-in screen" is a
 * property of the shell, not something each page should re-declare.
 */
export async function generateLayout(rawName: string | undefined, opts: LayoutOptions): Promise<void> {
  const config = readConfig(process.cwd());
  assertInputs("layout", rawName, opts);

  const name =
    rawName ??
    (await input({
      message: `Layout name (kebab-case, becomes ${config.srcDir}/_app/layouts/<name>-layout.tsx):`,
      validate: validateSliceName,
    }));
  const naming = resolveNaming(name);

  const guard = opts.guard ?? (await askGuard(config.features.auth, opts.defaults));
  if (guard && !config.features.auth) {
    throw new Error("--guard needs the auth feature — run `nextjs-fsd add auth` first");
  }

  // "(admin)" rather than "admin": a layout's default home is a route group,
  // which shares chrome without adding a URL segment.
  const route = opts.route === undefined ? `(${naming.name})` : normalizeRoute(opts.route);
  const routeCheck = validateRoute(route);
  if (routeCheck !== true) throw new Error(routeCheck);

  const context = { ...naming, ...config, copy: copyFor(config.locale), guard };
  const layouts = `${config.srcDir}/_app/layouts`;
  // Same rule as page and slice: an existing layout is being extended (given a
  // route file it did not have), not recreated.
  const extending = fs.existsSync(path.join(process.cwd(), `${layouts}/${naming.name}-layout.tsx`));
  const written = await applyTemplates(
    process.cwd(),
    [
      { template: "generate/layout/layout.tsx.hbs", output: `${layouts}/${naming.name}-layout.tsx` },
      {
        template: "generate/layout/guard.tsx.hbs",
        output: `${layouts}/${naming.name}-guard.tsx`,
        when: () => guard,
      },
      {
        template: "generate/layout/route.tsx.hbs",
        output: path.posix.join(config.appDir, route, "layout.tsx"),
        when: () => opts.routeFile !== false,
      },
    ],
    context,
    { skipExisting: extending }
  );

  if (extending && written.length === 0) {
    throw new Error(
      `${layouts}/${naming.name}-layout.tsx already exists and is already applied at ${config.appDir}/${route}/layout.tsx.\n` +
        "Pass --route <path> to apply it somewhere else as well."
    );
  }

  // The layout itself was left alone when extending, so a guard added now is
  // not rendering anything yet. Say the two lines that wire it.
  if (extending && written.some((file) => file.endsWith(`${naming.name}-guard.tsx`))) {
    console.log(
      pc.yellow(`${layouts}/${naming.name}-layout.tsx does not render it yet — add:`) +
        `\n  import { ${naming.pascal}Guard } from "./${naming.name}-guard";` +
        `\n  <${naming.pascal}Guard>{children}</${naming.pascal}Guard>`
    );
  }

  if (appendExport(process.cwd(), `${layouts}/index.ts`, `export { ${naming.pascal}Layout } from "./${naming.name}-layout";`)) {
    written.push(`${layouts}/index.ts`);
  }
  await formatFiles(process.cwd(), [`${layouts}/index.ts`]);

  report(written);
  if (guard) {
    console.log(
      pc.dim(
        `\nevery route under this layout is behind ${naming.pascal}Guard — the pages below call useSession() and trust it.` +
          "\nDo not also generate one with `generate page --auth`: two components redirecting on the same failed session race each other."
      )
    );
  }
  if (opts.routeFile === false) {
    console.log(pc.yellow("\nno route file — add a layout.tsx that re-exports it when you want it applied."));
  } else {
    console.log(
      `\n${pc.bold("Applies to:")} every route under ${config.appDir}/${route}/` +
        (route.startsWith("(") ? pc.dim(" (a route group — it adds nothing to the URL)") : "")
    );
  }
}

export interface ApiRouteOptions {
  route?: string;
  /** false when --no-route was passed; commander leaves it undefined otherwise. */
  routeFile?: boolean;
  defaults?: boolean;
}

/**
 * A Route Handler: the logic in `_app/api-routes` plus the `route.ts` that
 * serves it.
 *
 * `_app`, not `_pages`: a handler is not one route's content, it is backend
 * composition shared the way a layout is, and Next.js maps the URL to the
 * file — so the file stays a re-export (`export { getX as GET }`) and the
 * work lives in the segment, where it can be imported, tested and reused
 * without a request.
 *
 * The default route mirrors the segment: `api/<name>`, served at
 * `/api/<name>` from `<appDir>/api/<name>/route.ts`.
 */
export async function generateApiRoute(rawName: string | undefined, opts: ApiRouteOptions): Promise<void> {
  const config = readConfig(process.cwd());
  assertInputs("api-route", rawName, opts);

  const name =
    rawName ??
    (await input({
      message: `API route name (kebab-case, becomes ${config.srcDir}/_app/api-routes/<name>.ts):`,
      validate: validateSliceName,
    }));
  const naming = resolveNaming(name);
  // The logic module names the function; the route file names the method.
  const handler = `get${naming.pascal}`;

  const route = opts.route === undefined ? `api/${naming.name}` : normalizeRoute(opts.route);
  const routeCheck = validateRoute(route);
  if (routeCheck !== true) throw new Error(routeCheck);

  const routeFile =
    opts.routeFile ??
    (rawName === undefined && !opts.defaults
      ? await confirm({
          message: "Create the App Router route.ts too?",
          default: true,
        })
      : true);

  const apiRoutes = `${config.srcDir}/_app/api-routes`;
  // Same rule as page and layout: an existing handler is being extended
  // (served from somewhere else), not recreated.
  const extending = fs.existsSync(path.join(process.cwd(), `${apiRoutes}/${naming.name}.ts`));
  const existingRoute = extending ? findApiRouteFor(process.cwd(), config.appDir, handler) : undefined;

  const routePath = path.posix.join(config.appDir, route, "route.ts");
  // Like a layout applied to a second path, one handler may answer two URLs —
  // but only when asked: an explicit --route pointing somewhere new.
  const serveElsewhere = opts.route !== undefined && existingRoute !== undefined && routePath !== existingRoute;

  // Route groups contribute nothing to the URL, so printing the path verbatim
  // would name a URL that never exists.
  const routeUrl = route
    .split("/")
    .filter((segment) => !segment.startsWith("(") && !segment.startsWith("@"))
    .join("/");
  const context = { ...naming, ...config, copy: copyFor(config.locale), handler, routeUrl };

  const written = await applyTemplates(
    process.cwd(),
    [
      { template: "generate/api-route/handler.ts.hbs", output: `${apiRoutes}/${naming.name}.ts` },
      {
        template: "generate/api-route/route.ts.hbs",
        output: routePath,
        when: () => routeFile && (existingRoute === undefined || serveElsewhere),
      },
    ],
    context,
    { skipExisting: extending }
  );

  if (extending && written.length === 0) {
    const where =
      existingRoute !== undefined
        ? `already exists and is already served from ${existingRoute}`
        : "already has everything this would write";
    throw new Error(
      `${apiRoutes}/${naming.name}.ts ${where}.\nPass --route <path> to serve it from somewhere else as well.`
    );
  }

  if (appendExport(process.cwd(), `${apiRoutes}/index.ts`, `export { ${handler} } from "./${naming.name}";`)) {
    written.push(`${apiRoutes}/index.ts`);
  }
  await formatFiles(process.cwd(), [`${apiRoutes}/index.ts`]);

  report(written);
  if (extending) console.log(pc.dim(`\nextended the existing ${naming.name} handler; untouched files were left alone.`));
  if (existingRoute !== undefined && !serveElsewhere) {
    console.log(pc.dim(`\nalready served from ${existingRoute} — left alone rather than giving one handler a second URL.`));
  } else if (!routeFile) {
    console.log(pc.yellow("\nno route file — add a route.ts that re-exports the handler as GET when you want it served."));
  } else {
    console.log(`\n${pc.bold("Serves:")} /${routeUrl}`);
  }
}

/**
 * The route.ts that already serves this handler, if any.
 *
 * Found by reading the app directory rather than by guessing the path: a
 * handler generated with `--route "v1/health"` lives nowhere the name would
 * predict, and the whole point is to notice a route that is not where the
 * default would have put it.
 */
function findApiRouteFor(projectDir: string, appDir: string, handler: string): string | undefined {
  const root = path.join(projectDir, appDir);
  if (!fs.existsSync(root)) return undefined;
  const marker = `${handler} as GET`;
  for (const entry of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (path.basename(entry) !== "route.ts") continue;
    const file = path.join(root, entry);
    if (fs.readFileSync(file, "utf8").includes(marker)) {
      return path.posix.join(appDir, entry.split(path.sep).join("/"));
    }
  }
  return undefined;
}
