export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

/** Layers a slice can be generated into. `_app`/`_pages` are not here — they
 *  are created by `init` and `generate page`, not by `generate slice`. */
export type SliceLayer = "features" | "entities" | "widgets";

export const SLICE_LAYERS: SliceLayer[] = ["features", "entities", "widgets"];

/** FSD segments. A slice gets only the ones it actually has code for —
 *  an empty segment folder is noise. */
export type Segment = "ui" | "model" | "api" | "lib";

export const SEGMENTS: Segment[] = ["ui", "model", "api", "lib"];

export interface ProjectFeatures {
  /** shared/api: ApiError, catalogs, resolver, axios client, QueryClient. */
  errorHandling: boolean;
  /** shared/auth: access token, session hooks, require-session, login page. */
  auth: boolean;
}

export interface ProjectConfig {
  schemaVersion: number;
  /** Language the generated user-facing copy is written in. */
  locale: "th" | "en";
  /** Where the FSD layers live, relative to the project root. Always "src". */
  srcDir: string;
  /** Next.js App Router directory: "app" or "src/app", whichever exists. */
  appDir: string;
  /** tsconfig path alias that points at srcDir, without the "/*". */
  alias: string;
  packageManager: PackageManager;
  features: ProjectFeatures;
  /** CLI version that last wrote this file — for diagnosing template drift. */
  scaffoldVersion?: string;
}

export interface Naming {
  /** kebab-case: directory and file name — "reset-password". */
  name: string;
  /** PascalCase: component/type identifier — "ResetPassword". */
  pascal: string;
  /** camelCase: hook/variable identifier — "resetPassword". */
  camel: string;
  /** SCREAMING_SNAKE: error-code prefix — "RESET_PASSWORD". */
  screaming: string;
}
