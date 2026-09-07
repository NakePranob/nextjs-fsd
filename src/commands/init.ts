import path from "path";
import fs from "fs-extra";
import pc from "picocolors";

import { ProjectConfig } from "../types";
import { confirm, select } from "../prompts";
import { CONFIG_SCHEMA_VERSION, detectFeatures, isProjectDir, writeConfig } from "../utils/config";
import { Locale, copyFor } from "../utils/copy";
import { applyTemplates, renderTemplate } from "../utils/render";
import {
  addDependencies,
  appendScript,
  detectAppDir,
  detectPackageManager,
  installDependencies,
  patchEslintConfig,
  patchLayoutStyleImport,
  patchTsconfigPaths,
} from "../utils/project";
import { cliVersion } from "../utils/version";

const STEIGER_DEV_DEPS = {
  "@feature-sliced/steiger-plugin": "^0.7.0",
  steiger: "^0.6.0",
};

export interface InitOptions {
  locale?: Locale;
  install?: boolean;
  defaults?: boolean;
  yes?: boolean;
}

export async function initProject(projectDir: string, opts: InitOptions): Promise<void> {
  if (isProjectDir(projectDir)) {
    throw new Error(
      "already a nextjs-fsd project (nextjs-fsd.config.json exists) — use `generate` / `add` from here, or delete the config file to re-init"
    );
  }

  // Fails before anything is written if this is not an App Router project:
  // half-initialising a Pages Router app leaves a src/ tree nothing imports.
  const appDir = detectAppDir(projectDir);
  const srcDir = "src";
  const alias = "@";
  const packageManager = detectPackageManager(projectDir);

  const locale =
    opts.locale ??
    (opts.defaults
      ? "th"
      : ((await select({
          message: "Language for the generated user-facing copy?",
          choices: [
            { name: "Thai", value: "th" },
            { name: "English", value: "en" },
          ],
        })) as Locale));

  const stylesheet = path.join(appDir, "globals.css");
  const movesStylesheet = fs.existsSync(path.join(projectDir, stylesheet));

  if (!(opts.yes || opts.defaults)) {
    console.log(pc.bold("\nThis will:"));
    for (const line of [
      `keep Next.js routing in ${pc.cyan(appDir + "/")} and put the FSD layers in ${pc.cyan(srcDir + "/")} (_app, _pages, shared)`,
      movesStylesheet
        ? `move ${pc.cyan(stylesheet)} to ${pc.cyan(`${srcDir}/_app/styles/globals.css`)} and repoint the import in ${appDir}/layout.tsx`
        : `create ${pc.cyan(`${srcDir}/_app/styles/globals.css`)}`,
      `point the ${pc.cyan(`${alias}/*`)} tsconfig alias at ./${srcDir}/*`,
      `add ${pc.cyan("eslint.fsd.mjs")} — the import boundary as ESLint rules, so a wrong-way import is flagged in your editor (no new dependencies)`,
      `add steiger + the FSD plugin and a steiger.config.ts for the whole-tree checks ESLint cannot make, then chain both into the lint script`,
      `add ${pc.cyan("components.json")} so \`shadcn add\` writes into ${srcDir}/shared/ui instead of ./components/ui`,
      `write ${pc.cyan("docs/fsd.md")}, a ${pc.cyan(".claude/skills/nextjs-fsd")} skill, and point AGENTS.md at both`,
    ]) {
      console.log(`  ${pc.dim("•")} ${line}`);
    }
    console.log();
    if (!(await confirm({ message: "Proceed?", default: true }))) {
      throw new Error("cancelled — nothing was written");
    }
  }

  const context = {
    srcDir,
    appDir,
    alias,
    locale,
    copy: copyFor(locale),
    lintCommand: `${packageManager} run lint`,
    packageManager,
    cssSourceApp: toPosix(path.relative(path.join(srcDir, "_app", "styles"), appDir)),
    cssSourceSrc: toPosix(path.relative(path.join(srcDir, "_app", "styles"), srcDir)),
  };

  const written = await applyTemplates(projectDir, [
    { template: "init/steiger.config.ts.hbs", output: "steiger.config.ts" },
    { template: "init/eslint.fsd.mjs.hbs", output: "eslint.fsd.mjs" },
    { template: "init/fsd.md.hbs", output: "docs/fsd.md" },
    // Same content as the AGENTS.md section, aimed at the tool that reads
    // .claude/skills — an agent's instinct on "add a settings screen" is to
    // hand-write the files, which is exactly what the two linters then report.
    { template: "init/skill.md.hbs", output: ".claude/skills/nextjs-fsd/SKILL.md" },
    {
      template: "init/globals.css.hbs",
      output: `${srcDir}/_app/styles/globals.css`,
      when: () => !movesStylesheet,
    },
    // Written before anyone runs `shadcn init`, because its own defaults put
    // components in ./components/ui and a utils.ts at the project root —
    // outside the layers entirely. The aliases here send them into
    // shared/ui and shared/lib instead. Skipped if the project already has
    // one; that file is the user's decision, not ours.
    {
      template: "init/components.json.hbs",
      output: "components.json",
      when: () => !fs.existsSync(path.join(projectDir, "components.json")),
    },
  ], context);

  if (movesStylesheet) {
    // Moved rather than copied: the import in layout.tsx is its only
    // reference, and leaving a second copy behind means the next person edits
    // the one Tailwind no longer reads.
    const destination = `${srcDir}/_app/styles/globals.css`;
    await fs.move(path.join(projectDir, stylesheet), path.join(projectDir, destination));
    addTailwindSources(path.join(projectDir, destination), context.cssSourceApp, context.cssSourceSrc);
    written.push(`${destination} (moved from ${stylesheet})`);
    if (patchLayoutStyleImport(projectDir, appDir, alias)) written.push(`${appDir}/layout.tsx (stylesheet import)`);
    else
      console.log(
        pc.yellow(
          `\ncould not find \`import "./globals.css"\` in ${appDir}/layout.tsx — change it to \`import "${alias}/_app/styles/globals.css"\` by hand.`
        )
      );
  }

  if (patchTsconfigPaths(projectDir, alias, srcDir)) written.push(`tsconfig.json (${alias}/* alias)`);

  const eslintPatch = patchEslintConfig(projectDir);
  if (eslintPatch === "patched") written.push("eslint.config.mjs (spreads the FSD boundary rules)");
  if (appendScript(projectDir, "lint", `steiger ./${srcDir}`)) written.push("package.json (lint script)");
  written.push(...writeAgentDocs(projectDir, context));

  if (eslintPatch !== "patched" && eslintPatch !== "already") {
    console.log(
      pc.yellow(
        eslintPatch === "missing"
          ? "\nno flat ESLint config found — add one, then spread the generated rules into it:"
          : "\ncould not patch your ESLint config automatically — spread the generated rules into it by hand:"
      ) +
        '\n  import fsdBoundary from "./eslint.fsd.mjs";' +
        "\n  export default [...yourConfig, ...fsdBoundary];"
    );
  }

  const added = addDependencies(projectDir, STEIGER_DEV_DEPS, "devDependencies");

  const config: ProjectConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    locale,
    srcDir,
    appDir,
    alias,
    packageManager,
    features: detectFeatures(projectDir, srcDir),
    scaffoldVersion: cliVersion(),
  };
  writeConfig(projectDir, config);
  written.push("nextjs-fsd.config.json");

  report(written, added);

  if (added.length > 0 && opts.install !== false) {
    installDependencies(projectDir, packageManager);
  } else if (added.length > 0) {
    console.log(pc.yellow(`\nrun \`${packageManager} install\` to install: ${added.join(", ")}`));
  }

  // Only a render shows this one: create-next-app leaves
  // `body { font-family: Arial, Helvetica, sans-serif }` in globals.css, and
  // none of those faces carries Thai. The browser then falls back per glyph,
  // so a Thai UI renders in a face nobody chose — and Thai stacks two marks
  // above a consonant plus a vowel below, which Latin-tuned line heights clip.
  // Not patched automatically: which face to use is the project's call, and
  // rewriting someone's font stack is not what "init the layout" asked for.
  if (locale === "th") {
    console.log(
      pc.yellow("\nThai copy was generated, but this project's font stack cannot render it.") +
        `\n  ${pc.dim("globals.css sets")} body { font-family: Arial, Helvetica, sans-serif } ${pc.dim("— no Thai coverage in any of those.")}` +
        `\n  ${pc.dim("Load a Thai face in")} ${appDir}/layout.tsx ${pc.dim("and point --font-sans at it:")}` +
        '\n    import { Noto_Sans_Thai } from "next/font/google";' +
        '\n    const sans = Noto_Sans_Thai({ subsets: ["thai", "latin"], variable: "--font-sans" });' +
        `\n  ${pc.dim("Then drop the Arial rule and loosen the line heights per size — Thai needs the room.")}`
    );
  }

  console.log(
    `\n${pc.bold("Next:")} ${pc.cyan("nextjs-fsd generate page <name>")}, ` +
      `${pc.cyan("nextjs-fsd add error-handling")}, ${pc.cyan("nextjs-fsd add auth")}`
  );
}

/**
 * Adds an FSD section to AGENTS.md (creating it if absent) and a CLAUDE.md
 * that includes it.
 *
 * Appended, never rewritten: AGENTS.md is usually already the project's own
 * instructions file, and the FSD conventions are one section of it.
 */
function writeAgentDocs(projectDir: string, context: object): string[] {
  const written: string[] = [];
  const section = renderTemplate("init/agents-section.md.hbs", context);
  const agents = path.join(projectDir, "AGENTS.md");

  if (!fs.existsSync(agents)) {
    fs.writeFileSync(agents, `# AGENTS.md\n${section}`);
    written.push("AGENTS.md");
  } else if (!fs.readFileSync(agents, "utf8").includes("Feature-Sliced Design")) {
    fs.appendFileSync(agents, section);
    written.push("AGENTS.md (FSD section appended)");
  }

  const claude = path.join(projectDir, "CLAUDE.md");
  if (!fs.existsSync(claude)) {
    fs.writeFileSync(claude, renderTemplate("init/claude.md.hbs", context));
    written.push("CLAUDE.md");
  }
  return written;
}

/**
 * Names the trees Tailwind has to scan, because moving the stylesheet out of
 * the route directory moves it out of what auto-detection would have found.
 * Inserted after the last `@import` so it lands below `@import "tailwindcss"`
 * — an `@source` above it is ignored.
 */
export function addTailwindSources(cssFile: string, appSource: string, srcSource: string): void {
  const source = fs.readFileSync(cssFile, "utf8");
  if (source.includes("@source")) return;

  const block =
    `\n/* This file lives in the FSD app layer, not next to the routes, so name the\n` +
    `   trees Tailwind has to scan for class names explicitly instead of relying on\n` +
    `   where auto-detection decides the project root is. */\n` +
    `@source "${appSource}";\n@source "${srcSource}";\n`;

  const imports = [...source.matchAll(/^@import .*$/gm)];
  const last = imports[imports.length - 1];
  // `last.index === 0` is a real position, not "not found" — a stylesheet
  // whose very first line is `@import "tailwindcss"` is the common case.
  if (last?.index === undefined) {
    fs.writeFileSync(cssFile, block.trimStart() + "\n" + source);
    return;
  }
  const insertAt = source.indexOf("\n", last.index) + 1;
  fs.writeFileSync(cssFile, source.slice(0, insertAt) + block + source.slice(insertAt));
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function report(written: string[], added: string[] = []): void {
  console.log();
  for (const file of written) console.log(`  ${pc.green("+")} ${file}`);
  for (const dep of added) console.log(`  ${pc.green("+")} ${pc.dim("package.json:")} ${dep}`);
}
