/**
 * Session broker — process-per-session isolation (BRIDGE_SESSION_MODE=isolated).
 *
 * In shared mode the bridge fronts ONE Chromium and every CDP client lands on
 * the same browser target: a client's `browser.close()` kills Chromium for the
 * whole fleet, and any connection can enumerate/close pages it didn't open.
 * The broker gives each connection its OWN stealth Chromium instead, so:
 *
 *   - isolation is hard (separate processes) — no client sees or closes
 *     another's targets;
 *   - a client calling browser.close() only kills its own session;
 *   - stealth is preserved because each session is launched through the same
 *     puppeteer-extra stealth config (the launcher is injected below).
 *
 * The proxy stays a transparent byte-pipe: it just routes each connection to
 * the internal port of that session's browser. No CDP frame parsing.
 *
 * Session keying (assigned by the proxy, honoured here):
 *   - named  (?session=<key>) : reused across reconnects, kept until idle TTL.
 *   - ephemeral (no key)      : one browser for the connection, disposed when
 *                               its last socket closes.
 *
 * `launch` is injected so the module is unit-testable without a real browser.
 * It is `async (key, { onExit }) => { wsEndpoint, pid, close }`; the launcher
 * calls `onExit()` if the browser dies on its own (a client's browser.close()
 * or a crash) so the key stops routing to a dead port.
 */

/**
 * @param {object} opts
 * @param {(key: string, hooks: {onExit: () => void}) => Promise<{wsEndpoint: string, pid?: number, close: () => Promise<void>}>} opts.launch
 * @param {number} [opts.maxSessions]  Hard cap on concurrent sessions. A
 *   launch-per-connection endpoint is a trivial resource-exhaustion vector
 *   without one; acquisitions past the cap are rejected.
 * @param {number} [opts.idleTtlMs]  Sessions with no active sockets are reaped
 *   this long after their last release. Named sessions included.
 * @param {(event: string) => void} [opts.onEvent]
 * @param {(msg: string) => void} [opts.log]
 */
