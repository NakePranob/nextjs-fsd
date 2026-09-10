import path from "path";
import fs from "fs-extra";
import { execFileSync } from "child_process";
import pc from "picocolors";
import { PackageManager } from "../types";

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function packageJsonPath(projectDir: string): string {
  return path.join(projectDir, "package.json");
}

export function readPackageJson(projectDir: string): PackageJson {
  const file = packageJsonPath(projectDir);
  if (!fs.existsSync(file)) {
    throw new Error(`no package.json in ${projectDir} — run this inside a Next.js project`);
  }
  return fs.readJsonSync(file) as PackageJson;
}

/**
 * Writes JSON back with the indentation the file already had.
 *
 * `{ spaces: 2 }` is right for a file this CLI creates and wrong for one it
 * edits. A project whose formatter is set to anything else gets package.json,
 * tsconfig.json and nextjs-fsd.config.json silently reindented by every `add`
 * — and then a pre-commit format check fails on files nobody touched by hand.
 */
export function writeJson(file: string, data: unknown): void {
  fs.writeJsonSync(file, data, { spaces: detectIndent(file) });
}

/** First indented line wins: JSON's own nesting means every deeper level is a
 *  multiple of it. Falls back to 2 for a file being created. */
function detectIndent(file: string): number | string {
  if (!fs.existsSync(file)) return 2;
  const match = /\n([ \t]+)"/.exec(fs.readFileSync(file, "utf8"));
  if (!match) return 2;
  return match[1].includes("\t") ? "\t" : match[1].length;
}

/**
 * The git repository root at or above `projectDir`, or `projectDir` when
 * there is no repository.
 *
 * Agent tooling reads `.claude/` and `.agents/` from the repository root, not
 * from whichever directory a command ran in. In a monorepo — a `web/` beside
 * an `api/` — writing a skill next to package.json puts it somewhere nothing
 * ever loads it, which is a silent failure: the file exists, looks right, and
 * is never read.
 */
export function findRepoRoot(projectDir: string): string {
  let dir = path.resolve(projectDir);
  for (;;) {
    // A file, not a directory, inside a worktree or a submodule.
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(projectDir);
    dir = parent;
  }
}

// Lockfile, not the `packageManager` field: the field is often absent and the
// lockfile is what actually decided which client installed node_modules.
export function detectPackageManager(projectDir: string): PackageManager {
  const lockfiles: [string, PackageManager][] = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [lockfile, manager] of lockfiles) {
    if (fs.existsSync(path.join(projectDir, lockfile))) return manager;
  }
  return "npm";
}

/**
 * Writes an agent skill where the agents actually look for it.
 *
 * Real file under `.agents/skills/`, symlinked from `.claude/skills/`: Claude
 * Code reads the second, Codex and anything following the AGENTS.md
 * convention read the first, and one file means one thing to keep current.
 * Both go at the repository root — see findRepoRoot for why a monorepo
 * workspace is the wrong place.
 *
 * Returns what was written, as paths relative to `projectDir`, because that is
 * the directory the user typed the command in.
 */
export function writeAgentSkill(projectDir: string, name: string, content: string): string[] {
  const root = findRepoRoot(projectDir);
  const relative = (target: string) => toPosix(path.relative(projectDir, target)) || ".";

  const real = path.join(root, ".agents", "skills", name, "SKILL.md");
  fs.ensureDirSync(path.dirname(real));
  fs.writeFileSync(real, content);
  const written = [relative(real)];

  const link = path.join(root, ".claude", "skills", name);
  // lstat, not existsSync: a symlink left pointing at a deleted target is
  // still a thing in the way, and existsSync follows it and says no.
  if (lstatOrNull(link)) return written;

  fs.ensureDirSync(path.dirname(link));
  try {
    fs.symlinkSync(path.join("..", "..", ".agents", "skills", name), link, "dir");
    written.push(`${relative(link)} -> .agents/skills/${name}`);
  } catch {
    // Windows refuses symlinks without developer mode or elevation. A second
    // real copy still works for Claude Code — it just has to be rewritten by
    // the next `init`, which is what the CLI does anyway.
    fs.ensureDirSync(link);
    fs.writeFileSync(path.join(link, "SKILL.md"), content);
    written.push(relative(path.join(link, "SKILL.md")));
  }
  return written;
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Locates the Next.js App Router directory.
 *
 * Both layouts create-next-app can produce are supported as-is: `app/` at the
 * root, and `src/app/` when "use src directory" was chosen. FSD's own app
 * layer is `src/_app`, so it never collides with either — which is why this
 * detects rather than moves anything.
 */
export function detectAppDir(projectDir: string): string {
  const pkg = readPackageJson(projectDir);
  const hasNext = Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  if (!hasNext) {
    throw new Error(
      "this package.json has no `next` dependency — create the app first (`bunx create-next-app@latest`), then run `nextjs-fsd init` inside it"
    );
  }

  // Posix separators, deliberately, even on Windows: this value is not only a
  // path. It is interpolated into ESLint `files` globs, Tailwind `@source`
  // lines and the generated docs, and a glob with a backslash matches nothing
  // — so a project initialised on Windows would silently lose the rule that
  // keeps features out of the routing layer. `path.join` normalises it back
  // for the filesystem calls that need it.
  for (const candidate of ["app", "src/app"]) {
    if (fs.existsSync(path.join(projectDir, candidate, "layout.tsx"))) return candidate;
  }
  throw new Error(
    "no App Router layout found at app/layout.tsx or src/app/layout.tsx — this CLI only supports the App Router, not the legacy pages/ router"
  );
}

/**
 * Adds dependencies that are missing, leaving any already-declared version
 * alone — a project pinned to axios ^1.5 should not get silently bumped
 * because a template happened to be written against a newer one.
 * Returns the names actually added.
 */
export function addDependencies(
  projectDir: string,
  deps: Record<string, string>,
  kind: "dependencies" | "devDependencies" = "dependencies"
): string[] {
  const file = packageJsonPath(projectDir);
  const pkg = fs.readJsonSync(file) as PackageJson;
  const target = { ...(pkg[kind] ?? {}) };
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  const added: string[] = [];
  for (const [name, range] of Object.entries(deps)) {
    if (declared[name]) continue;
    target[name] = range;
    added.push(name);
  }
  if (added.length === 0) return [];

  // Sorted so a diff of package.json stays reviewable instead of appending in
  // whatever order a template listed its dependencies.
  pkg[kind] = Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b)));
  writeJson(file, pkg);
  return added;
}

