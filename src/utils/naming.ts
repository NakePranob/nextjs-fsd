import { Naming } from "../types";

export function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function toPascalCase(value: string): string {
  return toKebabCase(value)
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// A slice name becomes three things at once: a directory, a file prefix, and a
// PascalCase component identifier. Only the identifier can be illegal, and it
// fails at type-check time in a file nobody wrote by hand — so reject it here,
// where the message can still name the input.
export function validateSliceName(raw: string): string | true {
  const kebab = toKebabCase(raw);
  if (!kebab) return `invalid name "${raw}" — use letters and numbers, e.g. "reset-password"`;
  if (/^[0-9]/.test(kebab)) {
    return `"${kebab}" starts with a digit — the component would be \`export function ${toPascalCase(raw)}Page\`, which is not a valid identifier; pick another name`;
  }
  return true;
}

export function resolveNaming(raw: string): Naming {
  const check = validateSliceName(raw);
  if (check !== true) throw new Error(check);
  const name = toKebabCase(raw);
  return {
    name,
    directory: name,
    pascal: toPascalCase(name),
    camel: toCamelCase(name),
    screaming: name.replace(/-/g, "_").toUpperCase(),
  };
}

/**
 * Validate a slice name that may include optional group folders, for example
 * `employee/employee-record`. Groups are directories only; the final part is
 * still the slice name used for generated files and identifiers.
 */
export function validateSlicePath(raw: string): string | true {
  const value = raw.trim();
  if (!value || value.includes("\\")) {
    return `invalid slice path "${raw}" — use kebab-case parts separated by "/", e.g. "employee/employee-record"`;
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "")) {
    return `invalid slice path "${raw}" — group and slice names cannot be empty`;
  }
  for (const part of parts) {
    const check = validateSliceName(part);
    if (check !== true) return check;
  }
  return true;
}

export function resolveSliceNaming(raw: string): Naming {
  const check = validateSlicePath(raw);
  if (check !== true) throw new Error(check);
  const directory = raw
    .trim()
    .split("/")
    .map((part) => toKebabCase(part))
    .join("/");
  const naming = resolveNaming(directory.split("/").at(-1)!);
  return { ...naming, directory };
}

// App Router path for a page slice. Route groups stay verbatim — "(admin)"
// is a real directory Next.js reads and strips from the URL, so a caller
// passing `--route "(admin)/dashboard"` means exactly that.
export function normalizeRoute(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
  return trimmed;
}

const ROUTE_SEGMENT = /^(\([^()/]+\)|\[\[?\.{3}[A-Za-z][A-Za-z0-9_]*\]?\]|\[[A-Za-z][A-Za-z0-9_]*\]|@[a-z0-9-]+|[a-z0-9][a-z0-9._-]*)$/;

// Every segment either is a literal path piece or one of the App Router's own
// bracket forms. Validated because the segments become real directories: a
// stray "/" or space produces a route that never matches and a directory
// nobody expected.
export function validateRoute(raw: string): string | true {
  const route = normalizeRoute(raw);
  if (route === "") return true; // "" means the root route, app/page.tsx
  const bad = route.split("/").find((segment) => !ROUTE_SEGMENT.test(segment));
  if (bad !== undefined) {
    return `invalid route segment "${bad}" in "${route}" — use lowercase path segments, a route group "(admin)", a dynamic "[id]", or a catch-all "[...slug]"`;
  }
  return true;
}
