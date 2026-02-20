# CLAUDE.md — Shared Brain

## Project: Autonomous Influencer Infrastructure

## Lessons Learned

- [2026-02-20] select_active_intent must be called before any write_to_file
- [2026-02-20] scope validation blocks writes outside owned_scope
- [2026-02-20] agent_trace.jsonl confirms SHA-256 traceability working

## Parallel Agent Roles

| Agent     | Role            | Scope             |
| --------- | --------------- | ----------------- |
| Architect | Plans intents   | intent_map.md     |
| Builder   | Implements code | src/**, skills/** |
