import path from "path";
import fs from "fs-extra";
import pc from "picocolors";

import { ProjectConfig } from "../types";
import { confirm } from "../prompts";
import { readConfig, setFeature } from "../utils/config";
import { asCatalogEntries, copyFor } from "../utils/copy";
import { applyTemplates, formatFiles, TemplateEntry } from "../utils/render";
import {
  addDependencies,
  appendEnvExample,
  appendExport,
  appendScript,
  installDependencies,
  patchLayoutProviders,
  runCommand,
} from "../utils/project";
import { report } from "./init";

const API_DEPS = {
  "@tanstack/react-query": "^5.101.4",
  axios: "^1.19.0",
};

const PRETTIER_DEV_DEPS = {
  prettier: "^3.9.6",
  "prettier-plugin-tailwindcss": "^0.8.1",
};

export interface AddOptions {
  install?: boolean;
  yes?: boolean;
}

// confirmAdd prints what an add is about to do and asks before it happens: it
// writes a dozen files and patches the root layout, and there is no `undo` to
// walk that back. Defaults to yes here (unlike a delete) because getting to
// this prompt already required typing the command.
async function confirmAdd(lines: string[], opts: AddOptions): Promise<void> {
  if (opts.yes) return;
  console.log(pc.bold("\nThis will:"));
  for (const line of lines) console.log(`  ${pc.dim("•")} ${line}`);
  console.log();
  if (!(await confirm({ message: "Proceed?", default: true }))) {
    throw new Error("cancelled — nothing was written");
  }
}

/** Returns the dependencies added to package.json, so a caller that chains
 *  another add can install once at the end instead of twice. */
