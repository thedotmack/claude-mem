import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { PathDiscovery } from '../services/path-discovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function status(): Promise<void> {
    console.log('🔍 Claude Memory System Status Check');
    console.log('=====================================\n');
    
    console.log('📂 Installed Hook Scripts:');
    const pathDiscovery = PathDiscovery.getInstance();
    const claudeMemHooksDir = pathDiscovery.getHooksDirectory();
    const preCompactScript = join(claudeMemHooksDir, 'pre-compact.js');
    const sessionStartScript = join(claudeMemHooksDir, 'session-start.js');
    const sessionEndScript = join(claudeMemHooksDir, 'session-end.js');
    
    const checkScript = (path: string, name: string) => {
      if (existsSync(path)) {
        console.log(`  ✅ ${name}: Found at ${path}`);
      } else {
        console.log(`  ❌ ${name}: Not found at ${path}`);
      }
    };
    
    checkScript(preCompactScript, 'pre-compact.js');
    checkScript(sessionStartScript, 'session-start.js');
    checkScript(sessionEndScript, 'session-end.js');
    
    console.log('');
    
    console.log('⚙️  Settings Configuration:');
    
    const checkSettings = (name: string, path: string) => {
      if (!existsSync(path)) {
        console.log(`  ⏭️  ${name}: No settings file`);
        return;
      }
      
      console.log(`  📋 ${name}: ${path}`);
      
      try {
        const settings = JSON.parse(readFileSync(path, 'utf8'));
        
        const hasPreCompact = settings.hooks?.PreCompact?.some((matcher: any) => 
          matcher.hooks?.some((hook: any) => 
            hook.command?.includes('pre-compact.js') || hook.command?.includes('claude-mem')
          )
        );
        
        const hasSessionStart = settings.hooks?.SessionStart?.some((matcher: any) =>
          matcher.hooks?.some((hook: any) => 
            hook.command?.includes('session-start.js') || hook.command?.includes('claude-mem')
          )
        );
        
        const hasSessionEnd = settings.hooks?.SessionEnd?.some((matcher: any) =>
          matcher.hooks?.some((hook: any) => 
            hook.command?.includes('session-end.js') || hook.command?.includes('claude-mem')
          )
        );
        
        console.log(`     PreCompact: ${hasPreCompact ? '✅' : '❌'}`);
        console.log(`     SessionStart: ${hasSessionStart ? '✅' : '❌'}`);
        console.log(`     SessionEnd: ${hasSessionEnd ? '✅' : '❌'}`);
        
      } catch (error: any) {
        console.log(`     ⚠️  Could not parse settings`);
      }
    };
    
    checkSettings('Global', pathDiscovery.getClaudeSettingsPath());
    checkSettings('Project', join(process.cwd(), '.claude', 'settings.json'));
    
    console.log('');
    
    console.log('📦 Compressed Transcripts:');
    const claudeProjectsDir = join(pathDiscovery.getClaudeConfigDirectory(), 'projects');
    
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
    console.log(`  📍 Data location: ${pathDiscovery.getChromaDirectory()}`);
    console.log('  🔍 Features: Vector search, semantic similarity, document storage');
    
    console.log('');
    
    console.log('📊 Summary:');
    const globalPath = pathDiscovery.getClaudeSettingsPath();
    const projectPath = join(process.cwd(), '.claude', 'settings.json');
    
    let isInstalled = false;
    let installLocation = 'Not installed';
    
    try {
      if (existsSync(globalPath)) {
        const settings = JSON.parse(readFileSync(globalPath, 'utf8'));
        if (settings.hooks?.PreCompact || settings.hooks?.SessionStart || settings.hooks?.SessionEnd) {
          isInstalled = true;
          installLocation = 'Global';
        }
      }
      
      if (existsSync(projectPath)) {
        const settings = JSON.parse(readFileSync(projectPath, 'utf8'));
        if (settings.hooks?.PreCompact || settings.hooks?.SessionStart || settings.hooks?.SessionEnd) {
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