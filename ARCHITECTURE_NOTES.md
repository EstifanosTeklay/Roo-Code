# ARCHITECTURE_NOTES.md
## Phase 0: Archaeological Dig — Roo Code Nervous System Map

**Project:** TRP1 Week 1 — Intent-Driven Hook System for AI-Native IDE  
**Extension Base:** Roo Code (VS Code Extension)  
**Date:** 2026-02-17

---

## 1. How the VS Code Extension Works

A VS Code extension runs in two isolated processes:

### 1.1 The Extension Host (Node.js process)
This is the privileged backend. It can:
- Read/write files on disk
- Execute terminal commands
- Make HTTP requests (LLM API calls)
- Access VS Code APIs (`vscode.*`)
- Manage secrets and state

**Key files in the Extension Host:**
```
src/extension.ts              ← Entry point, registers commands
src/core/task/Task.ts         ← The agent's execution loop (177,950 bytes)
src/core/tools/               ← Individual tool implementations
src/core/webview/ClineProvider.ts  ← Orchestrates everything (134,013 bytes)
src/api/                      ← LLM provider adapters
```

### 1.2 The Webview (Chromium iframe)
This is the sandboxed UI layer. It:
- Renders the chat interface (React)
- Can ONLY communicate with the Extension Host via `postMessage`
- Has NO direct file system or network access

**Key files in the Webview:**
```
src/webview-ui/               ← React UI (Vite build)
src/core/webview/webviewMessageHandler.ts  ← Receives postMessage from UI (118,253 bytes)
```

### 1.3 The Message Bridge
```
Webview UI  →  postMessage  →  webviewMessageHandler.ts  →  ClineProvider.ts  →  Task.ts
Webview UI  ←  postMessage  ←  ClineProvider.ts
```

---

## 2. The Agent Execution Loop (Task.ts)

`Task.ts` is the core agent brain. The execution loop:

```
1. User sends message
2. ClineProvider creates a Task instance
3. Task builds the system prompt (via SYSTEM_PROMPT())
4. Task calls LLM API with conversation history
5. LLM streams back a response
6. If response contains tool calls:
   a. Parse tool call (native JSON args via NativeToolCallParser)
   b. Route to the correct Tool class
   c. Call tool.handle(task, block, callbacks)
   d. Append tool result to conversation
   e. Loop back to step 4
7. If response is text-only: display to user, end turn
```

---

## 3. Tool Execution: The Exact Call Chain

### 3.1 Tool Registration (build-tools.ts)
```typescript
// src/core/task/build-tools.ts
buildNativeToolsArray(options) 
  → getNativeTools()           // returns OpenAI function definitions
  → filterNativeToolsForMode() // filter by active mode
  → getMcpServerTools()        // add MCP tools
  // ← OUR HOOK: inject selectActiveIntentToolDefinition here
```

### 3.2 Tool Dispatch (Task.ts)
Tools are routed from the LLM response to the correct class. The dispatch calls `tool.handle()`.

### 3.3 Tool Execution (BaseTool.ts)
```typescript
// src/core/tools/BaseTool.ts
abstract class BaseTool<TName> {
  abstract execute(params, task, callbacks): Promise<void>
  
  async handle(task, block, callbacks): Promise<void> {
    if (block.partial) { await this.handlePartial(); return }
    params = block.nativeArgs   // ← typed args from LLM
    await this.execute(params, task, callbacks)  // ← THE HOOK POINT
  }
}
```

**Our Hook Injection:** We subclass `BaseTool` with `HookedBaseTool` which overrides `handle()`:
```typescript
async handle(task, block, callbacks) {
  // PRE-HOOK: check intent, validate scope, check concurrency
  const result = await hookEngine.preHook(...)
  if (!result.allowed) { pushToolResult(error); return }
  
  await super.handle(task, block, callbacks) // original execution
  
  // POST-HOOK: log trace to agent_trace.jsonl
  await hookEngine.postHook(...)
}
```

### 3.4 WriteToFileTool.ts — Detailed Flow
```typescript
execute(params, task, callbacks) {
  1. Validate path and content params
  2. Check rooIgnoreController access
  3. Check rooProtectedController write protection
  4. Open diff view (streaming preview)
  5. askApproval() → shows "Approve/Reject" to user
  6. If approved → diffViewProvider.saveChanges()
  7. fileContextTracker.trackFileContext()
  8. pushToolResult(message)
}
```
**Our pre-hook fires BEFORE step 1.** If blocked, we never enter execute().

---

## 4. System Prompt Construction

### 4.1 Call Chain
```
generateSystemPrompt.ts → SYSTEM_PROMPT() → generatePrompt()
```

### 4.2 generatePrompt() assembles sections:
```
${roleDefinition}          ← Mode-specific role (e.g., "You are Roo...")
${markdownFormattingSection()}
${getSharedToolUseSection()}
${getToolUseGuidelinesSection()}
${getCapabilitiesSection()}
${getModesSection()}
${getSkillsSection()}
${getRulesSection()}       ← .roorules, .cursorrules injection
${getSystemInfoSection()}
${getObjectiveSection()}
${addCustomInstructions()} ← ← ← OUR HOOK POINT
```

### 4.3 Our Injection
We inject the intent enforcement rules into `addCustomInstructions()` by prepending to `globalCustomInstructions`:

