import crypto from "crypto";
import fs from "fs-extra";
import type { ErrorShape, HttpContractConfig, ListShape, ResolvedHttpContract, SingleShape } from "../types";

export const SINGLE_SHAPES: readonly SingleShape[] = ["bare", "data"];
export const LIST_SHAPES: readonly ListShape[] = ["data-limit-offset-total", "data-meta", "items-total"];
export const ERROR_SHAPES: readonly ErrorShape[] = ["error-object", "errors-array", "problem-json"];

export interface HttpContractArtifact {
  schemaVersion: 1;
  projectName?: string;
  goModule?: string;
  apiPrefix?: string;
  preset: string;
  resolved: ResolvedHttpContract;
  presetHash: string;
}

export function hashResolved(resolved: ResolvedHttpContract): string {
  const canonical = JSON.stringify({
    single: resolved.single,
    list: resolved.list,
    error: resolved.error,
  });
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

export function defaultHttpContract(): HttpContractConfig {
  const resolved: ResolvedHttpContract = {
    single: "bare",
    list: "data-limit-offset-total",
    error: "error-object",
  };
  return { preset: "default", resolved, presetHash: hashResolved(resolved) };
}

function assertShape<T extends string>(value: unknown, allowed: readonly T[], field: string, file: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${file}: ${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function readHttpContract(filePath: string): HttpContractArtifact {
  const file = fs.readJsonSync(filePath) as Partial<HttpContractArtifact>;
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error(`${filePath}: contract must contain a JSON object`);
  }
  if (file.schemaVersion !== 1) throw new Error(`${filePath}: contract schemaVersion must be 1`);
  if (typeof file.preset !== "string" || !file.preset) throw new Error(`${filePath}: contract preset is required`);
  if (!file.resolved || typeof file.resolved !== "object") throw new Error(`${filePath}: contract resolved is required`);
  const resolved: ResolvedHttpContract = {
    single: assertShape(file.resolved.single, SINGLE_SHAPES, "resolved.single", filePath),
    list: assertShape(file.resolved.list, LIST_SHAPES, "resolved.list", filePath),
    error: assertShape(file.resolved.error, ERROR_SHAPES, "resolved.error", filePath),
  };
  const expected = hashResolved(resolved);
  if (file.presetHash !== expected) {
    throw new Error(`${filePath}: presetHash does not match resolved shapes (expected ${expected})`);
  }
  return {
    schemaVersion: 1,
    ...(file.projectName ? { projectName: file.projectName } : {}),
    ...(file.goModule ? { goModule: file.goModule } : {}),
    ...(file.apiPrefix ? { apiPrefix: file.apiPrefix } : {}),
    preset: file.preset,
    resolved,
    presetHash: expected,
  };
}

export function contractConfig(artifact: HttpContractArtifact): HttpContractConfig {
  return { preset: artifact.preset, resolved: artifact.resolved, presetHash: artifact.presetHash };
}

export function normalizeHttpContract(raw: unknown, file = "nextjs-fsd.config.json"): HttpContractConfig {
  if (raw === undefined) return defaultHttpContract();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file}: http must be an object`);
  }
  const value = raw as Partial<HttpContractConfig>;
  if (typeof value.preset !== "string" || !value.preset) throw new Error(`${file}: http.preset is required`);
  if (!value.resolved || typeof value.resolved !== "object") throw new Error(`${file}: http.resolved is required`);
  const resolved: ResolvedHttpContract = {
    single: assertShape(value.resolved.single, SINGLE_SHAPES, "http.resolved.single", file),
    list: assertShape(value.resolved.list, LIST_SHAPES, "http.resolved.list", file),
    error: assertShape(value.resolved.error, ERROR_SHAPES, "http.resolved.error", file),
  };
  const presetHash = hashResolved(resolved);
  if (value.presetHash !== presetHash) {
    throw new Error(`${file}: http.presetHash does not match resolved shapes (expected ${presetHash})`);
  }
  return { preset: value.preset, resolved, presetHash };
}
