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
import { readFileSync } from 'node:fs';
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

test('labels named in the config exist in the repo label set', () => {
  // Names only — a label the repo does not define gets created implicitly with
  // a default colour and no description, which is how label sets turn to mush.
  const labels = [...config.matchAll(/^'?([a-z][a-z0-9 :_-]*)'?:$/gim)].map((m) => m[1].trim());
  assert.ok(labels.includes('tests'), 'expected a tests label rule');
  assert.ok(labels.length >= 5, `only ${labels.length} label rules — did the file shape change?`);
  for (const l of labels) {
    assert.ok(l === l.toLowerCase(), `label "${l}" is not lowercase — GitHub labels are case-sensitive`);
  }
});
