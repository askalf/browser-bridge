import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearStaleSingletonLock } from '../profile-lock.mjs';

function tmpProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-lock-test-'));
}

// Chromium writes SingletonLock as a symlink to "<hostname>-<pid>", which is
// what makes lstat (not existsSync) the correct probe. Creating a symlink needs
// elevation or Developer Mode on Windows, so the symlink-shaped tests below run
// on Linux — the platform the image actually ships on — and skip elsewhere
// rather than reporting a false failure. The lstat contract itself is pinned
// platform-independently by the injected-fs test at the bottom.
function canSymlink() {
  const dir = tmpProfile();
  try {
    fs.symlinkSync('target-1', path.join(dir, 'probe'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const SYMLINKS = canSymlink();

test('clearStaleSingletonLock — removes a dangling SingletonLock symlink', (t) => {
  if (!SYMLINKS) return t.skip('symlink creation not permitted on this platform');
  const dir = tmpProfile();
  try {
    fs.symlinkSync('a2a862525639-34', path.join(dir, 'SingletonLock'));
    assert.equal(
      fs.existsSync(path.join(dir, 'SingletonLock')), false,
      'precondition: existsSync is false for a dangling link — the bug this guards'
    );

    assert.deepEqual(clearStaleSingletonLock(dir), ['SingletonLock']);
    assert.throws(() => fs.lstatSync(path.join(dir, 'SingletonLock')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearStaleSingletonLock — removes all three singleton entries', () => {
  const dir = tmpProfile();
  try {
    // Plain files: removal semantics are identical and this runs everywhere.
    for (const e of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      fs.writeFileSync(path.join(dir, e), '');
    }

    const removed = clearStaleSingletonLock(dir);

    assert.deepEqual(removed.sort(), ['SingletonCookie', 'SingletonLock', 'SingletonSocket']);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearStaleSingletonLock — leaves the rest of the profile alone', () => {
  const dir = tmpProfile();
  try {
    fs.mkdirSync(path.join(dir, 'Default'));
    fs.writeFileSync(path.join(dir, 'Default', 'Cookies'), 'sqlite');
    fs.writeFileSync(path.join(dir, 'Last Version'), '150.0');
    fs.writeFileSync(path.join(dir, 'SingletonLock'), '');

    clearStaleSingletonLock(dir);

    assert.equal(fs.readFileSync(path.join(dir, 'Default', 'Cookies'), 'utf8'), 'sqlite');
    assert.equal(fs.readFileSync(path.join(dir, 'Last Version'), 'utf8'), '150.0');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['Default', 'Last Version']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearStaleSingletonLock — no-op on a clean profile', () => {
  const dir = tmpProfile();
  try {
    fs.mkdirSync(path.join(dir, 'Default'));
    assert.deepEqual(clearStaleSingletonLock(dir), []);
    assert.deepEqual(fs.readdirSync(dir), ['Default']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearStaleSingletonLock — no-op on a directory that does not exist', () => {
  assert.deepEqual(clearStaleSingletonLock(path.join(os.tmpdir(), 'bb-lock-absent-xyz')), []);
});

test('clearStaleSingletonLock — returns [] for a missing profile argument', () => {
  assert.deepEqual(clearStaleSingletonLock(''), []);
  assert.deepEqual(clearStaleSingletonLock(undefined), []);
});

test('clearStaleSingletonLock — never throws when the unlink fails, and logs it', () => {
  const logged = [];
  const fakeFs = {
    lstatSync: () => ({}),
    unlinkSync: () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; },
  };

  const removed = clearStaleSingletonLock('/some/profile', { fs: fakeFs, log: (m) => logged.push(m) });

  assert.deepEqual(removed, [], 'nothing reported as removed');
  assert.equal(logged.length, 3, 'one line per entry it could not remove');
  assert.ok(logged.every((l) => l.includes('permission denied')));
});

test('clearStaleSingletonLock — probes with lstat, never existsSync', () => {
  // Pins the contract on every platform: a dangling symlink is invisible to
  // existsSync, so an implementation that used it would skip the one file that
  // blocks the launch. Fails loudly if the probe is ever swapped back.
  const probed = [];
  const fakeFs = {
    lstatSync: (p) => { probed.push(p); return {}; },
    existsSync: () => { throw new Error('existsSync must not be used — it is false for a dangling symlink'); },
    unlinkSync: () => {},
  };

  const removed = clearStaleSingletonLock('/profile', { fs: fakeFs });

  assert.equal(probed.length, 3);
  assert.ok(probed.every((p) => p.includes('Singleton')));
  assert.deepEqual(removed.sort(), ['SingletonCookie', 'SingletonLock', 'SingletonSocket']);
});

test('clearStaleSingletonLock — logs once when it clears something', () => {
  const dir = tmpProfile();
  const logged = [];
  try {
    fs.writeFileSync(path.join(dir, 'SingletonLock'), '');
    clearStaleSingletonLock(dir, { log: (m) => logged.push(m) });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /cleared stale profile lock \(SingletonLock\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearStaleSingletonLock — stays silent on a clean profile', () => {
  const dir = tmpProfile();
  const logged = [];
  try {
    clearStaleSingletonLock(dir, { log: (m) => logged.push(m) });
    assert.deepEqual(logged, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
