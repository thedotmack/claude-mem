---
name: make-mode
description: Create a custom claude-mem mode for any type of work
---

# Make Mode

You are guiding the user through creating a custom claude-mem mode. A mode defines what claude-mem's memory agent watches for and how it records observations.

## Step 1: Interview

Ask the user these questions **one at a time** (wait for each answer before asking the next):

1. **What kind of work do you do?** (e.g., legal review, sales outreach, academic research, content marketing, data analysis, project management)
2. **What would be most valuable to remember across sessions?** (e.g., client preferences, research findings, document templates, recurring patterns)
3. **What would be noise — not worth recording?** (e.g., routine file operations, simple lookups, meta-discussion)

If `$ARGUMENTS` is provided, use it as the mode name and ask the user to describe the work instead of asking question 1.

## Step 2: Design Observation Types (4-6)

Based on the interview, design observation types. Each type needs:
- `id`: lowercase kebab-case identifier
- `label`: human-readable name
- `description`: one-sentence explanation
- `emoji`: visual icon for display
- `work_emoji`: icon for the work table

**Rules:**
- Types must be **mutually exclusive** — each observation gets exactly one type
- Include at least one **decision or learning** type (for capturing rationale)
- Keep to 4-6 types (more creates decision fatigue)

**Present your proposed types to the user for review before proceeding.**

## Step 3: Design Observation Concepts (4-7)

Design cross-cutting knowledge categories. Each concept needs:
- `id`: lowercase kebab-case identifier
- `label`: human-readable name
- `description`: one-sentence explanation

**Rules:**
- Concepts are **tags**, not types — an observation can have 2-5 concepts
- Include at least one **gotcha or pattern** concept (for hard-won knowledge)
- Do NOT duplicate type names as concepts (types and concepts are separate dimensions)

**Present your proposed concepts to the user for review before proceeding.**

## Step 4: Generate Prompts

Generate all 33 prompt fields for the mode. The prompts fall into four categories:

### Domain-Specific Prompts (customize for the work domain)

1. `system_identity` — Who the memory agent is and what it records
2. `observer_role` — The agent's monitoring role
3. `recording_focus` — WHAT TO RECORD section with good/bad examples
4. `skip_guidance` — WHEN TO SKIP section
5. `type_guidance` — Lists all types with descriptions
6. `concept_guidance` — Lists all concepts with usage rules
7. `header_memory_start` — Section header for first memory block
8. `header_memory_continued` — Section header for continuation
9. `header_summary_checkpoint` — Section header for summaries
10. `continuation_greeting` — Greeting when resuming observation
11. `continuation_instruction` — Instructions for continued observation
12. `summary_instruction` — How to write progress summaries
13. `summary_context_label` — Label for the context section
14. `summary_format_instruction` — Format instruction for summaries
15. `summary_footer` — Footer for summary sections

### Structural Prompts (keep identical to code.json — do not customize)

16. `spatial_awareness` — Working directory context
17. `field_guidance` — How to write facts and file paths
18. `output_format_header` — "OUTPUT FORMAT" header
19. `format_examples` — Usually empty string
20. `footer` — Final instructions to the memory agent

### Observation XML Placeholders (adjust placeholder text for domain)

21. `xml_title_placeholder`
22. `xml_subtitle_placeholder`
23. `xml_fact_placeholder`
24. `xml_narrative_placeholder`
25. `xml_concept_placeholder`
26. `xml_file_placeholder`

### Summary XML Placeholders (adjust placeholder text for domain)

27. `xml_summary_request_placeholder`
28. `xml_summary_investigated_placeholder`
29. `xml_summary_learned_placeholder`
30. `xml_summary_completed_placeholder`
31. `xml_summary_next_steps_placeholder`
32. `xml_summary_notes_placeholder`

### Optional

33. `language_instruction` — Only include if the user works in a non-English language

### Template

Use this JSON skeleton — fill in ALL fields:

