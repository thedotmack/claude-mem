import {
  query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  collectDiagnostics,
  formatDiagnostics,
  type SystemDiagnostics,
} from "./collector.ts";

export interface BugReportInput {
  issueDescription: string;
  expectedBehavior?: string;
  stepsToReproduce?: string;
  includeLogs?: boolean;
}

export interface BugReportResult {
  title: string;
  body: string;
  success: boolean;
  error?: string;
}

export async function generateBugReport(
  input: BugReportInput
): Promise<BugReportResult> {
  try {
    // Collect system diagnostics
    const diagnostics = await collectDiagnostics({
      includeLogs: input.includeLogs !== false,
    });

    const formattedDiagnostics = formatDiagnostics(diagnostics);

    // Build the prompt
    const prompt = buildPrompt(
      formattedDiagnostics,
      input.issueDescription,
      input.expectedBehavior,
      input.stepsToReproduce
    );

    // Use Agent SDK to generate formatted issue
    let generatedMarkdown = "";
    let charCount = 0;
    const startTime = Date.now();

    const stream = query({
      prompt,
      options: {
        model: "sonnet",
        systemPrompt: `You are a GitHub issue formatter. Format bug reports clearly and professionally.`,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
      },
    });

    // Progress spinner frames
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let spinnerIdx = 0;

    // Stream the response
    for await (const message of stream) {
      if (message.type === "stream_event") {
        const event = message.event as { type: string; delta?: { type: string; text?: string } };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          generatedMarkdown += event.delta.text;
          charCount += event.delta.text.length;

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const spinner = spinnerFrames[spinnerIdx++ % spinnerFrames.length];
          process.stdout.write(`\r   ${spinner} Generating... ${charCount} chars (${elapsed}s)`);
        }
      }

      // Handle full assistant messages (fallback)
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && !generatedMarkdown) {
            generatedMarkdown = block.text;
            charCount = generatedMarkdown.length;
          }
        }
      }

      // Handle result
      if (message.type === "result") {
        const result = message as SDKResultMessage;
        if (result.subtype === "success" && !generatedMarkdown && result.result) {
          generatedMarkdown = result.result;
          charCount = generatedMarkdown.length;
        }
      }
    }

    // Clear the progress line
    process.stdout.write("\r" + " ".repeat(60) + "\r");

    // Extract title from markdown (first heading)
    const titleMatch = generatedMarkdown.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : "Bug Report";

    return {
      title,
      body: generatedMarkdown,
      success: true,
    };
  } catch (error) {
    // Fallback to template-based generation
    console.error("Agent SDK failed, using template fallback:", error);
    return generateTemplateFallback(input);
  }
}

function buildPrompt(
  diagnostics: string,
  issueDescription: string,
  expectedBehavior?: string,
  stepsToReproduce?: string
): string {
  let prompt = `You are a GitHub issue formatter. Given system diagnostics and a user's bug description, create a well-structured GitHub issue for the claude-mem repository.

SYSTEM DIAGNOSTICS:
${diagnostics}

USER DESCRIPTION:
${issueDescription}
`;

  if (expectedBehavior) {
    prompt += `\nEXPECTED BEHAVIOR:
${expectedBehavior}
`;
  }

  if (stepsToReproduce) {
    prompt += `\nSTEPS TO REPRODUCE:
${stepsToReproduce}
`;
  }

  prompt += `

IMPORTANT: If any part of the user's description is in a language other than English, translate it to English while preserving technical accuracy and meaning.

Create a GitHub issue with:
1. Clear, descriptive title (max 80 chars) in English - start with a single # heading
2. Problem statement summarizing the issue in English
3. Environment section (versions, platform) from the diagnostics
4. Steps to reproduce (if provided) in English
5. Expected vs actual behavior in English
6. Relevant logs (formatted as code blocks) if present in diagnostics
7. Any additional context that would help diagnose the issue

Format the output as valid GitHub Markdown. Make sure the title is a single # heading at the very top.
Do NOT add meta-commentary like "Here's a formatted issue" - just output the raw markdown.
All content must be in English for the GitHub issue.
`;

  return prompt;
}

async function generateTemplateFallback(
  input: BugReportInput
): Promise<BugReportResult> {
  const diagnostics = await collectDiagnostics({
    includeLogs: input.includeLogs !== false,
  });
  const formattedDiagnostics = formatDiagnostics(diagnostics);

  let body = `# Bug Report\n\n`;
  body += `## Description\n\n`;
  body += `${input.issueDescription}\n\n`;

  if (input.expectedBehavior) {
    body += `## Expected Behavior\n\n`;
    body += `${input.expectedBehavior}\n\n`;
  }

  if (input.stepsToReproduce) {
    body += `## Steps to Reproduce\n\n`;
    body += `${input.stepsToReproduce}\n\n`;
  }

  body += formattedDiagnostics;

  return {
    title: "Bug Report",
    body,
    success: true,
  };
}
