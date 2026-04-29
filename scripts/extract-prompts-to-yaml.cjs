#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const promptsPath = '/tmp/prompts-main.ts';
const promptsContent = fs.readFileSync(promptsPath, 'utf-8');

const initPromptMatch = promptsContent.match(/export function buildInitPrompt\([^)]+\): string \{[\s\S]*?return `([\s\S]*?)`;\s*\}/);
if (!initPromptMatch) {
  console.error('Could not find buildInitPrompt function');
  process.exit(1);
}
const initPrompt = initPromptMatch[1];

const observerRoleMatch = initPrompt.match(/Your job is to monitor[^\n]*\n\n(?:SPATIAL AWARENESS:[\s\S]*?\n\n)?/);
const observerRole = observerRoleMatch ? observerRoleMatch[0].replace(/\n\n$/, '') : '';

const recordingFocusMatch = initPrompt.match(/WHAT TO RECORD\n-{14}\n([\s\S]*?)(?=\n\nWHEN TO SKIP)/);
const recordingFocus = recordingFocusMatch ? `WHAT TO RECORD\n--------------\n${recordingFocusMatch[1]}` : '';

const skipGuidanceMatch = initPrompt.match(/WHEN TO SKIP\n-{12}\n([\s\S]*?)(?=\n\nOUTPUT FORMAT)/);
const skipGuidance = skipGuidanceMatch ? `WHEN TO SKIP\n------------\n${skipGuidanceMatch[1]}` : '';

const typeGuidanceMatch = initPrompt.match(/<!--\n\s+\*\*type\*\*: MUST be EXACTLY[^\n]*\n([\s\S]*?)-->/);
const typeGuidance = typeGuidanceMatch ? typeGuidanceMatch[0].replace(/<!--\n\s+/, '').replace(/\s+-->/, '').trim() : '';

const factsMatch = initPrompt.match(/\*\*facts\*\*: Concise[^\n]*\n([\s\S]*?)(?=\n  -->)/);
const filesMatch = initPrompt.match(/\*\*files\*\*:[^\n]*\n/);

const factsText = factsMatch ? `**facts**: Concise, self-contained statements\n${factsMatch[1].trim()}` : '';
const filesText = filesMatch ? filesMatch[0].trim() : '**files**: All files touched (full paths from project root)';

const fieldGuidance = `${factsText}\n\n${filesText}`;

const conceptGuidanceMatch = initPrompt.match(/<!--\n\s+\*\*concepts\*\*: 2-5 knowledge[^\n]*\n([\s\S]*?)-->/);
const conceptGuidance = conceptGuidanceMatch ? conceptGuidanceMatch[0].replace(/<!--\n\s+/, '').replace(/\s+-->/, '').trim() : '';

const jsonData = {
  name: "Code Development",
  description: "Software development and engineering work",
  version: "1.0.0",
  observation_types: [
    { id: "bugfix", label: "Bug Fix", description: "Something was broken, now fixed", emoji: "🔴", work_emoji: "🛠️" },
    { id: "feature", label: "Feature", description: "New capability or functionality added", emoji: "🟣", work_emoji: "🛠️" },
    { id: "refactor", label: "Refactor", description: "Code restructured, behavior unchanged", emoji: "🔄", work_emoji: "🛠️" },
    { id: "change", label: "Change", description: "Generic modification (docs, config, misc)", emoji: "✅", work_emoji: "🛠️" },
    { id: "discovery", label: "Discovery", description: "Learning about existing system", emoji: "🔵", work_emoji: "🔍" },
    { id: "decision", label: "Decision", description: "Architectural/design choice with rationale", emoji: "⚖️", work_emoji: "⚖️" }
  ],
  observation_concepts: [
    { id: "how-it-works", label: "How It Works", description: "Understanding mechanisms" },
    { id: "why-it-exists", label: "Why It Exists", description: "Purpose or rationale" },
    { id: "what-changed", label: "What Changed", description: "Modifications made" },
    { id: "problem-solution", label: "Problem-Solution", description: "Issues and their fixes" },
    { id: "gotcha", label: "Gotcha", description: "Traps or edge cases" },
    { id: "pattern", label: "Pattern", description: "Reusable approach" },
    { id: "trade-off", label: "Trade-Off", description: "Pros/cons of a decision" }
  ],
  prompts: {
    observer_role: observerRole,
    recording_focus: recordingFocus,
    skip_guidance: skipGuidance,
    type_guidance: typeGuidance,
    concept_guidance: conceptGuidance,
    field_guidance: fieldGuidance,
    format_examples: ""
  }
};

const yamlContent_OLD = `name: "Code Development"
description: "Software development and engineering work"
version: "1.0.0"

observation_types:
  - id: "bugfix"
    label: "Bug Fix"
    description: "Something was broken, now fixed"
    emoji: "🔴"
    work_emoji: "🛠️"
  - id: "feature"
    label: "Feature"
    description: "New capability or functionality added"
    emoji: "🟣"
    work_emoji: "🛠️"
  - id: "refactor"
    label: "Refactor"
    description: "Code restructured, behavior unchanged"
    emoji: "🔄"
    work_emoji: "🛠️"
  - id: "change"
    label: "Change"
    description: "Generic modification (docs, config, misc)"
    emoji: "✅"
    work_emoji: "🛠️"
  - id: "discovery"
    label: "Discovery"
    description: "Learning about existing system"
    emoji: "🔵"
    work_emoji: "🔍"
  - id: "decision"
    label: "Decision"
    description: "Architectural/design choice with rationale"
    emoji: "⚖️"
    work_emoji: "⚖️"

observation_concepts:
  - id: "how-it-works"
    label: "How It Works"
    description: "Understanding mechanisms"
  - id: "why-it-exists"
    label: "Why It Exists"
    description: "Purpose or rationale"
  - id: "what-changed"
    label: "What Changed"
    description: "Modifications made"
  - id: "problem-solution"
    label: "Problem-Solution"
    description: "Issues and their fixes"
  - id: "gotcha"
    label: "Gotcha"
    description: "Traps or edge cases"
  - id: "pattern"
    label: "Pattern"
    description: "Reusable approach"
  - id: "trade-off"
    label: "Trade-Off"
    description: "Pros/cons of a decision"

prompts:
  observer_role: |
    ${observerRole}

  recording_focus: |
    ${recordingFocus}

  skip_guidance: |
    ${skipGuidance}

  type_guidance: |
    ${typeGuidance}

  concept_guidance: |
    ${conceptGuidance}

  field_guidance: |
    ${fieldGuidance}

  format_examples: ""
`;

const outputPath = path.join(__dirname, '../modes/code.json');
fs.writeFileSync(outputPath, JSON.stringify(jsonData, null, 2), 'utf-8');

console.log('✅ Generated modes/code.json from prompts.ts');
console.log('\nExtracted sections:');
console.log('- observer_role:', observerRole.substring(0, 50) + '...');
console.log('- recording_focus:', recordingFocus.substring(0, 50) + '...');
console.log('- skip_guidance:', skipGuidance.substring(0, 50) + '...');
console.log('- type_guidance:', typeGuidance.substring(0, 50) + '...');
console.log('- concept_guidance:', conceptGuidance.substring(0, 50) + '...');
console.log('- field_guidance:', fieldGuidance.substring(0, 50) + '...');
