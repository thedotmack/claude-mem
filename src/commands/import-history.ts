#!/usr/bin/env node
import * as p from '@clack/prompts';
import path from 'path';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';
import { TranscriptCompressor } from '../core/compression/TranscriptCompressor.js';
import { TitleGenerator, TitleGenerationRequest } from '../core/titles/TitleGenerator.js';

interface ConversationMetadata {
  sessionId: string;
  timestamp: string;
  messageCount: number;
  branch?: string;
  cwd: string;
  fileSize: number;
}

interface ConversationItem extends ConversationMetadata {
  filePath: string;
  projectName: string;
  parsedDate: Date;
  relativeDate: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatRelativeDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function parseTimestamp(timestamp: string, fallbackPath: string): Date {
  try {
    const parsed = new Date(timestamp);
    if (!isNaN(parsed.getTime())) return parsed;
  } catch {}
  
  // Fallback: try to extract from filename
  const match = fallbackPath.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (match) {
    const [_, year, month, day, hour, minute, second] = match;
    return new Date(
      parseInt(year), 
      parseInt(month) - 1, 
      parseInt(day),
      parseInt(hour), 
      parseInt(minute), 
      parseInt(second)
    );
  }
  
  // Last resort: file stats
  const stats = fs.statSync(fallbackPath);
  return stats.mtime;
}

function extractFirstUserMessage(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (message.type === 'user' && message.message?.content) {
          const messageContent = message.message.content;
          if (Array.isArray(messageContent)) {
            const textContent = messageContent
              .filter(item => item.type === 'text')
              .map(item => item.text)
              .join(' ');
            if (textContent.trim()) return textContent.trim();
          } else if (typeof messageContent === 'string') {
            return messageContent.trim();
          }
        }
      } catch {}
    }
    
    return 'Conversation'; // Fallback
  } catch {
    return 'Conversation'; // Fallback
  }
}

async function loadImportedSessions(): Promise<Set<string>> {
  const importedIds = new Set<string>();
  const indexPath = path.join(os.homedir(), '.claude-mem', 'claude-mem-index.jsonl');
  
  if (!fs.existsSync(indexPath)) return importedIds;
  
  const content = fs.readFileSync(indexPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      // Check both session_id (from index) and sessionId (legacy)
      if (entry.session_id) {
        importedIds.add(entry.session_id);
      } else if (entry.sessionId) {
        importedIds.add(entry.sessionId);
      }
    } catch {}
  }
  
  return importedIds;
}

async function scanConversations(): Promise<{ conversations: ConversationItem[]; skippedCount: number }> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  
  if (!fs.existsSync(claudeDir)) {
    return { conversations: [], skippedCount: 0 };
  }
  
  const projects = fs.readdirSync(claudeDir)
    .filter(dir => fs.statSync(path.join(claudeDir, dir)).isDirectory());
  
  const conversations: ConversationItem[] = [];
  const importedSessionIds = await loadImportedSessions();
  let skippedCount = 0;
  
  for (const project of projects) {
    const projectDir = path.join(claudeDir, project);
    const files = fs.readdirSync(projectDir)
      .filter(file => file.endsWith('.jsonl'))
      .map(file => path.join(projectDir, file));
    
    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        
        // Parse first line for metadata
        const firstLine = JSON.parse(lines[0]);
        const messageCount = lines.length;
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;
        
        const metadata: ConversationMetadata = {
          sessionId: firstLine.sessionId || path.basename(filePath, '.jsonl'),
          timestamp: firstLine.timestamp || stats.mtime.toISOString(),
          messageCount,
          branch: firstLine.branch,
          cwd: firstLine.cwd || projectDir,
          fileSize
        };
        
        // Skip if already imported
        if (importedSessionIds.has(metadata.sessionId)) {
          skippedCount++;
          continue;
        }
        
        const projectName = path.basename(path.dirname(filePath));
        const parsedDate = parseTimestamp(metadata.timestamp, filePath);
        const relativeDate = formatRelativeDate(parsedDate);
        
        conversations.push({
          filePath,
          ...metadata,
          projectName,
          parsedDate,
          relativeDate
        });
      } catch {}
    }
  }
  
  return { conversations, skippedCount };
}

