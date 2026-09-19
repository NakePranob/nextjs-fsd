// End-to-end: runs the real CLI against a throwaway Next.js project and checks
// what it produced.
//
// The unit tests cover the patchers in isolation; nothing re-ran the actual
// command sequence, so a template that stopped rendering — or started leaking
// `{{alias}}` into its output — would have gone unnoticed until someone
// generated a project by hand. No network and no package install: the fixture
// below is the parts of a create-next-app project this CLI actually reads.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "bin", "nextjs-fsd.js");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nextjs-fsd-smoke-"));

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}\n       ${error.message.split("\n").join("\n       ")}`);
  }
}

/** The parts of a create-next-app@16 project that init and add actually read. */
function fixture(dir, { srcApp = false, lockfile, vitest = false } = {}) {
  const appDir = srcApp ? path.join(dir, "src", "app") : path.join(dir, "app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "smoke",
        private: true,
        scripts: { dev: "next dev", lint: "eslint" },
        dependencies: { next: "16.3.4", react: "19.2.8", "react-dom": "19.2.8" },
        // vitest here is never installed — the CLI only reads package.json to
        // decide whether the generated tests import from it or from bun:test.
        devDependencies: { typescript: "^5", ...(vitest ? { vitest: "^3" } : {}) },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, "eslint.config.mjs"),
    'import { defineConfig } from "eslint/config";\n\nconst eslintConfig = defineConfig([]);\n\nexport default eslintConfig;\n'
  );
  fs.writeFileSync(path.join(appDir, "globals.css"), '@import "tailwindcss";\n\n:root { --background: #fff; }\n');
  fs.writeFileSync(
    path.join(appDir, "layout.tsx"),
    'import type { Metadata } from "next";\nimport "./globals.css";\n\n' +
      "export const metadata: Metadata = { title: \"Smoke\" };\n\n" +
      'export default function RootLayout({ children }: LayoutProps<"/">) {\n' +
      '  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n'
  );
  // The package manager is detected from the lockfile, and it decides whether
  // a client.test.ts gets written at all — so a bun-shaped fixture is the only
  // way to exercise that template.
  if (lockfile === "bun") {
    fs.writeFileSync(path.join(dir, "bun.lock"), '{\n  "lockfileVersion": 1,\n  "workspaces": {}\n}\n');
  }
  return dir;
}

/**
 * Type-checks a generated project against the CLI's own node_modules.
 *
 * This is the check nothing else makes. Every assertion above reads the
 * generated files as text, so a template that emits `useStat` instead of
 * `useState` passes all of them — and that class of bug reached a real project
 * once, caught only by running `next build` by hand.
 *
 * What it does NOT check: whether package.json *declares* the dependencies the
 * code imports. The fixture borrows this repo's node_modules, so an import
 * resolves here even when the CLI forgot to add the package — the explicit
 * dependency assertions cover that, and `test:integration` (a real install)
 * covers a declared range that does not resolve. Three checks, three different
 * failures; none of them subsumes another.
 *
 * The project's own node_modules is never installed: a symlink to this repo's
 * is enough for tsc, which is why the frontend types are devDependencies here.
 * A separate tsconfig so the one init wrote stays intact for the assertions.
 */
const cliRoot = path.join(import.meta.dirname, "..");

/**
 * Points a fixture at this repo's node_modules.
 *
 * The fixtures are in a temp directory, so nothing resolves by walking up —
 * neither tsc looking for react's types nor steiger looking for its own
 * plugin. One symlink gives both.
 */
function linkModules(dir) {
  const modules = path.join(dir, "node_modules");
  if (!fs.existsSync(modules)) {
    // "junction" on Windows: a directory symlink there needs elevation or
    // Developer Mode, a junction needs neither. Both want an absolute target.
    fs.symlinkSync(path.join(cliRoot, "node_modules"), modules, process.platform === "win32" ? "junction" : "dir");
  }
}

/**
 * Runs the real steiger over a fixture, with the config the CLI wrote.
 *
 * The rest of this file reads generated files and asserts on their contents,
 * which cannot tell a working config from an inert one: a rule name the plugin
 * does not have, or a severity that turns out to be wrong, both read fine.
 * That gap shipped a regression once — the integration test caught it, but
 * only in CI, an install and ninety seconds later.
 */
function steiger(dir) {
  linkModules(dir);
  // spawnSync, not execFileSync: steiger prints its findings to stderr and
  // exits 0 for a warning, so the stdout a successful execFileSync returns is
  // empty either way — a check reading that would pass on a linter that said
  // nothing at all.
  const run = spawnSync(
    process.execPath,
    [path.join(cliRoot, "node_modules", "steiger", "dist", "cli.mjs"), "./src"],
    { cwd: dir, encoding: "utf8" }
  );
  return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

function typecheck(dir, label) {
  linkModules(dir);

  // Next writes route-prop types into .next/types during a build; declared
  // here so a typecheck does not need a build to have happened first.
  fs.writeFileSync(
    path.join(dir, "next-shims.d.ts"),
    "declare type LayoutProps<_T extends string = string> = { children: React.ReactNode };\n"
  );
  fs.writeFileSync(
    path.join(dir, "tsconfig.typecheck.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "dom.iterable", "esnext"],
          jsx: "react-jsx",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          esModuleInterop: true,
          isolatedModules: true,
          types: ["node", "react", "bun"],
          paths: { "@/*": ["./src/*", "./*"] },
        },
        // steiger.config.ts and eslint.fsd.mjs import the generated project's
        // own devDependencies, not this repo's — out of scope for this check.
        include: ["app/**/*.ts", "app/**/*.tsx", "src/**/*.ts", "src/**/*.tsx", "next-shims.d.ts"],
        exclude: ["node_modules", "steiger.config.ts", "eslint.fsd.mjs"],
      },
      null,
      2
    )
  );

  check(`generated TypeScript compiles (${label})`, () => {
    try {
      // node + TypeScript's own entry point, not node_modules/.bin/tsc: that
      // shim is an extensionless shell script, which execFileSync cannot run
      // on Windows (the runnable one there is tsc.CMD). Resolving the .js and
      // handing it to this node works the same way everywhere.
      execFileSync(process.execPath, [TSC, "-p", "tsconfig.typecheck.json"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // Both streams are empty when the spawn itself failed rather than the
      // compile — reporting only them turned "could not run tsc" into a
      // blank "tsc reported:" that named nothing.
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
      throw new Error(`tsc reported:\n${output || `(no output) ${error.code ?? ""} ${error.message}`.trim()}`);
    }
  });
}

function cli(dir, args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Runs a command that is expected to fail, and returns what it printed. */
function cliFails(dir, args) {
  try {
    cli(dir, args);
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  throw new Error(`\`${args.join(" ")}\` was expected to fail, but succeeded`);
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");

