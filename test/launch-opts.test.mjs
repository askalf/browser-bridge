import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunchOptions, envInt, envFlag, makeIsolatedLauncher, exitOnListenFailure, parseStealthFloor } from '../launch-opts.mjs';

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

test('envInt: default when unset or empty, value when a positive integer', () => {
  assert.equal(envInt('X', 20, {}), 20);
  assert.equal(envInt('X', 20, { X: '' }), 20);
  assert.equal(envInt('X', 20, { X: ' 7 ' }), 7);
});

test('envInt: rejects values that would silently misbehave', () => {
  // NaN disables a cap, 0 spins a timer, `8s` parses as 8 ms.
  for (const bad of ['abc', '0', '-5', '8s', '1.5', '1e3', '99999999999999999999']) {
    assert.throws(() => envInt('X', 1, { X: bad }), /X must be a positive integer/, bad);
  }
});

test('envFlag: only explicit truthy words turn a flag on', () => {
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(envFlag('F', { F: on }), true, on);
  for (const off of [undefined, '', '0', 'false', 'no', 'off']) assert.equal(envFlag('F', { F: off }), false, String(off));
});

test('makeIsolatedLauncher: a failed launch removes its profile and rethrows the original error', async () => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'bb-launch-test-'));
  try {
    let seen;
    const boom = new Error('chromium failed to start');
    const launch = makeIsolatedLauncher({
      tmpRoot: root,
      optionsFor: (key, userDataDir) => ({ key, userDataDir }),
      launchBrowser: async (opts) => { seen = opts.userDataDir; assert.ok(existsSync(seen)); throw boom; },
    });
    await assert.rejects(() => launch('k'), (err) => err === boom);
    assert.equal(existsSync(seen), false, 'the profile directory is removed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('makeIsolatedLauncher: close() shuts the browser and removes its profile; exits reach onExit', async () => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'bb-launch-test-'));
  try {
    let udd;
    let closed = 0;
    const listeners = {};
    const browser = {
      on: (ev, fn) => { listeners[ev] = fn; },
      wsEndpoint: () => 'ws://127.0.0.1:40001/devtools/browser/x',
      process: () => ({ pid: 4242 }),
      close: async () => { closed++; },
    };
    const launch = makeIsolatedLauncher({
      tmpRoot: root,
      optionsFor: (key, userDataDir) => { udd = userDataDir; return {}; },
      launchBrowser: async () => browser,
    });
    let exited = 0;
    const s = await launch('k', { onExit: () => { exited++; } });
    assert.equal(s.pid, 4242);
    listeners.disconnected();
    assert.equal(exited, 1);
    assert.ok(existsSync(udd));
    await s.close();
    assert.equal(closed, 1);
    assert.equal(existsSync(udd), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exitOnListenFailure: an occupied port exits 1; errors after listening only log', async () => {
  const net = await import('node:net');
  const http = await import('node:http');
  const holder = net.createServer();
  await new Promise((r) => holder.listen(0, '127.0.0.1', r));
  const port = holder.address().port;
  try {
    for (const make of [() => http.createServer(), () => net.createServer()]) {
      const server = make();
      const exits = [];
      exitOnListenFailure(server, 'test server', { exit: (c) => exits.push(c), log: () => {} });
      await new Promise((resolve) => {
        server.once('error', () => setImmediate(resolve));
        server.listen(port, '127.0.0.1');
      });
      assert.deepEqual(exits, [1], 'a failed bind is fatal');
    }
    const up = http.createServer();
    const exits = [];
    const logs = [];
    exitOnListenFailure(up, 'live server', { exit: (c) => exits.push(c), log: (m) => logs.push(m) });
    await new Promise((r) => up.listen(0, '127.0.0.1', r));
    up.emit('error', new Error('later trouble'));
    assert.deepEqual(exits, [], 'an error on a listening server does not exit');
    assert.match(logs[0], /live server error: later trouble/);
    await new Promise((r) => up.close(r));
  } finally {
    await new Promise((r) => holder.close(r));
  }
});

test('exitOnListenFailure: the default exit ends the process with status 1', async () => {
  const { spawnSync } = await import('node:child_process');
  const mod = new URL('../launch-opts.mjs', import.meta.url).href;
  const script = `
    import net from 'node:net';
    import { exitOnListenFailure } from ${JSON.stringify(mod)};
    const holder = net.createServer();
    holder.listen(0, '127.0.0.1', () => {
      const s = net.createServer();
      exitOnListenFailure(s, 'CDP proxy', { log: () => {} });
      s.listen(holder.address().port, '127.0.0.1');
      setTimeout(() => process.exit(0), 2000).unref();
    });
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10000 });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status} (${r.stderr})`);
});

test('parseStealthFloor: default when unset, 0 and positive integers accepted', () => {
  assert.equal(parseStealthFloor(undefined, 8), 7);
  assert.equal(parseStealthFloor('', 8), 7);
  assert.equal(parseStealthFloor(' 0 ', 8), 0);
  assert.equal(parseStealthFloor('6', 8), 6);
});

test('parseStealthFloor: rejects values parseInt would turn into a gate that never fails', () => {
  for (const bad of ['abc', '8s', '1.5', '-1', '1e3']) {
    assert.throws(() => parseStealthFloor(bad, 8), /BRIDGE_STEALTH_FLOOR must be a non-negative integer/, bad);
  }
  // The failure being prevented: with parseInt, `abc` gave NaN and no score fell below it.
  assert.equal(3 < parseInt('abc', 10), false);
});
