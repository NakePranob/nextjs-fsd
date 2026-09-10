import pc from "picocolors";
import { readConfig, writeConfig } from "../utils/config";
import { parseLocale } from "../utils/copy";
import { cliVersion } from "../utils/version";

export function showProjectConfig(): void {
  const config = readConfig(process.cwd());
  const rows: [string, string][] = [
    ["FSD layers", `${config.srcDir}/ (_app, _pages, features, entities, shared)`],
    ["App Router", `${config.appDir}/`],
    ["import alias", `${config.alias}/* -> ./${config.srcDir}/*`],
    ["copy language", config.locale],
    ["package manager", config.packageManager],
    ["error handling", config.features.errorHandling ? pc.green("installed") : pc.dim("not installed")],
    ["auth", config.features.auth ? pc.green("installed") : pc.dim("not installed")],
    ["prettier", config.features.prettier ? pc.green("installed") : pc.dim("not installed")],
  ];

  console.log();
  for (const [label, value] of rows) console.log(`  ${label.padEnd(16)} ${value}`);

  const stamped = config.scaffoldVersion;
  const current = cliVersion();
  if (stamped && stamped !== current) {
    console.log(
      pc.dim(`\n  scaffolded with nextjs-fsd ${stamped}, running ${current} — templates may have moved on since.`)
    );
  }
  console.log();
}

/**
 * Changes the language future generated copy is written in.
 *
 * Future only, and deliberately so: the catalogs and page titles already on
 * disk are meant to be edited, and rewriting them would throw away the wording
 * someone chose. The setting decides what the next draft reads like, nothing
 * more.
 */
export function setProjectLocale(value: string): void {
  const locale = parseLocale(value);
  if (locale === undefined) throw new Error('`config set locale` needs a value — "th" or "en"');

  const config = readConfig(process.cwd());
  if (config.locale === locale) {
    console.log(pc.dim(`\nalready ${locale} — nothing to change.\n`));
    return;
  }
  writeConfig(process.cwd(), { ...config, locale });
  console.log(
    `\n  ${pc.green("~")} nextjs-fsd.config.json: locale ${pc.dim(config.locale)} -> ${pc.green(locale)}\n` +
      pc.dim("  Applies to what gets generated from now on. Catalogs and titles already written are left as they are.\n")
  );
}