export function installDependencies(projectDir: string, manager: PackageManager): void {
  const command = manager === "npm" ? ["npm", "install"] : [manager, "install"];
  console.log(pc.dim(`> ${command.join(" ")}`));
  execFileSync(command[0], command.slice(1), { cwd: projectDir, stdio: "inherit" });
}

export function runCommand(projectDir: string, manager: PackageManager, args: string[]): void {
  const runner = manager === "npm" ? "npx" : manager === "yarn" ? "yarn" : manager === "pnpm" ? "pnpm" : "bunx";
  console.log(pc.dim(`> ${runner} ${args.join(" ")}`));
  execFileSync(runner, args, { cwd: projectDir, stdio: "inherit" });
}

/**
 * Puts `srcDir` first in the tsconfig `alias/*` path, keeping whatever was
 * mapped there as a fallback.
 *
 * create-next-app maps `@/*` to `./*` (the project root) when it does not use
 * a src directory, and TypeScript tries a paths array in order — so prepending
 * makes `@/_pages/login` resolve while an existing `@/app/thing` import in the
 * project keeps resolving too. Replacing the array outright would break those
 * silently, in files this CLI never looked at.
 *
 * Returns false if srcDir was already first.
 */
export function patchTsconfigPaths(projectDir: string, alias: string, srcDir: string): boolean {
  const file = path.join(projectDir, "tsconfig.json");
  if (!fs.existsSync(file)) throw new Error("no tsconfig.json — expected one in a Next.js TypeScript project");

  // Read as text and parse leniently: create-next-app writes strict JSON, but
  // a hand-edited tsconfig with comments is normal and JSON5 is not worth a
  // dependency here. A parse failure is reported, not swallowed.
  let config: any;
  try {
    config = fs.readJsonSync(file);
  } catch {
    throw new Error(
      "could not parse tsconfig.json as JSON (comments?) — add this by hand instead:\n" +
        `  "paths": { "${alias}/*": ["./${srcDir}/*"] }`
    );
  }

  const key = `${alias}/*`;
  const first = `./${srcDir}/*`;
  const options = (config.compilerOptions ??= {});
  const paths = (options.paths ??= {});
  const existing: string[] = Array.isArray(paths[key]) ? paths[key] : [];
  if (existing[0] === first) return false;
  paths[key] = [first, ...existing.filter((entry) => entry !== first)];
  writeJson(file, config);
  return true;
}

/**
 * Adds a step to an npm script, or creates it. Appended with `&&` rather than
 * replaced: `lint` already runs eslint in a fresh Next.js project and both
 * checks matter.
 */
export function appendScript(projectDir: string, name: string, step: string): boolean {
  const file = packageJsonPath(projectDir);
  const pkg = fs.readJsonSync(file) as PackageJson;
  const scripts = (pkg.scripts ??= {});
  const existing = scripts[name];
  if (existing?.includes(step)) return false;
  scripts[name] = existing ? `${existing} && ${step}` : step;
  writeJson(file, pkg);
  return true;
}

/** Appends an export line to a barrel, creating it if absent. */
export function appendExport(projectDir: string, barrel: string, line: string): boolean {
  const file = path.join(projectDir, barrel);
  if (!fs.existsSync(file)) {
    fs.ensureDirSync(path.dirname(file));
    fs.writeFileSync(file, `${line}\n`);
    return true;
  }
  const current = fs.readFileSync(file, "utf8");
  if (current.includes(line)) return false;
  fs.writeFileSync(file, current.replace(/\n*$/, "\n") + `${line}\n`);
  return true;
}

/** Appends a block to .env.example, skipping it if the key is already there. */
export function appendEnvExample(projectDir: string, key: string, block: string): boolean {
  const file = path.join(projectDir, ".env.example");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current.includes(key)) return false;
  fs.writeFileSync(file, current === "" ? block : current.replace(/\n*$/, "\n\n") + block);
  return true;
}

