#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";

import { NO_TTY_MESSAGE, select } from "./prompts";
import { initProject } from "./commands/init";
import { generateLayout, generatePage, generateSlice } from "./commands/generate";
import { addAuth, addErrorHandling } from "./commands/add";
import { setProjectLocale, showProjectConfig } from "./commands/config";
import { isProjectDir, readConfig } from "./utils/config";
import { parseLocale } from "./utils/copy";
import { cliVersion } from "./utils/version";

// fail is every command's catch, in one place so the two non-obvious cases stay
// consistent. @inquirer/prompts throws ExitPromptError on Ctrl-C and its raw
// message ("User force closed the prompt with 0 null") tells a user nothing.
// The no-TTY case normally never reaches here — prompts.ts rejects before a
// prompt starts — but stdin can also close mid-prompt, which arrives as the
// same error and deserves the same advice rather than "aborted".
function fail(err: unknown): void {
  const message = (err as Error).message ?? String(err);
  if ((err as Error).name === "ExitPromptError") {
    console.error(pc.red(process.stdin.isTTY ? "aborted" : NO_TTY_MESSAGE));
  } else {
    console.error(pc.red(message));
  }
  process.exitCode = 1;
}

const program = new Command();
program
  .name("nextjs-fsd")
  .description(
    "Keep a Next.js App Router project on Feature-Sliced Design.\n\n" +
      "Next.js creates the app (`create-next-app`); this only shapes what is inside it: `init` once, " +
      "then `generate` for slices and `add` for the API error handling and auth wiring.\n\n" +
      "Run `nextjs-fsd` with no arguments to pick what to do from a menu. Commands ask for whatever you omit; " +
      "`--defaults` answers every question for CI."
  )
  .version(cliVersion());

program
  .command("init")
  .description("shape an existing Next.js App Router project into FSD layers (run this once, after create-next-app)")
  .option("--locale <locale>", 'language for the generated user-facing copy: "th" (default) or "en"')
  .option("--no-install", "write the files but do not run the package manager")
  .option("--defaults", "skip every question; Thai copy, and no confirmation")
  .option("-y, --yes", "skip only the confirmation summary")
  .action(async (opts: { locale?: string; install?: boolean; defaults?: boolean; yes?: boolean }) => {
    try {
      await initProject(process.cwd(), {
        locale: parseLocale(opts.locale),
        install: opts.install,
        defaults: opts.defaults,
        yes: opts.yes || opts.defaults,
      });
    } catch (err) {
      fail(err);
    }
  });

async function runGenerateWizard(): Promise<void> {
  const target = await select({
    message: "What do you want to generate?",
    choices: [
      { name: "Page (a _pages slice plus its route file)", value: "page" },
      { name: "Slice (features / entities / widgets)", value: "slice" },
      { name: "Layout (shared chrome for a group of routes)", value: "layout" },
    ],
  });
  if (target === "page") await generatePage(undefined, {});
  else if (target === "slice") await generateSlice(undefined, undefined, {});
  else await generateLayout(undefined, {});
}

const generate = program
  .command("generate")
  .alias("g")
  .description("add a page or slice; bare `generate` opens a target wizard")
  .action(async () => {
    try {
      await runGenerateWizard();
    } catch (err) {
      fail(err);
    }
  });

generate
  .command("page [name]")
  .alias("p")
  .description("scaffold a _pages slice and the thin route file that re-exports it")
  .option("--title <title>", "heading and browser title; defaults to the Title Case of the page name")
  .option("--route <path>", 'App Router path; defaults to the page name. Route groups and dynamic segments work: "(admin)/dashboard", "loans/[id]"')
  .option("--no-route", "write the slice only, no route file")
  .option("--client", 'also create a "use client" leaf component')
  .option("--auth", "the client leaf sits behind useRequireSession (needs `add auth`)")
  .option("--errors", "add model/<name>-errors.ts, this page's own error catalog (needs `add error-handling`)")
  .option("--defaults", "skip every question; server component only, route = the page name")
  .action(async (name, opts) => {
    try {
      // commander folds --no-route into the same `route` key: false when it
      // was passed, a string when --route was, undefined when neither.
      const noRoute = opts.route === false;
      await generatePage(name, {
        title: opts.title,
        route: noRoute ? undefined : opts.route,
        routeFile: noRoute ? false : undefined,
        client: opts.client,
        auth: opts.auth,
        errors: opts.errors,
        defaults: opts.defaults,
      });
    } catch (err) {
      fail(err);
    }
  });

generate
  .command("slice [layer] [name]")
  .alias("s")
  .description("scaffold a features/entities/widgets slice with only the segments it needs")
  .option("--segments <list>", "comma-separated: ui,model,api,lib (default ui)")
  .option("--errors", "add model/<name>-errors.ts, this slice's own error catalog (needs `add error-handling`)")
  .option("--defaults", "skip every question; ui segment only")
  .action(async (layer, name, opts) => {
    try {
      await generateSlice(layer, name, {
        segments: opts.segments,
        errors: opts.errors,
        defaults: opts.defaults,
      });
    } catch (err) {
      fail(err);
    }
  });

