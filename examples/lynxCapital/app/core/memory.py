"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Short-term working memory per agent with token accounting and LLM-driven compaction.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

if TYPE_CHECKING:
    from langchain_openai import ChatOpenAI


MODEL_CONTEXT_LIMITS: dict[str, int] = {
    "gpt-5.4-nano": 128_000,
    "gpt-5.4-mini": 128_000,
    "gpt-5-mini":   128_000,
}

DEFAULT_LIMIT = 128_000
COMPACTION_RATIO = 0.70
KEEP_TAIL_MESSAGES = 6


def estimate_tokens(text: str) -> int:
    """Approximate token count: ~4 chars per token for English prose."""
    if not text:
        return 0
    return max(1, len(text) // 4)


def message_tokens(msg: BaseMessage) -> int:
    content = msg.content if isinstance(msg.content, str) else str(msg.content)
    extra = 0
    for tc in getattr(msg, "tool_calls", []) or []:
        extra += estimate_tokens(str(tc.get("args", "")))
        extra += estimate_tokens(str(tc.get("name", "")))
    return estimate_tokens(content) + extra + 4  # +4 per-message overhead


def context_limit(model: str) -> int:
    return MODEL_CONTEXT_LIMITS.get(model, DEFAULT_LIMIT)


@dataclass
class AgentMemory:
    """Per-agent message history with summary-based compaction."""

    agent_id: str
    model: str
    system: SystemMessage
    seed_summary: str = ""
    messages: list[BaseMessage] = field(default_factory=list)
    compactions: int = 0
    compaction_log: list[str] = field(default_factory=list)

    def append(self, msg: BaseMessage) -> None:
        self.messages.append(msg)

    def total_tokens(self) -> int:
        n = message_tokens(self.system)
        if self.seed_summary:
            n += estimate_tokens(self.seed_summary)
        for m in self.messages:
            n += message_tokens(m)
        return n

    def as_prompt(self) -> list[BaseMessage]:
        out: list[BaseMessage] = [self.system]
        if self.seed_summary:
            out.append(SystemMessage(content=f"Context from parent agent:\n{self.seed_summary}"))
        out.extend(self.messages)
        return out

    def should_compact(self) -> bool:
        limit = context_limit(self.model)
        return self.total_tokens() > int(limit * COMPACTION_RATIO)

    async def compact(self, llm: "ChatOpenAI") -> str | None:
        """Summarize older messages via a real LLM call. Keep the tail verbatim.

        Returns the new summary string if compaction occurred, else None.
        """
        if len(self.messages) <= KEEP_TAIL_MESSAGES + 2:
            return None

        head = self.messages[:-KEEP_TAIL_MESSAGES]
        tail = self.messages[-KEEP_TAIL_MESSAGES:]

        transcript_lines: list[str] = []
        for m in head:
            role = m.__class__.__name__.replace("Message", "")
            if isinstance(m, AIMessage) and m.tool_calls:
                calls = ", ".join(f"{tc['name']}({tc.get('args', {})})" for tc in m.tool_calls)
                transcript_lines.append(f"{role}: {m.content or ''}  [tools: {calls}]")
            elif isinstance(m, ToolMessage):
                snippet = str(m.content)[:200]
                transcript_lines.append(f"ToolResult: {snippet}")
            else:
                transcript_lines.append(f"{role}: {m.content}")

        prior_summary = self.seed_summary
        summarize_prompt = [
            SystemMessage(content=(
                "You are compacting an agent's working memory to stay within its "
                "context window. Produce a concise summary (<= 200 words) of the "
                "prior conversation and tool results. Focus on: decisions made, "
                "entities processed, outstanding work, and any errors. Use bullet "
                "points. Do not invent facts."
            )),
            HumanMessage(content=(
                (f"Previous summary:\n{prior_summary}\n\n" if prior_summary else "")
                + "Transcript to compact:\n" + "\n".join(transcript_lines)
            )),
        ]
        ai = await llm.ainvoke(summarize_prompt)
        summary = ai.content if isinstance(ai.content, str) else str(ai.content)

        self.seed_summary = summary
        self.messages = tail
        self.compactions += 1
        self.compaction_log.append(summary)
        return summary


class RunMemoryStore:
    """Container for all agent memories within a single run."""

    def __init__(self, run_id: str, model: str) -> None:
        self.run_id = run_id
        self.model = model
        self._agents: dict[str, AgentMemory] = {}

    def open(
        self,
        agent_id: str,
        system: SystemMessage,
        seed_summary: str = "",
    ) -> AgentMemory:
        mem = AgentMemory(
            agent_id=agent_id,
            model=self.model,
            system=system,
            seed_summary=seed_summary,
        )
        self._agents[agent_id] = mem
        return mem

    def get(self, agent_id: str) -> AgentMemory | None:
        return self._agents.get(agent_id)

    def aggregate_tokens(self) -> int:
        return sum(m.total_tokens() for m in self._agents.values())

    def aggregate_compactions(self) -> int:
        return sum(m.compactions for m in self._agents.values())