export async function importHistory(options: { verbose?: boolean; multi?: boolean } = {}) {
  console.clear();
  
  p.intro(chalk.bgCyan.black(' CLAUDE-MEM IMPORT '));
  
  const s = p.spinner();
  s.start('Scanning conversation history');
  
  const { conversations, skippedCount } = await scanConversations();
  
  if (conversations.length === 0) {
    s.stop('No new conversations found');
    const message = skippedCount > 0 
      ? `All ${skippedCount} conversation${skippedCount === 1 ? ' is' : 's are'} already imported.`
      : 'No conversations found.';
    p.outro(chalk.yellow(message));
    return;
  }
  
  // Sort by date (newest first)
  conversations.sort((a, b) => b.parsedDate.getTime() - a.parsedDate.getTime());
  
  const statusMessage = skippedCount > 0
    ? `Found ${conversations.length} new conversation${conversations.length === 1 ? '' : 's'} (${skippedCount} already imported)`
    : `Found ${conversations.length} new conversation${conversations.length === 1 ? '' : 's'}`;
  s.stop(statusMessage);
  
  // Group conversations by project for better organization
  const projectGroups = conversations.reduce((acc, conv) => {
    if (!acc[conv.projectName]) acc[conv.projectName] = [];
    acc[conv.projectName].push(conv);
    return acc;
  }, {} as Record<string, ConversationItem[]>);
  
  // Create selection options
  const importMode = await p.select({
    message: 'How would you like to import?',
    options: [
      { value: 'browse', label: 'Browse by Project', hint: 'Select project then conversations' },
      { value: 'project', label: 'Import Entire Project', hint: 'Select project and import all conversations' },
      { value: 'recent', label: 'Recent Conversations', hint: 'Import most recent across all projects' },
      { value: 'search', label: 'Search', hint: 'Search for specific conversations' }
    ]
  });
  
  if (p.isCancel(importMode)) {
    p.cancel('Import cancelled');
    return;
  }
  
  let selectedConversations: ConversationItem[] = [];
  
  if (importMode === 'browse') {
    // Project selection
    const projectOptions = Object.entries(projectGroups)
      .sort((a, b) => b[1][0].parsedDate.getTime() - a[1][0].parsedDate.getTime())
      .map(([project, convs]) => ({
        value: project,
        label: project,
        hint: `${convs.length} conversation${convs.length === 1 ? '' : 's'}, latest: ${convs[0].relativeDate}`
      }));
    
    const selectedProject = await p.select({
      message: 'Select a project',
      options: projectOptions
    });
    
    if (p.isCancel(selectedProject)) {
      p.cancel('Import cancelled');
      return;
    }
    
    const projectConvs = projectGroups[selectedProject as string];
    
    // Ask about title generation
    const generateTitles = await p.confirm({
      message: 'Would you like to generate titles for easier browsing?',
      initialValue: false
    });
    
    if (p.isCancel(generateTitles)) {
      p.cancel('Import cancelled');
      return;
    }
    
    if (generateTitles) {
      await processTitleGeneration(projectConvs, selectedProject as string);
    }
    
    // Conversation selection within project
    const titleGenerator = new TitleGenerator();
    const convOptions = projectConvs.map(conv => {
      const title = titleGenerator.getTitleForSession(conv.sessionId);
      const displayTitle = title ? `"${title}" • ` : '';
      return {
        value: conv.sessionId,
        label: `${displayTitle}${conv.relativeDate} • ${conv.messageCount} messages • ${formatFileSize(conv.fileSize)}`,
        hint: conv.branch ? `branch: ${conv.branch}` : undefined
      };
    });
    
    if (options.multi) {
      const selected = await p.multiselect({
        message: `Select conversations from ${selectedProject} (Space to select, Enter to confirm)`,
        options: convOptions,
        required: false
      });
      
      if (p.isCancel(selected)) {
        p.cancel('Import cancelled');
        return;
      }
      
      const selectedIds = selected as string[];
      selectedConversations = projectConvs.filter(c => selectedIds.includes(c.sessionId));
    } else {
      // Single select with continuous import
      let continueImporting = true;
      const importedInSession = new Set<string>();
      
      while (continueImporting && projectConvs.length > importedInSession.size) {
        const availableConvs = projectConvs.filter(c => !importedInSession.has(c.sessionId));
        
        if (availableConvs.length === 0) break;
        
        const titleGenerator = new TitleGenerator();
        const convOptions = availableConvs.map(conv => {
          const title = titleGenerator.getTitleForSession(conv.sessionId);
          const displayTitle = title ? `"${title}" • ` : '';
          return {
            value: conv.sessionId,
            label: `${displayTitle}${conv.relativeDate} • ${conv.messageCount} messages • ${formatFileSize(conv.fileSize)}`,
            hint: conv.branch ? `branch: ${conv.branch}` : undefined
          };
        });
        
        const selected = await p.select({
          message: `Select a conversation (${importedInSession.size}/${projectConvs.length} imported)`,
          options: [
            ...convOptions,
            { value: 'done', label: '✅ Done importing', hint: 'Exit import mode' }
          ]
        });
        
        if (p.isCancel(selected) || selected === 'done') {
          continueImporting = false;
          break;
        }
        
        const conv = availableConvs.find(c => c.sessionId === selected);
        if (conv) {
          selectedConversations = [conv];
          await processImport(selectedConversations, options.verbose);
          importedInSession.add(conv.sessionId);
        }
      }
      
      if (importedInSession.size > 0) {
        p.outro(chalk.green(`✅ Imported ${importedInSession.size} conversation${importedInSession.size === 1 ? '' : 's'}`));
      } else {
        p.outro(chalk.yellow('No conversations imported'));
      }
      return;
    }
    
  } else if (importMode === 'project') {
    // Project selection for importing entire project
    const projectOptions = Object.entries(projectGroups)
      .sort((a, b) => b[1][0].parsedDate.getTime() - a[1][0].parsedDate.getTime())
      .map(([project, convs]) => ({
        value: project,
        label: project,
        hint: `${convs.length} conversation${convs.length === 1 ? '' : 's'}, latest: ${convs[0].relativeDate}`
      }));
    
    const selectedProject = await p.select({
      message: 'Select a project to import all conversations',
      options: projectOptions
    });
    
    if (p.isCancel(selectedProject)) {
      p.cancel('Import cancelled');
      return;
    }
    
    const projectConvs = projectGroups[selectedProject as string];
    
    // Ask about title generation
    const generateTitles = await p.confirm({
      message: 'Would you like to generate titles for easier browsing?',
      initialValue: false
    });
    
    if (p.isCancel(generateTitles)) {
      p.cancel('Import cancelled');
      return;
    }
    
    if (generateTitles) {
      await processTitleGeneration(projectConvs, selectedProject as string);
    }
    
    const confirm = await p.confirm({
      message: `Import all ${projectConvs.length} conversation${projectConvs.length === 1 ? '' : 's'} from ${selectedProject}?`
    });
    
    if (p.isCancel(confirm) || !confirm) {
      p.cancel('Import cancelled');
      return;
    }
    
    selectedConversations = projectConvs;
    
  } else if (importMode === 'recent') {
    const limit = await p.text({
      message: 'How many recent conversations?',
      placeholder: '10',
      initialValue: '10',
      validate: (value) => {
        const num = parseInt(value);
        if (isNaN(num) || num < 1) return 'Please enter a valid number';
        if (num > conversations.length) return `Only ${conversations.length} available`;
      }
    });
    
    if (p.isCancel(limit)) {
      p.cancel('Import cancelled');
      return;
    }
    
    const count = parseInt(limit as string);
    selectedConversations = conversations.slice(0, count);
    
  } else if (importMode === 'search') {
    const searchTerm = await p.text({
      message: 'Search conversations (project name or session ID)',
      placeholder: 'Enter search term'
    });
    
    if (p.isCancel(searchTerm)) {
      p.cancel('Import cancelled');
      return;
    }
    
    const term = (searchTerm as string).toLowerCase();
    const matches = conversations.filter(c => 
      c.projectName.toLowerCase().includes(term) ||
      c.sessionId.toLowerCase().includes(term) ||
      (c.branch && c.branch.toLowerCase().includes(term))
    );
    
    if (matches.length === 0) {
      p.outro(chalk.yellow('No matching conversations found'));
      return;
    }
    
    const titleGenerator = new TitleGenerator();
    const matchOptions = matches.map(conv => {
      const title = titleGenerator.getTitleForSession(conv.sessionId);
      const displayTitle = title ? `"${title}" • ` : '';
      return {
        value: conv.sessionId,
        label: `${displayTitle}${conv.projectName} • ${conv.relativeDate} • ${conv.messageCount} msgs`,
        hint: formatFileSize(conv.fileSize)
      };
    });
    
    const selected = await p.multiselect({
      message: `Found ${matches.length} matches. Select to import:`,
      options: matchOptions,
      required: false
    });
    
    if (p.isCancel(selected)) {
      p.cancel('Import cancelled');
      return;
    }
    
    const selectedIds = selected as string[];
    selectedConversations = matches.filter(c => selectedIds.includes(c.sessionId));
  }
  
  // Process the import
  if (selectedConversations.length > 0) {
    await processImport(selectedConversations, options.verbose);
    p.outro(chalk.green(`✅ Successfully imported ${selectedConversations.length} conversation${selectedConversations.length === 1 ? '' : 's'}`));
  } else {
    p.outro(chalk.yellow('No conversations selected for import'));
  }
}