export function createSessionBroker({
  launch,
  maxSessions = 20,
  idleTtlMs = 300000,
  onEvent = () => {},
  log = () => {},
}) {
  /**
   * key -> {
   *   internalPort, wsPath, close, pid,
   *   refs, lastUsed, ephemeral, launching: Promise|null
   * }
   */
  const sessions = new Map();
  let created = 0;

  const parseWs = (wsEndpoint) => {
    const u = new URL(wsEndpoint); // ws://127.0.0.1:<port>/devtools/browser/<uuid>
    return { internalPort: Number(u.port), wsPath: u.pathname };
  };

  function handleFor(key, rec) {
    let released = false;
    return {
      key,
      internalPort: rec.internalPort,
      wsPath: rec.wsPath,
      release() {
        if (released) return;
        released = true;
        rec.refs = Math.max(0, rec.refs - 1);
        rec.lastUsed = Date.now();
        // Ephemeral sessions die with their connection; named ones linger for
        // reuse until the idle reaper collects them.
        if (rec.ephemeral && rec.refs === 0) dispose(key, rec);
      },
    };
  }

  /**
   * Get (or launch) the session for `key` and take a reference to it. The
   * caller MUST call the returned handle's release() when its socket closes.
   * Throws if the session cap is reached.
   */
  async function acquire(key, ephemeral) {
    const existing = sessions.get(key);
    if (existing) {
      if (existing.launching) await existing.launching; // coalesce concurrent first-connects
      existing.refs++;
      existing.lastUsed = Date.now();
      return handleFor(key, existing);
    }

    if (sessions.size >= maxSessions) {
      onEvent('session-rejected');
      throw new Error(`browser-bridge: session cap (${maxSessions}) reached`);
    }

    // Reserve the slot BEFORE the async launch so the cap counts in-flight
    // launches and concurrent acquisitions of the same key coalesce.
    // starting is true from before launch() is called until the endpoint is
    // published or the launch fails, so an exit reported at any point in
    // between (even synchronously, from inside launch()) fails the launch.
    const rec = { refs: 1, lastUsed: Date.now(), ephemeral, launching: null, starting: true };
    sessions.set(key, rec);
    rec.launching = (async () => {
      const b = await launch(key, { onExit: () => exited(key, rec) });
      if (rec.exitedDuringLaunch) {
        // The browser died before its endpoint was published: fail the launch
        // (every coalesced acquirer sees it) rather than route to a dead port.
        try { await b.close(); } catch { /* already gone */ }
        throw new Error(`browser-bridge: session '${key}' browser exited during launch`);
      }
      const { internalPort, wsPath } = parseWs(b.wsEndpoint);
      rec.internalPort = internalPort;
      rec.wsPath = wsPath;
      rec.close = b.close;
      rec.pid = b.pid;
    })();
    try {
      await rec.launching;
    } catch (err) {
      sessions.delete(key);
      onEvent('session-launch-failed');
      throw err;
    } finally {
      rec.starting = false;
    }
    rec.launching = null;
    created++;
    onEvent('session-created');
    log(`session '${key}' up (pid ${rec.pid ?? '?'}, internal :${rec.internalPort})`);
    return handleFor(key, rec);
  }

  /**
   * Close and forget the session for `key`. With `expected`, only when that
   * record is still the live one: a handle from a browser that has since
   * exited and been replaced must not close the replacement.
   */
  async function dispose(key, expected) {
    const rec = sessions.get(key);
    if (!rec || (expected && rec !== expected)) return;
    sessions.delete(key);
    try {
      if (rec.close) await rec.close();
    } catch { /* already gone */ }
    onEvent('session-disposed');
    log(`session '${key}' disposed`);
  }

  // The browser went away without the broker asking (a client's
  // browser.close(), or a crash). Forget the key so the next connect launches
  // a fresh browser instead of being piped to a dead port, and run close() to
  // clean up what the launcher left behind (the profile directory). Ignored
  // once the record has been replaced or disposed through dispose().
  function exited(key, rec) {
    if (sessions.get(key) !== rec) return;
    if (rec.starting) { rec.exitedDuringLaunch = true; return; } // acquire() fails the launch
    log(`session '${key}' browser exited`);
    dispose(key, rec).catch(() => {});
  }

  /** Reap idle, unreferenced sessions past the TTL. */
  async function reap() {
    const now = Date.now();
    for (const [key, rec] of [...sessions]) {
      if (rec.refs === 0 && !rec.launching && now - rec.lastUsed > idleTtlMs) {
        await dispose(key);
      }
    }
  }

  /**
   * Deep health probe: launch a throwaway session, confirm it produced a live
   * CDP endpoint, dispose it. Heavier than a page eval, so callers should cache
   * the result (the health server refreshes at most every few minutes).
   */
  async function probe() {
    // A full broker is busy, not broken: report it without launching (which
    // would be rejected, counted as a rejection, and mark the container
    // unhealthy exactly when it is doing the most work).
    if (sessions.size >= maxSessions) return 'saturated';
    const key = `__probe__${now36()}`;
    try {
      const h = await acquire(key, true);
      const ok = Number.isInteger(h.internalPort) && h.internalPort > 0;
      h.release(); // ephemeral -> disposes
      return ok ? 'ok' : 'degraded';
    } catch {
      await dispose(key).catch(() => {});
      return 'degraded';
    }
  }

  function stats() {
    let referenced = 0;
    for (const rec of sessions.values()) if (rec.refs > 0) referenced++;
    return {
      sessionsActive: sessions.size,
      sessionsReferenced: referenced,
      sessionsCreatedTotal: created,
      maxSessions,
    };
  }

  async function disposeAll() {
    for (const key of [...sessions.keys()]) await dispose(key);
  }

  return { acquire, dispose, reap, probe, stats, disposeAll };
}

// A monotonic-ish suffix for probe keys without Date.now churn in hot paths.
let probeSeq = 0;
function now36() {
  probeSeq = (probeSeq + 1) % Number.MAX_SAFE_INTEGER;
  return probeSeq.toString(36);
}
