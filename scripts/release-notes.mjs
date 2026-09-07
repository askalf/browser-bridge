// Extract one version's section from CHANGELOG.md for the GitHub release body.
//
//   node scripts/release-notes.mjs 0.2.0            # writes release-notes.md
//   node scripts/release-notes.mjs 0.2.0 --stdout   # prints instead
//
// Line-based on purpose: the previous inline RegExp had `(?=\n## \[|$)` under the
// `m` flag, and `$` matched the blank line right after the heading, so the lazy
// group was always empty and every release shipped the "Release vX.Y.Z" fallback.
// Splitting on lines has no escaping layers to get wrong and is tested in
// test/release-notes.test.mjs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function extractSection(md, version) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return "";
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

export function releaseNotes(md, version) {
  return extractSection(md, version) || `Release v${version}`;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const version = process.argv[2] || process.env.VERSION;
  if (!version) {
    console.error("usage: node scripts/release-notes.mjs <version> [--stdout]");
    process.exit(2);
  }
  const md = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "";
  if (!extractSection(md, version)) console.error(`warning: no "## [${version}]" section in CHANGELOG.md; using fallback body`);
  const body = releaseNotes(md, version) + "\n";
  if (process.argv.includes("--stdout")) process.stdout.write(body);
  else writeFileSync("release-notes.md", body);
}
