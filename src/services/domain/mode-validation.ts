import type { ModePrompts } from './types.js';

// The standalone mode installer ships without src/; its copy is kept in sync by a test.
export const REQUIRED_PROMPT_KEYS = [
  'system_identity',
  'spatial_awareness',
  'observer_role',
  'recording_focus',
  'skip_guidance',
  'type_guidance',
  'concept_guidance',
  'field_guidance',
  'output_format_header',
  'format_examples',
  'footer',
  'xml_title_placeholder',
  'xml_subtitle_placeholder',
  'xml_fact_placeholder',
  'xml_narrative_placeholder',
  'xml_concept_placeholder',
  'xml_file_placeholder',
  'xml_summary_request_placeholder',
  'xml_summary_investigated_placeholder',
  'xml_summary_learned_placeholder',
  'xml_summary_completed_placeholder',
  'xml_summary_next_steps_placeholder',
  'xml_summary_notes_placeholder',
  'header_memory_start',
  'header_memory_continued',
  'header_summary_checkpoint',
  'continuation_greeting',
  'continuation_instruction',
  'summary_instruction',
  'summary_context_label',
  'summary_format_instruction',
  'summary_footer',
] as const satisfies readonly (keyof ModePrompts)[];

export type RequiredPromptKey = typeof REQUIRED_PROMPT_KEYS[number];

// Bundled security types use underscores (security_alert and security_note).
const ITEM_ID_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Return missing or invalid content, using the same requirements as the mode installer. */
export function validateMode(mode: unknown): string[] {
  if (!isObject(mode)) return ['mode (must be an object)'];

  const missing: string[] = [];
  const requireString = (value: unknown, label: string, allowEmpty = false): void => {
    if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
      missing.push(label);
    }
  };

  for (const field of ['name', 'description', 'version']) {
    requireString(mode[field], field);
  }

  const prompts = isObject(mode.prompts) ? mode.prompts : {};
  for (const key of REQUIRED_PROMPT_KEYS) {
    // The meme-tokens mode deliberately has no file placeholder.
    requireString(prompts[key], `prompts.${key}`, key === 'format_examples' || key === 'xml_file_placeholder');
  }

  for (const [label, fields, guidanceKey] of [
    ['observation_types', ['id', 'label', 'description', 'emoji', 'work_emoji'], 'type_guidance'],
    ['observation_concepts', ['id', 'label', 'description'], 'concept_guidance'],
  ] as const) {
    const items = mode[label];
    if (!Array.isArray(items) || items.length === 0) {
      missing.push(`${label} (must contain at least one item)`);
      continue;
    }

    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      const itemPath = `${label}[${index}]`;
      if (!isObject(item)) {
        missing.push(`${itemPath} (must be an object)`);
        continue;
      }
      for (const field of fields) requireString(item[field], `${itemPath}.${field}`);
      if (typeof item.id !== 'string' || !item.id.trim()) continue;
      if (!ITEM_ID_PATTERN.test(item.id)) {
        missing.push(`${itemPath}.id (must be lowercase words separated by hyphens or underscores)`);
      }
      if (seen.has(item.id)) missing.push(`${itemPath}.id (duplicate: ${item.id})`);
      seen.add(item.id);
      const guidance = prompts[guidanceKey];
      if (typeof guidance === 'string' && !guidance.includes(item.id)) {
        missing.push(`prompts.${guidanceKey} (must mention ${item.id})`);
      }
    }
  }

  return missing;
}
