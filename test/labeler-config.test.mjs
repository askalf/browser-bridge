// The labeler config is the kind of file that rots silently: a path glob that
// matches nothing still parses, still runs, and simply labels nothing forever.
// Nobody notices, because the symptom is an absence. This asserts every glob in
// .github/labeler.yml matches at least one tracked file, so moving or renaming a
// source file breaks CI instead of quietly retiring a label.
//
// Reads the YAML with a targeted regex rather than a parser: the repo ships no
// YAML dependency and this file's shape is fixed and simple. The structural
// assertions below fail loudly if that shape ever changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = readFileSync(path.join(root, '.github', 'labeler.yml'), 'utf8');

const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

// Minimal glob → RegExp for the subset the config uses: `**` (any depth,
// including none), `*` (one segment), and literals. Order matters — `**` must be
// consumed before `*`.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // `a/**` matches a/b and a/b/c; `**/x` matches x and a/x.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
      continue;
    }
    if (c === '*') {
      re += '[^/]*';
      continue;
    }
    re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Every quoted glob under a `- '…'` bullet in the changed-files blocks.
const globs = [...config.matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]);

test('the config actually declares globs', () => {
  assert.ok(globs.length >= 10, `only found ${globs.length} globs — did the file shape change?`);
});

test('every glob matches at least one tracked file', () => {
  const dead = globs.filter((g) => {
    const re = globToRegExp(g);
    return !tracked.some((f) => re.test(f));
  });
  assert.deepEqual(dead, [], `these labeler globs match nothing (moved or renamed?): ${dead.join(', ')}`);
});

// .github/labels.json is the repository's declared label set. A label that is
// applied but not declared gets created implicitly, with a default colour and
// no description, which is how label sets turn to mush. This file checks
// declared-vs-applied OFFLINE; CI's `labels` job checks declared-vs-live with
// `gh label list`, so the manifest cannot rot either. Between the two, "every
// applied label exists in the repo" is actually proven rather than asserted.
const manifest = JSON.parse(readFileSync(path.join(root, '.github', 'labels.json'), 'utf8'));
const declared = new Set(manifest.map((l) => l.name));

test('the label manifest is well-formed', () => {
  assert.ok(manifest.length >= 10, `only ${manifest.length} labels declared — did the file shape change?`);
  const names = manifest.map((l) => l.name);
  assert.equal(new Set(names).size, names.length, 'duplicate label names in the manifest');
  // GitHub label names are unique case-insensitively: `Bug` cannot coexist with
  // `bug`. Fold before checking so the manifest cannot declare a pair GitHub
  // would refuse.
  const folded = names.map((n) => n.toLowerCase());
  assert.equal(new Set(folded).size, folded.length, 'labels that differ only by case');
  for (const l of manifest) {
    assert.match(l.color, /^[0-9a-f]{6}$/i, `label "${l.name}": colour "${l.color}" is not six hex digits`);
  }
});

test('every label the labeler config applies is declared', () => {
  const labels = [...config.matchAll(/^'?([a-z][a-z0-9 :_-]*)'?:$/gim)].map((m) => m[1].trim());
  assert.ok(labels.includes('tests'), 'expected a tests label rule');
  assert.ok(labels.length >= 5, `only ${labels.length} label rules — did the file shape change?`);
  const missing = labels.filter((l) => !declared.has(l));
  assert.deepEqual(missing, [],
    `labeler.yml applies labels the repo does not declare — actions/labeler would create them ad hoc: ${missing.join(', ')}`);
});

test('every label an issue template applies is declared', () => {
  const dir = path.join(root, '.github', 'ISSUE_TEMPLATE');
  const forms = readdirSync(dir).filter((f) => f.endsWith('.yml') && f !== 'config.yml');
  // Two is the family floor: every repo ships a bug and a feature form. A repo
  // whose product is a DETECTOR ships a third, the false-positive form — so this
  // cannot assert three without failing on every repo that has nothing to be
  // wrong about.
  assert.ok(forms.length >= 2, `only ${forms.length} issue forms — did the directory shape change?`);
  for (const f of forms) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    const m = /^labels:\s*\[([^\]]*)\]\s*$/m.exec(src);
    assert.ok(m, `${f}: no top-level labels: [...] line`);
    const labels = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.ok(labels.length >= 1, `${f}: labels list is empty`);
    const missing = labels.filter((l) => !declared.has(l));
    assert.deepEqual(missing, [], `${f} applies undeclared labels: ${missing.join(', ')}`);
  }
});
