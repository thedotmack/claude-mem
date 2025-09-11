import * as p from '@clack/prompts';
import { TranscriptParser } from './transcript-parser.js';
import path from 'path';
import fs from 'fs';

/**
 * Conversation item for selection UI
 */
export interface ConversationItem {
  filePath: string;
  sessionId: string;
  timestamp: string;
  messageCount: number;
  gitBranch?: string;
  cwd: string;
  fileSize: number;
  displayName: string;
  projectName: string;
  parsedDate: Date;
  relativeDate: string;
  dateGroup: string;
}


/**
 * Selection result
 */
export interface SelectionResult {
  selectedFiles: string[];
  cancelled: boolean;
}

/**
 * Interactive conversation selector service
 */
export class ConversationSelector {
  private parser: TranscriptParser;
  
  constructor() {
    this.parser = new TranscriptParser();
  }
  
  /**
   * Show interactive selection UI for conversations with improved flow
   */
  async selectConversations(): Promise<SelectionResult> {
    p.intro('🧠 Claude History Import');
    
    const s = p.spinner();
    s.start('Scanning for conversation files...');
    
    const conversationFiles = await this.parser.scanConversationFiles();
    
    if (conversationFiles.length === 0) {
      s.stop('❌ No conversation files found');
      p.outro('No conversation files found in Claude projects directory');
      return { selectedFiles: [], cancelled: true };
    }
    
    // Get metadata for each file
    const conversations: ConversationItem[] = [];
    for (const filePath of conversationFiles) {
      try {
        const metadata = await this.parser.getConversationMetadata(filePath);
        const projectName = this.extractProjectName(filePath);
        const parsedDate = this.parseTimestamp(metadata.timestamp, filePath);
        const relativeDate = this.formatRelativeDate(parsedDate);
        const dateGroup = this.getDateGroup(parsedDate);
        
        conversations.push({
          filePath,
          ...metadata,
          projectName,
          parsedDate,
          relativeDate,
          dateGroup,
          displayName: this.createDisplayName(filePath, metadata)
        });
      } catch (e) {
        // Skip invalid files silently
      }
    }
    
    if (conversations.length === 0) {
      s.stop('❌ No valid conversation files found');
      p.outro('No valid conversation files found');
      return { selectedFiles: [], cancelled: true };
    }
    
    s.stop(`Found ${conversations.length} conversation files`);
    
    // Sort by timestamp (newest first)
    conversations.sort((a, b) => b.parsedDate.getTime() - a.parsedDate.getTime());
    
    // If there are too many conversations, offer filtering options first
    let filteredConversations = conversations;
    if (conversations.length > 100) {
      const filterChoice = await p.select({
        message: `Found ${conversations.length} conversations. How would you like to proceed?`,
        options: [
          { value: 'recent', label: 'Show recent (last 50)', hint: 'Most recent conversations' },
          { value: 'project', label: 'Filter by project', hint: 'Select specific project first' },
          { value: 'all', label: 'Show all', hint: `Display all ${conversations.length} conversations` }
        ]
      });
      
      if (p.isCancel(filterChoice)) {
        p.cancel('Selection cancelled');
        return { selectedFiles: [], cancelled: true };
      }
      
      if (filterChoice === 'recent') {
        filteredConversations = conversations.slice(0, 50);
      } else if (filterChoice === 'project') {
        const projectNames = [...new Set(conversations.map(c => c.projectName))].sort();
        const selectedProject = await p.select({
          message: 'Select project:',
          options: projectNames.map(project => {
            const count = conversations.filter(c => c.projectName === project).length;
            return {
              value: project,
              label: project,
              hint: `${count} conversation${count === 1 ? '' : 's'}`
            };
          })
        });
        
        if (p.isCancel(selectedProject)) {
          p.cancel('Selection cancelled');
          return { selectedFiles: [], cancelled: true };
        }
        
        filteredConversations = conversations.filter(c => c.projectName === selectedProject);
      }
    }
    
    // Conversation selection
    const selectedConversations = await this.selectConversationsFromList(filteredConversations);
    if (!selectedConversations || selectedConversations.length === 0) {
      p.cancel('No conversations selected');
      return { selectedFiles: [], cancelled: true };
    }
    
    // Confirmation
    const confirmed = await this.confirmSelection(selectedConversations);
    if (!confirmed) {
      p.cancel('Import cancelled');
      return { selectedFiles: [], cancelled: true };
    }
    
    p.outro(`Ready to import ${selectedConversations.length} conversations`);
    return { selectedFiles: selectedConversations.map(c => c.filePath), cancelled: false };
  }
  
  /**
   * Extract project name from file path
   */
  private extractProjectName(filePath: string): string {
    return path.basename(path.dirname(filePath));
  }
  
  /**
   * Safely parse timestamp with fallback to file modification time
   */
  private parseTimestamp(timestamp: string | undefined, filePath: string): Date {
    // Try parsing the provided timestamp
    if (timestamp) {
      const date = new Date(timestamp);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
    
    // Fallback to file modification time
    try {
      const stats = fs.statSync(filePath);
      return stats.mtime;
    } catch (e) {
      // Last resort: current time
      return new Date();
    }
  }
  
  /**
   * Format date as relative time (e.g., "2 days ago", "3 weeks ago")
   */
  private formatRelativeDate(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);
    
    if (diffMinutes < 1) return 'just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffWeeks < 4) return `${diffWeeks}w ago`;
    if (diffMonths < 12) return `${diffMonths}mo ago`;
    
    const diffYears = Math.floor(diffMonths / 12);
    return `${diffYears}y ago`;
  }
  