export async function addErrorHandling(opts: AddOptions): Promise<string[]> {
  const projectDir = process.cwd();
  const config = readConfig(projectDir);
  if (config.features.errorHandling) {
    throw new Error(
      `error handling is already installed (${config.srcDir}/shared/api/client.ts exists) — edit the catalogs there, or delete the directory to reinstall`
    );
  }

  const providersFile = `${config.srcDir}/_app/providers/index.tsx`;
  const ownsProviders = !fs.existsSync(path.join(projectDir, providersFile));

  await confirmAdd(
    [
      `add ${pc.cyan(`${config.srcDir}/shared/api/`)} — ApiError, the error catalog + resolver, an axios client with a single-flight 401 refresh, and a QueryClient`,
      `add ${pc.cyan(`${config.srcDir}/shared/ui/form-error.tsx`)} and ${pc.cyan(`${config.srcDir}/shared/config/env.ts`)}`,
      `add ${pc.cyan(`${config.srcDir}/shared/auth/access-token.ts`)} — the in-memory token the request interceptor reads (\`add auth\` fills in the rest)`,
      ownsProviders
        ? `add ${pc.cyan(providersFile)} and wrap ${config.appDir}/layout.tsx in <Providers>`
        : pc.yellow(`leave your existing ${providersFile} alone — you add <QueryClientProvider> to it yourself`),
      `add ${Object.keys(API_DEPS).join(" + ")} to package.json`,
    ],
    opts
  );

  // The refresh rules are the part that fails silently in a browser, so they
  // get the one test — but only where it runs with no extra setup. `bun test`
  // resolves the tsconfig alias on its own; node:test and vitest both need
  // config this CLI has no business writing into someone's project.
  const writesTest = config.packageManager === "bun";

  const context = errorContext(config);
  const entries: TemplateEntry[] = [
    { template: "add/errors/api-error.ts.hbs", output: `${config.srcDir}/shared/api/api-error.ts` },
    { template: "add/errors/error-catalog.ts.hbs", output: `${config.srcDir}/shared/api/error-catalog.ts` },
    { template: "add/errors/error-resolver.ts.hbs", output: `${config.srcDir}/shared/api/error-resolver.ts` },
    { template: "add/errors/client.ts.hbs", output: `${config.srcDir}/shared/api/client.ts` },
    { template: "add/errors/query-client.ts.hbs", output: `${config.srcDir}/shared/api/query-client.ts` },
    { template: "add/errors/index.ts.hbs", output: `${config.srcDir}/shared/api/index.ts` },
    { template: "add/errors/access-token.ts.hbs", output: `${config.srcDir}/shared/auth/access-token.ts` },
    { template: "add/errors/env.ts.hbs", output: `${config.srcDir}/shared/config/env.ts` },
    { template: "add/errors/config-index.ts.hbs", output: `${config.srcDir}/shared/config/index.ts` },
    { template: "add/errors/form-error.tsx.hbs", output: `${config.srcDir}/shared/ui/form-error.tsx` },
    { template: "add/errors/providers.tsx.hbs", output: providersFile, when: () => ownsProviders },
    {
      template: "add/errors/client.test.ts.hbs",
      output: `${config.srcDir}/shared/api/client.test.ts`,
      when: () => writesTest,
    },
  ];

  const written = await applyTemplates(projectDir, entries, context);

  if (appendExport(projectDir, `${config.srcDir}/shared/ui/index.ts`, 'export { FormError } from "./form-error";')) {
    written.push(`${config.srcDir}/shared/ui/index.ts`);
  }
  if (
    appendEnvExample(
      projectDir,
      "NEXT_PUBLIC_API_URL",
      "# Base URL of the API, including whatever prefix it mounts its routes under.\n" +
        "# Whatever origin this app runs on must also be allowed by the API's CORS\n" +
        "# config, or the browser drops the refresh cookie.\n" +
        "NEXT_PUBLIC_API_URL=http://localhost:8080/api\n"
    )
  ) {
    written.push(".env.example");
  }

  const layoutPatch = ownsProviders ? patchLayoutProviders(projectDir, config.appDir, config.alias) : "already";
  if (layoutPatch === "patched") written.push(`${config.appDir}/layout.tsx (<Providers>)`);

  // The two files above were edited as text, not rendered from a template, so
  // applyTemplates never saw them. Missing ones are skipped.
  await formatFiles(projectDir, [`${config.appDir}/layout.tsx`, `${config.srcDir}/shared/ui/index.ts`]);

  const added = addDependencies(projectDir, API_DEPS);
  if (writesTest) {
    // next build type-checks every file under the project, the generated test
    // included — without these types `bun:test` is an unresolved module and
    // the production build fails on a file that only ever runs in bun.
    added.push(...addDependencies(projectDir, { "@types/bun": "^1.3.14" }, "devDependencies"));
    if (appendScript(projectDir, "test", "bun test")) written.push("package.json (test script)");
  }
  setFeature(projectDir, "errorHandling", true);
  report(written, added);

  if (!ownsProviders) {
    console.log(
      pc.yellow(`\n${providersFile} already exists — wrap its children yourself:`) +
        `\n  import { QueryClientProvider } from "@tanstack/react-query";` +
        `\n  import { makeQueryClient } from "${config.alias}/shared/api";` +
        `\n  const [queryClient] = useState(makeQueryClient);   // not a module constant` +
        `\n  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>`
    );
  } else if (layoutPatch === "manual") {
    console.log(
      pc.yellow(`\ncould not find {children} in ${config.appDir}/layout.tsx — wrap it in <Providers> by hand:`) +
        `\n  import { Providers } from "${config.alias}/_app/providers";`
    );
  }

  if (!writesTest) {
    console.log(
      pc.dim(
        `\nno client.test.ts written: \`bun test\` resolves the ${config.alias}/ alias with no config, ` +
          `${config.packageManager} needs a runner set up first. The single-flight refresh is the part worth pinning down when you add one.`
      )
    );
  }

  finish(projectDir, config, added, opts);
  console.log(
    `\n${pc.bold("Next:")} render a failure with ${pc.cyan("<FormError error={mutation.error} />")}, ` +
      `and give each domain its own catalog with ${pc.cyan("nextjs-fsd generate page <name> --errors")}`
  );
  return added;
}