generate
  .command("layout [name]")
  .alias("l")
  .description("scaffold a shared route shell in _app/layouts plus the layout.tsx that re-exports it")
  .option("--route <path>", 'where it applies; defaults to the route group "(<name>)". A real segment works too: "admin"')
  .option("--no-route", "write the component only, no layout.tsx")
  .option("--defaults", "skip every question; route = the (<name>) group")
  .action(async (name, opts) => {
    try {
      const noRoute = opts.route === false;
      await generateLayout(name, {
        route: noRoute ? undefined : opts.route,
        routeFile: noRoute ? false : undefined,
        defaults: opts.defaults,
      });
    } catch (err) {
      fail(err);
    }
  });

async function runAddWizard(): Promise<void> {
  // Read once, up front: the menu should say what is already installed rather
  // than letting someone walk a confirmation to reach "already installed".
  const config = readConfig(process.cwd());
  const target = await select({
    message: "What do you want to add?",
    choices: [
      {
        name: "Error handling (ApiError, per-domain catalogs, axios client with a 401 refresh, QueryClient)",
        value: "errors",
        disabled: config.features.errorHandling ? "— already installed" : false,
      },
      {
        name: "Auth (access token in memory, session hooks, route guard, login page)",
        value: "auth",
        disabled: config.features.auth ? "— already installed" : false,
      },
    ],
  });
  if (target === "errors") await addErrorHandling({});
  else await addAuth({});
}

const add = program
  .command("add")
  .description("add shared infrastructure; bare `add` opens an error-handling/auth wizard")
  .action(async () => {
    try {
      await runAddWizard();
    } catch (err) {
      fail(err);
    }
  });

add
  .command("error-handling")
  .alias("errors")
  .description("add shared/api: ApiError, per-domain error catalogs, a resolver, an axios client with a single-flight 401 refresh, and a QueryClient")
  .option("--no-install", "write the files but do not run the package manager")
  .option("-y, --yes", "skip the confirmation summary")
  .action(async (opts: { install?: boolean; yes?: boolean }) => {
    try {
      await addErrorHandling({ install: opts.install, yes: opts.yes });
    } catch (err) {
      fail(err);
    }
  });

add
  .command("auth")
  .description("add shared/auth and a login page: access token in memory, session hooks, useRequireSession (installs error handling first if missing)")
  .option("--no-install", "write the files but do not run the package manager")
  .option("-y, --yes", "skip the confirmation summary")
  .action(async (opts: { install?: boolean; yes?: boolean }) => {
    try {
      await addAuth({ install: opts.install, yes: opts.yes });
    } catch (err) {
      fail(err);
    }
  });

const config = program
  .command("config")
  .description("inspect the project config")
  .action(() => {
    try {
      showProjectConfig();
    } catch (err) {
      fail(err);
    }
  });

config
  .command("set <key> <value>")
  .description('change a project setting; only `locale` (th|en) is settable, and it affects future generation only')
  .action((key: string, value: string) => {
    try {
      if (key !== "locale") {
        throw new Error(`unknown setting "${key}" — only \`locale\` can be set (th or en)`);
      }
      setProjectLocale(value);
    } catch (err) {
      fail(err);
    }
  });

config
  .command("show")
  .description("print the resolved project config and which features are installed")
  .action(() => {
    try {
      showProjectConfig();
    } catch (err) {
      fail(err);
    }
  });

// runTopMenu is bare `nextjs-fsd` — the command name is the one thing people
// remember, so give the same "ask, then delegate" menu the subcommands give
// when run bare, instead of Commander's static help (which lists commands but
// never lets you act on one).
//
// Deliberately NOT a .action() on the root: giving the root an action makes it
// callable, which turns a mistyped subcommand into "too many arguments"
// instead of Commander's "unknown command 'ad' (Did you mean add?)".
async function runTopMenu(): Promise<void> {
  if (!isProjectDir(process.cwd())) {
    console.log(pc.dim(`${process.cwd()} isn't a nextjs-fsd project yet — only "init" can run here.\n`));
    await initProject(process.cwd(), {});
    return;
  }

  const target = await select({
    message: "What do you want to do?",
    choices: [
      { name: "Generate (a page or a features/entities slice)", value: "generate" },
      { name: "Add (error handling / auth)", value: "add" },
      { name: "Show the project config", value: "config" },
    ],
  });
  if (target === "generate") await runGenerateWizard();
  else if (target === "add") await runAddWizard();
  else showProjectConfig();
}

if (process.argv.length <= 2) {
  runTopMenu().catch(fail);
} else {
  program.parseAsync(process.argv);
}
