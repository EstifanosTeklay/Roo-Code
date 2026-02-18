/**
 * HookEngine.test.ts
 *
 * Validates the complete enforced intent handshake in realistic tool execution flows.
 *
 * Test Scenarios:
 *  1. GATE: Writing a file without declaring intent is blocked
 *  2. HANDSHAKE: Declaring intent loads <intent_context> XML correctly
 *  3. SCOPE: Writing outside owned_scope is blocked with SCOPE_VIOLATION
 *  4. SCOPE: Writing inside owned_scope is allowed
 *  5. CONCURRENCY: Stale file detection blocks write when another agent modified the file
 *  6. TRACE: Post-hook logs a valid entry to agent_trace.jsonl
 *  7. SELF-CORRECT: Blocked result is valid JSON the LLM can parse and act on
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { HookEngine } from "../HookEngine"
import { IntentStore } from "../IntentStore"
import { TraceLogger } from "../TraceLogger"

// ─── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Creates a temporary directory with a scaffolded .orchestration/ folder
 * containing a real active_intents.yaml for testing.
 */
function createTestWorkspace(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roo-hook-test-"))
	const orchDir = path.join(tmpDir, ".orchestration")
	fs.mkdirSync(orchDir, { recursive: true })

	// Write a real active_intents.yaml with two intents
	const yaml = `
active_intents:
  - id: INT-001
    name: Weather API Implementation
    status: IN_PROGRESS
    owned_scope:
      - src/api/**
      - src/services/weather/**
    constraints:
      - Must not introduce external API dependencies without approval
    acceptance_criteria:
      - All tests in tests/api/ pass

  - id: INT-002
    name: Auth Middleware Refactor
    status: PENDING
    owned_scope:
      - src/auth/**
      - src/middleware/jwt.ts
    constraints:
      - Must maintain backward compatibility with Basic Auth
    acceptance_criteria:
      - Unit tests in tests/auth/ pass
`.trim()

	fs.writeFileSync(path.join(orchDir, "active_intents.yaml"), yaml)
	return tmpDir
}

/**
 * Cleans up the temporary workspace after each test.
 */
