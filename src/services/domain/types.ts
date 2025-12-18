/**
 * TypeScript interfaces for domain configuration system
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

export interface DomainPrompts {
  init_context: string;
  type_guidance: string;
  concept_guidance: string;
}

export interface DomainConfig {
  name: string;
  description: string;
  version: string;
  observation_types: ObservationType[];
  observation_concepts: ObservationConcept[];
  prompts: DomainPrompts;
}
