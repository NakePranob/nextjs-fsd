import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  detectAppDir,
  findRepoRoot,
  patchEslintConfig,
  patchLayoutProviders,
  patchTsconfigPaths,
  writeAgentSkill,
  writeJson,
} from "../dist/utils/project.js";
import { addTailwindSources } from "../dist/commands/init.js";
import { validateSliceName, validateRoute, resolveNaming } from "../dist/utils/naming.js";

// The layout create-next-app@16 writes. `{ children }` appears twice here and
// the first one is the parameter — patching that one is what this pins down.
const NEXT_LAYOUT = `import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "@/_app/styles/globals.css";

export const metadata: Metadata = { title: "Create Next App" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
`;

function tempProject(layout = NEXT_LAYOUT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextjs-fsd-"));
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app", "layout.tsx"), layout);
  return dir;
}

test("wraps the JSX children, not the destructured parameter", () => {
  const dir = tempProject();
  assert.equal(patchLayoutProviders(dir, "app", "@"), "patched");

  const patched = fs.readFileSync(path.join(dir, "app", "layout.tsx"), "utf8");
  assert.match(patched, /RootLayout\(\{ children \}: LayoutProps<"\/">\)/);
  assert.match(patched, /<body className="min-h-full flex flex-col"><Providers>\{children\}<\/Providers><\/body>/);
  assert.match(patched, /^import \{ Providers \} from "@\/_app\/providers";$/m);
  // The import goes after the existing ones, not into the middle of them.
  assert.ok(patched.indexOf('import { Providers }') > patched.indexOf('import "@/_app/styles/globals.css"'));
});

test("second run is a no-op", () => {
  const dir = tempProject();
  patchLayoutProviders(dir, "app", "@");
  const once = fs.readFileSync(path.join(dir, "app", "layout.tsx"), "utf8");
  assert.equal(patchLayoutProviders(dir, "app", "@"), "already");
  assert.equal(fs.readFileSync(path.join(dir, "app", "layout.tsx"), "utf8"), once);
});

test("a layout with no body is reported, not mangled", () => {
  const dir = tempProject(`import x from "y";\nexport default function L({ children }) { return children; }\n`);
  assert.equal(patchLayoutProviders(dir, "app", "@"), "manual");
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "app", "layout.tsx"), "utf8"), /Providers/);
});

test("@source lands below @import, where Tailwind reads it", () => {
  const dir = tempProject();
  const css = path.join(dir, "globals.css");
  fs.writeFileSync(css, `@import "tailwindcss";\n\n:root { --background: #fff; }\n`);
  addTailwindSources(css, "../../../app", "../..");

  const lines = fs.readFileSync(css, "utf8").split("\n");
  assert.ok(lines.indexOf('@import "tailwindcss";') < lines.indexOf('@source "../../../app";'));
  assert.ok(lines.includes('@source "../..";'));
});

test("srcDir goes first in the tsconfig alias, root stays as a fallback", () => {
  const dir = tempProject();
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } })
  );
  assert.equal(patchTsconfigPaths(dir, "@", "src"), true);
  const paths = JSON.parse(fs.readFileSync(path.join(dir, "tsconfig.json"), "utf8")).compilerOptions.paths;
  assert.deepEqual(paths["@/*"], ["./src/*", "./*"]);
  // Idempotent: an already-correct tsconfig is left alone.
  assert.equal(patchTsconfigPaths(dir, "@", "src"), false);
});

test("names that would not compile are rejected before anything is written", () => {
  assert.equal(validateSliceName("reset-password"), true);
  assert.equal(validateSliceName("ResetPassword"), true);
  assert.match(String(validateSliceName("2fa")), /not a valid identifier|starts with a digit/);
  assert.match(String(validateSliceName("!!")), /invalid name/);
  assert.deepEqual(resolveNaming("resetPassword"), {
    name: "reset-password",
    pascal: "ResetPassword",
    camel: "resetPassword",
    screaming: "RESET_PASSWORD",
  });
});

test("App Router route shapes are accepted, junk is not", () => {
  for (const route of ["dashboard", "(admin)/dashboard", "loans/[id]", "docs/[...slug]", ""]) {
    assert.equal(validateRoute(route), true, route);
  }
  assert.match(String(validateRoute("loans/{id}")), /invalid route segment/);
  assert.match(String(validateRoute("my page")), /invalid route segment/);
});

// The flat config create-next-app@16 writes.
const NEXT_ESLINT = `import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([...nextVitals, ...nextTs, globalIgnores([".next/**"])]);

export default eslintConfig;
`;