async function processTitleGeneration(conversations: ConversationItem[], projectName: string) {
  const titleGenerator = new TitleGenerator();
  const existingTitles = titleGenerator.getExistingTitles();
  
  // Filter conversations that don't have titles yet
  const conversationsNeedingTitles = conversations.filter(conv => !existingTitles.has(conv.sessionId));
  
  if (conversationsNeedingTitles.length === 0) {
    p.note('All conversations already have titles!', 'Title Generation');
    return;
  }
  
  const s = p.spinner();
  s.start(`Generating titles for ${conversationsNeedingTitles.length} conversations...`);
  
  const requests: TitleGenerationRequest[] = conversationsNeedingTitles.map(conv => ({
    sessionId: conv.sessionId,
    projectName: projectName,
    firstMessage: extractFirstUserMessage(conv.filePath)
  }));
  
  try {
    await titleGenerator.batchGenerateTitles(requests);
    s.stop(`✅ Generated ${conversationsNeedingTitles.length} titles`);
  } catch (error) {
    s.stop(`❌ Failed to generate titles`);
    console.error(chalk.red(`Error: ${error}`));
  }
}

async function processImport(conversations: ConversationItem[], verbose?: boolean) {
  const s = p.spinner();
  
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const progress = conversations.length > 1 ? `[${i + 1}/${conversations.length}] ` : '';
    
    s.start(`${progress}Importing ${conv.projectName} (${conv.relativeDate})`);
    
    try {
      // Extract project name from the conversation's cwd field
      const projectName = path.basename(conv.cwd);
      
      // Use TranscriptCompressor to process
      const compressor = new TranscriptCompressor();
      await compressor.compress(conv.filePath, conv.sessionId, projectName);
      
      s.stop(`${progress}Imported ${conv.projectName} (${conv.messageCount} messages)`);
      
      if (verbose) {
        p.note(`Session: ${conv.sessionId}\nSize: ${formatFileSize(conv.fileSize)}\nBranch: ${conv.branch || 'main'}`, 'Details');
      }
      
    } catch (error) {
      s.stop(`${progress}Failed to import ${conv.projectName}`);
      if (verbose) {
        console.error(chalk.red(`Error: ${error}`));
      }
    }
  }
}