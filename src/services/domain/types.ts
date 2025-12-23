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

  // Observation XML placeholders
  xml_title_placeholder: string;           // e.g., "[**title**: Short title capturing the core action or topic]"
  xml_subtitle_placeholder: string;        // e.g., "[**subtitle**: One sentence explanation (max 24 words)]"
  xml_fact_placeholder: string;            // e.g., "[Concise, self-contained statement]"
  xml_narrative_placeholder: string;       // e.g., "[**narrative**: Full context: What was done, how it works, why it matters]"
  xml_concept_placeholder: string;         // e.g., "[knowledge-type-category]"
  xml_file_placeholder: string;            // e.g., "[path/to/file]"

  // Summary XML placeholders
  xml_summary_request_placeholder: string;      // e.g., "[Short title capturing the user's request AND...]"
  xml_summary_investigated_placeholder: string; // e.g., "[What has been explored so far? What was examined?]"
  xml_summary_learned_placeholder: string;      // e.g., "[What have you learned about how things work?]"
  xml_summary_completed_placeholder: string;    // e.g., "[What work has been completed so far? What has shipped or changed?]"
  xml_summary_next_steps_placeholder: string;   // e.g., "[What are you actively working on or planning to work on next in this session?]"
  xml_summary_notes_placeholder: string;        // e.g., "[Additional insights or observations about the current progress]"

  // Section headers (with separator lines)
  header_memory_start: string;        // e.g., "MEMORY PROCESSING START\n======================="
  header_memory_continued: string;    // e.g., "MEMORY PROCESSING CONTINUED\n==========================="
  header_summary_checkpoint: string;  // e.g., "PROGRESS SUMMARY CHECKPOINT\n==========================="

  // Continuation prompts
  continuation_greeting: string;      // e.g., "Hello memory agent, you are continuing to observe the primary Claude session."
  continuation_instruction: string;   // e.g., "IMPORTANT: Continue generating observations from tool use messages using the XML structure below."

  // Summary prompts
  summary_instruction: string;        // Instructions for writing progress summary
  summary_context_label: string;      // Label for Claude's response section (e.g., "Claude's Full Response to User:")
  summary_format_instruction: string; // Instruction to use XML format (e.g., "Respond in this XML format:")
  summary_footer: string;             // Footer with closing instructions and language requirement
}

export interface ModeConfig {
  name: string;
  description: string;
  version: string;
  observation_types: ObservationType[];
  observation_concepts: ObservationConcept[];
  prompts: ModePrompts;
}
