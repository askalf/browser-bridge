/**
 * The Observation is picket's neutral, capture-agnostic view of a page.
 *
 * Both capture backends (static HTML parse + live CDP) emit this exact shape,
 * so the detector, provenance tagger and neutralizer never care how the page
 * was read. Every text-bearing node carries its provenance (where the text
 * came from) and visibility signals (whether a human would ever see it) — the
 * two things indirect-prompt-injection defense hinges on.
 *
 * @typedef {Object} ObsNode
 * @property {string}   id            stable-ish id, e.g. "n12"
 * @property {string}   text          the raw text content of the node
 * @property {NodeSource} source      where the text was sourced from
 * @property {string}   tag           lowercased owner tag, e.g. "div", "img"
 * @property {string}   path          crude DOM path for the human report
 * @property {boolean}  hidden        true if a sighted user would not read it
 * @property {string[]} hiddenReasons e.g. ["display:none","low-contrast","zero-width"]
 *
 * @typedef {('text'|'comment'|'meta'|'attr:alt'|'attr:title'|'attr:aria-label'|'attr:placeholder'|'attr:value')} NodeSource
 *
 * @typedef {Object} Observation
 * @property {string}    url
 * @property {string}    origin        scheme://host[:port] — the page's own origin
 * @property {string}    title
 * @property {ObsNode[]} nodes
 * @property {('static'|'cdp')} capturedBy
 */

/** Provenance is binary by design: the task/system framing the broker supplies
 *  is TRUSTED; everything sourced from the page is UNTRUSTED. There is no third
 *  bucket — that ambiguity is exactly what injections exploit. */
export const TRUSTED = 'trusted';
export const UNTRUSTED = 'untrusted';

/** Every node in an Observation is page-derived, hence untrusted. */
export function provenanceOf(_node) {
  return UNTRUSTED;
}

export function emptyObservation(url = 'about:blank') {
  let origin = '';
  try { origin = new URL(url).origin; } catch { origin = ''; }
  return { url, origin, title: '', nodes: [], capturedBy: 'static' };
}
