"""Layer test: the same picket-mcp wiring exercised with a RAW MCP client - no
CrewAI. If this passes and the flow fails, the problem is in the flow; if this
fails, the problem is in the picket wiring. Run: python _plumbing_check.py"""
from __future__ import annotations

import asyncio
import os

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = os.path.dirname(os.path.abspath(__file__))
PICKET_MCP = os.environ.get("PICKET_MCP", os.path.join(HERE, "..", "..", "bin", "picket-mcp.mjs"))
with open(os.path.join(HERE, "hostile-invoice.html"), encoding="utf-8") as f:
    PAGE = f.read()


async def run() -> bool:
    params = StdioServerParameters(
        command="node",
        args=[PICKET_MCP],
        env={**os.environ, "PICKET_ALLOWLIST": "acme.example", "PICKET_CDP": ""},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = sorted(t.name for t in (await session.list_tools()).tools)
            print("tools:", tools)
            res = await session.call_tool(
                "picket_observe", {"html": PAGE, "task": "process the acme invoice"}
            )
            text = "\n".join(b.text for b in res.content if getattr(b, "text", None))
            print("observe verdict line:", text.splitlines()[0])
            return (
                tools == ["picket_gate", "picket_login", "picket_observe"]
                and "BLOCK" in text
                and "exfil.evil.example" not in text
                and "Invoice #7" in text
            )


if __name__ == "__main__":
    ok = asyncio.run(run())
    print("PLUMBING_PASS" if ok else "PLUMBING_FAIL")
    raise SystemExit(0 if ok else 1)
