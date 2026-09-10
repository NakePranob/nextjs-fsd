import path from "path";
import fs from "fs-extra";
import pc from "picocolors";

import { SLICE_LAYERS, SEGMENTS, Segment, SliceLayer } from "../types";
import { checkbox, confirm, input, select } from "../prompts";
import { readConfig } from "../utils/config";
import { copyFor } from "../utils/copy";
import { normalizeRoute, resolveNaming, validateRoute, validateSliceName } from "../utils/naming";
import { applyTemplates, renderTemplate, TemplateEntry, formatFiles } from "../utils/render";
import { appendExport } from "../utils/project";
import { report } from "./init";

export interface PageOptions {
  title?: string;
  route?: string;
  /** false when --no-route was passed; commander leaves it undefined otherwise. */
  routeFile?: boolean;
  client?: boolean;
  auth?: boolean;
  errors?: boolean;
  defaults?: boolean;
}

export async function generatePage(rawName: string | undefined, opts: PageOptions): Promise<void> {
  const config = readConfig(process.cwd());
  assertInputs("page", rawName, opts);

  const name =
    rawName ??
    (await input({
      message: "Page name (kebab-case, becomes src/_pages/<name>/):",
      validate: validateSliceName,
    }));
  const naming = resolveNaming(name);

  let { client, auth, errors } = opts;
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

  const route = opts.route === undefined ? naming.name : normalizeRoute(opts.route);
  const routeCheck = validateRoute(route);
  if (routeCheck !== true) throw new Error(routeCheck);

  const slice = `${config.srcDir}/_pages/${naming.name}`;
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
    ? findRouteFor(process.cwd(), config.appDir, config.alias, naming.name)
    : undefined;

  const hasContent = Boolean(client || auth);
  const context = {
    ...naming,
    ...config,
    copy: copyFor(config.locale),
    title: title || toTitleCase(naming.name),
    hasContent,
    auth: Boolean(auth),
  };

  const written = await applyTemplates(
    process.cwd(),
    [
      { template: "generate/page/index.ts.hbs", output: `${slice}/index.ts` },
      { template: "generate/page/page.tsx.hbs", output: `${slice}/ui/${naming.name}-page.tsx` },
      {
        template: "generate/page/content.tsx.hbs",
        output: `${slice}/ui/${naming.name}-content.tsx`,
        when: () => hasContent,
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
        "Pass --client or --errors to add a leaf component or an error catalog to it."
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

export interface SliceOptions {
  segments?: string;
  errors?: boolean;
  defaults?: boolean;
}

export async function generateSlice(
  rawLayer: string | undefined,
  rawName: string | undefined,
  opts: SliceOptions
): Promise<void> {
  const config = readConfig(process.cwd());
  assertSliceInputs(rawLayer, rawName, opts);

  const layer =
    parseLayer(rawLayer) ??
    ((await select({
      message: "Which layer?",
      choices: [
        { name: "features — a whole user action, reused by two or more pages", value: "features" },
        { name: "entities — a business object, reused by two or more features", value: "entities" },
        { name: "widgets — a composite UI block (FSD v2.1 discourages this; prefer features)", value: "widgets" },
      ],
    })) as SliceLayer);

  const name =
    rawName ??
    (await input({
      message: `Slice name (kebab-case, becomes ${config.srcDir}/${layer}/<name>/):`,
      validate: validateSliceName,
    }));
  const naming = resolveNaming(name);

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
  const onDisk = existingSegments(process.cwd(), slicePath(config.srcDir, layer, naming.name), naming.name);
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

  const slice = slicePath(config.srcDir, layer, naming.name);
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
    `\n${pc.dim("imported as")} import { ${naming.pascal} } from "${config.alias}/${layer}/${naming.name}";` +
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
function findRouteFor(projectDir: string, appDir: string, alias: string, name: string): string | undefined {
  const root = path.join(projectDir, appDir);
  if (!fs.existsSync(root)) return undefined;
  const marker = `${alias}/_pages/${name}"`;
  for (const entry of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (path.basename(entry) !== "page.tsx") continue;
    const file = path.join(root, entry);
    if (fs.readFileSync(file, "utf8").includes(marker)) {
      return path.posix.join(appDir, entry.split(path.sep).join("/"));
    }
  }
  return undefined;
}

function slicePath(srcDir: string, layer: string, name: string): string {
  return `${srcDir}/${layer}/${name}`;
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
  if (!SLICE_LAYERS.includes(normalized as SliceLayer)) {
    throw new Error(
      `unknown layer "${value}" — use ${SLICE_LAYERS.join(", ")}.\n` +
        "`_pages` slices come from `generate page`, and `_app`/`shared` are written by `init` and `add`."
    );
  }
  return normalized as SliceLayer;
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

  // "(admin)" rather than "admin": a layout's default home is a route group,
  // which shares chrome without adding a URL segment.
  const route = opts.route === undefined ? `(${naming.name})` : normalizeRoute(opts.route);
  const routeCheck = validateRoute(route);
  if (routeCheck !== true) throw new Error(routeCheck);

  const context = { ...naming, ...config, copy: copyFor(config.locale) };
  const layouts = `${config.srcDir}/_app/layouts`;
  // Same rule as page and slice: an existing layout is being extended (given a
  // route file it did not have), not recreated.
  const extending = fs.existsSync(path.join(process.cwd(), `${layouts}/${naming.name}-layout.tsx`));
  const written = await applyTemplates(
    process.cwd(),
    [
      { template: "generate/layout/layout.tsx.hbs", output: `${layouts}/${naming.name}-layout.tsx` },
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

  if (appendExport(process.cwd(), `${layouts}/index.ts`, `export { ${naming.pascal}Layout } from "./${naming.name}-layout";`)) {
    written.push(`${layouts}/index.ts`);
  }
  await formatFiles(process.cwd(), [`${layouts}/index.ts`]);

  report(written);
  if (opts.routeFile === false) {
    console.log(pc.yellow("\nno route file — add a layout.tsx that re-exports it when you want it applied."));
  } else {
    console.log(
      `\n${pc.bold("Applies to:")} every route under ${config.appDir}/${route}/` +
        (route.startsWith("(") ? pc.dim(" (a route group — it adds nothing to the URL)") : "")
    );
  }
}
