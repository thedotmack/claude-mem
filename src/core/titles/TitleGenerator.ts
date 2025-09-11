import { query } from '@anthropic-ai/claude-code';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getClaudePath } from '../../shared/settings.js';

export interface TitleGenerationRequest {
  sessionId: string;
  projectName: string;
  firstMessage: string;
}

export interface GeneratedTitle {
  session_id: string;
  generated_title: string;
  timestamp: string;
  project_name: string;
}

export class TitleGenerator {
  private titlesIndexPath: string;

  constructor() {
    this.titlesIndexPath = path.join(os.homedir(), '.claude-mem', 'conversation-titles.jsonl');
    this.ensureTitlesIndex();
  }

  private ensureTitlesIndex(): void {
    const dir = path.dirname(this.titlesIndexPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.titlesIndexPath)) {
      fs.writeFileSync(this.titlesIndexPath, '', 'utf-8');
    }
  }

  async generateTitle(firstMessage: string): Promise<string> {
    const prompt = `Generate a 3-7 word descriptive title for this conversation based on the first message.

The title should:
- Capture the main topic or intent
- Be concise and descriptive
- Use proper capitalization
- Not include "Help with" or "Question about" prefixes

First message: "${firstMessage.substring(0, 500)}"

Respond with just the title, nothing else.`;

    const response = await query({
      prompt,
      options: {
        model: 'claude-3-5-haiku-20241022',
        pathToClaudeCodeExecutable: getClaudePath(),
      },
    });

    let title = '';
    if (response && typeof response === 'object' && Symbol.asyncIterator in response) {
      for await (const message of response) {
        if (message?.content) title += message.content;
        if (message?.text) title += message.text;
      }
    } else if (typeof response === 'string') {
      title = response;
    }

    return title.trim().replace(/^["']|["']$/g, '');
  }

  async batchGenerateTitles(requests: TitleGenerationRequest[]): Promise<GeneratedTitle[]> {
    const results: GeneratedTitle[] = [];
    
    for (const request of requests) {
      try {
        const title = await this.generateTitle(request.firstMessage);
        
        const generatedTitle: GeneratedTitle = {
          session_id: request.sessionId,
          generated_title: title,
          timestamp: new Date().toISOString(),
          project_name: request.projectName
        };
        
        results.push(generatedTitle);
        this.storeTitleInIndex(generatedTitle);
      } catch (error) {
        console.error(`Failed to generate title for ${request.sessionId}:`, error);
      }
    }
    
    return results;
  }

  private storeTitleInIndex(title: GeneratedTitle): void {
    const line = JSON.stringify(title) + '\n';
    fs.appendFileSync(this.titlesIndexPath, line, 'utf-8');
  }

  getExistingTitles(): Map<string, GeneratedTitle> {
    const titles = new Map<string, GeneratedTitle>();
    
    if (!fs.existsSync(this.titlesIndexPath)) {
      return titles;
    }
    
    const content = fs.readFileSync(this.titlesIndexPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    
    for (const line of lines) {
      try {
        const title = JSON.parse(line) as GeneratedTitle;
        titles.set(title.session_id, title);
      } catch (error) {
        // Skip invalid lines
      }
    }
    
    return titles;
  }

  getTitleForSession(sessionId: string): string | null {
    const titles = this.getExistingTitles();
    const title = titles.get(sessionId);
    return title ? title.generated_title : null;
  }
}