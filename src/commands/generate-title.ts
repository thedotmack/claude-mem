import { OptionValues } from 'commander';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getClaudePath } from '../shared/settings.js';
import path from 'path';
import fs from 'fs';

const SESSION_DIR = path.join(process.env.HOME || '', '.claude-mem', 'sessions');

/**
 * Generate a session title and subtitle from a user prompt
 * CLI command that uses Agent SDK (like changelog.ts)
 */
export async function generateTitle(prompt: string, options: OptionValues): Promise<void> {
  if (!prompt || prompt.trim().length === 0) {
    console.error(JSON.stringify({
      success: false,
      error: 'Prompt is required'
    }));
    process.exit(1);
  }

  const systemPrompt = `You are a title and subtitle generator for claude-mem session metadata.

Your job is to analyze a user's request and generate:
1. A concise title (3-8 words)
2. A one-sentence subtitle (max 20 words)

TITLE GUIDELINES:
- 3-8 words maximum
- Scannable and clear
- Captures the core action or topic
- Professional and informative
- Examples:
  * "Dark Mode Implementation"
  * "Authentication Bug Fix"
  * "API Rate Limiting Setup"
  * "React Component Refactoring"

SUBTITLE GUIDELINES:
- One sentence, max 20 words
- Descriptive and specific
- Focus on the outcome or benefit
- Use active voice when possible
- Examples:
  * "Adding theme toggle and dark color scheme support to the application"
  * "Resolving login timeout issue affecting user session persistence"
  * "Implementing request throttling to prevent API quota exhaustion"

OUTPUT FORMAT:
You must output EXACTLY two lines:
Line 1: Title only (no prefix, no quotes)
Line 2: Subtitle only (no prefix, no quotes)

EXAMPLE:

User request: "Help me add dark mode to my app"

Output:
Dark Mode Implementation
Adding theme toggle and dark color scheme support to the application

USER REQUEST:
${prompt}

Now generate the title and subtitle (two lines exactly):`;

  try {
    const response = await query({
      prompt: systemPrompt,
      options: {
        allowedTools: [],
        pathToClaudeCodeExecutable: getClaudePath()
      }
    });

    // Extract text from response (same pattern as changelog.ts)
    let fullResponse = '';
    if (response && typeof response === 'object' && Symbol.asyncIterator in response) {
      for await (const message of response) {
        if (message?.type === 'assistant' && message?.message?.content) {
          const content = message.message.content;
          if (typeof content === 'string') {
            fullResponse += content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                fullResponse += block.text;
              }
            }
          }
        }
      }
    }

    // Parse the response - expecting exactly 2 lines
    const lines = fullResponse.trim().split('\n').filter(line => line.trim().length > 0);

    if (lines.length < 2) {
      console.error(JSON.stringify({
        success: false,
        error: 'Could not generate title and subtitle',
        response: fullResponse
      }));
      process.exit(1);
    }

    const title = lines[0].trim();
    const subtitle = lines[1].trim();

    // Save to session metadata if --save flag is provided
    if (options.save) {
      if (!options.project || !options.session) {
        console.error(JSON.stringify({
          success: false,
          error: '--project and --session are required when using --save'
        }));
        process.exit(1);
      }

      try {
        const sessionFile = path.join(SESSION_DIR, `${options.project}_streaming.json`);

        if (!fs.existsSync(sessionFile)) {
          console.error(JSON.stringify({
            success: false,
            error: `Session file not found: ${sessionFile}`
          }));
          process.exit(1);
        }

        let sessionData: any = {};
        try {
          sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        } catch (e) {
          console.error(JSON.stringify({
            success: false,
            error: 'Failed to parse session file'
          }));
          process.exit(1);
        }

        // Update metadata
        sessionData.promptTitle = title;
        sessionData.promptSubtitle = subtitle;
        sessionData.updatedAt = new Date().toISOString();

        // Write back to file
        fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
      } catch (error: any) {
        console.error(JSON.stringify({
          success: false,
          error: `Failed to save metadata: ${error.message}`
        }));
        process.exit(1);
      }
    }

    // Output format depends on options
    if (options.json) {
      console.log(JSON.stringify({
        success: true,
        title,
        subtitle
      }, null, 2));
    } else if (options.oneline) {
      console.log(`${title} - ${subtitle}`);
    } else {
      console.log(title);
      console.log(subtitle);
    }

  } catch (error: any) {
    console.error(JSON.stringify({
      success: false,
      error: error.message || 'Unknown error generating title'
    }));
    process.exit(1);
  }
}
