# Example: a Microsoft AutoGen agent browsing behind picket

Put a real **AutoGen v0.4+ agent** (`AssistantAgent` running the genuine
tool-execution loop over a `McpWorkbench`) behind picket's
indirect-prompt-injection firewall by serving its browser through
**`picket-mcp`**. Every page the agent reads arrives instruction-stripped, and
every browser action is gated: allowlist-checked, stepped-up on
high-authority verbs, credential typing refused outright.

```
AssistantAgent  ─▶  McpWorkbench (stdio)  ─▶  picket-mcp  ─▶  the page
  the tool loop       AutoGen's MCP client     the firewall
```

The model is a deterministic `ScriptedModelClient` (no network, no API key):
it emits the same `FunctionCall`s a real tool-calling LLM would — *including
the exfil navigation a hijacked model would emit* — and AutoGen's genuine
agent loop executes them through the picket gate. The whole example runs
offline.

## The scenario

The agent's task is mundane: *process the acme invoice*. The invoice page is
booby-trapped — a `display:none` div carries the classic lethal trifecta
(instruction to the AI + sensitive-data ask + exfil destination). A naive
agent ingests that and becomes the attacker's. Here the payload is withheld at
`picket_observe`, and when the scripted model deliberately emits the hijack
actions anyway, the gate refuses each one.

## Files

| File | What it is |
|------|------------|
| `autogen_governed_agent.py` | the AutoGen agent + scripted offline model; 6 governed tool calls |
| `hostile-invoice.html` | the booby-trapped page (visible invoice + hidden trifecta injection) |
| `_plumbing_check.py` | the same picket wiring exercised with a raw MCP client, no AutoGen (layer test) |
| `evidence/` | captured stdout + exact version provenance from a real run |
| `requirements.txt` | pinned AutoGen versions (`autogen-ext[mcp]` pulls the MCP client) |

## Run

```bash
python -m venv .venv && . .venv/bin/activate   # .venv\Scripts\activate on Windows
pip install -r requirements.txt
python autogen_governed_agent.py    # -> GOVERNED_AGENT_PASS
python _plumbing_check.py           # -> PLUMBING_PASS (picket wiring only, no AutoGen)
```

`PICKET_MCP` overrides the path to `picket-mcp` (defaults to `../../bin/picket-mcp.mjs`;
Node ≥20 must be on PATH).

## What you should see

- **Perception** — `picket_observe` returns `BLOCK … LETHAL TRIFECTA` with the
  payload **withheld**: no `exfil.evil.example`, no "ignore all previous
  instructions" in anything the agent loop hands the model — but `Invoice #7`
  and the payment link survive.
- **Action** — the gate, four verdicts through the real agent loop:
  - navigate `acme.example/pay/7` (the actual task) → **ALLOW**
  - navigate `exfil.evil.example` (what a hijacked model would emit) → **DENY**
  - type into `#password` → **DENY**
  - submit "approve the wire transfer" → **STEP-UP**
- **Identity** — `picket_login` **fails closed**: no vault is configured in
  the MCP server's environment, so no lease is possible; secrets are filled at
  the browser layer by a keeper wired in-process, never ambient in env.

The run exits 0 only if all three planes prove out (`GOVERNED_AGENT_PASS`).

## Suite

picket is the browser leg of the Own Your Stack agent-security tools:
[warden](https://github.com/askalf/warden) (actions) ·
[keeper](https://github.com/askalf/keeper) (secrets) ·
[canon](https://github.com/askalf/canon) (skills). warden has the same
four-framework series for MCP *tool* governance — this series is the *browser*
counterpart.
