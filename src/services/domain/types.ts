/**
 * TypeScript interfaces for mode configuration system
 */

export interface ObservationType {
  id: string;
  label: string;
  description: string;
  emoji: string;
  work_emoji: string;
}

export interface ObservationConcept {
  id: string;
  label: string;
  description: string;
}

export interface ModePrompts {
  system_identity: string;       // Base persona and role definition
  language_instruction?: string; // Optional language constraints (e.g., "Write in Korean")
  spatial_awareness: string;     // Working directory context guidance
  observer_role: string;         // What the observer's job is in this mode
  recording_focus: string;       // What to record and how to think about it
  skip_guidance: string;         // What to skip recording
  type_guidance: string;         // Valid observation types for this mode
  concept_guidance: string;      // Valid concept categories for this mode
  field_guidance: string;        // Guidance for facts/files fields
  output_format_header: string;  // Text introducing the XML schema
  format_examples: string;       // Optional additional XML examples (empty string if not needed)
  footer: string;                // Closing instructions and encouragement
}

export interface ModeConfig {
  name: string;
  description: string;
  version: string;
  observation_types: ObservationType[];
  observation_concepts: ObservationConcept[];
  prompts: ModePrompts;
}