test("spreads the FSD boundary into the flat config, without an anonymous default", () => {
  const dir = tempProject();
  fs.writeFileSync(path.join(dir, "eslint.config.mjs"), NEXT_ESLINT);
  assert.equal(patchEslintConfig(dir), "patched");

  const patched = fs.readFileSync(path.join(dir, "eslint.config.mjs"), "utf8");
  assert.match(patched, /^import fsdBoundary from "\.\/eslint\.fsd\.mjs";$/m);
  // The import lands after the existing ones, not inside them.
  assert.ok(patched.indexOf("import fsdBoundary") > patched.indexOf("eslint-config-next/typescript"));
  // Named const, because eslint-config-next warns on `export default [...]`.
  assert.match(patched, /const fsdEslintConfig = \[\.\.\.eslintConfig, \.\.\.fsdBoundary\];/);
  assert.match(patched, /export default fsdEslintConfig;/);
  assert.doesNotMatch(patched, /export default \[/);

  assert.equal(patchEslintConfig(dir), "already");
});

test("a restructured eslint config is reported, not mangled", () => {
  const dir = tempProject();
  // No `export default <identifier>` to anchor on.
  const inline = 'import x from "y";\nexport default [...x, { rules: {} }];\n';
  fs.writeFileSync(path.join(dir, "eslint.config.mjs"), inline);
  assert.equal(patchEslintConfig(dir), "manual");
  assert.equal(fs.readFileSync(path.join(dir, "eslint.config.mjs"), "utf8"), inline);
});

test("no flat eslint config at all is its own answer", () => {
  assert.equal(patchEslintConfig(tempProject()), "missing");
});

// The rule this pins down is not "these globs are right" but "there is exactly
// one no-restricted-imports per file group". Flat config replaces a rule's
// options when a later block matches the same file instead of merging them, so
// a second block silently disables the first — and the config still reads as
// though both applied.
test("every generated eslint block configures no-restricted-imports at most once per file group", async () => {
  const { renderTemplate } = await import("../dist/utils/render.js");
  const source = renderTemplate("init/eslint.fsd.mjs.hbs", { srcDir: "src", appDir: "app", alias: "@" });

  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const blocks = module.default;
  assert.ok(blocks.length > 0);

  const seen = new Set();
  for (const block of blocks) {
    assert.ok(block.rules["no-restricted-imports"], "every block carries the rule");
    const key = JSON.stringify(block.files);
    assert.ok(!seen.has(key), `two blocks target ${key} — the later one would win`);
    seen.add(key);
  }

  // Overlap between groups is the same trap: src/features/** must not also be
  // covered by a broader src/** block.
  assert.ok(!blocks.some((block) => block.files.some((glob) => glob === "src/**/*.{ts,tsx}")));
});

test("appDir is posix even on Windows, because it becomes a glob", () => {
  // path.join would give "src\\app" on Windows, and that string is
  // interpolated into ESLint `files` globs and Tailwind `@source` lines, where
  // a backslash matches nothing. The bug is invisible on the filesystem —
  // Windows accepts both separators — and shows up as a lint rule that
  // silently stops applying.
  const dir = tempProject();
  fs.mkdirSync(path.join(dir, "src", "app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app", "layout.tsx"), "export default function L() {}\n");
  fs.rmSync(path.join(dir, "app"), { recursive: true, force: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { next: "16.3.4" } })
  );

  assert.equal(detectAppDir(dir), "src/app");
  assert.doesNotMatch(detectAppDir(dir), /\\\\/);
});

test("editing a JSON file keeps the indentation it already had", () => {
  // package.json belongs to the project's formatter, not to this CLI. Writing
  // it back at 2 spaces reindents a file nobody edited, and the next commit
  // fails a format check on the diff.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextjs-fsd-json-"));
  for (const [label, indent] of [["four spaces", "    "], ["tabs", "\t"]]) {
    const file = path.join(dir, `${label.replace(" ", "-")}.json`);
    fs.writeFileSync(file, `{\n${indent}"name": "web",\n${indent}"scripts": {\n${indent}${indent}"lint": "eslint"\n${indent}}\n}\n`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    parsed.scripts.format = "prettier --write .";
    writeJson(file, parsed);
    const written = fs.readFileSync(file, "utf8");
    assert.match(written, new RegExp(`^${indent === "\t" ? "\\t" : "    "}"name"`, "m"), label);
    assert.equal(JSON.parse(written).scripts.format, "prettier --write .", label);
  }

  // A file being created has no indentation to read — 2 is the JSON default
  // every other tool writes.
  const fresh = path.join(dir, "fresh.json");
  writeJson(fresh, { a: 1 });
  assert.match(fs.readFileSync(fresh, "utf8"), /^  "a"/m);
});

test("the skill goes to the repository root, not the workspace it was run in", () => {
  // The bug this pins down is silent: a skill written to web/.claude/skills
  // exists, reads correctly, and is never loaded, because agents look at the
  // repository root.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nextjs-fsd-mono-"));
  fs.mkdirSync(path.join(repo, ".git"));
  const workspace = path.join(repo, "web");
  fs.mkdirSync(workspace);

  assert.equal(findRepoRoot(workspace), path.resolve(repo));

  const written = writeAgentSkill(workspace, "nextjs-fsd", "# skill\n");
  assert.equal(fs.readFileSync(path.join(repo, ".agents/skills/nextjs-fsd/SKILL.md"), "utf8"), "# skill\n");
  // Reported relative to where the command was typed, which is up and over.
  assert.ok(written.some((line) => line.startsWith("../.agents/skills/nextjs-fsd/SKILL.md")), written.join(", "));

  // Read through .claude/skills, whichever way that path was made.
  const link = path.join(repo, ".claude/skills/nextjs-fsd");
  const viaClaude = fs.statSync(link).isDirectory()
    ? fs.readFileSync(path.join(link, "SKILL.md"), "utf8")
    : null;
  assert.equal(viaClaude, "# skill\n");

  // Second run leaves the link alone rather than throwing on an existing path.
  assert.doesNotThrow(() => writeAgentSkill(workspace, "nextjs-fsd", "# skill\n"));
});

test("no repository above it falls back to the project directory", () => {
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), "nextjs-fsd-loose-"));
  assert.equal(findRepoRoot(loose), path.resolve(loose));
});
