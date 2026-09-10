import path from "path";
import nodeFs from "fs";
import { createRequire } from "module";
import fs from "fs-extra";
import Handlebars from "handlebars";

Handlebars.registerHelper("eq", (a, b) => a === b);
Handlebars.registerHelper("includes", (list: unknown, value: unknown) =>
  Array.isArray(list) && list.includes(value)
);

export function getTemplatesRoot(): string {
  const candidates = [
    path.join(__dirname, "..", "..", "templates"),
    path.join(__dirname, "..", "..", "..", "templates"),
  ];
  const resolved = candidates.find((candidate) =>
    nodeFs.existsSync(path.join(candidate, "init", "steiger.config.ts.hbs"))
  );
  if (!resolved) throw new Error("unable to locate templates directory");
  return resolved;
}

export function renderString(source: string, context: object): string {
  return Handlebars.compile(source, { noEscape: true })(context);
}

export function renderTemplate(template: string, context: object): string {
  const source = nodeFs.readFileSync(path.join(getTemplatesRoot(), template), "utf8");
  return renderString(source, context);
}

export interface TemplateEntry {
  /** path relative to templates/, e.g. "add/errors/api-error.ts.hbs" */
  template: string;
  /** path relative to the project root, e.g. "src/shared/api/api-error.ts" */
  output: string;
  when?: (ctx: any) => boolean;
  /** Replace an existing file instead of refusing. Only for files this CLI
   *  wrote itself and fully owns. */
  overwrite?: boolean;
}

export interface ApplyOptions {
  /**
   * Leave files that already exist alone instead of refusing the batch.
   *
   * For extending something already generated — adding a `model/` segment to a
   * slice that only had `ui/`. The caller is responsible for having decided
   * there is genuinely something new to write; this only stops the existing
   * files from being an error.
   */
  skipExisting?: boolean;
}

/**
 * Renders a set of templates, refusing the whole batch if any output already
 * exists.
 *
 * All-or-nothing on purpose: a partial write leaves a slice with two of its
 * four files rendered against a name the other two never saw, and the second
 * run then refuses because of the files the first run made. Reporting every
 * collision up front also means one message instead of one per re-run.
 */
export async function applyTemplates(
  projectRoot: string,
  entries: TemplateEntry[],
  context: object,
  opts: ApplyOptions = {}
): Promise<string[]> {
  const root = getTemplatesRoot();
  let planned = entries.filter((entry) => !entry.when || entry.when(context));

  const exists = (entry: TemplateEntry) => fs.existsSync(path.join(projectRoot, entry.output));
  if (opts.skipExisting) {
    planned = planned.filter((entry) => entry.overwrite || !exists(entry));
  } else {
    const collisions = planned.filter((entry) => !entry.overwrite && exists(entry)).map((entry) => entry.output);
    if (collisions.length > 0) {
      throw new Error(
        `refusing to overwrite existing file${collisions.length > 1 ? "s" : ""}:\n` +
          collisions.map((file) => `  ${file}`).join("\n") +
          "\nDelete them first, or generate under a different name."
      );
    }
  }

  const written: string[] = [];
  for (const entry of planned) {
    const source = await fs.readFile(path.join(root, entry.template), "utf8");
    const outputPath = path.join(projectRoot, entry.output);
    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, renderString(source, context));
    written.push(entry.output);
  }
  await formatFiles(projectRoot, written);
  return written;
}

/**
 * Runs the project's own prettier over the given files, if it has one.
 *
 * `add prettier` puts `prettier --check .` on the lint script, so from that
 * point every generated file has to pass it — and keeping forty templates
 * hand-matched to whatever printWidth a project chose is not a thing anyone
 * can keep doing. The project's prettier, resolved from the project: a
 * generator that formats with its own copy gets undone the moment the project
 * runs its own.
 *
 * Also called by hand for the files the regex patchers edit after this —
 * splicing `<Providers>` into a formatted layout.tsx un-formats it.
 *
 * Best-effort: a project can have the config and not yet the binary
 * (`--no-install`), and failing a generate over cosmetics trades the wrong way
 * round. Unformatted files are what lint is for.
 */
export async function formatFiles(projectRoot: string, files: string[]): Promise<void> {
  let prettier: any;
  try {
    prettier = createRequire(path.join(projectRoot, "noop.js"))("prettier");
  } catch {
    return; // No prettier in this project. Nothing to be consistent with.
  }

  for (const file of files) {
    const full = path.join(projectRoot, file);
    try {
      // getFileInfo, not just the extension: it applies .prettierignore and
      // .gitignore, so a file the project excluded stays excluded.
      const info = await prettier.getFileInfo(full, { ignorePath: [".gitignore", ".prettierignore"] });
      if (info.ignored || !info.inferredParser) continue;
      const config = await prettier.resolveConfig(full);
      const source = await fs.readFile(full, "utf8");
      await fs.writeFile(full, await prettier.format(source, { ...config, filepath: full }));
    } catch {
      // A file prettier cannot parse is worth seeing in lint, not worth
      // aborting a generate over.
    }
  }
}