```typescript
// In ClineProvider or Task, before calling SYSTEM_PROMPT():
const intentPrompt = getIntentEnforcementPrompt(activeIntentIds)
const enrichedInstructions = intentPrompt + "\n\n" + (globalCustomInstructions || "")
// Pass enrichedInstructions as globalCustomInstructions to SYSTEM_PROMPT()
```

---

## 5. The Two-Stage State Machine (Handshake Protocol)

```
┌─────────────────────────────────────────────────────────┐
│ STATE 1: REQUEST                                         │
│ User: "Refactor the auth middleware"                     │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ STATE 2: REASONING INTERCEPT (The Handshake)             │
│ LLM: calls select_active_intent("INT-002")               │
│ Pre-Hook intercepts → reads active_intents.yaml          │
│ Injects <intent_context> XML block as tool result        │
│ LLM now knows: scope=[src/auth/**], constraints=[...]    │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ STATE 3: CONTEXTUALIZED ACTION                           │
│ LLM: calls write_to_file("src/auth/middleware.ts", ...)  │
│ Pre-Hook: validates scope ✓, checks concurrency ✓        │
│ execute() runs → file written                            │
│ Post-Hook: logs trace to agent_trace.jsonl               │
└─────────────────────────────────────────────────────────┘
```

---

## 6. Hook Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                         EXTENSION HOST                            │
│                                                                   │
│  ClineProvider                                                    │
│       │                                                           │
│       ├── SYSTEM_PROMPT()                                         │
│       │        └── addCustomInstructions()                        │
│       │                 └── [INJECTED] IntentEnforcementPrompt   │
│       │                                                           │
│       └── Task.ts (Agent Loop)                                    │
│                │                                                  │
│                ├── LLM API Call                                   │
│                │                                                  │
│                └── Tool Dispatch                                   │
│                         │                                         │
│              ┌──────────┴──────────┐                             │
│              │   HookedBaseTool    │  ← src/hooks/HookedBaseTool │
│              │   (Middleware)      │                              │
│              │  ┌───────────────┐  │                             │
│              │  │  PRE-HOOK     │  │  HookEngine.preHook()       │
│              │  │ • intent check│  │  • intent declared?          │
│              │  │ • scope valid │  │  • scope matches?            │
│              │  │ • concurrency │  │  • file stale?               │
│              │  │ • HITL gate   │  │  • human approved?           │
│              │  └──────┬────────┘  │                             │
│              │         │           │                              │
│              │  ┌──────▼────────┐  │                             │
│              │  │  execute()    │  │  Original tool logic         │
│              │  │ (BaseTool)    │  │                              │
│              │  └──────┬────────┘  │                             │
│              │         │           │                              │
│              │  ┌──────▼────────┐  │                             │
│              │  │  POST-HOOK    │  │  HookEngine.postHook()      │
│              │  │ • hash content│  │  • sha256 content hash       │
│              │  │ • classify    │  │  • AST_REFACTOR / EVOLUTION  │
│              │  │ • log trace   │  │  • append agent_trace.jsonl  │
│              │  └───────────────┘  │                             │
│              └─────────────────────┘                             │
│                                                                   │
│  .orchestration/                                                  │
│  ├── active_intents.yaml   ← Intent source of truth              │
│  ├── agent_trace.jsonl     ← Immutable audit ledger              │
│  ├── intent_map.md         ← Spatial index                       │
│  └── CLAUDE.md             ← Shared brain                        │
└──────────────────────────────────────────────────────────────────┘
```

---

## 7. Key Files Summary

| File | Purpose | Hook Interaction |
|------|---------|-----------------|
| `src/extension.ts` | Extension entry point | No change needed |
| `src/core/task/Task.ts` | Agent execution loop | Instantiates HookEngine per task |
| `src/core/task/build-tools.ts` | Tool registration | Inject `selectActiveIntentToolDefinition` |
| `src/core/tools/BaseTool.ts` | Abstract base for all tools | Extended by HookedBaseTool |
| `src/core/tools/WriteToFileTool.ts` | File write tool | Extended by hooked version |
| `src/core/tools/ExecuteCommandTool.ts` | Shell command tool | Extended by hooked version |
| `src/core/prompts/system.ts` | System prompt builder | Intent rules injected via addCustomInstructions |
| `src/core/webview/ClineProvider.ts` | Main orchestrator | Passes enriched instructions to SYSTEM_PROMPT |
| **`src/hooks/HookEngine.ts`** | **Our middleware core** | Pre/Post hook logic |
| **`src/hooks/HookedBaseTool.ts`** | **Our tool wrapper** | Intercepts handle() |
| **`src/hooks/IntentStore.ts`** | **YAML reader/writer** | Reads active_intents.yaml |
| **`src/hooks/TraceLogger.ts`** | **JSONL appender** | Writes agent_trace.jsonl |
| **`src/hooks/SelectActiveIntentTool.ts`** | **New tool definition** | The Handshake tool |
| **`src/hooks/IntentSystemPrompt.ts`** | **Prompt injection** | Intent enforcement rules |

---

## 8. What We Are NOT Changing in Roo Core

To maintain a clean fork and minimize merge conflicts:

- `BaseTool.ts` — NOT modified. We extend it.
- `Task.ts` — MINIMAL change: instantiate HookEngine and pass to tools.
- `build-tools.ts` — ONE addition: push `selectActiveIntentToolDefinition` to the tools array.
- `system.ts` — NOT modified. We prepend to `globalCustomInstructions` upstream.
- All existing tool files — NOT modified. Hooked versions are new subclasses.

---

*Generated during Phase 0 Archaeological Dig — ready for Phase 1 implementation.*
