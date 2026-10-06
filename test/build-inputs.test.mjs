// build.yml decides whether a PR owes the image build from the paths it changes. A path that
// slips past that decision skips the image job while the required docker-build check still
// passes, so this runs the step's own script against scratch repositories and asserts the
// decision. The script is read out of the workflow rather than copied here, so the two cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8').replace(/\r\n/g, '\n');

// The run: block of the step with id: diff, dedented.
function stepScript(y) {
  const lines = y.split('\n');
  const at = lines.findIndex((l) => /^\s+- id: diff$/.test(l));
  assert.ok(at >= 0, 'build.yml has no step with id: diff');
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  assert.ok(run > at, 'the diff step has no run: | block');
  const indent = /^(\s*)/.exec(lines[run])[1].length;
  const body = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() && /^(\s*)/.exec(l)[1].length <= indent) break;
    body.push(l);
  }
  const pad = Math.min(...body.filter((l) => l.trim()).map((l) => /^(\s*)/.exec(l)[1].length));
  return body.map((l) => l.slice(pad)).join('\n');
}

const script = stepScript(workflow);

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();

const put = (dir, f, body) => {
  mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  writeFileSync(path.join(dir, f), body);
};

// A base commit holding README.md and `existing`, then a commit that adds `files` and makes each
// [from, to] in `moves` with git mv. origin points at the repository itself so the script's fetch
// of the base sha resolves. Returns the script's changed= output.
function decide(files, { event = 'pull_request', existing = [], moves = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-build-inputs-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'core.quotePath', 'true');
    put(dir, 'README.md', 'base\n');
    for (const f of existing) put(dir, f, `export const body = ${JSON.stringify(f)};\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');
    for (const f of files) put(dir, f, 'x\n');
    for (const [from, to] of moves) {
      mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      git(dir, 'mv', from, to);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'change');
    git(dir, 'remote', 'add', 'origin', pathToFileURL(dir).href);
    const out = path.join(dir, '.github-output');
    writeFileSync(out, '');
    const r = spawnSync('bash', ['-c', script], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, EVENT: event, BASE_SHA: base, GITHUB_OUTPUT: out },
    });
    assert.equal(r.status, 0, `the step script failed:\n${r.stdout}${r.stderr}`);
    const m = /^changed=(.*)$/m.exec(readFileSync(out, 'utf8'));
    assert.ok(m, 'the step script wrote no changed= output');
    return m[1];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a root module change owes the image build', () => {
  assert.equal(decide(['launch.mjs']), 'true');
});

test('each image input owes the build', () => {
  for (const f of ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', '.github/workflows/build.yml'])
    assert.equal(decide([f]), 'true', f);
});

test('moving an unchanged root module into a directory owes the image build', () => {
  assert.equal(decide([], { existing: ['session-broker.mjs'], moves: [['session-broker.mjs', 'lib/session-broker.mjs']] }), 'true');
});

test('moving an unchanged module into the root owes the image build', () => {
  assert.equal(decide([], { existing: ['lib/a.mjs'], moves: [['lib/a.mjs', 'a.mjs']] }), 'true');
});

test('a root module with a non-ASCII name owes the image build', () => {
  assert.equal(decide(['café.mjs']), 'true');
});

test('a module in a directory, docs or tests owe nothing', () => {
  assert.equal(decide(['test/a.test.mjs', 'policy/x.mjs', 'docs/guide.md', 'README.md']), 'false');
  assert.equal(decide([], { existing: ['test/a.mjs'], moves: [['test/a.mjs', 'test/b.mjs']] }), 'false');
});

test('a push always owes the image build', () => {
  assert.equal(decide(['docs/guide.md'], { event: 'push' }), 'true');
});
