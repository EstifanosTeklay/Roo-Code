# src/hooks — Intent-Driven Hook Engine

This directory contains the **Deterministic Hook System** that upgrades Roo Code into a governed AI-Native IDE. It acts as a strict middleware boundary between the LLM's tool calls and the file system.

---

## Architecture

```
LLM Tool Call
     │
     ▼
presentAssistantMessage.ts  ← integration point
     │
     ├── HookEngine.preHook()    ← GATE: is this allowed?
     │        ├── Intent declared?
     │        ├── Scope valid?
     │        └── File stale?
     │
     ├── Original tool.handle()  ← actual execution
     │
     └── HookEngine.postHook()   ← LOG: what happened?
              └── TraceLogger → agent_trace.jsonl
```

---

## Files

| File | Responsibility |
|------|---------------|
| `HookEngine.ts` | Core middleware. Pre/post hook logic, intent validation, scope enforcement, concurrency control |
| `HookedBaseTool.ts` | Abstract base class pattern. Extend this instead of BaseTool for any new tools that need governance |
| `IntentStore.ts` | Reads and writes `.orchestration/active_intents.yaml`. Single source of truth for intents |
| `TraceLogger.ts` | Appends structured entries to `.orchestration/agent_trace.jsonl`. Immutable audit ledger |
| `SelectActiveIntentTool.ts` | OpenAI function definition for the `select_active_intent` tool. Injected into build-tools.ts |
| `IntentSystemPrompt.ts` | Generates intent enforcement rules injected into the LLM system prompt via Task.ts |
| `index.ts` | Public API barrel export |

---

## The Two-Stage Handshake Protocol

The AI cannot write code immediately. Every turn follows this state machine:

`
State 1: User Request
  └─→ State 2: Reasoning Intercept
            AI calls select_active_intent(intent_id)
            HookEngine loads context from active_intents.yaml
            Returns <intent_context> XML to AI
        └─→ State 3: Contextualized Action
                  AI calls write_to_file (now with context)
                  Pre-Hook validates scope + concurrency
                  Tool executes
                  Post-Hook logs trace to agent_trace.jsonl
```

---

## Integration Points (minimal Roo Code changes)

| File | Change |
|------|--------|
| `src/core/task/build-tools.ts` | +1 line: inject `selectActiveIntentToolDefinition` |
| `src/core/assistant-message/presentAssistantMessage.ts` | +1 import, +1 HookEngine instance, +select_active_intent case, +pre/post hooks on write_to_file |
| `src/core/task/Task.ts` | +3 lines: prepend intent rules to customInstructions |

---

## Sidecar Storage (.orchestration/)

Created automatically at runtime in the user's workspace:

```
.orchestration/
├── active_intents.yaml   ← YOU edit this to define intents
├── agent_trace.jsonl     ← machine-written, never edit
├── intent_map.md         ← spatial index, auto-updated
└── CLAUDE.md             ← shared brain for parallel agents
```

---

## Design Principles

- **Non-invasive:** Core Roo Code files are minimally changed. All logic is isolated here.
- **Fail-safe:** If hooks throw, a structured JSON error is returned to the LLM for self-correction.
- **Composable:** New tools can be governed by extending `HookedBaseTool` instead of `BaseTool`.
- **Append-only ledger:** `agent_trace.jsonl` is never modified, only appended to.
