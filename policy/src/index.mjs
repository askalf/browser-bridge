/**
 * @askalf/fieldpass — a governed agentic browser.
 *
 * An indirect-prompt-injection firewall + action gate that wraps a CDP browser
 * so agents can read untrusted web pages without being hijacked by them.
 * Part of the Own Your Stack agent-security suite: redstamp · strongroom · truecopy · cordon.
 */

export { GovernedBrowser, KeeperStub } from './govern.mjs';
export { ContextBroker } from './broker.mjs';
export { ReplayOracle, snapshot, diffSnapshots, verifyClaims, stableHash } from './oracle.mjs';
export { SessionRecorder, toCanonSkill, replaySkill, skillHash, canonicalJson } from './skill.mjs';
export { detect, analyzeNode, ACTIONS, worstAction, severityToAction } from './detect.mjs';
export { captureFromHtml, captureFromBridge } from './capture.mjs';
export { buildSafeObservation } from './neutralize.mjs';
export { WardenClient, LocalPolicy, makePolicy } from './policy.mjs';
export { LLMJudge, applyEscalations, selectEscalationCandidates, heuristicBackend, VERDICTS_SCHEMA } from './judge.mjs';
export { makeClaudeBackend } from './claude-judge.mjs';
export * as patterns from './patterns.mjs';