function cleanupWorkspace(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HookEngine — Intent Handshake Protocol", () => {
	let cwd: string
	let engine: HookEngine

	beforeEach(() => {
		cwd = createTestWorkspace()
		engine = new HookEngine(cwd)
	})

	afterEach(() => {
		cleanupWorkspace(cwd)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// TEST 1: Gate — no intent declared
	// ─────────────────────────────────────────────────────────────────────────
	describe("TEST 1: INTENT_REQUIRED gate", () => {
		it("blocks write_to_file when no intent has been declared", async () => {
			const result = await engine.preHook({
				toolName: "write_to_file",
				params: { path: "src/api/weather.ts", content: "export const x = 1" },
				activeIntentId: null,
				cwd,
			})

			expect(result.allowed).toBe(false)
			expect(result.reason).toContain("INTENT_REQUIRED")
			expect(result.reason).toContain("select_active_intent")
		})

		it("blocks execute_command when no intent has been declared", async () => {
			const result = await engine.preHook({
				toolName: "execute_command",
				params: { command: "rm -rf dist/" },
				activeIntentId: null,
				cwd,
			})

			expect(result.allowed).toBe(false)
			expect(result.reason).toContain("INTENT_REQUIRED")
		})

		it("allows read_file without intent declaration (safe tool)", async () => {
			const result = await engine.preHook({
				toolName: "read_file",
				params: { path: "src/api/weather.ts" },
				activeIntentId: null,
				cwd,
			})

			expect(result.allowed).toBe(true)
		})
	})

	// ─────────────────────────────────────────────────────────────────────────
	// TEST 2: Handshake — select_active_intent loads context
	// ─────────────────────────────────────────────────────────────────────────
	describe("TEST 2: Handshake — select_active_intent context injection", () => {
		it("returns structured <intent_context> XML for a valid intent ID", async () => {
			const result = await engine.selectIntent("INT-001")

			expect(result).toContain("<intent_context>")
			expect(result).toContain("<id>INT-001</id>")
			expect(result).toContain("Weather API Implementation")
			expect(result).toContain("src/api/**")
			expect(result).toContain("Must not introduce external API dependencies")
			expect(result).toContain("</intent_context>")
		})

		it("sets the active intent ID after successful selection", async () => {
			expect(engine.getActiveIntentId()).toBeNull()

			await engine.selectIntent("INT-001")

			expect(engine.getActiveIntentId()).toBe("INT-001")
		})

		it("returns an error message for an invalid intent ID", async () => {
			const result = await engine.selectIntent("INT-999")

			expect(result).toContain("ERROR")
			expect(result).toContain("INT-999")
			expect(result).toContain("INT-001") // suggests valid IDs
		})

		it("does not set active intent for an invalid ID", async () => {
			await engine.selectIntent("INT-999")

			expect(engine.getActiveIntentId()).toBeNull()
		})
	})

	// ─────────────────────────────────────────────────────────────────────────
	// TEST 3: Scope enforcement — write OUTSIDE owned_scope
	// ─────────────────────────────────────────────────────────────────────────
	describe("TEST 3: SCOPE_VIOLATION — write outside owned_scope", () => {
		it("blocks write_to_file targeting a file outside INT-001 scope", async () => {
			await engine.selectIntent("INT-001")

			// INT-001 owns src/api/** and src/services/weather/**
			// src/auth/middleware.ts is NOT in scope
			const result = await engine.preHook({
				toolName: "write_to_file",
				params: { path: "src/auth/middleware.ts", content: "export const y = 2" },
				activeIntentId: engine.getActiveIntentId(),
				cwd,
			})

			expect(result.allowed).toBe(false)
			expect(result.reason).toContain("SCOPE_VIOLATION")
			expect(result.reason).toContain("INT-001")
			expect(result.reason).toContain("src/auth/middleware.ts")
		})

		it("includes owned scope in the violation message for self-correction", async () => {
			await engine.selectIntent("INT-001")

			const result = await engine.preHook({
				toolName: "write_to_file",
				params: { path: "src/auth/middleware.ts", content: "export const y = 2" },
				activeIntentId: engine.getActiveIntentId(),
				cwd,
			})

			expect(result.reason).toContain("src/api/**")
		})
	})

	// ─────────────────────────────────────────────────────────────────────────
	// TEST 4: Scope enforcement — write INSIDE owned_scope
	// ─────────────────────────────────────────────────────────────────────────
	describe("TEST 4: Scope allowed — write inside owned_scope", () => {
		it("allows write_to_file targeting a file inside INT-001 scope", async () => {
			await engine.selectIntent("INT-001")

			const result = await engine.preHook({
				toolName: "write_to_file",
				params: { path: "src/api/weather.ts", content: "export const getWeather = () => {}" },
				activeIntentId: engine.getActiveIntentId(),
				cwd,
			})

			expect(result.allowed).toBe(true)
		})

		it("allows write_to_file for INT-002 scope after switching intent", async () => {
			await engine.selectIntent("INT-002")

			const result = await engine.preHook({
				toolName: "write_to_file",
				params: { path: "src/auth/middleware.ts", content: "export const auth = () => {}" },
				activeIntentId: engine.getActiveIntentId(),
				cwd,
			})

			expect(result.allowed).toBe(true)
		})
	})

	// ─────────────────────────────────────────────────────────────────────────
	// TEST 5: Concurrency — stale file detection
	// ─────────────────────────────────────────────────────────────────────────
	describe("TEST 5: Concurrency control — stale file detection", () => {
		it("blocks write when file was modified by another agent since last read", async () => {
			await engine.selectIntent("INT-001")

			const filePath = "src/api/weather.ts"
			const absolutePath = path.join(cwd, filePath)

			// Ensure directory exists
			fs.mkdirSync(path.dirname(absolutePath), { recursive: true })

			// Simulate: Agent A reads the file (sets cache)
			fs.writeFileSync(absolutePath, "// original content", "utf-8")
			await engine.preHook({
				toolName: "write_to_file",
				params: { path: filePath, content: "// agent A version" },
				activeIntentId: engine.getActiveIntentId(),
				cwd,
			})

			// Simulate: Agent B modifies the file on disk (different content)
			fs.writeFileSync(absolutePath, "// agent B modified this", "utf-8")

			// Now Agent A tries to write — should be blocked (stale)
			const result = await engine.preHook({
				toolName: "write_to_file",
				params: { path: filePath, content: "// agent A version" },
				activeIntentId: engine.getActiveIntentId(),
				cwd,
			})

			expect(result.allowed).toBe(false)
			expect(result.reason).toContain("STALE_FILE")
			expect(result.reason).toContain(filePath)
		})

		it("allows write when file has not been modified since last read", async () => {
			await engine.selectIntent("INT-001")

			const filePath = "src/api/weather.ts"
			const absolutePath = path.join(cwd, filePath)
			fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
			fs.writeFileSync(absolutePath, "// original content", "utf-8")

			// First write — seeds the cache
			await engine.preHook({
				toolName: "write_to_file",
				params: { path: filePath, content: "// agent A version" },
				activeIntentId: engine.getActiveIntentId(),
				cwd,
			})

			// No other agent touches the file

			// Second write by same agent — should be allowed
			const result = await engine.preHook({
				toolName: "write_to_file",
				params: { path: filePath, content: "// agent A updated version" },
				activeIntentId: engine.getActiveIntentId(),
				cwd,
			})

			expect(result.allowed).toBe(true)
		})
	})

	// ─────────────────────────────────────────────────────────────────────────
	// TEST 6: Post-hook — trace logging to agent_trace.jsonl
	// ─────────────────────────────────────────────────────────────────────────
	describe("TEST 6: Post-hook trace logging", () => {
		it("appends a valid trace entry to agent_trace.jsonl after a write", async () => {
			await engine.selectIntent("INT-001")

			await engine.postHook({
				toolName: "write_to_file",
				params: {
					path: "src/api/weather.ts",
					content: "export const getWeather = async () => ({ temp: 22 })",
				},
				activeIntentId: engine.getActiveIntentId(),
				cwd,
				result: null,
				elapsedMs: 120,
			})

			// Read the trace log
			const tracePath = path.join(cwd, ".orchestration", "agent_trace.jsonl")
			expect(fs.existsSync(tracePath)).toBe(true)

			const lines = fs.readFileSync(tracePath, "utf-8").trim().split("\n")
			expect(lines.length).toBe(1)

			const entry = JSON.parse(lines[0])
			expect(entry.id).toBeDefined()
			expect(entry.timestamp).toBeDefined()
			expect(entry.intent_id).toBe("INT-001")
			expect(entry.tool).toBe("write_to_file")
			expect(entry.mutation_class).toMatch(/AST_REFACTOR|INTENT_EVOLUTION/)
			expect(entry.files[0].relative_path).toBe("src/api/weather.ts")
			expect(entry.files[0].content_hash).toMatch(/^sha256:/)
			expect(entry.files[0].contributor.entity_type).toBe("AI")
		})

		it("correctly classifies a new export as INTENT_EVOLUTION", async () => {
			await engine.selectIntent("INT-001")

			await engine.postHook({
				toolName: "write_to_file",
				params: {
					path: "src/api/weather.ts",
					content: "export class WeatherService { async fetch() {} }",
				},
				activeIntentId: engine.getActiveIntentId(),
				cwd,
				result: null,
				elapsedMs: 80,
			})

			const tracePath = path.join(cwd, ".orchestration", "agent_trace.jsonl")
			const entry = JSON.parse(fs.readFileSync(tracePath, "utf-8").trim())
			expect(entry.mutation_class).toBe("INTENT_EVOLUTION")
		})

		it("correctly classifies a simple edit as AST_REFACTOR", async () => {
			await engine.selectIntent("INT-001")

			await engine.postHook({
				toolName: "write_to_file",
				params: {
					path: "src/api/weather.ts",
					// No new exports or routes — just internal logic change
					content: "const formatTemp = (t: number) => `${t}°C`",
				},
				activeIntentId: engine.getActiveIntentId(),
				cwd,
				result: null,
				elapsedMs: 60,
			})

			const tracePath = path.join(cwd, ".orchestration", "agent_trace.jsonl")
			const entry = JSON.parse(fs.readFileSync(tracePath, "utf-8").trim())
			expect(entry.mutation_class).toBe("AST_REFACTOR")
		})
	})

	// ─────────────────────────────────────────────────────────────────────────
	// TEST 7: Self-correction — blocked result is parseable JSON
	// ─────────────────────────────────────────────────────────────────────────
	describe("TEST 7: Self-correction — LLM-parseable error format", () => {
		it("produces a reason string that can be serialized as JSON for LLM self-correction", async () => {
			// No intent declared — will be blocked
			const result = await engine.preHook({
				toolName: "write_to_file",
				params: { path: "src/api/weather.ts", content: "x" },
				activeIntentId: null,
				cwd,
			})

			expect(result.allowed).toBe(false)

			// Simulate what presentAssistantMessage does with the blocked result
			const errorPayload = JSON.stringify({
				error: result.reason,
				type: "HOOK_BLOCKED",
				tool: "write_to_file",
			})

			// Must be valid JSON the LLM can parse and act on
			expect(() => JSON.parse(errorPayload)).not.toThrow()

			const parsed = JSON.parse(errorPayload)
			expect(parsed.type).toBe("HOOK_BLOCKED")
			expect(parsed.error).toContain("INTENT_REQUIRED")
		})
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// IntentStore unit tests
// ─────────────────────────────────────────────────────────────────────────────
describe("IntentStore", () => {
	let tmpDir: string
	let store: IntentStore

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roo-intent-store-"))
		store = new IntentStore(tmpDir)
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	it("creates active_intents.yaml on first use", () => {
		expect(fs.existsSync(path.join(tmpDir, "active_intents.yaml"))).toBe(true)
	})

	it("returns null for a non-existent intent ID", async () => {
		const intent = await store.getIntent("INT-999")
		expect(intent).toBeNull()
	})

	it("lists all intent IDs", async () => {
		const ids = await store.listIntentIds()
		expect(Array.isArray(ids)).toBe(true)
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// TraceLogger unit tests
// ─────────────────────────────────────────────────────────────────────────────
describe("TraceLogger", () => {
	let tmpDir: string
	let logger: TraceLogger

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roo-trace-"))
		logger = new TraceLogger(tmpDir)
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	it("appends valid JSONL entries", async () => {
		await logger.appendTrace({
			id: "test-uuid",
			timestamp: new Date().toISOString(),
			intent_id: "INT-001",
			tool: "write_to_file",
			mutation_class: "AST_REFACTOR",
			files: [
				{
					relative_path: "src/api/weather.ts",
					content_hash: "sha256:abc123",
					contributor: { entity_type: "AI", model_identifier: "claude-sonnet" },
				},
			],
		})

		const entries = await logger.readAll()
		expect(entries.length).toBe(1)
		expect(entries[0].intent_id).toBe("INT-001")
		expect(entries[0].mutation_class).toBe("AST_REFACTOR")
	})

	it("appends multiple entries without overwriting", async () => {
		await logger.appendTrace({
			id: "uuid-1",
			timestamp: new Date().toISOString(),
			intent_id: "INT-001",
			tool: "write_to_file",
			mutation_class: "AST_REFACTOR",
			files: [],
		})

		await logger.appendTrace({
			id: "uuid-2",
			timestamp: new Date().toISOString(),
			intent_id: "INT-002",
			tool: "write_to_file",
			mutation_class: "INTENT_EVOLUTION",
			files: [],
		})

		const entries = await logger.readAll()
		expect(entries.length).toBe(2)
		expect(entries[0].id).toBe("uuid-1")
		expect(entries[1].id).toBe("uuid-2")
	})

	it("filters entries by intent ID", async () => {
		await logger.appendTrace({
			id: "uuid-1",
			timestamp: new Date().toISOString(),
			intent_id: "INT-001",
			tool: "write_to_file",
			mutation_class: "AST_REFACTOR",
			files: [],
		})
		await logger.appendTrace({
			id: "uuid-2",
			timestamp: new Date().toISOString(),
			intent_id: "INT-002",
			tool: "write_to_file",
			mutation_class: "INTENT_EVOLUTION",
			files: [],
		})

		const int001Entries = await logger.getEntriesForIntent("INT-001")
		expect(int001Entries.length).toBe(1)
		expect(int001Entries[0].id).toBe("uuid-1")
	})
})