export async function addAuth(opts: AddOptions): Promise<void> {
  const projectDir = process.cwd();
  let config = readConfig(projectDir);
  if (config.features.auth) {
    throw new Error(
      `auth is already installed (${config.srcDir}/shared/auth/session.ts exists) — edit it there, or delete the directory to reinstall`
    );
  }

  // Not an error like `add rbac`'s "run add auth first": auth cannot work
  // without the client at all — every hook below goes through it — so there is
  // no choice to offer, only a step to take first.
  let added: string[] = [];
  if (!config.features.errorHandling) {
    console.log(pc.dim("auth needs the API client, which `add error-handling` installs — doing that first.\n"));
    // install: false so the two adds share one install run at the end.
    added = await addErrorHandling({ ...opts, install: false });
    config = readConfig(projectDir);
    console.log();
  }

  await confirmAdd(
    [
      `add ${pc.cyan(`${config.srcDir}/shared/auth/`)} — session hooks (useSession/useLogin/useLogout), useRequireSession with a ?next= round trip, and an auth error catalog`,
      `add ${pc.cyan(`${config.srcDir}/_pages/login/`)} and ${pc.cyan(`${config.appDir}/login/page.tsx`)}`,
      pc.yellow(
        "assumes the API answers POST /auth/login with an access token, keeps the refresh token in an httpOnly cookie, and serves GET /users/me — adjust the paths and the Session type if yours differ"
      ),
      pc.dim("password login only: MFA, OAuth providers and RBAC are not scaffolded"),
    ],
    opts
  );

  const context = errorContext(config);
  const auth = `${config.srcDir}/shared/auth`;
  const slice = `${config.srcDir}/_pages/login`;
  // Same rule as client.test.ts: `bun test` resolves the alias with no config,
  // every other runner needs setup this CLI has no business writing. What it
  // covers is the open-redirect guard on ?next=, which is the one thing here
  // that fails as a security bug rather than a visible one.
  const writesTest = config.packageManager === "bun";
  const written = await applyTemplates(
    projectDir,
    [
      { template: "add/auth/session.ts.hbs", output: `${auth}/session.ts` },
      { template: "add/auth/require-session.ts.hbs", output: `${auth}/require-session.ts` },
      {
        template: "add/auth/require-session.test.ts.hbs",
        output: `${auth}/require-session.test.ts`,
        when: () => writesTest,
      },
      { template: "add/auth/auth-errors.ts.hbs", output: `${auth}/auth-errors.ts` },
      { template: "add/auth/index.ts.hbs", output: `${auth}/index.ts` },
      { template: "add/auth/login-index.ts.hbs", output: `${slice}/index.ts` },
      { template: "add/auth/login-page.tsx.hbs", output: `${slice}/ui/login-page.tsx` },
      { template: "add/auth/login-form.tsx.hbs", output: `${slice}/ui/login-form.tsx` },
      { template: "generate/page/route.tsx.hbs", output: path.posix.join(config.appDir, "login", "page.tsx") },
    ],
    { ...context, name: "login", pascal: "Login" }
  );

  setFeature(projectDir, "auth", true);
  report(written);
  finish(projectDir, config, added, opts);
  console.log(
    `\n${pc.bold("Next:")} put a page behind the session guard with ` +
      pc.cyan("nextjs-fsd generate page dashboard --auth")
  );
}

/**
 * Adds prettier, with the Tailwind class-sorting plugin pointed at the
 * stylesheet `init` moved.
 *
 * Worth a command rather than a line in the README because of that pointer:
 * Tailwind v4 has no config file for the plugin to find, so it needs
 * `tailwindStylesheet`, and `init` is what moved `globals.css` out of the
 * route directory in the first place. Everyone who adds prettier by hand
 * afterwards has to rediscover both facts.
 *
 * Prettier's own defaults are left alone. Indent width and print width are
 * taste, they are the first thing anyone changes, and a generator picking them
 * would only be picking a fight.
 */
