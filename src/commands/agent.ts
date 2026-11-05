import { spawn } from "child_process";
import path from "path";
import fs from "fs-extra";

import { Locale } from "../utils/copy";
import { ProjectConfig, ProjectFeatures } from "../types";
import { detectFeatures, isProjectDir, readConfig } from "../utils/config";
import { readHttpContract } from "../utils/http-contract";
import { cliVersion } from "../utils/version";

/**
 * The agent interface: one interview, one plan, one apply.
 *
 * These commands are a thin router over the CLI that already exists. They do not
 * generate files themselves — plan validates and prints the exact commands it
 * would run, apply spawns those same commands. Keeping one implementation of
 * each action is the point: a second generator here would drift from `init`,
 * `add`, and `generate` the first time either side changed.
 */

export type AddTarget = "error-handling" | "auth" | "prettier";

export interface GenerateAnswers {
  kind: "page" | "slice" | "layout" | "api-route";
  name: string;
  /** slice only. */
  layer?: "features" | "entities" | "widgets";
  segments?: string[];
  title?: string;
  route?: string | false;
  client?: boolean;
  auth?: boolean;
  api?: boolean;
  model?: boolean;
  errors?: boolean;
  guard?: boolean;
}

export interface AgentAnswers {
  init?: boolean;
  locale?: Locale;
  install?: boolean;
  hooks?: boolean;
  httpContract?: string;
  add?: AddTarget[];
  generate?: GenerateAnswers[];
}

export interface PlanStep {
  id: string;
  description: string;
  command: string[];
}

export interface Plan {
  schemaVersion: 1;
  writes: false;
  root: string;
  initialized: boolean;
  contract?: { file: string; preset: string; resolved: { single: string; list: string; error: string }; presetHash: string };
  steps: PlanStep[];
  warnings: string[];
}

const ADD_TARGETS: readonly AddTarget[] = ["error-handling", "auth", "prettier"];
const GENERATE_KINDS: readonly GenerateAnswers["kind"][] = ["page", "slice", "layout", "api-route"];
const SLICE_LAYERS: readonly NonNullable<GenerateAnswers["layer"]>[] = ["features", "entities", "widgets"];

function cliPath(): string {
  return path.resolve(__dirname, "..", "..", "bin", "nextjs-fsd.js");
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false`);
  return value;
}

function parseAnswers(raw: unknown): AgentAnswers {
  const value = expectObject(raw, "answers");
  const answers: AgentAnswers = {};

  answers.init = optionalBoolean(value.init, "init");
  answers.install = optionalBoolean(value.install, "install");
  answers.hooks = optionalBoolean(value.hooks, "hooks");
  if (value.locale !== undefined) {
    if (value.locale !== "th" && value.locale !== "en") throw new Error('locale must be "th" or "en"');
    answers.locale = value.locale;
  }
  if (value.httpContract !== undefined) answers.httpContract = expectString(value.httpContract, "httpContract");

  if (value.add !== undefined) {
    if (!Array.isArray(value.add)) throw new Error("add must be an array");
    const seen = new Set<AddTarget>();
    for (const target of value.add) {
      if (typeof target !== "string" || !ADD_TARGETS.includes(target as AddTarget)) {
        throw new Error(`add entries must be one of: ${ADD_TARGETS.join(", ")}`);
      }
      if (!seen.has(target as AddTarget)) seen.add(target as AddTarget);
    }
    answers.add = [...seen];
  }

  if (value.generate !== undefined) {
    if (!Array.isArray(value.generate)) throw new Error("generate must be an array");
    answers.generate = value.generate.map((entry, index) => parseGenerate(entry, `generate[${index}]`));
  }

  return answers;
}

function parseGenerate(raw: unknown, label: string): GenerateAnswers {
  const value = expectObject(raw, label);
  const kind = expectString(value.kind, `${label}.kind`) as GenerateAnswers["kind"];
  if (!GENERATE_KINDS.includes(kind)) {
    throw new Error(`${label}.kind must be one of: ${GENERATE_KINDS.join(", ")}`);
  }
  const step: GenerateAnswers = { kind, name: expectString(value.name, `${label}.name`) };

  if (value.layer !== undefined) {
    const layer = expectString(value.layer, `${label}.layer`) as NonNullable<GenerateAnswers["layer"]>;
    if (!SLICE_LAYERS.includes(layer)) {
      throw new Error(`${label}.layer must be one of: ${SLICE_LAYERS.join(", ")}`);
    }
    step.layer = layer;
  }
  if (kind === "slice" && !step.layer) throw new Error(`${label}.layer is required for a slice`);

  if (value.segments !== undefined) {
    if (!Array.isArray(value.segments) || value.segments.some((segment) => typeof segment !== "string")) {
      throw new Error(`${label}.segments must be an array of strings`);
    }
    step.segments = value.segments as string[];
  }
  if (value.title !== undefined) step.title = expectString(value.title, `${label}.title`);
  if (value.route === false) step.route = false;
  else if (value.route !== undefined) step.route = expectString(value.route, `${label}.route`);
  for (const field of ["client", "auth", "api", "model", "errors", "guard"] as const) {
    step[field] = optionalBoolean(value[field], `${label}.${field}`);
  }
  return step;
}

export function readAnswersFile(file: string): AgentAnswers {
  const text = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(file), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: answers are not valid JSON (${(error as Error).message})`);
  }
  return parseAnswers(parsed);
}

