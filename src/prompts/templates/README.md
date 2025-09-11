# Claude Memory Templates

This directory contains modular templates for the Claude Memory System, including LLM analysis prompts and system integration responses.

## Files

### AnalysisTemplates.ts
The main template system for LLM analysis prompts. Contains clean, separated template functions for:

- **Entity extraction instructions** - Guidelines for identifying and categorizing technical entities
- **Relationship mapping instructions** - Rules for creating meaningful connections between entities
- **Output format specifications** - Exact format requirements for pipe-separated summaries
- **Example outputs** - Sample outputs to guide the LLM
- **MCP tool usage instructions** - Step-by-step MCP tool usage workflow
- **Dynamic content injection helpers** - Functions for injecting project/session context

### HookTemplates.ts
System integration templates for Claude Code hook responses. Provides standardized templates for:

- **Pre-compact hook responses** - Approve/block compression operations with proper formatting
- **Session-start hook responses** - Load and format context with rich memory information  
- **Pre-tool use hook responses** - Security policies and permission controls
- **Error handling templates** - User-friendly error messages with troubleshooting guidance
- **Progress indicators** - Status updates for long-running operations
- **Response validation** - Ensures compliance with Claude Code hook specifications

### ContextTemplates.ts
Human-readable formatting templates for user-facing messages during memory operations.

### Legacy Templates
- `analysis-template.txt` - Legacy mustache-style template (deprecated)
- `session-start-template.txt` - Legacy mustache-style template (deprecated)

## Architecture

The new template system follows these principles:

1. **Pure Functions** - Each template function takes context and returns formatted strings
2. **Modular Design** - Complex prompts are broken into focused, reusable components
3. **Type Safety** - Full TypeScript support with proper interfaces
4. **Context Injection** - Dynamic content injection through helper functions
5. **Composable Templates** - Build complex prompts by combining template sections

## Usage

### Hook Templates Usage
```typescript
import { 
  createPreCompactSuccessResponse,
  createSessionStartMemoryResponse,
  createPreToolUseAllowResponse,
  validateHookResponse 
} from './HookTemplates.js';

// Pre-compact hook: approve compression
const preCompactResponse = createPreCompactSuccessResponse();
console.log(JSON.stringify(preCompactResponse));
// Output: {"continue": true, "suppressOutput": true}

// Session start hook: load context with memories
const sessionResponse = createSessionStartMemoryResponse({
  projectName: 'claude-mem',
  memoryCount: 15,
  lastSessionTime: '2 hours ago',
  recentComponents: ['HookTemplates', 'PromptOrchestrator'],
  recentDecisions: ['Use TypeScript for type safety']
});
console.log(JSON.stringify(sessionResponse));

// Pre-tool use: allow memory tools
const toolResponse = createPreToolUseAllowResponse('Memory operations are always permitted');
console.log(JSON.stringify(toolResponse));

// Validate responses before sending
const validation = validateHookResponse(preCompactResponse, 'PreCompact');
if (!validation.isValid) {
  console.error('Invalid response:', validation.errors);
}
```

### Analysis Templates Usage
```typescript
import { buildCompleteAnalysisPrompt } from './AnalysisTemplates.js';

const prompt = buildCompleteAnalysisPrompt(
  'myproject',        // projectPrefix
  'session123',       // sessionId
  [],                // toolUseChains
  '2024-01-01',      // timestamp (optional)
  'archive.jsonl'    // archiveFilename (optional)
);
```

### Individual Template Components
```typescript
import { 
  createEntityExtractionInstructions,
  createOutputFormatSpecification,
  createExampleOutput
} from './AnalysisTemplates.js';

// Get just the entity extraction guidelines
const entityInstructions = createEntityExtractionInstructions('myproject');

// Get output format specification
const outputFormat = createOutputFormatSpecification('2024-01-01', 'archive.jsonl');

// Get example output
const examples = createExampleOutput('myproject', 'session123');
```

### Context Injection
```typescript
import { 
  injectProjectContext,
  injectSessionContext,
  validateTemplateContext 
} from './AnalysisTemplates.js';

// Validate context before using templates
const context = { projectPrefix: 'myproject', sessionId: 'session123' };
const errors = validateTemplateContext(context);
if (errors.length > 0) {
  console.error('Invalid context:', errors);
}

// Inject dynamic content into template strings
let template = "Working on {{projectPrefix}} session {{sessionId}}";
template = injectProjectContext(template, 'myproject');
template = injectSessionContext(template, 'session123');
```

## Template Sections

### Entity Extraction Instructions
- Categories of entities to extract (components, patterns, decisions, etc.)
- Naming conventions with project prefixes
- Entity type classifications
- Observation field templates

### Relationship Mapping
- Available relationship types
- Active-voice relationship guidelines
- Graph connection strategies

### Output Format
- Pipe-separated format specification
- Required fields and exact values
- Summary writing guidelines

### MCP Tool Usage
- Step-by-step MCP tool workflow
- Entity creation instructions
- Relationship creation guidelines

### Critical Requirements
- Entity count requirements (3-15 entities)
- Relationship count requirements (5-20 relationships)
- Output line requirements (3-10 summaries)
- Format validation rules

## Benefits Over Legacy System

1. **Maintainability** - Separated concerns make individual sections easy to update
2. **Testability** - Pure functions can be unit tested independently
3. **Reusability** - Template components can be reused across different contexts
4. **Debugging** - Easy to isolate issues to specific template sections
5. **Type Safety** - Full TypeScript support prevents runtime template errors
6. **Performance** - No string parsing overhead, direct function composition

## Migration from constants.ts

The massive `createAnalysisPrompt` function in `constants.ts` has been refactored into this modular system:

**Before** (130+ lines in single function):
```typescript
export function createAnalysisPrompt(...) {
  // Massive template string with embedded logic
  return `You are analyzing...${incrementalSection}${toolChains}...`;
}
```

**After** (clean delegation):
```typescript
export function createAnalysisPrompt(...) {
  return buildCompleteAnalysisPrompt(...);
}
```

This maintains backward compatibility while providing a much cleaner, more maintainable internal structure.