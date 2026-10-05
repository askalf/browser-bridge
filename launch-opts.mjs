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
