#!/usr/bin/env node

// Refuses to publish anything the git history does not vouch for.
//
// Every check here exists because the mistake it catches is silent: npm takes
// whatever `package.json` says, so a tag that disagrees with it, or a publish
// from a dirty tree, produces a version on the registry that no commit
// corresponds to — and the only way to fix a wrong version is to publish
// another one.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// pnpm keeps the argument separator when it forwards script arguments, so
// accept both `node scripts/check-release.mjs v0.1.0` and
// `pnpm run release:check -- v0.1.0`.
const args = process.argv.slice(2).filter((arg) => arg !== "--");

function git(...rest) {
  return execFileSync("git", rest, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fail(message) {
  console.error(`release check failed: ${message}`);
  process.exit(1);
}

if (args.length > 1) fail("expected at most one tag argument, for example v0.1.0");

// With no argument, derive the tag from HEAD. Exactly one release tag has to
// point at it: zero means someone is publishing an untagged commit, and more
// than one means the intended version is genuinely ambiguous.
let tag = args[0] ?? process.env.RELEASE_TAG;
if (!tag) {
  const atHead = git("tag", "--points-at", "HEAD", "--list", "v*.*.*")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);

  if (atHead.length !== 1) {
    fail(
      atHead.length === 0
        ? "HEAD has no release tag; publish only from an exact vX.Y.Z tag"
        : `HEAD has multiple release tags: ${atHead.join(", ")}`
    );
  }
  tag = atHead[0];
}

const SEMVER_TAG =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
if (!SEMVER_TAG.test(tag)) fail(`"${tag}" is not a valid release tag; expected vX.Y.Z`);

const expected = tag.slice(1);
if (packageJson.version !== expected) {
  fail(`package.json has ${packageJson.version}, but ${tag} requires ${expected}`);
}

let tagType;
let tagCommit;
try {
  tagType = git("cat-file", "-t", `refs/tags/${tag}`);
  tagCommit = git("rev-parse", `refs/tags/${tag}^{commit}`);
} catch {
  fail(`tag ${tag} is not available in this checkout (fetch tags, or check the name)`);
}

// Annotated only. A lightweight tag carries no author, date or message, so
// there is nothing recording who cut the release or why.
if (tagType !== "tag") fail(`${tag} must be an annotated tag; lightweight tags are not accepted`);

const head = git("rev-parse", "HEAD");
if (tagCommit !== head) {
  fail(`${tag} points at ${tagCommit.slice(0, 12)}, but HEAD is ${head.slice(0, 12)}`);
}

// A dirty tree means the tarball would contain something no commit has.
if (git("status", "--porcelain")) fail("working tree is not clean");

// The files field decides what ships. A missing entry is not a build error —
// it is a package that installs and then cannot find its own templates.
const files = packageJson.files ?? [];
const missing = ["dist", "templates", "bin"].filter((entry) => !files.includes(entry));
if (missing.length > 0) {
  fail(`package.json "files" is missing ${missing.join(", ")} — the published package would be unusable`);
}

console.log(`release check passed: ${packageJson.name}@${packageJson.version} <- ${tag} (${head.slice(0, 12)})`);
