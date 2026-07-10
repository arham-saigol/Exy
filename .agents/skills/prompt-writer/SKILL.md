---
name: prompt-writer
description: Write or improve a prompt for GPT-5.6 in Codex. Use when the user wants a coding-task prompt for feature work, fixes, refactors, code review, or implementation planning.
---

# Prompt Writer

Write the prompt the user should send to Codex. Optimize for a clear outcome, not a detailed operating procedure.

## Compose

1. Preserve the user's requested mode and every decision-changing fact they supplied: implement, investigate, review, explain, or plan; requirements, constraints, formats, and priorities. Do not turn a request for one mode into another.
2. Lead with the result Codex should produce. State the desired behavior or decision in concrete terms.
3. Add only decision-changing context the user supplied: observed behavior and repro steps, compatibility needs, non-negotiable constraints, and required output format.
4. Add completion evidence only when the task needs a meaningful check. Name the user-visible outcome, test, or evidence needed rather than prescribing a workflow.
5. State the requested deliverable when it is not obvious, such as a patch, review findings, explanation, or implementation plan.
6. Return the finished prompt with no commentary unless the user asks for alternatives or an explanation.

## HTML prompt file

When the user asks to create an HTML file or page for the prompt, read [html-prompt.md](html-prompt.md) and build the page from its template.

## Match the task

- **Feature or fix:** Describe the intended behavior, affected user flow or API, important constraints, and how success can be checked. Include reproduction steps for bugs when available.
- **Refactor:** State the architectural goal and invariants to preserve, such as public behavior, compatibility, or performance. Request a plan only when the user wants one.
- **Review:** Identify the change or area to assess, the risks to prioritize, and the reporting shape when it matters. Ask for actionable findings with evidence; do not ask for an implementation plan unless requested.
- **Plan:** State the decision or outcome to plan for, the relevant constraints and unknowns, and the level of detail needed. Ask for a plan, tradeoffs, and risks only to the extent the user needs them.

## Keep it lean

- Use the user's terminology and preserve explicit requirements.
- Prefer specific facts over generic quality language. Replace "make it robust" with the failure cases or invariants that matter.
- Mention a file, component, command, source, or screenshot only when the user supplied it or it is essential to identify the work.
- Let Codex inspect the workspace and choose its implementation approach. Do not routinely add directory maps, file lists, step-by-step implementation plans, edit permissions, allowed or forbidden files, approval rules, or tool-use policies.
- Do not add model settings, API syntax, generic role instructions, repeated constraints, or examples unless they resolve a real ambiguity.
- When information is missing, make a reasonable prompt from what is known. Ask one targeted question only when the missing answer would materially change the requested result.

## Final check

The prompt should preserve every decision-changing user requirement and make the requested result and deliverable clear. When the task needs it, state what success looks like and what must remain true. Remove instructions that merely restate Codex's normal behavior or do not affect the result.
