# Domain docs

Layout: single-context.

## Before codebase exploration

- MUST read the root `CONTEXT.md`, if present.
- MUST read relevant decisions in `docs/adr/`, if present.
- If a root `CONTEXT-MAP.md` later exists, MUST follow it to the relevant context docs instead.

If these files are absent, proceed silently.
Create domain docs only when actual terms or decisions need documentation.

## Consumer rules

MUST use the glossary's canonical terms in issues, specifications, proposals, and code-related explanations.
If a needed term is missing, identify the gap for `/domain-modeling`.
MUST identify conflicts with existing ADRs rather than silently overriding their decisions.

`CONTEXT.md` is a domain glossary, not a specification or implementation plan.
Spec Kit specifications and plans remain in their feature directories.
The Spec Kit constitution remains in `.specify/memory/constitution.md`.
