import { spawn } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";
import readline from "readline";

import { cliVersion } from "../utils/version";

/**
 * A stdio MCP server that routes tool calls back into this CLI.
 *
 * The tools spawn the real binary instead of importing command functions: the
 * CLI already prints JSON for the agent commands, and spawning keeps the
 * process boundary that makes `apply` stop on the first failing step. Nothing
 * is reimplemented here — a tool with no matching command would be a second
 * source of truth for scaffolding rules.
 */

export interface McpServerOptions {
  root?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS: ToolDefinition[] = [
  {
    name: "fsd_interview",
    description: "Return the nextjs-fsd interview questions as JSON. Writes nothing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "fsd_plan",
    description: "Resolve answers and print the scaffold plan. Writes no project files.",
    inputSchema: {
      type: "object",
      properties: {
        answers: { type: "object", description: "The answers object accepted by `nextjs-fsd plan --answers`." },
      },
      required: ["answers"],
      additionalProperties: false,
    },
  },
  {
    name: "fsd_apply",
    description: "Run the plan built from the same answers object used by fsd_plan.",
    inputSchema: {
      type: "object",
      properties: {
        answers: { type: "object", description: "The answers object accepted by `nextjs-fsd apply --answers`." },
      },
      required: ["answers"],
      additionalProperties: false,
    },
  },
  {
    name: "fsd_check",
    description: "Check the project's config, feature flags, contract, and generated guidance.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "fsd_config_show",
    description: "Print the resolved nextjs-fsd.config.json for the server root.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

class McpToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "McpToolError";
  }
}

function resolveRoot(input: string | undefined): string {
  const base = process.cwd();
  const root = path.resolve(base, input ?? ".");
  if (root !== base && !root.startsWith(`${base}${path.sep}`)) {
    throw new McpToolError("OUTSIDE_ROOT", `root must stay inside ${base} (got ${root})`);
  }
  return root;
}

function cliPath(): string {
  return path.resolve(__dirname, "..", "..", "bin", "nextjs-fsd.js");
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

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new McpToolError("INVALID_CLI_OUTPUT", `${label} did not return JSON: ${text.trim()}`);
  }
}

function answersObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpToolError("INVALID_PARAMS", "answers must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function withAnswersFile<T>(answers: unknown, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextjs-fsd-mcp-"));
  const file = path.join(dir, "answers.json");
  fs.writeJsonSync(file, answersObject(answers), { spaces: 2 });
  try {
    return await fn(file);
  } finally {
    fs.removeSync(dir);
  }
}

async function callTool(name: string, args: Record<string, unknown>, root: string): Promise<unknown> {
  if (name === "fsd_interview") {
    const result = await runCli(root, ["interview"]);
    if (result.code !== 0) throw new McpToolError("CLI_FAILED", result.stderr || result.stdout);
    return parseJson(result.stdout, "interview");
  }

  if (name === "fsd_plan") {
    return withAnswersFile(args.answers, async (file) => {
      const result = await runCli(root, ["plan", "--answers", file]);
      if (result.code !== 0) throw new McpToolError("CLI_FAILED", result.stderr || result.stdout);
      return parseJson(result.stdout, "plan");
    });
  }

  if (name === "fsd_apply") {
    return withAnswersFile(args.answers, async (file) => {
      const result = await runCli(root, ["apply", "--answers", file]);
      const payload = parseJson(result.stdout, "apply") as { ok?: boolean; warnings?: string[] };
      if (result.code !== 0 || payload.ok !== true) {
        const detail = (payload.warnings ?? []).join("; ") || result.stderr.trim() || "apply failed";
        throw new McpToolError("APPLY_FAILED", detail);
      }
      return payload;
    });
  }

  if (name === "fsd_check") {
    const result = await runCli(root, ["check"]);
    // check answers with a JSON report even when it finds problems; returning it
    // is more useful to an agent than a transport error that drops the checks.
    return parseJson(result.stdout, "check");
  }

  if (name === "fsd_config_show") {
    const result = await runCli(root, ["config", "show", "--json"]);
    if (result.code !== 0) throw new McpToolError("CLI_FAILED", result.stderr || result.stdout);
    return parseJson(result.stdout, "config show");
  }

  throw new McpToolError("UNKNOWN_TOOL", `unknown tool: ${name}`);
}

function writeResponse(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function errorResponse(id: string | number | null | undefined, code: number, message: string): void {
  writeResponse({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export function startMcpServer(options: McpServerOptions = {}): void {
  const root = resolveRoot(options.root);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      errorResponse(null, -32700, "parse error");
      return;
    }
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      errorResponse(request.id, -32600, "invalid request");
      return;
    }
    if (request.id === undefined) return; // notification
    const params = request.params ?? {};
    if (request.method === "initialize") {
      writeResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "nextjs-fsd-mcp", version: cliVersion() },
        },
      });
      return;
    }
    if (request.method === "ping") {
      writeResponse({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    }
    if (request.method === "tools/list") {
      writeResponse({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } });
      return;
    }
    if (request.method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        typeof params.arguments === "object" && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      callTool(name, args, root)
        .then((result) => {
          writeResponse({
            jsonrpc: "2.0",
            id: request.id,
            result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
          });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          writeResponse({
            jsonrpc: "2.0",
            id: request.id,
            result: { content: [{ type: "text", text: message }], isError: true },
          });
        });
      return;
    }
    errorResponse(request.id, -32601, `method not found: ${request.method}`);
  });
}
