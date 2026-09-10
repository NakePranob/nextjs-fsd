// The slow, high-fidelity check: a real create-next-app, a real install, a
// real `next build` and `lint`.
//
// Deliberately not part of `pnpm test`. The smoke test type-checks generated
// output against this repo's own node_modules, which is fast and offline but
// cannot see two things: a dependency range that does not resolve (the fixture
// borrows packages it never installed), and a Next.js release that changes
// behaviour under us. Both need the real thing, and the real thing costs
// minutes and a network — so it runs on demand and in CI, not on every save.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "bin", "nextjs-fsd.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nextjs-fsd-integration-"));
const keep = process.argv.includes("--keep");

// One entry per shape that changes what the CLI writes: where the App Router
// lives, and which package manager (which decides whether a test file is
// generated at all).
const MATRIX = [
  { name: "app-npm", srcDir: false, manager: "npm", locale: "th" },
  { name: "src-bun", srcDir: true, manager: "bun", locale: "en" },
];

let failures = 0;

function run(command, args, cwd, label) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    failures += 1;
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    console.log(`  FAIL ${label}\n${output.split("\n").slice(-25).map((line) => `       ${line}`).join("\n")}`);
    return null;
  }
}

function ok(label) {
  console.log(`  ok   ${label}`);
}

for (const entry of MATRIX) {
  console.log(`\n${entry.name} (${entry.manager}, ${entry.srcDir ? "src/app" : "app"}, locale ${entry.locale})`);
  const dir = path.join(root, entry.name);

  const created = run(
    "npx",
    [
      "--yes",
      "create-next-app@latest",
      dir,
      "--ts",
      "--app",
      "--tailwind",
      "--eslint",
      entry.srcDir ? "--src-dir" : "--no-src-dir",
      "--disable-git",
      `--use-${entry.manager}`,
      "--yes",
    ],
    root,
    `${entry.name}: create-next-app`
  );
  if (created === null) continue;
  ok(`${entry.name}: create-next-app`);

  // The CLI installs on its own here — that is the point of this test.
  const steps = [
    ["init", "--locale", entry.locale, "--defaults"],
    // Early on purpose. It puts `prettier --check .` on the lint script, so
    // everything generated after it has to come out formatted — which is the
    // thing worth proving, and only a real install and a real lint can.
    ["add", "prettier", "-y"],
    ["add", "auth", "-y"],
    ["generate", "layout", "admin", "--defaults"],
    ["generate", "page", "dashboard", "--auth", "--route", "(admin)/dashboard", "--errors", "--defaults"],
    ["generate", "slice", "entities", "loan", "--segments", "ui,api,lib", "--errors", "--defaults"],
    // Extending an existing slice, which is a different code path.
    ["generate", "slice", "entities", "loan", "--segments", "ui,api,lib,model", "--defaults"],
  ];
  let generated = true;
  for (const args of steps) {
    if (run(process.execPath, [CLI, ...args], dir, `${entry.name}: ${args.join(" ")}`) === null) {
      generated = false;
      break;
    }
  }
  if (!generated) continue;
  ok(`${entry.name}: init + add + generate`);

  // A generated slice has no consumer, and steiger warns about that by design;
  // give the page one so `lint` is checked against a realistic tree.
  const pagesDir = path.join(dir, "src", "_pages", "dashboard", "ui");
  fs.writeFileSync(
    path.join(pagesDir, "dashboard-content.tsx"),
    '"use client";\n\n' +
      'import { Loan, useLoanQuery, type LoanRecord } from "@/entities/loan";\n' +
      'import { useRequireSession } from "@/shared/auth";\n\n' +
      "export function DashboardContent() {\n" +
      "  const session = useRequireSession();\n" +
      "  const loans = useLoanQuery();\n" +
      "  const rows: LoanRecord[] = loans.data ?? [];\n" +
      '  if (session.isPending || session.isError) return <p className="text-sm">…</p>;\n' +
      "  return (\n    <div>\n      {rows.map((row) => (\n        <Loan key={row.id} />\n      ))}\n    </div>\n  );\n}\n"
  );

  const runner = entry.manager === "bun" ? "bunx" : "npx";
  // This fixture is the test's own hand-written file, not the CLI's output —
  // format it so `prettier --check .` below is checking generated code only.
  run(runner, ["prettier", "--write", path.join("src", "_pages", "dashboard", "ui", "dashboard-content.tsx")], dir,
      `${entry.name}: format the hand-written fixture`);

  if (run(runner, ["next", "build"], dir, `${entry.name}: next build`) !== null) ok(`${entry.name}: next build`);
  if (run(entry.manager === "bun" ? "bun" : "npm", ["run", "lint"], dir, `${entry.name}: lint`) !== null) {
    ok(`${entry.name}: lint`);
  }
  if (entry.manager === "bun" && run("bun", ["test"], dir, `${entry.name}: bun test`) !== null) {
    ok(`${entry.name}: bun test`);
  }
}

if (keep) {
  console.log(`\nkept ${root}`);
} else {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nintegration test passed" : `\nintegration test: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
