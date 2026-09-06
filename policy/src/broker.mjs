/**
 * ContextBroker — a pool of isolated, keeper-backed persona browser contexts on
 * top of ONE shared CDP browser.
 *
 * The capture path (capture.mjs) spins up a throwaway context per observe and
 * closes it — correct for a one-shot read, but it means a logged-in session
 * can't persist, and concurrent agents would trample one shared page. The
 * broker fixes both:
 *
 *   - One persistent, ISOLATED `BrowserContext` per persona (its own cookies /
 *     storage), keeper-logged-in ONCE on first checkout and reused after.
 *   - checkout/checkin with a per-persona lock so two tasks never share one
 *     persona's session concurrently; a bounded pool with LRU eviction of idle
 *     contexts so a hostile/idle pile-up can't exhaust the browser.
 *   - Non-destructive: it closes only the contexts it created, then
 *     `disconnect()`s — NEVER `browser.close()` (the bridge is shared prod).
 *
 * The secret never reaches the caller: keeper resolves user/pass only inside the
 * CDP fill (same property as GovernedBrowser.login); the checkout handle exposes
 * the authenticated `page`, not the credential.
 */

import { KeeperStub } from './govern.mjs';

const now = () => Date.now();

export class ContextBroker {
  /**
   * @param {Object} opts
   * @param {*}        [opts.browser]            an already-connected puppeteer Browser (tests inject a fake)
   * @param {Function} [opts.connect]            async () => browser (called once, lazily)
   * @param {string}   [opts.browserWSEndpoint]  CDP ws endpoint (lazily puppeteer.connect)
   * @param {string}   [opts.browserURL]         CDP http endpoint
   * @param {KeeperStub} [opts.keeper]
   * @param {number}   [opts.maxContexts=4]      pool ceiling
   * @param {Object}   [opts.loginConfig]        { persona: { url, userSelector, passSelector, submitSelector, timeoutMs } }
   */
  constructor(opts = {}) {
    this._browser = opts.browser || null;
    this._connect = opts.connect || null;
    this._wsEndpoint = opts.browserWSEndpoint || null;
    this._browserURL = opts.browserURL || null;
    this.keeper = opts.keeper || new KeeperStub();
    this.maxContexts = opts.maxContexts ?? 4;
    this.loginConfig = opts.loginConfig || {};
    this._pool = new Map(); // persona -> slot
    this._closed = false;
  }

  /** Connect (and cache) the shared browser exactly once. */
  async _browserConn() {
    if (this._browser) return this._browser;
    if (this._connect) { this._browser = await this._connect(); return this._browser; }
    if (this._wsEndpoint || this._browserURL) {
      const { default: puppeteer } = await import('puppeteer-core');
      this._browser = await puppeteer.connect({ browserWSEndpoint: this._wsEndpoint, browserURL: this._browserURL });
      this._ownsConnection = true;
      return this._browser;
    }
    throw new Error('ContextBroker needs a browser, connect(), browserWSEndpoint, or browserURL');
  }

  _handle(slot) {
    return { persona: slot.persona, page: slot.page, context: slot.context, release: () => this.checkin(slot.persona) };
  }

  /** Keeper-backed login, run once per fresh context. The secret is resolved and
   *  typed here and nowhere else; it never enters the returned handle. */
  async _login(slot) {
    const cfg = this.loginConfig[slot.persona];
    if (!cfg) return false;
    const lease = this.keeper.lease(slot.persona);
    const { user, pass } = this.keeper._resolve(lease.id); // CDP-fill scope only
    await slot.page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs || 20000 });
    if (cfg.userSelector) await slot.page.type(cfg.userSelector, user);
    if (cfg.passSelector) await slot.page.type(cfg.passSelector, pass);
    if (cfg.submitSelector) await slot.page.click(cfg.submitSelector);
    slot.loggedIn = true;
    return true;
  }

  /** Evict the least-recently-used IDLE context to free a pool slot. */
  async _evictIdle() {
    let lru = null;
    for (const slot of this._pool.values()) {
      if (slot.busy) continue;
      if (!lru || slot.lastUsed < lru.lastUsed) lru = slot;
    }
    if (!lru) return false;
    this._pool.delete(lru.persona);
    try { await lru.context.close(); } catch { /* noop */ }
    return true;
  }

  /**
   * Borrow the persona's context. Returns a handle { persona, page, context,
   * release() }. Blocks if that persona is already checked out (per-persona
   * serialization). Throws if the pool is full and every context is busy.
   */
  async checkout(persona) {
    if (this._closed) throw new Error('ContextBroker is closed');
    if (!persona) throw new Error('checkout needs a persona');

    const existing = this._pool.get(persona);
    if (existing) {
      if (!existing.busy) { existing.busy = true; existing.lastUsed = now(); return this._handle(existing); }
      return await new Promise((resolve) => existing.waiters.push(resolve)); // handed the handle by checkin
    }

    // New persona: make room if at capacity.
    if (this._pool.size >= this.maxContexts) {
      const freed = await this._evictIdle();
      if (!freed) throw new Error(`ContextBroker at capacity (${this.maxContexts} contexts, all busy)`);
    }

    const browser = await this._browserConn();
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    if (page.setCacheEnabled) await page.setCacheEnabled(false);
    const slot = { persona, context, page, busy: true, lastUsed: now(), loggedIn: false, waiters: [] };
    this._pool.set(persona, slot);
    try {
      await this._login(slot);
    } catch (e) {
      // a login failure must not leak a half-open slot
      this._pool.delete(persona);
      try { await context.close(); } catch { /* noop */ }
      throw new Error(`ContextBroker: login failed for "${persona}": ${e.message}`);
    }
    return this._handle(slot);
  }

  /** Return a persona's context to the pool (kept warm + authenticated for reuse). */
  checkin(persona) {
    const slot = this._pool.get(typeof persona === 'object' && persona ? persona.persona : persona);
    if (!slot) return;
    slot.lastUsed = now();
    const next = slot.waiters.shift();
    if (next) next(this._handle(slot)); // hand off without releasing the lock
    else slot.busy = false;
  }

  /** Borrow → run fn(handle) → always check back in. */
  async withPersona(persona, fn) {
    const h = await this.checkout(persona);
    try { return await fn(h); }
    finally { this.checkin(persona); }
  }

  stats() {
    let busy = 0;
    for (const s of this._pool.values()) if (s.busy) busy++;
    return { size: this._pool.size, busy, max: this.maxContexts, personas: [...this._pool.keys()] };
  }

  /** Close every context we created, then disconnect. NEVER browser.close(). */
  async close() {
    this._closed = true;
    for (const slot of this._pool.values()) {
      try { await slot.context.close(); } catch { /* noop */ }
    }
    this._pool.clear();
    if (this._browser) {
      try { await this._browser.disconnect(); } catch { /* noop */ }
    }
  }
}
