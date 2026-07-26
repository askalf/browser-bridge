import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunchOptions } from '../launch-opts.mjs';

const base = {
  chromePath: '/usr/bin/chromium',
  commonArgs: ['--no-sandbox', '--disable-gpu'],
  debugPort: 9223,
  userDataDir: '/home/browser/data',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0',
};

test('buildLaunchOptions — profile is an option, never an arg', () => {
  const o = buildLaunchOptions(base);
  assert.equal(o.userDataDir, '/home/browser/data');
  assert.equal(
    o.args.some((a) => a.startsWith('--user-data-dir')),
    false,
    'a --user-data-dir arg would be shadowed by the one puppeteer injects for the stealth plugin (#56)'
  );
});

test('buildLaunchOptions — exactly one profile source, so Chromium cannot pick the wrong one', () => {
  const o = buildLaunchOptions(base);
  const sources = o.args.filter((a) => a.startsWith('--user-data-dir')).length + (o.userDataDir ? 1 : 0);
  assert.equal(sources, 1);
});

test('buildLaunchOptions — carries commonArgs, debug port and UA through', () => {
  const o = buildLaunchOptions(base);
  assert.ok(o.args.includes('--no-sandbox'));
  assert.ok(o.args.includes('--disable-gpu'));
  assert.ok(o.args.includes('--remote-debugging-port=9223'));
  assert.ok(o.args.includes(`--user-agent=${base.userAgent}`));
});

test('buildLaunchOptions — ephemeral debug port is passed as 0, not omitted', () => {
  const o = buildLaunchOptions({ ...base, debugPort: 0 });
  assert.ok(o.args.includes('--remote-debugging-port=0'));
});

test('buildLaunchOptions — keeps the automation flag suppressed', () => {
  const o = buildLaunchOptions(base);
  assert.deepEqual(o.ignoreDefaultArgs, ['--enable-automation']);
  assert.equal(o.headless, true);
  assert.equal(o.executablePath, '/usr/bin/chromium');
});

test('buildLaunchOptions — rejects a --user-data-dir smuggled in via commonArgs', () => {
  assert.throws(
    () => buildLaunchOptions({ ...base, commonArgs: [...base.commonArgs, '--user-data-dir=/tmp/wrong'] }),
    /must be the userDataDir option/
  );
});

test('buildLaunchOptions — requires a profile directory', () => {
  assert.throws(() => buildLaunchOptions({ ...base, userDataDir: '' }), /userDataDir is required/);
});
