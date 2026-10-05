import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ════════════════════════════════════════════════════════════════════
// Launch-option assembly, kept pure so it can be asserted in tests.
//
// Why this exists: the profile directory MUST be passed as puppeteer's
// `userDataDir` *option*, never as a `--user-data-dir` entry in `args`.
// puppeteer-extra-plugin-user-data-dir (a dependency of the stealth
// plugin) reads `options.userDataDir` in its beforeLaunch hook; when it
// finds nothing it mints its own temp profile, writes the stealth profile
// files there, and puppeteer turns that into a second --user-data-dir
// flag. With the flag present twice the plugin's directory is the one
// Chromium uses and ours is silently ignored — observed both locally on
// Chromium 150 and on the deployed 0.3.3 container, where
// /home/browser/data sat empty while /tmp/puppeteer_dev_profile-* held the
// real profile. The flag ORDER differed between those two environments and
// the plugin won regardless, so don't reason about this as first- or
// last-wins; just never emit the flag twice. See #56.
// ════════════════════════════════════════════════════════════════════

/**
 * Assemble puppeteer.launch() options for a stealth Chromium.
 *
 * @param {object} o
 * @param {string} o.chromePath      executable path
 * @param {string[]} o.commonArgs    shared hardening/headless flags
 * @param {number} o.debugPort       --remote-debugging-port (0 = ephemeral)
 * @param {string} o.userDataDir     profile directory; passed as an OPTION
 * @param {string} o.userAgent       UA override for this browser
 * @returns {{headless: true, executablePath: string, userDataDir: string, args: string[], ignoreDefaultArgs: string[]}}
 */
export function buildLaunchOptions({ chromePath, commonArgs, debugPort, userDataDir, userAgent }) {
  if (!userDataDir) throw new Error('buildLaunchOptions: userDataDir is required');

  const args = [
    ...commonArgs,
    `--remote-debugging-port=${debugPort}`,
    `--user-agent=${userAgent}`,
  ];

  // Guard the invariant at the source rather than trusting callers: if a
  // --user-data-dir ever creeps back into commonArgs, fail loudly here
  // instead of silently launching against the wrong profile.
  const stray = args.filter((a) => a.startsWith('--user-data-dir'));
  if (stray.length) {
    throw new Error(
      `buildLaunchOptions: --user-data-dir must be the userDataDir option, not an arg (got ${stray.join(', ')})`
    );
  }

  return {
    headless: true,
    executablePath: chromePath,
    userDataDir,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
  };
}

/**
 * Read a positive-integer env var, or the default when unset or empty.
 * Anything else throws at startup: a typo like `abc` or `8s` would
 * otherwise parse to NaN or a wrong unit and quietly disable a session cap,
 * spin a timer every millisecond, or crash on the first socket that uses it.
 *
 * @param {string} name
 * @param {number} def
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 */
export function envInt(name, def, env = process.env) {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return def;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(env[name])}`);
  }
  return Number(raw);
}

/**
 * Read a boolean env var. Only 1/true/yes/on (any case) turn it on, so an
 * explicit `0` or `false` means off rather than "set, therefore on".
 *
 * @param {string} name
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function envFlag(name, env = process.env) {
  return /^(1|true|yes|on)$/i.test((env[name] ?? '').trim());
}

/**
 * The session broker's launcher for isolated mode: each session gets a fresh
 * profile directory under `tmpRoot` and its own browser. The directory is
 * removed when the session closes, and also when the launch itself fails, so
 * a failing launch (including the periodic health probe) never leaves
 * profiles behind.
 *
 * @param {object} o
 * @param {(opts: object) => Promise<any>} o.launchBrowser  puppeteer.launch
 * @param {(key: string, userDataDir: string) => object} o.optionsFor  launch options for a session
 * @param {string} [o.tmpRoot]  parent of the per-session profile directories
 * @returns {(key: string, hooks?: {onExit?: () => void}) => Promise<{wsEndpoint: string, pid?: number, close: () => Promise<void>}>}
 */
export function makeIsolatedLauncher({ launchBrowser, optionsFor, tmpRoot = os.tmpdir() }) {
  return async (key, { onExit } = {}) => {
    const udd = fs.mkdtempSync(path.join(tmpRoot, 'bb-sess-'));
    const removeProfile = () => { try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* gone */ } };
    let b;
    try {
      b = await launchBrowser(optionsFor(key, udd));
    } catch (err) {
      removeProfile();
      throw err;
    }
    if (onExit) b.on('disconnected', onExit);
    return {
      wsEndpoint: b.wsEndpoint(),
      pid: b.process()?.pid,
      close: async () => {
        try { await b.close(); } catch { /* already gone */ }
        removeProfile();
      },
    };
  };
}

/**
 * Make a failed listen() fatal. A server that cannot bind its port emits
 * 'error' before it is listening; leaving the process up would give a
 * container whose health check is green (or absent) while the port it exists
 * for serves nothing. Errors after a successful listen are only logged.
 *
 * @param {import('node:net').Server} server
 * @param {string} name  shown in the log line
 * @param {{exit?: (code: number) => void, log?: (msg: string) => void}} [o]
 */
export function exitOnListenFailure(server, name, { exit = (code) => process.exit(code), log = console.error } = {}) {
  server.on('error', (err) => {
    log(`[browser-bridge] ${name} error: ${err.message}`);
    if (!server.listening) exit(1);
  });
}
