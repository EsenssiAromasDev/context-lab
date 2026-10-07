# Context fixtures

Expected outcomes (SPEC §44). These folders are data for tests and dogfooding;
their CLAUDE.md files describe the fixture, not this repository.

| Fixture | Expected |
| --- | --- |
| `simple-project/` | 1 observed project instruction, 0 issues |
| `redundant-project/` | `CLAUDE.md > Testing` and `.claude/rules/testing.md > Testing` → lexical overlap (exact duplicate section) |
| `nested-project/` | before a Read: root observed, `src/api/CLAUDE.md` available; after reading `src/api/service.ts` without a `nested_memory` attachment: inferred; with one: observed |
