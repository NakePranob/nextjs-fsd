import path from "path";
import nodeFs from "fs";
import fs from "fs-extra";

// cliVersion reads this CLI's own version out of its package.json — one source
// of truth for `--version` and for the stamp written into a project's
// nextjs-fsd.config.json. Two candidates because __dirname is dist/utils when
// installed and src/utils when running from a checkout.
export function cliVersion(): string {
  const candidates = [
    path.join(__dirname, "..", "..", "package.json"),
    path.join(__dirname, "..", "..", "..", "package.json"),
  ];
  const resolved = candidates.find((candidate) => nodeFs.existsSync(candidate));
  if (!resolved) throw new Error("unable to locate package.json");
  return fs.readJsonSync(resolved).version as string;
}
