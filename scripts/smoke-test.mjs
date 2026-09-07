// End-to-end: runs the real CLI against a throwaway Next.js project and checks
// what it produced.
//
// The unit tests cover the patchers in isolation; nothing re-ran the actual
// command sequence, so a template that stopped rendering — or started leaking
// `{{alias}}` into its output — would have gone unnoticed until someone
// generated a project by hand. No network and no package install: the fixture
// below is the parts of a create-next-app project this CLI actually reads.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "bin", "nextjs-fsd.js");
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
function fixture(dir, { srcApp = false, lockfile } = {}) {
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
        devDependencies: { typescript: "^5" },
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
function typecheck(dir, label) {
  const cliRoot = path.join(import.meta.dirname, "..");
  const modules = path.join(dir, "node_modules");
  if (!fs.existsSync(modules)) fs.symlinkSync(path.join(cliRoot, "node_modules"), modules, "dir");

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
      execFileSync(path.join(cliRoot, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.typecheck.json"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`tsc reported:\n${(error.stdout ?? "").trim() || (error.stderr ?? "").trim()}`);
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
    ".claude/skills/nextjs-fsd/SKILL.md",
    "AGENTS.md",
    "nextjs-fsd.config.json",
  ])
);
check("the skill carries frontmatter and defers FSD theory to the FSD skill", () => {
  const skill = read(a, ".claude/skills/nextjs-fsd/SKILL.md");
  assert.match(skill, /^---\nname: nextjs-fsd\ndescription: >/);
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
  assert.match(agents, /\.claude\/skills\/nextjs-fsd\/SKILL\.md/);
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
  // structure FSD's own guidance recommends starting from.
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
    "src/_pages/login/ui/login-form.tsx",
    "app/login/page.tsx",
    ".env.example",
  ])
);
check("<Providers> wraps the JSX children, not the destructured parameter", () => {
  const layout = read(a, "app/layout.tsx");
  assert.match(layout, /RootLayout\(\{ children \}: LayoutProps<"\/">\)/);
  assert.match(layout, /<body><Providers>\{children\}<\/Providers><\/body>/);
});
check("the catalog carries Thai copy by default", () =>
  assert.match(read(a, "src/shared/api/error-catalog.ts"), /VALIDATION_ERROR: "ข้อมูล/)
);
check("both features are recorded", () =>
  assert.deepEqual(JSON.parse(read(a, "nextjs-fsd.config.json")).features, { errorHandling: true, auth: true })
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
    "src/_pages/dashboard/ui/dashboard-page.tsx",
    "src/_pages/dashboard/ui/dashboard-content.tsx",
    "src/_pages/dashboard/model/dashboard-errors.ts",
    "app/(admin)/dashboard/page.tsx",
  ])
);
check("the route file re-exports metadata too, not just default", () =>
  assert.match(read(a, "app/(admin)/dashboard/page.tsx"), /export \{ DashboardPage as default, metadata \}/)
);
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
});
check("the login route lands under src/app", () => assert.ok(has(b, "src/app/login/page.tsx")));

// ------------------------------------------------------------------ bun shape

console.log("\nbun project");
const c = fixture(path.join(root, "c"), { lockfile: "bun" });
cli(c, ["init", "--no-install", "--defaults"]);
cli(c, ["add", "error-handling", "--no-install", "-y"]);
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
  assert.ok(!JSON.parse(read(a, "package.json")).devDependencies?.["@types/bun"]);
});

// ------------------------------------------------------- typecheck the output

console.log("\ntypecheck");
typecheck(a, "app/, thai, auth + pages + slices");
typecheck(b, "src/app/, english, auth");
typecheck(c, "bun, error handling + generated test");

// --------------------------------------------------------- no unrendered vars

console.log("\nrendered output");
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