export async function addPrettier(opts: AddOptions): Promise<void> {
  const projectDir = process.cwd();
  const config = readConfig(projectDir);
  if (config.features.prettier) {
    throw new Error(
      "a prettier config already exists in this project — a second one would not merge with it, it would be ignored. Add the plugin to the config you have:\n" +
        '  "plugins": ["prettier-plugin-tailwindcss"],\n' +
        `  "tailwindStylesheet": "./${config.srcDir}/_app/styles/globals.css",\n` +
        '  "tailwindFunctions": ["cn", "cva"]'
    );
  }

  await confirmAdd(
    [
      `add ${pc.cyan(".prettierrc")} — prettier defaults plus prettier-plugin-tailwindcss, pointed at ${pc.cyan(`${config.srcDir}/_app/styles/globals.css`)} (Tailwind v4 has no config file to find) and taught about ${pc.cyan("cn()")} / ${pc.cyan("cva()")}`,
      `add ${pc.cyan(".prettierignore")} — markdown only; prettier already reads .gitignore`,
      `add a ${pc.cyan("format")} script, and ${pc.cyan("prettier --check .")} to ${pc.cyan("lint")} so whatever runs lint enforces it`,
      `add ${Object.keys(PRETTIER_DEV_DEPS).join(" + ")} to devDependencies`,
      pc.yellow(
        "then format the project once — every file, in one pass. Adding the check without the pass would leave `lint` failing on files nobody touched. Commit it on its own."
      ),
    ],
    opts
  );

  const written = await applyTemplates(
    projectDir,
    [
      { template: "add/prettier/prettierrc.hbs", output: ".prettierrc" },
      { template: "add/prettier/prettierignore.hbs", output: ".prettierignore" },
    ],
    config
  );

  if (appendScript(projectDir, "format", "prettier --write .")) written.push("package.json (format script)");
  // On lint rather than a pre-commit hook: the project may not have one, and
  // whatever already runs lint — CI, a hook, an editor task — picks this up
  // with no further wiring.
  if (appendScript(projectDir, "lint", "prettier --check .")) written.push("package.json (lint script)");

  const added = addDependencies(projectDir, PRETTIER_DEV_DEPS, "devDependencies");
  setFeature(projectDir, "prettier", true);
  report(written, added);
  finish(projectDir, config, added, opts);

  // The pass has to happen, and it has to happen here. `prettier --check .` on
  // lint against an unformatted tree fails on every file in the project — an
  // add that hands back a red lint is worse than one that never touched lint.
  // Needs the install, so `--no-install` gets the instruction instead.
  if (opts.install === false) {
    console.log(
      pc.yellow(
        `\n\`lint\` will fail until the project is formatted. Run \`${config.packageManager} install\`, ` +
          `then \`${config.packageManager} run format\`.`
      )
    );
    return;
  }

  console.log(pc.dim("\nformatting the project once, so `lint` passes:"));
  try {
    runCommand(projectDir, config.packageManager, ["prettier", "--write", "."]);
  } catch {
    // Everything above already landed. Failing the whole command now would
    // suggest none of it did, and the fix is one command the user can run.
    console.log(
      pc.yellow(
        `\ncould not run prettier — everything else is written. Run \`${config.packageManager} run format\` ` +
          "once the install finishes; `lint` fails until you do."
      )
    );
    return;
  }
  console.log(
    `\n${pc.bold("Next:")} commit that pass on its own — it touches every file, ` +
      "and nobody can review it mixed into a change."
  );
}

function errorContext(config: ProjectConfig) {
  const copy = copyFor(config.locale);
  return {
    ...config,
    copy,
    commonCatalogEntries: asCatalogEntries(copy.common),
    authCatalogEntries: asCatalogEntries(copy.auth),
  };
}

function finish(projectDir: string, config: ProjectConfig, added: string[], opts: AddOptions): void {
  if (added.length === 0) return;
  if (opts.install === false) {
    console.log(pc.yellow(`\nrun \`${config.packageManager} install\` to install: ${added.join(", ")}`));
    return;
  }
  installDependencies(projectDir, config.packageManager);
}