```json
{
  "name": "",
  "description": "",
  "version": "1.0.0",
  "observation_types": [
    { "id": "", "label": "", "description": "", "emoji": "", "work_emoji": "" }
  ],
  "observation_concepts": [
    { "id": "", "label": "", "description": "" }
  ],
  "prompts": {
    "system_identity": "",
    "spatial_awareness": "SPATIAL AWARENESS: Tool executions include the working directory (tool_cwd) to help you understand:\n- Which project or folder is being worked on\n- Where files are located relative to the working directory\n- How to match requested paths to actual execution paths",
    "observer_role": "",
    "recording_focus": "",
    "skip_guidance": "",
    "type_guidance": "",
    "concept_guidance": "",
    "field_guidance": "**facts**: Concise, self-contained statements\nEach fact is ONE piece of information\n      No pronouns - each fact must stand alone\n      Include specific details: filenames, formats, sources, values\n\n**files**: All files touched (full paths from working directory)",
    "output_format_header": "OUTPUT FORMAT\n-------------\nOutput observations using this XML structure:",
    "format_examples": "",
    "footer": "IMPORTANT! DO NOT do any work right now other than generating this OBSERVATIONS from tool use messages - and remember that you are a memory agent designed to summarize a DIFFERENT session, not this one.\n\nNever reference yourself or your own actions. Do not output anything other than the observation content formatted in the XML structure above. All other output is ignored by the system, and the system has been designed to be smart about token usage. Please spend your tokens wisely on useful observations.\n\nRemember that we record these observations as a way of helping us stay on track with our progress, and to help us keep important decisions and changes at the forefront of our minds! :) Thank you so much for your help!",
    "xml_title_placeholder": "[**title**: Short title capturing the core action or topic]",
    "xml_subtitle_placeholder": "[**subtitle**: One sentence explanation (max 24 words)]",
    "xml_fact_placeholder": "[Concise, self-contained statement]",
    "xml_narrative_placeholder": "[**narrative**: Full context: What was done, how it works, why it matters]",
    "xml_concept_placeholder": "[knowledge-type-category]",
    "xml_file_placeholder": "[path/to/file]",
    "xml_summary_request_placeholder": "",
    "xml_summary_investigated_placeholder": "",
    "xml_summary_learned_placeholder": "",
    "xml_summary_completed_placeholder": "",
    "xml_summary_next_steps_placeholder": "",
    "xml_summary_notes_placeholder": "",
    "header_memory_start": "",
    "header_memory_continued": "",
    "header_summary_checkpoint": "",
    "continuation_greeting": "",
    "continuation_instruction": "IMPORTANT: Continue generating observations from tool use messages using the XML structure below.",
    "summary_instruction": "",
    "summary_context_label": "",
    "summary_format_instruction": "Respond in this XML format:",
    "summary_footer": ""
  }
}
```

## Step 5: Write the Mode File

1. Write the generated JSON to `plugin/modes/{mode-name}.json`
2. Validate:
   - All ModePrompts fields are present (compare with template above — all 33 fields)
   - All type and concept IDs are lowercase kebab-case
   - JSON parses without errors
3. Optionally create a `{mode-name}--chill.json` behavioral variant:
   - Only override `name`, `prompts.recording_focus`, and `prompts.skip_guidance`
   - Follow the pattern from `plugin/modes/code--chill.json`

## Step 6: Activate

Update settings to use the new mode:

```bash
curl -s -X POST http://localhost:37777/api/settings \
  -H "Content-Type: application/json" \
  -d '{"CLAUDE_MEM_MODE": "{mode-name}", "CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES": "{comma-separated-type-ids}", "CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS": "{comma-separated-concept-ids}"}'
```

Tell the user: mode takes full effect on the next session (after `/clear` or new conversation).

## Anti-Pattern Guards

- **No hardcoded modes** — generate dynamically from user input
- **No code changes required** — modes are JSON drop-in files
- **No overlapping types** — each must capture a distinct category
- **No missing prompt fields** — ModeManager doesn't handle missing fields gracefully
- **Valid filenames only** — lowercase, hyphens, no spaces (e.g., `sales-outreach`, not `Sales Outreach`)
- **Types ≠ Concepts** — never use a type name as a concept
