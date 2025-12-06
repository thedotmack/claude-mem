/**
 * Real-world test scenarios extracted from actual claude-mem usage.
 * These represent typical tool usage patterns that generate observations.
 */

// A real Bash command observation
export const bashCommandScenario = {
  tool_name: 'Bash',
  tool_input: {
    command: 'git status',
    description: 'Check git status'
  },
  tool_response: {
    stdout: 'On branch main\nnothing to commit, working tree clean',
    exit_code: 0
  }
};

// A real Read file observation
export const readFileScenario = {
  tool_name: 'Read',
  tool_input: {
    file_path: '/project/src/index.ts'
  },
  tool_response: {
    content: 'export function main() { console.log("Hello"); }'
  }
};

// A real Write file observation
export const writeFileScenario = {
  tool_name: 'Write',
  tool_input: {
    file_path: '/project/src/config.ts',
    content: 'export const API_KEY = "test";'
  },
  tool_response: {
    success: true
  }
};

// A real Edit file observation
export const editFileScenario = {
  tool_name: 'Edit',
  tool_input: {
    file_path: '/project/src/app.ts',
    old_string: 'const PORT = 3000;',
    new_string: 'const PORT = 8080;'
  },
  tool_response: {
    success: true
  }
};

// A real Grep search observation
export const grepScenario = {
  tool_name: 'Grep',
  tool_input: {
    pattern: 'function.*main',
    path: '/project/src'
  },
  tool_response: {
    matches: [
      'src/index.ts:10:export function main() {',
      'src/cli.ts:5:function mainCli() {'
    ]
  }
};

// A real session with prompts
export const sessionScenario = {
  claudeSessionId: 'abc-123-def-456',
  project: 'claude-mem',
  userPrompt: 'Help me fix the bug in the parser'
};

// Another session scenario
export const sessionWithBuildScenario = {
  claudeSessionId: 'xyz-789-ghi-012',
  project: 'my-app',
  userPrompt: 'Run the build and fix any type errors'
};

// Test observation data
export const sampleObservation = {
  title: 'Fixed parser bug',
  type: 'bugfix' as const,
  content: 'The XML parser was not handling empty tags correctly. Added check for self-closing tags.',
  files: ['/project/src/parser.ts'],
  concepts: ['bugfix', 'parser', 'xml']
};

// Another observation
export const featureObservation = {
  title: 'Added search functionality',
  type: 'feature' as const,
  content: 'Implemented full-text search using FTS5 for observations and sessions.',
  files: ['/project/src/services/search.ts'],
  concepts: ['feature', 'search', 'fts5']
};

// Session summary scenario
export const sessionSummaryScenario = {
  claudeSessionId: 'abc-123-def-456',
  last_user_message: 'Thanks, that fixed it!',
  last_assistant_message: 'The bug was in the parser. I added a check for self-closing tags in src/parser.ts:42.'
};
