/**
 * Capture: page -> Observation. Two backends, one output shape.
 *
 *  - captureFromHtml: static parse (node-html-parser). No browser. Sees inline
 *    styles/attributes/comments — enough for the test corpus and CI. It cannot
 *    resolve CSS-class-based hiding (no computed styles); that is the honest
 *    gap the CDP backend closes.
 *  - captureFromBridge: drives a real Chrome over CDP (your DevTools
 *    bridge) in an ISOLATED context and reads getComputedStyle for ground-truth
 *    visibility. This is the production path.
 */

import { parse } from 'node-html-parser';

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);
const ATTR_SOURCES = [
  ['alt', 'attr:alt'], ['title', 'attr:title'], ['aria-label', 'attr:aria-label'],
  ['placeholder', 'attr:placeholder'], ['value', 'attr:value'],
];

const NAMED = {
  white: '#ffffff', black: '#000000', red: '#ff0000', lime: '#00ff00', green: '#008000',
  blue: '#0000ff', yellow: '#ffff00', silver: '#c0c0c0', gray: '#808080', grey: '#808080',
  transparent: null, inherit: null, none: null,
};

function toRgb(c) {
  if (!c) return null;
  c = String(c).trim().toLowerCase();
  if (c in NAMED) c = NAMED[c];
  if (!c) return null;
  if (c[0] === '#') {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    if (h.length >= 6) {
      const n = parseInt(h.slice(0, 6), 16);
      if (Number.isNaN(n)) return null;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return null;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    if (p.length >= 3) return [p[0], p[1], p[2]];
  }
  return null;
}
const colorDist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

function parseStyle(str) {
  const m = {};
  if (!str) return m;
  for (const decl of String(str).split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    m[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim().toLowerCase();
  }
  return m;
}

/** Visibility reasons derivable from an element's own inline style + aria. */
function ownHiddenReasons(el) {
  const reasons = [];
  const s = parseStyle(el.getAttribute && el.getAttribute('style'));
  if (s.display === 'none') reasons.push('display:none');
  if (s.visibility === 'hidden' || s.visibility === 'collapse') reasons.push('visibility:hidden');
  if (s.opacity !== undefined && parseFloat(s.opacity) === 0) reasons.push('opacity:0');
  if (s['font-size'] !== undefined) {
    const fs = parseFloat(s['font-size']);
    if (!Number.isNaN(fs) && fs <= 1) reasons.push('tiny-font');
  }
  const neg = (v) => v !== undefined && parseFloat(v) <= -1000;
  if ((s.position === 'absolute' || s.position === 'fixed') && (neg(s.left) || neg(s.top))) reasons.push('offscreen');
  if (neg(s['text-indent']) || neg(s['margin-left'])) reasons.push('offscreen');
  if (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clip === 'rect(0,0,0,0)' || (s['clip-path'] || '').includes('inset(100%)')) reasons.push('clip');
  if ((el.getAttribute && el.getAttribute('aria-hidden')) === 'true') reasons.push('aria-hidden');
  return { reasons, style: s };
}

function mkNode(id, text, source, tag, path, hidden, hiddenReasons) {
  return { id: `n${id}`, text, source, tag, path, hidden: !!hidden, hiddenReasons: [...new Set(hiddenReasons)] };
}

/**
 * @param {string} html
 * @param {{url?: string}} [opts]
 * @returns {import('./observation.mjs').Observation}
 */
export function captureFromHtml(html, opts = {}) {
  const url = opts.url || 'about:blank';
  let origin = '';
  try { origin = new URL(url).origin; } catch { origin = ''; }

  const root = parse(html, {
    comment: true,
    blockTextElements: { script: false, style: false, noscript: false, pre: true },
  });

  const nodes = [];
  let id = 0;
  let title = '';

  const walk = (el, path, inherited) => {
    for (const child of el.childNodes || []) {
      const nt = child.nodeType;
      if (nt === 3) {
        const t = (child.text ?? child.rawText ?? '');
        if (t && t.trim() && !/^\s*<!doctype/i.test(t)) nodes.push(mkNode(id++, t, inherited.source || 'text', el.rawTagName?.toLowerCase() || '', path, inherited.hidden, inherited.reasons));
      } else if (nt === 8) {
        const t = (child.text ?? child.rawText ?? '');
        if (t && t.trim()) nodes.push(mkNode(id++, t, 'comment', 'comment', path, true, [...inherited.reasons, 'comment']));
      } else if (nt === 1) {
        const tag = (child.rawTagName || '').toLowerCase();
        // Declarative shadow DOM: a <template shadowrootmode> the browser would
        // upgrade into an open shadow root. node-html-parser exposes its markup
        // as ordinary childNodes, so descend it and tag descendants `shadow`.
        // A plain <template> (no shadowrootmode) stays inert via SKIP_TAGS below.
        if (tag === 'template' && child.getAttribute && child.getAttribute('shadowrootmode')) {
          walk(child, `${path}>template(shadow)`, {
            hidden: inherited.hidden,
            reasons: inherited.hidden ? inherited.reasons : [],
            bg: inherited.bg,
            source: 'shadow',
          });
          continue;
        }
        if (!tag || SKIP_TAGS.has(tag)) {
          if (tag === 'head') { // still grab <title> and <meta> from head
            const titleEl = child.querySelector && child.querySelector('title');
            if (titleEl) title = titleEl.text.trim();
            for (const meta of (child.querySelectorAll ? child.querySelectorAll('meta') : [])) {
              const content = meta.getAttribute('content');
              if (content && content.trim()) nodes.push(mkNode(id++, content, 'meta', 'meta', `${path}>head>meta`, false, []));
            }
          }
          continue;
        }
        if (tag === 'title' && !title) title = child.text.trim();

        const own = ownHiddenReasons(child);
        const ownBg = toRgb(own.style['background-color'] || own.style.background);
        const bg = ownBg || inherited.bg;
        const fg = toRgb(own.style.color);
        const reasons = [...inherited.reasons, ...own.reasons];
        if (fg && bg && colorDist(fg, bg) <= 24) reasons.push('low-contrast');
        const hidden = inherited.hidden || reasons.length > 0;

        // attribute-sourced text is never rendered as body copy -> treat as hidden
        for (const [attr, source] of ATTR_SOURCES) {
          const v = child.getAttribute && child.getAttribute(attr);
          if (v && v.trim()) nodes.push(mkNode(id++, v, source, tag, `${path}>${tag}@${attr}`, false, []));
        }

        walk(child, `${path}>${tag}`, { hidden, reasons: hidden ? reasons : [], bg, source: inherited.source });
      }
    }
  };

  walk(root, '', { hidden: false, reasons: [], bg: null, source: 'text' });
  return { url, origin, title, nodes, capturedBy: 'static' };
}

/* ------------------------------------------------------------------ */
/* Live CDP backend — drives a CDP browser bridge, read-only.         */
/* ------------------------------------------------------------------ */

/** Function injected into the page; returns the same node shape via real CSS. */
export function inPageExtract() {
  const out = [];
  let id = 0;
  const push = (text, source, tag, hidden, reasons) => {
    if (text && text.trim()) out.push({ id: 'n' + id++, text, source, tag, path: tag, hidden, hiddenReasons: reasons });
  };
  // CSS ::before/::after `content` renders visible text that lives in no DOM
  // node — getComputedStyle is the only way to read it. Return the string
  // literal only; skip none/normal and the dynamic forms (attr()/counter()/
  // url()/gradients) that carry no attacker-controlled prose.
  const pseudoContent = (el, sel) => {
    let c;
    try { c = getComputedStyle(el, sel).content; } catch (e) { return null; }
    if (!c || c === 'none' || c === 'normal') return null;
    if (/^(attr|counter|counters|url|var|image-set|linear-gradient|radial-gradient)\(/i.test(c)) return null;
    const m = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/.exec(c);
    const s = m ? (m[1] !== undefined ? m[1] : m[2]).replace(/\\(.)/g, '$1') : c;
    return s && s.trim() ? s : null;
  };
  const isHidden = (el) => {
    const cs = getComputedStyle(el);
    const r = [];
    if (cs.display === 'none') r.push('display:none');
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') r.push('visibility:hidden');
    if (parseFloat(cs.opacity) === 0) r.push('opacity:0');
    if (parseFloat(cs.fontSize) <= 1) r.push('tiny-font');
    const rect = el.getBoundingClientRect();
    if (rect.right < 0 || rect.bottom < 0 || rect.left > (innerWidth + 2000) || (rect.width <= 1 && rect.height <= 1 && el.textContent.trim().length > 4)) r.push('offscreen');
    // Low-contrast by color DISTANCE, matching the static backend's colorDist<=24
    // tolerance. Exact string equality (fg === bg) missed near-but-not-identical
    // colors — #fffffe on #ffffff is a 1-bit-off evasion the static path caught.
    // getComputedStyle returns rgb()/rgba(); skip a transparent background
    // (alpha 0): the real backdrop is an ancestor's, so matching rgba(…,0) would
    // be a false signal.
    const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(',').map(parseFloat); return p.length >= 3 ? p : null; };
    const fg = rgb(cs.color), bg = rgb(cs.backgroundColor);
    const opaque = (c) => c && (c.length < 4 || c[3] > 0);
    if (opaque(fg) && opaque(bg) && Math.abs(fg[0] - bg[0]) + Math.abs(fg[1] - bg[1]) + Math.abs(fg[2] - bg[2]) <= 24) r.push('low-contrast');
    if (el.getAttribute('aria-hidden') === 'true') r.push('aria-hidden');
    return r;
  };
  const walk = (el, inheritedHidden, source) => {
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        if (child.textContent.trim()) push(child.textContent, source, el.tagName ? el.tagName.toLowerCase() : 'shadow-root', inheritedHidden.length > 0, inheritedHidden);
      } else if (child.nodeType === 8) {
        push(child.textContent, 'comment', 'comment', true, ['comment']);
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) continue;
        const r = [...inheritedHidden, ...isHidden(child)];
        // Keep parity with the static backend's ATTR_SOURCES — `value` was
        // missing, so an injection smuggled in an <input value="…"> was caught
        // offline but invisible to the live (production) path.
        for (const a of ['alt', 'title', 'aria-label', 'placeholder', 'value']) {
          const v = child.getAttribute && child.getAttribute(a);
          if (v) push(v, 'attr:' + a, tag, false, []);
        }
        for (const sel of ['::before', '::after']) {
          const pt = pseudoContent(child, sel);
          if (pt) push(pt, 'pseudo', tag, r.length > 0, r);
        }
        walk(child, r, source);
        // Open shadow root: a web component's shadow tree, invisible to a plain
        // childNodes walk. Descend it with the host's inherited visibility so a
        // display:none host still hides its shadow subtree. A CLOSED shadow root
        // exposes no `.shadowRoot` handle and is genuinely unreachable — a
        // documented residual edge, same honesty as CSS-class hiding on static.
        if (child.shadowRoot) walk(child.shadowRoot, r, 'shadow');
      }
    }
  };
  for (const c of document.head ? document.head.querySelectorAll('meta[content]') : []) {
    push(c.getAttribute('content'), 'meta', 'meta', false, []);
  }
  walk(document.body, [], 'text');
  return { title: document.title, nodes: out };
}

