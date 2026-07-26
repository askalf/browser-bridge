// ════════════════════════════════════════════════════════════════════
// Stale Chromium singleton-lock cleanup.
//
// Chromium guards a profile against concurrent use with three entries at the
// profile root: `SingletonLock` (a symlink whose target is `<hostname>-<pid>`),
// `SingletonCookie`, and `SingletonSocket`. It removes them on a clean exit, so
// they only linger when the process was killed — which is exactly what happens
// to a container: SIGKILL after the stop grace period, or the host going away.
//
// With an ephemeral profile that never mattered, because the profile died with
// the container. It matters as soon as the profile is on a volume: the next
// container reads a lock naming a hostname that no longer exists (container
// hostnames are per-container by default) and Chromium refuses to start:
//
//   The profile appears to be in use by another Chromium process (34) on
//   another computer (a2a862525639). Chromium has locked the profile so that
//   it doesn't get corrupted.
//
// which the bridge surfaces as `failed to launch: ... Code: 21` and then a
// restart loop, since every subsequent attempt reads the same lock.
//
// Pinning the container hostname does NOT fix this — verified on the box: a
// lock written by an earlier container still names the OLD hostname, so the
// comparison fails regardless of what the current hostname is.
//
// Clearing the lock here is safe in a way it would not be on a desktop: this
// process is the only intended user of the profile, and it runs before Chromium
// launches. We are not racing a live browser — a live browser would be inside
// this same container, which has just started. The narrow risk is two bridges
// sharing one profile directory, which is already unsupported (shared mode runs
// one Chromium; isolated mode gives every session its own directory).
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

// Only these three. Deliberately not a recursive clean — a profile is user data,
// and deleting anything else would be destroying state the volume exists to keep.
const SINGLETON_ENTRIES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

/**
 * Remove stale Chromium singleton entries from a profile directory.
 *
 * Must be called BEFORE puppeteer.launch(). Never throws: a profile we cannot
 * tidy should still get a launch attempt, and Chromium's own error is a better
 * diagnostic than one from this helper.
 *
 * @param {string} userDataDir  profile directory
 * @param {{ fs?: typeof fs, log?: (msg: string) => void }} [deps] injected for tests
 * @returns {string[]} the entries actually removed
 */
export function clearStaleSingletonLock(userDataDir, deps = {}) {
  const io = deps.fs ?? fs;
  const log = deps.log ?? (() => {});
  if (!userDataDir) return [];

  const removed = [];
  for (const entry of SINGLETON_ENTRIES) {
    const target = path.join(userDataDir, entry);
    try {
      // lstat, not existsSync: SingletonLock is a symlink whose target
      // (`<hostname>-<pid>`) does not resolve, so existsSync returns false for
      // the very file that blocks the launch.
      io.lstatSync(target);
    } catch {
      continue; // not present — nothing to do
    }
    try {
      io.unlinkSync(target);
      removed.push(entry);
    } catch (err) {
      log(`could not remove stale ${entry}: ${err.message}`);
    }
  }

  if (removed.length) {
    log(`cleared stale profile lock (${removed.join(', ')}) — previous run did not exit cleanly`);
  }
  return removed;
}
