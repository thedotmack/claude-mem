---
name: create-mode
description: Create a custom claude-mem observation mode for domain-specific tracking. Use when asked to "create a mode", "new mode", "custom mode", or "make a mode for X".
---

# Create Mode

Guide the user through creating a custom observation mode JSON file for their specific domain.

## Workflow

### Step 1: Understand the Domain

Ask the user:
- **What domain or workflow** is this mode for? (e.g., "data science", "devops", "design review", "sales calls")
- **What should be tracked?** What kinds of events or decisions matter in this workflow?

### Step 2: Design Observation Types

Each mode needs 4-8 observation types. Each type has:
- `id` — lowercase kebab-case identifier
- `label` — Human-readable name
- `description` — When to use this type (guides the AI observer)
- `emoji` — Timeline emoji
- `work_emoji` — Work-in-progress emoji

**Example for a "data-science" mode:**
```json
[
  { "id": "experiment", "label": "Experiment", "description": "Hypothesis tested with measurable outcome", "emoji": "🧪", "work_emoji": "🔬" },
  { "id": "data-insight", "label": "Data Insight", "description": "Pattern or anomaly discovered in data", "emoji": "📊", "work_emoji": "📈" },
  { "id": "model-change", "label": "Model Change", "description": "Model architecture, hyperparameters, or training modified", "emoji": "🤖", "work_emoji": "⚙️" },
  { "id": "pipeline-fix", "label": "Pipeline Fix", "description": "Data pipeline or ETL issue resolved", "emoji": "🔴", "work_emoji": "🛠️" },
  { "id": "decision", "label": "Decision", "description": "Methodology or approach decision made", "emoji": "⚖️", "work_emoji": "🤔" },
  { "id": "discovery", "label": "Discovery", "description": "New understanding of data, domain, or tooling", "emoji": "🔵", "work_emoji": "🔍" }
]
```

### Step 3: Design Observation Concepts

Concepts are categories that tag observations for search. Each concept has:
- `id` — lowercase kebab-case
- `label` — Human-readable
- `description` — What this concept covers

Design 6-12 concepts relevant to the domain.

### Step 4: Configure Prompts

The mode JSON includes prompt configuration that guides the AI observer:
- `observer_system_prompt` — Overall instruction for what to observe
- `observation_guidance` — How to write observations in this domain
- `recording_focus` — What's worth recording vs. skipping
- `skip_guidance` — What to explicitly skip

### Step 5: Generate the Mode File

Use `code.json` as the structural template. The full mode file structure:

```json
{
  "name": "Mode Display Name",
  "description": "One-line description",
  "version": "1.0.0",
  "observation_types": [ ... ],
  "observation_concepts": [ ... ],
  "prompts": {
    "observer_system_prompt": "You are observing [domain] work...",
    "observation_guidance": "Focus on...",
    "recording_focus": "Record when...",
    "skip_guidance": "Skip routine..."
  }
}
```

### Step 6: Save and Activate

1. **Save** the mode JSON to the claude-mem modes directory. To find it, call `GET http://localhost:37777/api/modes` — but for writing, the mode file goes in the plugin's `modes/` directory. Use `~/.claude/plugins/marketplaces/thedotmack/modes/` as the target.
2. **Optionally activate** by asking: "Want to set this as the mode for the current project?" If yes, create `.claude-mem.json` in the project root.

## Inheritance

If the new mode should extend an existing mode, use the `parent--child` naming convention:
- `code--data-science` inherits all code types and adds data science types
- The child JSON only needs to contain the overrides/additions

For inherited modes, only include the fields that differ from the parent.

## Validation

After creating, verify the mode loads by calling:
```
GET http://localhost:37777/api/modes
```
The new mode should appear in the list.