/** The answers object the MCP server writes to a temp file. */
export function answersFromObject(raw: unknown): AgentAnswers {
  return parseAnswers(raw);
}

function addCommand(target: AddTarget, answers: AgentAnswers, root: string): string[] {
  const args = ["add", target, "-y"];
  if (answers.install === false) args.push("--no-install");
  if (target === "error-handling" && answers.httpContract) {
    args.push("--http-contract", path.resolve(root, answers.httpContract));
  }
  return args;
}

function generateCommand(step: GenerateAnswers): string[] {
  const args =
    step.kind === "slice"
      ? ["generate", "slice", step.layer!, step.name, "--defaults"]
      : ["generate", step.kind, step.name, "--defaults"];
  if (step.kind === "slice") args.push("--segments", (step.segments?.length ? step.segments : ["ui"]).join(","));
  if (step.kind === "page") {
    if (step.title) args.push("--title", step.title);
    if (step.client) args.push("--client");
    if (step.auth) args.push("--auth");
    if (step.api) args.push("--api");
    if (step.model) args.push("--model");
    if (step.errors) args.push("--errors");
  }
  if (step.kind === "slice" && step.errors) args.push("--errors");
  if (step.kind === "layout") {
    if (step.guard) args.push("--guard");
  }
  if (step.route === false) args.push("--no-route");
  else if (step.route) args.push("--route", step.route);
  return args;
}

