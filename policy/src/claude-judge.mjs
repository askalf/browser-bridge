/**
 * Claude backend for the LLM judge — the production escalation path.
 *
 * Uses Anthropic's official SDK (optional dependency, lazy-imported so the
 * picket core stays dependency-free). Defaults to claude-haiku-4-5: the
 * cheapest, fastest tier, which is the right call for a high-volume binary
 * classifier — bump `model` to an Opus tier for the hardest pages. Forces
 * schema-valid JSON via output_config.format so there is nothing to coax or
 * salvage from prose.
 *
 *   import { LLMJudge } from './judge.mjs';
 *   import { makeClaudeBackend } from './claude-judge.mjs';
 *   const judge = new LLMJudge({ backend: makeClaudeBackend() }); // ANTHROPIC_API_KEY
 *
 * baseURL is overridable for an Anthropic-compatible proxy.
 */

import { parseVerdicts } from './judge.mjs';

export function makeClaudeBackend(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const baseURL = opts.baseURL ?? process.env.ANTHROPIC_BASE_URL; // e.g. a dario/proxy endpoint
  const model = opts.model ?? 'claude-haiku-4-5';
  const maxTokens = opts.maxTokens ?? 1024;

  return async function claudeBackend({ system, user, schema }) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    const resp = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      // Constrain the response to the verdicts schema — no prose to parse around.
      output_config: { format: { type: 'json_schema', schema } },
    });
    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseVerdicts(text);
  };
}

/**
 * dario backend — run the judge on your Claude Pro/Max SUBSCRIPTION instead of a
 * metered API key, by routing through a local dario proxy (github.com/askalf/dario).
 * dario is Anthropic-compatible at http://localhost:3456; it rebuilds the request
 * into Claude Code wire-shape so it bills to the subscription pool, then forwards to
 * Anthropic. The api key is the literal string "dario" (dario supplies the real OAuth).
 *
 * Caveat: dario normalizes the body toward CC's shape, so the `output_config.format`
 * JSON-schema constraint may be dropped — the model returns prose-wrapped JSON instead
 * of schema-enforced JSON. That's fine here: the prompt already demands JSON and
 * parseVerdicts() tolerates prose-wrapped output. Override the endpoint with DARIO_URL.
 */
export function makeDarioBackend(opts = {}) {
  return makeClaudeBackend({
    baseURL: opts.baseURL ?? process.env.DARIO_URL ?? 'http://localhost:3456',
    apiKey: opts.apiKey ?? 'dario',
    ...opts,
  });
}
