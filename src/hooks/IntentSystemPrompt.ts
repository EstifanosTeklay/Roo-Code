/**
 * IntentSystemPrompt generates the intent-enforcement block
 * to be injected into the system prompt via addCustomInstructions().
 *
 * INJECTION POINT: src/core/prompts/system.ts → addCustomInstructions()
 * The caller appends this to globalCustomInstructions before calling SYSTEM_PROMPT().
 */

export function getIntentEnforcementPrompt(activeIntentIds: string[]): string {
	return `
## MANDATORY PROTOCOL - READ THIS FIRST

RULE: Your first tool call MUST be select_active_intent. Not read_file. Not list_files. SELECT_ACTIVE_INTENT FIRST.

Available intent IDs: ${activeIntentIds.length > 0 ? activeIntentIds.join(", ") : "INT-001, INT-002"}

Step 1: Call select_active_intent(intent_id) immediately
Step 2: Only after that, read files and write code

If you call anything else first, you will be blocked.
`.trim()
}
