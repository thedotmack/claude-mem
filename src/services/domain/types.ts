
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
  system_identity: string;
  spatial_awareness: string;
  observer_role: string;         
  recording_focus: string;       
  skip_guidance: string;         
  type_guidance: string;         
  concept_guidance: string;      
  field_guidance: string;        
  output_format_header: string;  
  format_examples: string;       
  footer: string;                

  xml_title_placeholder: string;           
  xml_subtitle_placeholder: string;        
  xml_fact_placeholder: string;            
  xml_narrative_placeholder: string;       
  xml_concept_placeholder: string;         
  xml_file_placeholder: string;            

  xml_summary_request_placeholder: string;      
  xml_summary_investigated_placeholder: string; 
  xml_summary_learned_placeholder: string;      
  xml_summary_completed_placeholder: string;    
  xml_summary_next_steps_placeholder: string;   
  xml_summary_notes_placeholder: string;        

  header_memory_start: string;        
  header_memory_continued: string;    
  header_summary_checkpoint: string;  

  continuation_greeting: string;      
  continuation_instruction: string;   

  summary_instruction: string;        
  summary_context_label: string;      
  summary_format_instruction: string; 
  summary_footer: string;             
}

export interface ModeConfig {
  name: string;
  description: string;
  version: string;
  observation_types: ObservationType[];
  observation_concepts: ObservationConcept[];
  prompts: ModePrompts;
}
