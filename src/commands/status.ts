import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as paths from '../shared/paths.js';
import { HooksDatabase } from '../services/sqlite/index.js';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function status(): Promise<void> {
    console.log('🔍 Claude Memory System Status Check');
    console.log('=====================================\n');

    // paths imported

    console.log('⚙️  Settings Configuration:');
    
    const checkSettings = (name: string, path: string) => {
      if (!existsSync(path)) {
        console.log(`  ⏭️  ${name}: No settings file`);
        return;
      }
      
      console.log(`  📋 ${name}: ${path}`);
      
      try {
        const settings = JSON.parse(readFileSync(path, 'utf8'));

        const hasSessionStart = settings.hooks?.SessionStart?.some((matcher: any) =>
          matcher.hooks?.some((hook: any) => hook.command?.includes('claude-mem'))
        );

        const hasStop = settings.hooks?.Stop?.some((matcher: any) =>
          matcher.hooks?.some((hook: any) => hook.command?.includes('claude-mem'))
        );

        const hasUserPrompt = settings.hooks?.UserPromptSubmit?.some((matcher: any) =>
          matcher.hooks?.some((hook: any) => hook.command?.includes('claude-mem'))
        );

        const hasPostTool = settings.hooks?.PostToolUse?.some((matcher: any) =>
          matcher.hooks?.some((hook: any) => hook.command?.includes('claude-mem'))
        );

        console.log(`     SessionStart (claude-mem context): ${hasSessionStart ? '✅' : '❌'}`);
        console.log(`     Stop (claude-mem summary): ${hasStop ? '✅' : '❌'}`);
        console.log(`     UserPromptSubmit (claude-mem new): ${hasUserPrompt ? '✅' : '❌'}`);
        console.log(`     PostToolUse (claude-mem save): ${hasPostTool ? '✅' : '❌'}`);

      } catch (error: any) {
        console.log(`     ⚠️  Could not parse settings`);
      }
    };
    
    checkSettings('Global', paths.ClaudeSettingsPath());
    checkSettings('Project', join(process.cwd(), '.claude', 'settings.json'));
    
    console.log('');
    
    console.log('📦 Compressed Transcripts:');
    const claudeProjectsDir = join(paths.ClaudeConfigDirectory(), 'projects');
    
    if (existsSync(claudeProjectsDir)) {
      try {
        let compressedCount = 0;
        let archiveCount = 0;
        
        const searchDir = (dir: string, depth = 0) => {
          if (depth > 3) return;
          
          const files = readdirSync(dir);
          for (const file of files) {
            const fullPath = join(dir, file);
            const stats = statSync(fullPath);
            
            if (stats.isDirectory() && !file.startsWith('.')) {
              searchDir(fullPath, depth + 1);
            } else if (file.endsWith('.jsonl.compressed')) {
              compressedCount++;
            } else if (file.endsWith('.jsonl.archive')) {
              archiveCount++;
            }
          }
        };
        
        searchDir(claudeProjectsDir);
        
        console.log(`  Compressed files: ${compressedCount}`);
        console.log(`  Archive files: ${archiveCount}`);
        
      } catch (error) {
        console.log(`  ⚠️  Could not scan projects directory`);
      }
    } else {
      console.log(`  ℹ️  No Claude projects directory found`);
    }
    
    console.log('');
    
    console.log('🔧 Runtime Environment:');
    
    const checkCommand = (cmd: string, name: string) => {
      try {
        const version = execSync(`${cmd} --version`, { encoding: 'utf8' }).trim();
        console.log(`  ✅ ${name}: ${version}`);
      } catch {
        console.log(`  ❌ ${name}: Not found`);
      }
    };
    
    checkCommand('node', 'Node.js');
    checkCommand('bun', 'Bun');
    
    console.log('');
    
    console.log('🧠 Chroma Storage Status:');
    console.log('  ✅ Storage backend: Chroma MCP');
    console.log(`  📍 Data location: ${paths.ChromaDirectory()}`);
    console.log('  🔍 Features: Vector search, semantic similarity, document storage');

    console.log('');
    
    console.log('📊 Summary:');
    const globalPath = paths.ClaudeSettingsPath();
    const projectPath = join(process.cwd(), '.claude', 'settings.json');
    
    let isInstalled = false;
    let installLocation = 'Not installed';
    
    try {
      if (existsSync(globalPath)) {
        const settings = JSON.parse(readFileSync(globalPath, 'utf8'));
        if (settings.hooks?.SessionStart || settings.hooks?.Stop || settings.hooks?.PostToolUse) {
          isInstalled = true;
          installLocation = 'Global';
        }
      }

      if (existsSync(projectPath)) {
        const settings = JSON.parse(readFileSync(projectPath, 'utf8'));
        if (settings.hooks?.SessionStart || settings.hooks?.Stop || settings.hooks?.PostToolUse) {
          isInstalled = true;
          installLocation = installLocation === 'Global' ? 'Global + Project' : 'Project';
        }
      }
    } catch {}
    
    if (isInstalled) {
      console.log(`  ✅ Claude Memory System is installed (${installLocation})`);
      console.log('');
      console.log('💡 To test: Use /compact in Claude Code');
    } else {
      console.log(`  ❌ Claude Memory System is not installed`);
      console.log('');
      console.log('💡 To install: claude-mem install');
    }
  }