/**
 * Repoints the root layout's stylesheet import at the FSD app layer.
 *
 * The CSS file moves because Tailwind v4's `@theme` is project-wide
 * configuration, which is app-layer, not route-adjacent — and the import in
 * layout.tsx is the only reference to its old path.
 */
export function patchLayoutStyleImport(projectDir: string, appDir: string, alias: string): boolean {
  const file = path.join(projectDir, appDir, "layout.tsx");
  const source = fs.readFileSync(file, "utf8");
  const target = `import "${alias}/_app/styles/globals.css";`;
  if (source.includes(target)) return false;

  const patched = source.replace(/^import\s+["']\.\/globals\.css["'];?[ \t]*$/m, target);
  if (patched === source) return false;
  fs.writeFileSync(file, patched);
  return true;
}

/**
 * Wraps the root layout's JSX `{children}` in `<Providers>`.
 *
 * Anchored on `<body`, because `{ children }` appears twice in every App
 * Router layout and the first one is the destructured parameter —
 * `RootLayout({ children }: LayoutProps<"/">)`. Patching that one produces
 * `RootLayout(<Providers>{children}</Providers>: ...)`, a file that no longer
 * parses, which is why the search starts after the opening body tag instead of
 * at the top of the file.
 *
 * Regex, not an AST: this runs once on a file whose shape create-next-app
 * fixes, and every way it can miss — already wrapped, no <body>, no children —
 * returns without touching the file so the caller can print instructions.
 */
export function patchLayoutProviders(projectDir: string, appDir: string, alias: string): "patched" | "already" | "manual" {
  const file = path.join(projectDir, appDir, "layout.tsx");
  const source = fs.readFileSync(file, "utf8");
  if (/<Providers[\s>]/.test(source)) return "already";

  const bodyAt = source.indexOf("<body");
  if (bodyAt === -1) return "manual";
  const children = /\{\s*children\s*\}/.exec(source.slice(bodyAt));
  if (!children) return "manual";

  const imports = [...source.matchAll(/^import .*$/gm)];
  const lastImport = imports[imports.length - 1];
  // index 0 is a real position: a layout whose first line is an import.
  if (lastImport?.index === undefined) return "manual";
  const importAt = source.indexOf("\n", lastImport.index) + 1;

  // Children first, then the import: both edits are index-based, and the
  // import sits earlier in the file, so doing the later one first keeps the
  // earlier offset valid.
  const childrenAt = bodyAt + children.index;
  const withProvider =
    source.slice(0, childrenAt) +
    "<Providers>" +
    children[0] +
    "</Providers>" +
    source.slice(childrenAt + children[0].length);

  const importLine = `import { Providers } from "${alias}/_app/providers";\n`;
  fs.writeFileSync(file, withProvider.slice(0, importAt) + importLine + withProvider.slice(importAt));
  return "patched";
}

const ESLINT_CONFIG_FILES = ["eslint.config.mjs", "eslint.config.js", "eslint.config.ts", "eslint.config.cjs"];

/**
 * Spreads the generated FSD boundary config into the project's flat ESLint
 * config.
 *
 * A separate `eslint.fsd.mjs` plus a two-line patch, rather than injecting the
 * rules into the array literal: create-next-app's config is
 * `export default eslintConfig;` over a `defineConfig([...])` call, and
 * splicing rules into that call means parsing JS to find the right closing
 * bracket. Two anchors — the last import, and the default export — are all
 * this needs, and a config someone has restructured falls through to printed
 * instructions instead of a wrong edit.
 */
export function patchEslintConfig(projectDir: string): "patched" | "already" | "manual" | "missing" {
  const file = ESLINT_CONFIG_FILES.map((name) => path.join(projectDir, name)).find((candidate) =>
    fs.existsSync(candidate)
  );
  if (!file) return "missing";

  const source = fs.readFileSync(file, "utf8");
  if (source.includes("eslint.fsd.mjs")) return "already";

  // `export default <identifier>;` is the shape every create-next-app config
  // has had. An inline array or call expression is left alone.
  const exported = /^export default (\w+);?[ \t]*$/m.exec(source);
  const imports = [...source.matchAll(/^import .*$/gm)];
  const lastImport = imports[imports.length - 1];
  if (!exported || lastImport?.index === undefined) return "manual";

  // The export sits after the imports, so replacing it first keeps the
  // import offset computed from the original source valid.
  const importAt = source.indexOf("\n", lastImport.index) + 1;
  // A named const rather than `export default [...]`: eslint-config-next
  // warns on an anonymous default export, and init should not hand someone a
  // config file that lints with a warning.
  const withExport = source.replace(
    exported[0],
    `const fsdEslintConfig = [...${exported[1]}, ...fsdBoundary];\nexport default fsdEslintConfig;`
  );
  fs.writeFileSync(
    file,
    withExport.slice(0, importAt) + 'import fsdBoundary from "./eslint.fsd.mjs";\n' + withExport.slice(importAt)
  );
  return "patched";
}
