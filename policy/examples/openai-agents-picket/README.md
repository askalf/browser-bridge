# Example: an OpenAI Agents SDK agent browsing behind picket

Put a real **OpenAI Agents SDK** agent (the `@openai/agents` runtime — an
`Agent` with MCP servers, executed by the SDK's `Runner`, the genuine
tool-execution loop) behind picket's indirect-prompt-injection firewall by
serving its browser through **`picket-mcp`**. Every page the agent reads
arrives instruction-stripped, and every browser action is gated.

```
Agents SDK Runner ─▶ MCPServerStdio (stdio) ─▶ picket-mcp ─▶ the page
  the tool loop         the SDK's MCP client     the firewall
```

The model is a small **scripted stub** injected via a custom `ModelProvider`,
so the whole example runs **offline with no OpenAI API key**: the thing under
test is picket's governance of the agent's browsing, not OpenAI inference. The
stub emits the same `function_call` items a real model would — *including the
exfil navigation a hijacked model would emit* — and the genuine Agents-SDK
Runner executes them through the picket gate.

## The scenario

The agent's task is mundane: *process the acme invoice*. The invoice page is
booby-trapped — a `display:none` div carries the classic lethal trifecta
(instruction to the AI + sensitive-data ask + exfil destination). A naive agent
ingests that and becomes the attacker's. Here the payload is withheld at
`picket_observe`, and when the scripted model deliberately emits the hijack
actions anyway, the gate refuses each one.

## Files

| File | What it is |
|------|------------|
| `agent_governed_browse.mjs` | the Agents-SDK agent + scripted offline model; 6 governed tool calls |
| `hostile-invoice.html` | the booby-trapped page (visible invoice + hidden trifecta injection) |
| `_plumbing_check.mjs` | the same picket wiring exercised with a raw MCP client, no Agents SDK (layer test) |
| `evidence/` | captured stdout + exact version provenance from a real run |
| `package.json` | pinned Agents SDK + MCP SDK versions |

## Run

```bash
npm install
node agent_governed_browse.mjs   # -> GOVERNED_AGENT_PASS
node _plumbing_check.mjs         # -> PLUMBING_PASS (picket wiring only, no Agents SDK)
```

`PICKET_MCP` overrides the path to `picket-mcp` (defaults to `../../bin/picket-mcp.mjs`).

## What you should see

- **Perception** — `picket_observe` returns `BLOCK … LETHAL TRIFECTA` with the
  payload **withheld**: no `exfil.evil.example`, no "ignore all previous
  instructions" in anything the Runner hands the model — but `Invoice #7`
  and the payment link survive.
- **Action** — the gate, four verdicts through the real Runner loop:
  - navigate `acme.example/pay/7` (the actual task) → **ALLOW**
  - navigate `exfil.evil.example` (what a hijacked model would emit) → **DENY**
  - type into `#password` → **DENY**
  - submit "approve the wire transfer" → **STEP-UP**
- **Identity** — `picket_login` **fails closed**: no vault is configured in the
  MCP server's environment, so no lease is possible; secrets are filled at the
  browser layer by a keeper wired in-process, never ambient in env.

The run exits 0 only if all three planes prove out (`GOVERNED_AGENT_PASS`).

### Gotcha worth knowing

`MCPServerStdio` does **not** forward the parent's environment to the spawned
server — pass `env` explicitly or the firewall runs with an open allowlist
(the first thing this example's evidence run caught).

## Suite

picket is the browser leg of the Own Your Stack agent-security tools:
[warden](https://github.com/askalf/warden) (actions) ·
[keeper](https://github.com/askalf/keeper) (secrets) ·
[canon](https://github.com/askalf/canon) (skills). warden has the same
four-framework series for MCP *tool* governance — this series is the *browser*
counterpart.