/**
 * Drive the bridge to capture a live page. Non-destructive: isolated context,
 * close just our page/context, then disconnect — never browser.close().
 *
 * If `opts.page` is supplied (e.g. a ContextBroker-checked-out, keeper-logged-in
 * persona page), it is reused as-is — no context is created or closed and the
 * browser is NOT disconnected: the caller owns that page's lifecycle. This is
 * how an authenticated persona session gets read through the firewall.
 * @param {{browserURL?: string, browserWSEndpoint?: string, page?: object, url?: string, html?: string, timeoutMs?: number}} opts
 */
export async function captureFromBridge(opts) {
  const navOpts = { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs || 20000 };

  if (opts.page) {
    const page = opts.page;
    if (opts.html != null) await page.setContent(opts.html, navOpts);
    else if (opts.url) await page.goto(opts.url, navOpts);
    const { title, nodes } = await page.evaluate(inPageExtract);
    const url = opts.url || (opts.html != null ? 'inline://content' : (page.url ? page.url() : 'about:blank'));
    let origin = '';
    try { origin = new URL(url).origin; } catch { /* noop */ }
    return { url, origin, title, nodes, capturedBy: 'cdp' };
  }

  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.connect({
    browserURL: opts.browserURL,
    browserWSEndpoint: opts.browserWSEndpoint,
  });
  let context;
  try {
    context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setCacheEnabled(false);
    // setContent injects exact HTML (real computed styles, no hosting); goto for live URLs.
    if (opts.html != null) await page.setContent(opts.html, navOpts);
    else await page.goto(opts.url, navOpts);
    const { title, nodes } = await page.evaluate(inPageExtract);
    const url = opts.url || (opts.html != null ? 'inline://content' : 'about:blank');
    let origin = '';
    try { origin = new URL(url).origin; } catch { /* noop */ }
    return { url, origin, title, nodes, capturedBy: 'cdp' };
  } finally {
    try { if (context) await context.close(); } catch { /* noop */ }
    await browser.disconnect(); // NEVER close() — the bridge is shared prod
  }
}