function generateId(step: GenerateAnswers): string {
  return `generate-${step.kind}-${step.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/**
 * Builds the plan without writing anything.
 *
 * Feature dependencies are resolved here rather than left to the caller: `add
 * auth` installs error handling itself, but a plan that lists only `add auth`
 * would hide a file-writing step from the confirmation it exists for. The same
 * applies to an HTTP contract, which only `add error-handling` can install.
 */
export function buildPlan(answers: AgentAnswers, root: string): Plan {
  const initialized = isProjectDir(root);
  const warnings: string[] = [];
  const steps: PlanStep[] = [];
  const config = initialized ? readConfig(root) : undefined;

  let contract: Plan["contract"];
  if (answers.httpContract) {
    const artifact = readHttpContract(path.resolve(root, answers.httpContract));
    contract = {
      file: path.resolve(root, answers.httpContract),
      preset: artifact.preset,
      resolved: artifact.resolved,
      presetHash: artifact.presetHash,
    };
  }

  const wantsInit = answers.init !== false;
  if (wantsInit && !initialized) {
    const args = ["init", "--defaults"];
    if (answers.locale) args.push("--locale", answers.locale);
    if (answers.install === false) args.push("--no-install");
    if (answers.hooks === false) args.push("--no-hooks");
    steps.push({ id: "init", description: "shape the App Router project into FSD layers", command: args });
  } else if (initialized) {
    warnings.push("init skipped — nextjs-fsd.config.json already exists");
  } else {
    throw new Error("this is not a nextjs-fsd project; set init true or run `nextjs-fsd init` first");
  }

  const requested = new Set(answers.add ?? []);
  const features: ProjectFeatures = config?.features ?? { errorHandling: false, auth: false, prettier: false };
  if (contract && !features.errorHandling) requested.add("error-handling");
  if (requested.has("auth") && !features.errorHandling) requested.add("error-handling");

  for (const target of ADD_TARGETS) {
    if (!requested.has(target)) continue;
    const installed = features[target === "error-handling" ? "errorHandling" : target];
    if (installed) {
      warnings.push(`add ${target} skipped — already installed`);
      if (target === "error-handling" && contract) {
        warnings.push("the HTTP contract was not applied: remove shared/api and re-run `add error-handling --http-contract` to change it");
      }
      continue;
    }
    steps.push({
      id: `add-${target}`,
      description:
        target === "error-handling"
          ? "install shared/api with the response parsers for the selected contract"
          : target === "auth"
            ? "install the session flow and login page"
            : "install prettier and the Tailwind class-sorting plugin",
      command: addCommand(target, answers, root),
    });
  }

  for (const step of answers.generate ?? []) {
    steps.push({ id: generateId(step), description: `generate ${step.kind} ${step.name}`, command: generateCommand(step) });
  }

  if (contract && contract.preset !== "default") {
    warnings.push(
      `the contract preset "${contract.preset}" is remembered in nextjs-fsd.config.json; keep http-contract.json with the API so later installs use the same shapes`
    );
  }

  return {
    schemaVersion: 1,
    writes: false,
    root,
    initialized,
    ...(contract ? { contract } : {}),
    steps,
    warnings,
  };
}

export function planAnswers(file: string, root: string): Plan {
  return buildPlan(readAnswersFile(file), root);
}

export interface StepResult {
  id: string;
  command: string[];
  ok: boolean;
  /** True when the step had nothing left to do and the CLI said so. */
  skipped?: boolean;
  stdout: string;
  stderr: string;
}

export interface ApplyResult {
  schemaVersion: 1;
  ok: boolean;
  root: string;
  steps: StepResult[];
  warnings: string[];
}

function runCli(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath(), ...args], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Applies the same plan, one command at a time, and stops at the first failure.
 *
 * Stopping is deliberate: the steps depend on each other (`add auth` needs the
 * client from `add error-handling`; a generate needs the layers `init` writes),
 * so continuing past a failure would only produce a second, unrelated error.
 */
export async function applyAnswers(file: string, root: string): Promise<ApplyResult> {
  const plan = buildPlan(readAnswersFile(file), root);
  const steps: StepResult[] = [];
  for (const step of plan.steps) {
    const result = await runCli(root, step.command);
    // A retried apply reaches a generate step whose output already exists. The
    // generator refuses rather than silently doing nothing, which is right for
    // a human — but for a plan replay it is the success case. Match the two
    // messages that mean "there was nothing left to write"; anything else is a
    // real failure and stops the run.
    const benign =
      result.code !== 0 &&
      /already has everything this would write|already has every segment this would write|already exists and is already applied at|already exists and is already served/.test(
        result.stderr
      );
    steps.push({
      id: step.id,
      command: step.command,
      ok: result.code === 0 || benign,
      ...(benign ? { skipped: true } : {}),
      stdout: result.stdout,
      stderr: result.stderr,
    });
    if (result.code !== 0 && !benign) break;
  }
  return {
    schemaVersion: 1,
    ok: steps.length === plan.steps.length && steps.every((step) => step.ok),
    root,
    steps,
    warnings: plan.warnings,
  };
}

export interface CheckResult {
  schemaVersion: 1;
  ok: boolean;
  initialized: boolean;
  root: string;
  checks: Array<{ id: string; ok: boolean; detail: string; warning?: boolean }>;
  warnings: string[];
  config?: {
    locale: string;
    srcDir: string;
    appDir: string;
    alias: string;
    features: ProjectFeatures;
    http: { preset: string; resolved: { single: string; list: string; error: string }; presetHash: string };
  };
}

/**
 * Verifies the state an agent would otherwise infer by reading files itself:
 * config present, feature flags match disk, and the recorded contract is one the
 * config accepts. Findings that only cost convenience (a missing skill or
 * linter) are warnings; a feature flag pointing at missing files is a failure,
 * because every gate downstream reads it.
 */
export function checkProject(root: string): CheckResult {
  const checks: CheckResult["checks"] = [];
  const warnings: string[] = [];
  const base = { schemaVersion: 1 as const, root };

  if (!isProjectDir(root)) {
    return {
      ...base,
      ok: false,
      initialized: false,
      checks: [{ id: "config", ok: false, detail: "nextjs-fsd.config.json not found — run `nextjs-fsd init`" }],
      warnings,
    };
  }

  let config: ProjectConfig;
  try {
    config = readConfig(root);
    checks.push({ id: "config", ok: true, detail: "nextjs-fsd.config.json is valid" });
  } catch (error) {
    return {
      ...base,
      ok: false,
      initialized: true,
      checks: [{ id: "config", ok: false, detail: (error as Error).message }],
      warnings,
    };
  }

  const exists = (relative: string) => fs.existsSync(path.join(root, relative));
  const appDirOk = exists(config.appDir);
  checks.push({ id: "app-dir", ok: appDirOk, detail: `${config.appDir} ${appDirOk ? "exists" : "is missing"}` });

  const detected = detectFeatures(root, config.srcDir);
  for (const [feature, relative] of [
    ["errorHandling", `${config.srcDir}/shared/api/client.ts`],
    ["auth", `${config.srcDir}/shared/auth/session.ts`],
  ] as const) {
    const expected = config.features[feature];
    const fileExists = exists(relative);
    if (expected && !fileExists) {
      checks.push({ id: feature, ok: false, detail: `config says installed but ${relative} is missing` });
    } else if (!expected && fileExists) {
      warnings.push(`config says ${feature} is not installed but ${relative} exists — run \`nextjs-fsd config show\` to inspect it`);
    } else {
      checks.push({ id: feature, ok: true, detail: expected ? "installed" : "not installed" });
    }
  }
  if (config.features.prettier !== detected.prettier) {
    warnings.push("the prettier flag and the prettier config on disk disagree");
  }

  const skill = `.agents/skills/nextjs-fsd/SKILL.md`;
  if (!exists(skill)) warnings.push(`${skill} is missing — regenerate it with \`nextjs-fsd init\` in a fresh project`);
  const steiger = exists("steiger.config.ts");
  if (!steiger) warnings.push("steiger.config.ts is missing — the FSD boundary check is not wired");

  checks.push({
    id: "contract",
    ok: true,
    detail: `${config.http.preset} (${config.http.resolved.single} / ${config.http.resolved.list} / ${config.http.resolved.error})`,
  });

  return {
    ...base,
    ok: checks.every((check) => check.ok),
    initialized: true,
    checks,
    warnings,
    config: {
      locale: config.locale,
      srcDir: config.srcDir,
      appDir: config.appDir,
      alias: config.alias,
      features: config.features,
      http: config.http,
    },
  };
}

export function interview(): unknown {
  return {
    schemaVersion: 1,
    cliVersion: cliVersion(),
    questions: [
      {
        id: "project.locale",
        type: "select",
        question: "Language for generated user-facing copy",
        options: [
          { value: "th", label: "Thai" },
          { value: "en", label: "English" },
        ],
        default: "th",
      },
      {
        id: "project.install",
        type: "confirm",
        question: "Install dependencies after writing files?",
        description: "Pass false in an environment with no network; install later yourself.",
        default: true,
      },
      {
        id: "project.hooks",
        type: "confirm",
        question: "Install the commit-msg hook?",
        default: true,
      },
      {
        id: "http.contract",
        type: "text",
        question: "Path to the Go API's http-contract.json (leave blank for the default preset)",
        description:
          "go-scaffold writes this file at the API project root. It decides the single/list/error response shapes the generated client understands.",
        required: false,
      },
      {
        id: "features.add",
        type: "multiselect",
        question: "Which shared features should be installed?",
        options: [
          { value: "error-handling", label: "Error handling + API client" },
          { value: "auth", label: "Auth session and login page" },
          { value: "prettier", label: "Prettier with Tailwind sorting" },
        ],
        default: ["error-handling"],
      },
    ],
  };
}
