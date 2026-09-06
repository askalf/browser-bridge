// scripts/release-notes.mjs — the release workflow's changelog extraction.
// Runs against the REAL CHANGELOG.md plus synthetic edge cases, so a tag can
// never ship the "Release vX.Y.Z" fallback while a section for it exists
// (every release up to v0.5.1 did exactly that: the inline regex's `|$` under
// the `m` flag matched the blank line after the heading and captured nothing).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractSection, releaseNotes } from "../scripts/release-notes.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const pkgVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("package.json version has a CHANGELOG section (the release workflow reads it)", () => {
  const body = extractSection(changelog, pkgVersion);
  assert.ok(body.length > 0, `no "## [${pkgVersion}]" section in CHANGELOG.md`);
  assert.equal(releaseNotes(changelog, pkgVersion), body, "fallback must not be used when a section exists");
});

test("section spans from its heading to the next version heading only", () => {
  const body = extractSection(changelog, "0.5.0");
  assert.match(body, /^### Added/, "starts with the first line after the heading");
  assert.doesNotMatch(body, /^## \[/m, "must not include a following version heading");
  assert.doesNotMatch(body, /\[0\.4\.0\] - /, "must not bleed into the 0.4.0 section");
});

test("blank line after the heading does not truncate the body (the bug the inline regex had)", () => {
  const md = "# Changelog\n\n## [1.2.3] - 2026-01-01\n\n### Added\n\n- thing\n\n## [1.2.2] - 2025-12-31\n\n- old\n";
  assert.equal(extractSection(md, "1.2.3"), "### Added\n\n- thing");
});

test("last section in the file runs to EOF", () => {
  const md = "## [1.0.0] - x\n- a\n\n## [0.9.0] - y\n\n- z\n";
  assert.equal(extractSection(md, "0.9.0"), "- z");
});

test("CRLF changelog is handled", () => {
  const md = "## [1.0.0] - 2026-01-01\r\n\r\n- a\r\n- b\r\n\r\n## [0.9.0]\r\n- z\r\n";
  assert.equal(extractSection(md, "1.0.0"), "- a\n- b");
});

test("version is matched literally, not as a regex", () => {
  const md = "## [1.0.0] - x\n- dot\n## [1x0x0] - y\n- letter\n";
  assert.equal(extractSection(md, "1x0x0"), "- letter");
  assert.equal(extractSection(md, "1.0.0"), "- dot");
});

test("missing section falls back to a plain title", () => {
  assert.equal(extractSection(changelog, "99.99.99"), "");
  assert.equal(releaseNotes(changelog, "99.99.99"), "Release v99.99.99");
});

test("CLI prints the same body the workflow will attach", () => {
  const out = execFileSync(process.execPath, ["scripts/release-notes.mjs", "0.5.0", "--stdout"], { cwd: root, encoding: "utf8" });
  assert.equal(out.trimEnd(), extractSection(changelog, "0.5.0"));
});