/** Every generated text file in a fixture, node_modules aside. */
function* walkGenerated(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") yield* walkGenerated(full);
    } else if (/\.(ts|tsx|mjs|json|css|md)$/.test(entry.name)) {
      yield full;
    }
  }
}
const has = (dir, file) => fs.existsSync(path.join(dir, file));

function assertFiles(dir, files) {
  const missing = files.filter((file) => !has(dir, file));
  assert.deepEqual(missing, [], `missing: ${missing.join(", ")}`);
}

// ---------------------------------------------------------------- app/ layout

console.log("\nroot app/ layout, Thai copy");
const a = fixture(path.join(root, "a"));

const initOutput = cli(a, ["init", "--no-install", "--defaults"]);
check("Thai copy warns that the stock font stack has no Thai coverage", () => {
  // Found only by rendering the login page: create-next-app leaves
  // `font-family: Arial, Helvetica, sans-serif` on body, so Thai falls back
  // per glyph to whatever the OS picks.
  assert.match(initOutput, /font stack cannot render it/);
  assert.match(initOutput, /Noto_Sans_Thai/);
});
check("init writes the layer, linter, shadcn and agent files", () =>
  assertFiles(a, [
    "src/_app/styles/globals.css",
    "steiger.config.ts",
    "eslint.fsd.mjs",
    "components.json",
    "docs/fsd.md",
    ".agents/skills/nextjs-fsd/SKILL.md",
    ".agents/skills/feature-sliced-design/SKILL.md",
    "AGENTS.md",
    "nextjs-fsd.config.json",
  ])
);
check("the FSD methodology skill ships with its references", () => {
  assertFiles(a, [".agents/skills/feature-sliced-design/references/framework-integration.md"]);
  assert.match(
    read(a, ".agents/skills/feature-sliced-design/references/framework-integration.md"),
    /## Next\.js/
  );
});
check("the methodology skill is copied verbatim, never rendered", () =>
  // Handlebars would read this Vue example as an expression and render it to
  // nothing — a doc that silently loses the line it was demonstrating.
  assert.match(
    read(a, ".agents/skills/feature-sliced-design/references/cross-import-patterns.md"),
    /{{ comment\.text }}/
  )
);
check("the skill carries frontmatter and defers FSD theory to the FSD skill", () => {
  const skill = read(a, ".agents/skills/nextjs-fsd/SKILL.md");
  // Line-ending agnostic on purpose: what this asserts is the frontmatter, and
  // a CRLF checkout is a separate failure with its own check below — one
  // assertion should not fail for the other's reason.
  assert.match(skill, /^---\r?\nname: nextjs-fsd\r?\ndescription: >/);
  assert.match(skill, /nextjs-fsd\.config\.json/);
  assert.match(skill, /feature-sliced-design` skill/);
  // The commands it tells an agent to run have to be the ones that exist.
  for (const command of ["generate page", "generate slice", "generate layout", "add error-handling", "add auth"]) {
    assert.match(skill, new RegExp(`nextjs-fsd ${command.replace(" ", " ")}`), command);
  }
});
check("AGENTS.md points at both the doc and the skill", () => {
  const agents = read(a, "AGENTS.md");
  assert.match(agents, /docs\/fsd\.md/);
  assert.match(agents, /\.agents\/skills\/nextjs-fsd\/SKILL\.md/);
});
check(".claude/skills reaches the same file, without a second copy to keep current", () => {
  const link = path.join(a, ".claude", "skills", "nextjs-fsd");
  assert.equal(read(a, ".claude/skills/nextjs-fsd/SKILL.md"), read(a, ".agents/skills/nextjs-fsd/SKILL.md"));
  // A symlink everywhere it is allowed; the Windows fallback writes a real
  // copy, and that is the only case where two files exist.
  if (process.platform !== "win32") assert.ok(fs.lstatSync(link).isSymbolicLink());
});
check("the stylesheet moved rather than being copied", () => assert.ok(!has(a, "app/globals.css")));
check("@source lands below @import, where Tailwind reads it", () => {
  const lines = read(a, "src/_app/styles/globals.css").split("\n");
  assert.ok(lines.indexOf('@import "tailwindcss";') < lines.indexOf('@source "../../../app";'));
});
check("the root layout imports the moved stylesheet", () =>
  assert.match(read(a, "app/layout.tsx"), /import "@\/_app\/styles\/globals\.css";/)
);
check("srcDir goes first in the tsconfig alias, root kept as a fallback", () =>
  assert.deepEqual(JSON.parse(read(a, "tsconfig.json")).compilerOptions.paths["@/*"], ["./src/*", "./*"])
);
check("insignificant-slice is a warning, so a fresh slice does not fail lint", () => {
  // At default severity steiger errors on any slice with one consumer, which
  // is every slice on the day it is created — `lint` would fail on the
  // structure FSD's own guidance recommends starting from. Only the
  // integration test can catch this: it installs the plugin and runs lint for
  // real, where the smoke test only reads the config it wrote.
  assert.match(read(a, "steiger.config.ts"), /"fsd\/insignificant-slice": "warn"/);
});
check("both linters are chained into lint", () =>
  assert.equal(JSON.parse(read(a, "package.json")).scripts.lint, "eslint && steiger ./src")
);
check("the eslint config spreads the boundary under a named default", () => {
  const config = read(a, "eslint.config.mjs");
  assert.match(config, /import fsdBoundary from "\.\/eslint\.fsd\.mjs";/);
  assert.match(config, /export default fsdEslintConfig;/);
});
check("shadcn is aimed at shared/ui, not ./components/ui", () =>
  assert.equal(JSON.parse(read(a, "components.json")).aliases.ui, "@/shared/ui")
);
check("a second init refuses instead of re-running", () =>
  assert.match(cliFails(a, ["init", "--defaults"]), /already a nextjs-fsd project/)
);

cli(a, ["add", "auth", "--no-install", "-y"]);
check("add auth pulls in error handling first", () =>
  assertFiles(a, [
    "src/shared/api/client.ts",
    "src/shared/api/error-catalog.ts",
    "src/shared/auth/access-token.ts",
    "src/shared/auth/session.ts",
    "src/shared/ui/form-error.tsx",
    "src/_app/providers/index.tsx",
    "src/_pages/login/index.ts",
    "src/_pages/login/index.server.ts",
    "src/_pages/login/ui/login-form.tsx",
    "app/login/page.tsx",
    ".env.example",
  ])
);
check("the login slice splits its public API like a generated page with a leaf", () => {
  assert.match(read(a, "src/_pages/login/index.ts"), /export \{ LoginForm \}/);
  assert.match(read(a, "src/_pages/login/index.server.ts"), /export \{ LoginPage, metadata \}/);
  assert.match(read(a, "app/login/page.tsx"), /from "@\/_pages\/login\/index\.server";/);
});
check("<Providers> wraps the JSX children, not the destructured parameter", () => {
  const layout = read(a, "app/layout.tsx");
  assert.match(layout, /RootLayout\(\{ children \}: LayoutProps<"\/">\)/);
  assert.match(layout, /<body><Providers>\{children\}<\/Providers><\/body>/);
});
check("the catalog carries Thai copy by default", () =>
  assert.match(read(a, "src/shared/api/error-catalog.ts"), /VALIDATION_ERROR: "ข้อมูล/)
);
check("the Thai typography rules ship with a Thai project only", () => {
  // Tone marks stack and a latin-subset mono face has no Thai glyph — true
  // wherever Thai is rendered, noise in a project that renders none.
  assert.match(read(a, "docs/fsd.md"), /Thai copy renders differently/);
  assert.match(read(a, ".agents/skills/nextjs-fsd/SKILL.md"), /nothing Thai inside/);
});
check("both features are recorded, and the one not installed yet is not", () =>
  assert.deepEqual(JSON.parse(read(a, "nextjs-fsd.config.json")).features, {
    errorHandling: true,
    auth: true,
    prettier: false,
  })
);
check("a second add auth refuses", () =>
  assert.match(cliFails(a, ["add", "auth", "-y"]), /already installed/)
);

// ------------------------------------------------------------------- generate

console.log("\ngenerate");
cli(a, ["generate", "page", "dashboard", "--auth", "--errors", "--route", "(admin)/dashboard", "--defaults"]);
check("a page slice, its leaf, its catalog and its route file", () =>
  assertFiles(a, [
    "src/_pages/dashboard/index.ts",
    "src/_pages/dashboard/index.server.ts",
    "src/_pages/dashboard/ui/dashboard-page.tsx",
    "src/_pages/dashboard/ui/dashboard-content.tsx",
    "src/_pages/dashboard/model/dashboard-errors.ts",
    "app/(admin)/dashboard/page.tsx",
  ])
);
check("the route file re-exports metadata too, not just default", () =>
  assert.match(
    read(a, "app/(admin)/dashboard/page.tsx"),
    /export \{ DashboardPage as default, metadata \} from "@\/_pages\/dashboard\/index\.server";/
  )
);
check("a page with a client leaf splits its public API in two", () => {
  // index.ts is the client-safe half: any Client Component importing the slice
  // must not pull the server component into the client graph.
  assert.match(read(a, "src/_pages/dashboard/index.ts"), /export \{ DashboardContent \}/);
  assert.doesNotMatch(read(a, "src/_pages/dashboard/index.ts"), /DashboardPage/);
  assert.doesNotMatch(read(a, "src/_pages/dashboard/index.ts"), /^export \{[^}]*metadata/m);
  // index.server.ts is the server-only half the route file imports.
  assert.match(
    read(a, "src/_pages/dashboard/index.server.ts"),
    /export \{ DashboardPage, metadata \} from "\.\/ui\/dashboard-page";/
  );
});
check("a server-only page keeps the single-entry public API", () => {
  cli(a, ["generate", "page", "plain", "--defaults"]);
  assert.match(read(a, "src/_pages/plain/index.ts"), /export \{ PlainPage, metadata \}/);
  assert.match(read(a, "app/plain/page.tsx"), /from "@\/_pages\/plain";/);
  assert.ok(!has(a, "src/_pages/plain/index.server.ts"), "a server-only page needs no index.server.ts");
});
check("--auth puts the guard on the client leaf, not the page", () => {
  assert.match(read(a, "src/_pages/dashboard/ui/dashboard-content.tsx"), /"use client";[\s\S]*useRequireSession/);
  // The page's comment mentions "use client"; only a leading directive counts.
  assert.doesNotMatch(read(a, "src/_pages/dashboard/ui/dashboard-page.tsx"), /^\s*"use client";/);
});
check("re-generating a page adds nothing and says so", () => {
  const before = read(a, "src/_pages/dashboard/index.ts");
  assert.match(cliFails(a, ["generate", "page", "dashboard", "--defaults"]), /already has everything/);
  assert.equal(read(a, "src/_pages/dashboard/index.ts"), before);
});
check("extending a page routed from a group does not add a second route file", () => {
  // app/settings/page.tsx and app/(admin)/settings/page.tsx both resolve to
  // /settings, which Next.js rejects at build time — so extending has to find
  // the route where it actually is, not where the default would have put it.
  cli(a, ["generate", "page", "settings", "--route", "(admin)/settings", "--defaults"]);
  const output = cli(a, ["generate", "page", "settings", "--client", "--defaults"]);
  assert.match(output, /already routed from app\/\(admin\)\/settings\/page\.tsx/);
  assert.ok(has(a, "src/_pages/settings/ui/settings-content.tsx"), "the new leaf was not written");
  assert.ok(has(a, "src/_pages/settings/index.server.ts"), "the server-only entry was not written");
  assert.match(output, /finish the split by hand/);
  assert.ok(!has(a, "app/settings/page.tsx"), "a duplicate route was written");
  assert.ok(!has(a, "app/dashboard/page.tsx"), "a duplicate route was written");
});

cli(a, ["generate", "slice", "features", "loan-application", "--segments", "ui", "--defaults"]);
check("a slice gets only the segments asked for", () => {
  assertFiles(a, ["src/features/loan-application/index.ts", "src/features/loan-application/ui/loan-application.tsx"]);
  assert.ok(!has(a, "src/features/loan-application/model"), "model/ should not exist");
});

cli(a, ["generate", "slice", "features", "loan-application", "--segments", "ui,model,api", "--defaults"]);
check("a segment can be added to a slice that already exists", () =>
  assertFiles(a, ["src/features/loan-application/model/loan-application.ts", "src/features/loan-application/api/loan-application.ts"])
);

cli(a, ["generate", "slice", "features", "loan-application", "--segments", "config", "--defaults"]);
check("a config segment carries the slice's flags and joins the public API", () => {
  assertFiles(a, ["src/features/loan-application/config/loan-application.ts"]);
  assert.match(
    read(a, "src/features/loan-application/index.ts"),
    /export \{ loanApplicationConfig \} from "\.\/config\/loan-application";/
  );
});

cli(a, ["generate", "page", "alpha", "beta", "--defaults"]);
check("several pages generate in one command, each routed by its own name", () =>
  assertFiles(a, ["src/_pages/alpha/index.ts", "app/alpha/page.tsx", "src/_pages/beta/index.ts", "app/beta/page.tsx"])
);
check("--route with several pages is refused instead of guessing", () =>
  assert.match(cliFails(a, ["generate", "page", "alpha", "beta", "--route", "x", "--defaults"]), /only one page/)
);

cli(a, ["generate", "slice", "f", "employee/employee-record", "--segments", "ui,config", "--defaults"]);
check("a slice group nests under its group, files named for the slice", () => {
  assertFiles(a, [
    "src/features/employee/employee-record/index.ts",
    "src/features/employee/employee-record/ui/employee-record.tsx",
    "src/features/employee/employee-record/config/employee-record.ts",
  ]);
  assert.match(
    read(a, "src/features/employee/employee-record/index.ts"),
    /export \{ EmployeeRecord \} from "\.\/ui\/employee-record";/
  );
});

cli(a, ["generate", "slice", "entities", "ledger-account", "-r", "src/domain", "--segments", "ui", "--defaults"]);
cli(a, ["generate", "page", "vault", "--root", "src/domain", "--defaults"]);
check("--root puts slices under another FSD root with matching imports", () => {
  assertFiles(a, [
    "src/domain/entities/ledger-account/index.ts",
    "src/domain/_pages/vault/index.ts",
    "app/vault/page.tsx",
  ]);
  assert.match(read(a, "app/vault/page.tsx"), /from "@\/domain\/_pages\/vault";/);
});
check("--root outside src/ is refused instead of writing unresolvable imports", () =>
  assert.match(cliFails(a, ["generate", "slice", "entities", "x", "-r", "other", "--defaults"]), /must stay inside src/)
);
check("index.ts gains the new exports and keeps the old one", () => {
  const barrel = read(a, "src/features/loan-application/index.ts");
  assert.match(barrel, /export \{ LoanApplication \} from "\.\/ui\/loan-application";/);
  assert.match(barrel, /export \{ useLoanApplication \} from "\.\/model\/loan-application";/);
  assert.match(barrel, /useCreateLoanApplication/);
  assert.equal(barrel.split("\n").filter((line) => line.includes("./ui/loan-application")).length, 1);
});
check("the record type does not collide with the ui component's name", () => {
  // ui/<name>.tsx exports `LoanApplication` (a component) and api/<name>.ts a
  // record type. One index.ts cannot re-export both under one name — TS2300 —
  // and a type unreachable through the public API cannot be annotated against
  // without breaking the import boundary the eslint rules enforce.
  const api = read(a, "src/features/loan-application/api/loan-application.ts");
  assert.match(api, /export type LoanApplicationRecord = /);
  assert.doesNotMatch(api, /export type LoanApplication = /);
  const barrel = read(a, "src/features/loan-application/index.ts");
  assert.match(barrel, /type LoanApplicationRecord/);
  assert.match(barrel, /export \{ LoanApplication \} from "\.\/ui\/loan-application";/);
});
check("the api segment carries a mutation that invalidates its key", () => {
  const api = read(a, "src/features/loan-application/api/loan-application.ts");
  assert.match(api, /useMutation/);
  assert.match(api, /invalidateQueries\(\{ queryKey: loanApplicationKey \}\)/);
});
check("extending with nothing new says so instead of writing", () =>
  assert.match(
    cliFails(a, ["generate", "slice", "features", "loan-application", "--segments", "ui,model", "--defaults"]),
    /already has every segment/
  )
);
check("the api segment is refused without error handling", () => {
  const bare = fixture(path.join(root, "bare"));
  cli(bare, ["init", "--no-install", "--defaults"]);
  assert.match(
    cliFails(bare, ["generate", "slice", "features", "x", "--segments", "api", "--defaults"]),
    /needs the error-handling feature/
  );
});

cli(a, ["generate", "layout", "admin", "--defaults"]);
check("a layout lands in _app/layouts with a route-group layout.tsx", () => {
  assertFiles(a, ["src/_app/layouts/admin-layout.tsx", "src/_app/layouts/index.ts", "app/(admin)/layout.tsx"]);
  assert.match(read(a, "app/(admin)/layout.tsx"), /export \{ AdminLayout as default \}/);
  assert.match(read(a, "src/_app/layouts/index.ts"), /export \{ AdminLayout \}/);
});

const guarded = cli(a, ["generate", "layout", "portal", "--guard", "--defaults"]);
check("--guard puts the one useRequireSession in the shell, and the layout renders it", () => {
  assertFiles(a, ["src/_app/layouts/portal-guard.tsx", "src/_app/layouts/portal-layout.tsx"]);
  assert.match(read(a, "src/_app/layouts/portal-guard.tsx"), /useRequireSession/);
  assert.match(read(a, "src/_app/layouts/portal-layout.tsx"), /<PortalGuard>\{children\}<\/PortalGuard>/);
  assert.doesNotMatch(guarded, /\{\{/);
});
check("a page that would guard itself under a guarded shell is told", () =>
  assert.match(
    cli(a, ["generate", "page", "portal-home", "--auth", "--route", "(portal)/home", "--defaults"]),
    /already guards the routes under it/
  )
);
cli(a, ["generate", "page", "invoices", "--model", "--defaults"]);
check("--model is a legacy alias for --api, and both land in api/", () => {
  const api = read(a, "src/_pages/invoices/api/invoices.ts");
  assert.match(api, /export const invoicesKey = \["invoices"\] as const;/);
  assert.match(api, /invalidateQueries\(\{ queryKey: invoicesKey \}\)/);
  assert.ok(!has(a, "src/_pages/invoices/model/invoices.ts"), "query hooks do not belong in model/");
  // The public API of a page is the page. Hooks are the slice's own business,
  // imported relatively from its ui/.
  assert.doesNotMatch(read(a, "src/_pages/invoices/index.ts"), /invoicesKey/);
});
cli(a, ["generate", "page", "ledger", "--api", "--defaults"]);
check("--api gives a page its query hooks in api/", () =>
  assertFiles(a, ["src/_pages/ledger/api/ledger.ts"])
);
check("--guard is refused without auth", () => {
  const bare = fixture(path.join(root, "guard-bare"));
  cli(bare, ["init", "--no-install", "--defaults"]);
  assert.match(
    cliFails(bare, ["generate", "layout", "admin", "--guard", "--defaults"]),
    /needs the auth feature/
  );
});

cli(a, ["generate", "api-route", "health", "--defaults"]);
check("an api route lands in _app/api-routes with a route.ts that serves it", () =>
  assertFiles(a, ["src/_app/api-routes/health.ts", "src/_app/api-routes/index.ts", "app/api/health/route.ts"])
);
check("the route.ts is a re-export and the barrel carries the handler", () => {
  assert.match(read(a, "app/api/health/route.ts"), /export \{ getHealth as GET \} from "@\/_app\/api-routes";/);
  assert.match(read(a, "src/_app/api-routes/index.ts"), /export \{ getHealth \} from "\.\/health";/);
  assert.match(read(a, "src/_app/api-routes/health.ts"), /export async function getHealth/);
});
check("re-running an api route adds nothing and says so", () =>
  assert.match(
    cliFails(a, ["generate", "api-route", "health", "--defaults"]),
    /already served from app\/api\/health\/route\.ts/
  )
);
check("one handler can serve a second URL when asked", () => {
  const output = cli(a, ["generate", "api-route", "health", "--route", "v1/health", "--defaults"]);
  assert.ok(has(a, "app/v1/health/route.ts"), "the second route was not written");
  // "Serves:" alone: the word is wrapped in bold codes, so a regex spanning
  // into the URL would only match where colors are off. The file existing
  // above plus this branch label is the assertion.
  assert.match(output, /Serves:/);
  assert.match(
    cliFails(a, ["generate", "api-route", "health", "--route", "v1/health", "--defaults"]),
    /already served from/
  );
});

// -------------------------------------------------------------- src/app/ + en

console.log("\nsrc/app/ layout, English copy");
const b = fixture(path.join(root, "b"), { srcApp: true });
cli(b, ["init", "--locale", "en", "--no-install", "--defaults"]);
cli(b, ["add", "auth", "--no-install", "-y"]);
check("appDir is detected as src/app", () =>
  assert.equal(JSON.parse(read(b, "nextjs-fsd.config.json")).appDir, "src/app")
);
check("@source is relative to the real app dir", () =>
  assert.match(read(b, "src/_app/styles/globals.css"), /@source "\.\.\/\.\.\/app";/)
);
check("the already-correct tsconfig alias is left alone", () =>
  assert.deepEqual(JSON.parse(read(b, "tsconfig.json")).compilerOptions.paths["@/*"], ["./src/*", "./*"])
);
check("English copy is used throughout", () => {
  assert.match(read(b, "src/shared/api/error-catalog.ts"), /VALIDATION_ERROR: "Some fields are invalid/);
  assert.match(read(b, "src/_pages/login/ui/login-page.tsx"), /Sign in/);
  // …and the Thai typography rules stay out of a project that renders none.
  assert.doesNotMatch(read(b, "docs/fsd.md"), /Thai copy renders differently/);
});
check("the login route lands under src/app", () => assert.ok(has(b, "src/app/login/page.tsx")));

// ------------------------------------------------------------------ bun shape

console.log("\nbun project");
const c = fixture(path.join(root, "c"), { lockfile: "bun" });
cli(c, ["init", "--no-install", "--defaults"]);
cli(c, ["add", "error-handling", "--no-install", "-y"]);
check("error handling leaves shared/auth with a public API, not a lone file", () => {
  // A segment holding one file and no index.ts is a steiger error — and `add
  // auth` may not run for months. The export is appended, so a project with
  // its own index.ts keeps it.
  assert.match(read(c, "src/shared/auth/index.ts"), /export \{ getAccessToken, setAccessToken \}/);
});
check("a bun project gets the refresh test and the types it needs to compile", () => {
  // Nothing else covers this template: the package manager is read from the
  // lockfile, so the npm-shaped fixtures above never generate it — and this is
  // the file that broke `next build` for want of @types/bun.
  assert.ok(has(c, "src/shared/api/client.test.ts"));
  const pkg = JSON.parse(read(c, "package.json"));
  assert.ok(pkg.devDependencies["@types/bun"], "@types/bun was not added");
  assert.equal(pkg.scripts.test, "bun test");
  assert.match(read(c, "src/shared/api/client.test.ts"), /from "bun:test"/);
});
check("an npm project gets neither the test nor the bun types", () => {
  assert.ok(!has(a, "src/shared/api/client.test.ts"));
  assert.ok(!has(a, "src/shared/auth/require-session.test.ts"));
  assert.ok(!JSON.parse(read(a, "package.json")).devDependencies?.["@types/bun"]);
});

cli(c, ["add", "auth", "--no-install", "-y"]);
check("a bun project gets the ?next= guard test too", () => {
  // The other fixtures are npm-shaped, so this is the only place the auth
  // test template is written at all — and the only place tsc sees it.
  assert.match(read(c, "src/shared/auth/require-session.test.ts"), /from "bun:test"/);
  assert.match(read(c, "src/shared/auth/require-session.test.ts"), /safeNext/);
  // Installed error handling first, so the access-token line was appended —
  // and installing auth on top kept it instead of duplicating it.
  const barrel = read(c, "src/shared/auth/index.ts");
  assert.match(barrel, /export \{ getAccessToken, setAccessToken \}/);
  assert.match(barrel, /export \{ sessionKey, useLogin, useLogout, useSession/);
  assert.equal(barrel.match(/from "\.\/access-token"/g).length, 1);
});
check("the login form picks ?next= back up instead of always landing home", () =>
  assert.match(read(c, "src/_pages/login/ui/login-form.tsx"), /router\.replace\(safeNext\(/)
);
check("a logout leaves the page from the one place that ends the session", () => {
  // Clearing the cache does not re-render a component that is not otherwise
  // re-rendering, so a redirect left to each call site is one a call site
  // forgets: the shell keeps drawing the session it had already read.
  const session = read(c, "src/shared/auth/session.ts");
  assert.match(session, /router\.replace\("\/login"\)/);
  assert.equal(session.match(/router\.replace/g).length, 1);
});
check("someone already signed in is sent past the login form", () =>
  assert.match(read(c, "src/_pages/login/ui/login-form.tsx"), /if \(session\.isSuccess\) signedIn\(\)/)
);
check("a 401 from anywhere resets the session entry rather than removing it", () => {
  const queryClient = read(c, "src/shared/api/query-client.ts");
  // removeQueries does not notify the observers mounted on the entry, so a
  // sidebar or a guard that was not re-rendering goes on showing a session
  // that is over, and nothing ever sees isError.
  assert.match(queryClient, /resetQueries\(\{ queryKey: sessionKey \}\)/);
  // The call, not the prose: the comment above it names removeQueries to say
  // why it is wrong.
  assert.doesNotMatch(queryClient, /client\.removeQueries/);
  assert.match(queryClient, /export const sessionKey/);
  assert.match(queryClient, /mutationCache: new MutationCache/);
  // shared/auth may not exist at all (error handling installs alone), so the
  // key has to live here and be imported back, never the other way round.
  // The prose above it says so; only an import would be the bug.
  assert.doesNotMatch(queryClient, /^import .*shared\/auth/m);
});

// ---------------------------------------------------------------- vitest shape

console.log("\nvitest project");
const v = fixture(path.join(root, "v"), { vitest: true });
cli(v, ["init", "--no-install", "--defaults"]);
cli(v, ["add", "error-handling", "--no-install", "-y"]);
check("a vitest project gets the refresh test with vitest imports", () => {
  // No bun lockfile, so this is the only place the vitest rendering is
  // exercised — and it is rendering only: vitest is declared but never
  // installed here, so no typecheck runs over this fixture.
  assert.match(read(v, "src/shared/api/client.test.ts"), /from "vitest"/);
  assert.ok(!JSON.parse(read(v, "package.json")).devDependencies?.["@types/bun"]);
});
cli(v, ["add", "auth", "--no-install", "-y"]);
check("a vitest project gets the ?next= guard test with vitest imports", () => {
  assert.match(read(v, "src/shared/auth/require-session.test.ts"), /from "vitest"/);
  assert.match(read(v, "src/shared/auth/require-session.test.ts"), /safeNext/);
});

// ------------------------------------------------------------------- hooks

console.log("\ncommit-msg hook");
const g = fixture(path.join(root, "g"));
execFileSync("git", ["init", "-q"], { cwd: g, stdio: "ignore" });
cli(g, ["init", "--no-install", "--defaults"]);
check("a repository gets the hook, and git is pointed at it", () => {
  assertFiles(g, [".githooks/commit-msg"]);
  assert.equal(
    execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: g, encoding: "utf8" }).trim(),
    ".githooks"
  );
  assert.match(read(g, "AGENTS.md"), /Conventional Commits/);
});
check("the generated hook refuses a subject that is not a Conventional Commit", () => {
  // Shape only: the language and the emoji are the project's call, and this
  // is the half that is the same everywhere.
  if (process.platform === "win32") return; // no POSIX sh to run it with
  const hook = path.join(g, ".githooks", "commit-msg");
  const message = path.join(g, "msg.txt");
  const run = (subject) => {
    fs.writeFileSync(message, `${subject}\n`);
    try {
      execFileSync("sh", [hook, message], { cwd: g, stdio: "ignore" });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(run("feat(login): add the MFA step"), 0);
  assert.equal(run("feat: ✨ เพิ่มหน้าเข้าสู่ระบบ"), 0, "language and emoji are not this hook's business");
  assert.equal(run("0.2.0"), 0, "a release commit is the bare version");
  assert.equal(run("wip"), 1);
});
check("a project with husky keeps its own hooks path", () => {
  const h = fixture(path.join(root, "h"));
  execFileSync("git", ["init", "-q"], { cwd: h, stdio: "ignore" });
  fs.mkdirSync(path.join(h, ".husky"));
  cli(h, ["init", "--no-install", "--defaults"]);
  // husky points core.hooksPath at .husky itself; taking that over would turn
  // every hook it manages off.
  assertFiles(h, [".husky/commit-msg"]);
  assert.ok(!has(h, ".githooks/commit-msg"));
  assert.throws(() =>
    execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: h, stdio: "ignore" })
  );
});
check("no repository means no hook, and no commit section in AGENTS.md", () => {
  // Fixture `a` is a plain directory: create-next-app makes a repo, a
  // monorepo workspace does not have one of its own.
  assert.ok(!has(a, ".githooks/commit-msg"));
  assert.doesNotMatch(read(a, "AGENTS.md"), /Conventional Commits/);
});

// ------------------------------------------------------------- brownfield

console.log("\ninit over a project that already has rules of its own");
const d = fixture(path.join(root, "d"));
fs.writeFileSync(path.join(d, "steiger.config.ts"), "export default [];\n");
fs.mkdirSync(path.join(d, "docs"), { recursive: true });
fs.writeFileSync(path.join(d, "docs", "fsd.md"), "# ours\n");
fs.writeFileSync(
  path.join(d, "eslint.config.mjs"),
  'import { defineConfig } from "eslint/config";\n\n' +
    'const eslintConfig = defineConfig([{ rules: { "no-restricted-imports": ["error", { patterns: [] }] } }]);\n\n' +
    "export default eslintConfig;\n"
);
const brownfield = cli(d, ["init", "--no-install", "--defaults"]);
check("init writes what is missing instead of refusing over what is there", () => {
  // It used to throw on the first collision and write nothing at all, which is
  // the worst answer for the one command that runs on somebody else's work.
  assert.equal(read(d, "steiger.config.ts"), "export default [];\n");
  assert.equal(read(d, "docs/fsd.md"), "# ours\n");
  assertFiles(d, ["nextjs-fsd.config.json", "src/_app/styles/globals.css", "components.json"]);
  assert.match(brownfield, /left alone: steiger\.config\.ts/);
  assert.match(brownfield, /left alone: docs\/fsd\.md/);
});
check("a project with its own import rules does not get a second set", () => {
  // Flat config replaces a rule's options when a later block matches the same
  // file, so two sets do not add up — the last one to match wins, silently.
  assert.ok(!has(d, "eslint.fsd.mjs"));
  assert.doesNotMatch(read(d, "eslint.config.mjs"), /fsdBoundary/);
  assert.match(brownfield, /left alone: eslint\.fsd\.mjs/);
});

// ------------------------------------------------- the generated lint config

console.log("\nsteiger, for real");
check("a generated project passes the steiger config the CLI wrote it", () => {
  const { status, output } = steiger(a);
  assert.equal(status, 0, output);
});
check("insignificant-slice warns on a one-consumer slice instead of failing lint", () => {
  // A slice with one reference is every slice on the day it is created, and
  // at the rule's default severity that is a failed lint on brand-new code.
  // The config turns it down to a warning; this is the check that the turning
  // down still works, which reading the config file cannot tell you.
  //
  // Zero references is a different case the rule says nothing about, which is
  // why the import below has to exist for this to mean anything.
  const content = path.join(a, "src", "_pages", "dashboard", "ui", "dashboard-content.tsx");
  const before = fs.readFileSync(content, "utf8");
  fs.writeFileSync(content, `import { LoanApplication } from "@/features/loan-application";\n${before}\nexport const used = LoanApplication;\n`);
  try {
    const { status, output } = steiger(a);
    assert.match(output, /insignificant-slice/);
    assert.match(output, /warning/);
    assert.equal(status, 0, "a warning must not fail lint");
  } finally {
    fs.writeFileSync(content, before);
  }
});

// ------------------------------------------------------- typecheck the output

console.log("\ntypecheck");
typecheck(a, "app/, thai, auth + pages + slices");
typecheck(b, "src/app/, english, auth");
typecheck(c, "bun, error handling + auth + both generated tests");

// --------------------------------------------------------- no unrendered vars

console.log("\nrendered output");
check("generated files use LF, whatever the host OS", () => {
  // Git on Windows checks text files out as CRLF by default, so without a
  // .gitattributes pinning LF the templates arrive with \r\n and the CLI emits
  // it — a generator whose output depends on the host OS produces diffs
  // between developers that are nothing but line endings.
  const crlf = [];
  for (const dir of [a, b, c]) {
    for (const file of walkGenerated(dir)) {
      if (fs.readFileSync(file, "utf8").includes("\r\n")) crlf.push(path.relative(dir, file));
    }
  }
  assert.deepEqual(crlf, [], `CRLF in: ${crlf.join(", ")}`);
});
const prettierOutput = cli(a, ["add", "prettier", "--no-install", "-y"]);
check("add prettier points the plugin at the stylesheet init moved", () => {
  const config = JSON.parse(read(a, ".prettierrc"));
  assert.deepEqual(config.plugins, ["prettier-plugin-tailwindcss"]);
  // The whole reason this is a command: Tailwind v4 has no config file, so the
  // plugin has to be handed the stylesheet — at the path init moved it to.
  assert.equal(config.tailwindStylesheet, "./src/_app/styles/globals.css");
  assert.ok(has(a, `${config.tailwindStylesheet.slice(2)}`), "tailwindStylesheet points at a file that exists");
  assert.deepEqual(config.tailwindFunctions, ["cn", "cva"]);
});
check("add prettier wires format and a check on lint", () => {
  const scripts = JSON.parse(read(a, "package.json")).scripts;
  assert.equal(scripts.format, "prettier --write .");
  assert.match(scripts.lint, /prettier --check \./);
  // Appended, not replaced — eslint and steiger still run.
  assert.match(scripts.lint, /eslint/);
  assert.match(scripts.lint, /steiger/);
});
check("add prettier with --no-install formats nothing and says lint will fail", () => {
  // The pass needs prettier on disk. Without it the honest move is to leave
  // the tree alone and say plainly that lint is red until it runs.
  assert.match(read(a, "steiger.config.ts"), /^import fsd from/m);
  assert.match(prettierOutput, /lint` will fail until the project is formatted/);
});
check("a second add prettier refuses instead of writing an ignored config", () => {
  const output = cliFails(a, ["add", "prettier", "-y"]);
  assert.match(output, /already exists/);
});

check("no template variable survived into any generated file", () => {
  const leaks = [];
  for (const dir of [a, b]) {
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (/\.(ts|tsx|mjs|json|css|md)$/.test(entry.name)) {
          const body = fs.readFileSync(full, "utf8");
          // `{{` never legitimately appears in the output: JSX uses one brace,
          // and no generated file writes a handlebars expression on purpose.
          // Only the methodology skill is exempt — it is copied byte-for-byte,
          // Vue examples and all. `.claude/` holds the symlinked copy of both
          // skills, so it is skipped too.
          const relative = path.relative(dir, full).split(path.sep).join("/");
          if (relative.includes("skills/feature-sliced-design/")) continue;
          if (relative.startsWith(".claude/")) continue;
          if (body.includes("{{")) leaks.push(path.relative(dir, full));
        }
      }
    };
    walk(dir);
  }
  assert.deepEqual(leaks, [], `unrendered template syntax in: ${leaks.join(", ")}`);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nsmoke test passed" : `\nsmoke test: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