  /**
   * Get date group for grouping conversations
   */
  private getDateGroup(date: Date): string {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const thisWeekStart = new Date(today.getTime() - today.getDay() * 24 * 60 * 60 * 1000);
    const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const conversationDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    
    if (conversationDate.getTime() >= today.getTime()) {
      return 'Today';
    } else if (conversationDate.getTime() >= yesterday.getTime()) {
      return 'Yesterday';
    } else if (conversationDate.getTime() >= thisWeekStart.getTime()) {
      return 'This Week';
    } else if (conversationDate.getTime() >= lastWeekStart.getTime()) {
      return 'Last Week';
    } else if (conversationDate.getTime() >= thisMonthStart.getTime()) {
      return 'This Month';
    } else {
      return 'Older';
    }
  }
  
  /**
   * Create display name for conversation
   */
  private createDisplayName(filePath: string, metadata: any): string {
    const parsedDate = this.parseTimestamp(metadata.timestamp, filePath);
    const relativeDate = this.formatRelativeDate(parsedDate);
    const sizeKB = Math.round(metadata.fileSize / 1024);
    const branchInfo = metadata.gitBranch ? `${metadata.gitBranch}` : '';
    
    return `${relativeDate} • ${metadata.messageCount} msgs • ${sizeKB}KB${branchInfo ? ` • ${branchInfo}` : ''}`;
  }
  
  
  /**
   * Select specific conversations from list
   */
  private async selectConversationsFromList(
    conversations: ConversationItem[]
  ): Promise<ConversationItem[] | null> {
    // Group conversations by date for better organization
    const groupedConversations = this.groupConversationsByDate(conversations);
    const options = this.createGroupedOptions(groupedConversations, conversations);
    
    // Multi-select with select all/none shortcuts
    const selectedIndices = await p.multiselect({
      message: `Select conversations to import (${conversations.length} available, Space=toggle, Enter=confirm):`,
      options,
      required: false
    });
    
    if (p.isCancel(selectedIndices)) return null;
    
    // Return selected conversations
    const selected = selectedIndices as number[];
    if (selected.length === 0) {
      return [];
    }
    
    return selected.map(i => conversations[i]);
  }
  
  /**
   * Confirm selection before processing
   */
  private async confirmSelection(conversations: ConversationItem[]): Promise<boolean> {
    const totalSize = conversations.reduce((sum, c) => sum + c.fileSize, 0);
    const sizeKB = Math.round(totalSize / 1024);
    const projects = [...new Set(conversations.map(c => c.projectName))];
    
    const details = [
      `${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`,
      `${projects.length} project${projects.length === 1 ? '' : 's'}: ${projects.join(', ')}`,
      `Total size: ${sizeKB}KB`
    ].join('\n');
    
    const confirmed = await p.confirm({
      message: `Ready to import:\n\n${details}\n\nContinue?`,
      initialValue: true
    });
    
    return !p.isCancel(confirmed) && confirmed;
  }
  
  /**
   * Group conversations by date sections
   */
  private groupConversationsByDate(conversations: ConversationItem[]): Map<string, ConversationItem[]> {
    const groups = new Map<string, ConversationItem[]>();
    
    for (const conv of conversations) {
      const group = conv.dateGroup;
      if (!groups.has(group)) {
        groups.set(group, []);
      }
      groups.get(group)!.push(conv);
    }
    
    return groups;
  }
  
  /**
   * Create options with date group headers
   */
  private createGroupedOptions(groupedConversations: Map<string, ConversationItem[]>, allConversations: ConversationItem[]) {
    const options: any[] = [];
    
    // Add hint at top about selecting all/none
    options.push({ 
      value: 'hint', 
      label: '💡 Use Space to toggle, A to select all, I to invert', 
      disabled: true 
    });
    options.push({ value: 'separator-hint', label: '─'.repeat(60), disabled: true });
    
    // Define order of groups
    const groupOrder = ['Today', 'Yesterday', 'This Week', 'Last Week', 'This Month', 'Older'];
    
    for (const groupName of groupOrder) {
      const conversations = groupedConversations.get(groupName);
      if (!conversations || conversations.length === 0) continue;
      
      // Add group header (disabled option for visual separation)
      if (options.length > 2) { // Account for hint and separator
        options.push({ value: `separator-${groupName}`, label: '─'.repeat(50), disabled: true });
      }
      options.push({ 
        value: `header-${groupName}`, 
        label: `${groupName} (${conversations.length})`, 
        disabled: true 
      });
      
      // Add conversations in this group
      for (const conv of conversations) {
        const index = allConversations.indexOf(conv);
        const projectInfo = conv.projectName ? `[${conv.projectName}]` : '';
        const workingDir = conv.cwd && conv.cwd !== 'undefined' ? path.basename(conv.cwd) : '';
        const hint = `${projectInfo} ${workingDir}`.trim() || (conv.gitBranch ? `Branch: ${conv.gitBranch}` : '');
        
        options.push({
          value: index,
          label: `  ${conv.displayName}`,
          hint: hint
        });
      }
    }
    
    return options;
  }
  
}