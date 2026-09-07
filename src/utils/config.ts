import path from "path";
import fs from "fs-extra";
import { PackageManager, ProjectConfig, ProjectFeatures } from "../types";
import { Locale } from "./copy";
import { detectPackageManager } from "./project";

const CONFIG_FILE = "nextjs-fsd.config.json";
export const CONFIG_SCHEMA_VERSION = 1;

export function configPath(projectDir: string): string {
  return path.join(projectDir, CONFIG_FILE);
}

export function isProjectDir(projectDir: string): boolean {
  return fs.existsSync(configPath(projectDir));
}

export function writeConfig(projectDir: string, config: ProjectConfig): void {
  fs.writeJsonSync(configPath(projectDir), config, { spaces: 2 });
}

/**
 * Detects which features are actually on disk.
 *
 * Every command reads the config file, but a key the file does not define used
 * to mean "false" to every caller — so `add auth` would re-install a
 * shared/api that was already there and clobber the catalog someone had
 * filled in. The tree always knew the answer; this stops the guessing. The
 * file still wins wherever it has a value: an explicit `false` is an answer,
 * not a hole.
 */
export function detectFeatures(projectDir: string, srcDir = "src"): ProjectFeatures {
  const has = (relative: string) => fs.existsSync(path.join(projectDir, srcDir, relative));
  return {
    errorHandling: has("shared/api/client.ts"),
    auth: has("shared/auth/session.ts"),
  };
}

export function readConfig(projectDir: string): ProjectConfig {
  const file = configPath(projectDir);
  if (!fs.existsSync(file)) {
    throw new Error(
      `${projectDir} isn't a nextjs-fsd project — no ${CONFIG_FILE}.\n` +
        "Run `nextjs-fsd init` in a Next.js App Router project first."
    );
  }

  const raw = fs.readJsonSync(file) as Partial<ProjectConfig>;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILE} must contain a JSON object`);
  }

  const schemaVersion = raw.schemaVersion ?? CONFIG_SCHEMA_VERSION;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`${CONFIG_FILE} has invalid schemaVersion "${String(schemaVersion)}" — expected a positive integer`);
  }
  if (schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `${CONFIG_FILE} uses schemaVersion ${schemaVersion}, but this CLI supports up to ${CONFIG_SCHEMA_VERSION} — upgrade nextjs-fsd first`
    );
  }

  const srcDir = raw.srcDir ?? "src";
  const appDir = raw.appDir ?? "app";
  if (!fs.existsSync(path.join(projectDir, appDir))) {
    throw new Error(
      `${CONFIG_FILE} points appDir at "${appDir}", which doesn't exist — fix the path, or re-run \`nextjs-fsd init\``
    );
  }

  const detected = detectFeatures(projectDir, srcDir);
  const features = { ...(raw.features ?? {}) } as Partial<ProjectFeatures>;
  for (const key of Object.keys(detected) as (keyof ProjectFeatures)[]) {
    if (typeof features[key] !== "boolean") features[key] = detected[key];
  }

  return {
    schemaVersion,
    locale: (raw.locale as Locale) ?? "th",
    srcDir,
    appDir,
    alias: raw.alias ?? "@",
    packageManager: (raw.packageManager as PackageManager) ?? detectPackageManager(projectDir),
    features: features as ProjectFeatures,
    ...(raw.scaffoldVersion ? { scaffoldVersion: raw.scaffoldVersion } : {}),
  };
}

export function setFeature(projectDir: string, feature: keyof ProjectFeatures, value: boolean): void {
  const config = readConfig(projectDir);
  writeConfig(projectDir, { ...config, features: { ...config.features, [feature]: value } });
}
