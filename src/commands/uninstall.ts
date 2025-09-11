import { OptionValues } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PathDiscovery } from '../services/path-discovery.js';

export async function uninstall(options: OptionValues = {}): Promise<void> {
  console.log('🔄 Uninstalling Claude Memory System hooks...');
  
  const locations = [];
  if (options.all) {
    locations.push({
      name: 'User',
      path: PathDiscovery.getInstance().getClaudeSettingsPath()
    });
    locations.push({
      name: 'Project',
      path: join(process.cwd(), '.claude', 'settings.json')
    });
  } else {
    const isProject = options.project;
    const pathDiscovery = PathDiscovery.getInstance();
    locations.push({
      name: isProject ? 'Project' : 'User',
      path: isProject ? join(process.cwd(), '.claude', 'settings.json') : pathDiscovery.getClaudeSettingsPath()
    });
  }
  
  const pathDiscovery = PathDiscovery.getInstance();
  const claudeMemHooksDir = pathDiscovery.getHooksDirectory();
  const preCompactScript = join(claudeMemHooksDir, 'pre-compact.js');
  const sessionStartScript = join(claudeMemHooksDir, 'session-start.js');
  const sessionEndScript = join(claudeMemHooksDir, 'session-end.js');
  
  let removedCount = 0;
  
  for (const location of locations) {
    if (!existsSync(location.path)) {
      console.log(`⏭️  No settings found at ${location.name} location`);
      continue;
    }
    
    try {
      const content = readFileSync(location.path, 'utf8');
      const settings = JSON.parse(content);
      
      if (!settings.hooks) {
        console.log(`⏭️  No hooks configured in ${location.name} settings`);
        continue;
      }
      
      let modified = false;
      
      if (settings.hooks.PreCompact) {
        const filteredPreCompact = settings.hooks.PreCompact.filter((matcher: any) => 
          !matcher.hooks?.some((hook: any) => 
            hook.command === preCompactScript ||
            hook.command?.includes('pre-compact.js') ||
            hook.command?.includes('claude-mem')
          )
        );
        
        if (filteredPreCompact.length !== settings.hooks.PreCompact.length) {
          settings.hooks.PreCompact = filteredPreCompact.length ? filteredPreCompact : undefined;
          modified = true;
          console.log(`✅ Removed PreCompact hook from ${location.name} settings`);
        }
      }
      
      if (settings.hooks.SessionStart) {
        const filteredSessionStart = settings.hooks.SessionStart.filter((matcher: any) => 
          !matcher.hooks?.some((hook: any) => 
            hook.command === sessionStartScript ||
            hook.command?.includes('session-start.js') ||
            hook.command?.includes('claude-mem')
          )
        );
        
        if (filteredSessionStart.length !== settings.hooks.SessionStart.length) {
          settings.hooks.SessionStart = filteredSessionStart.length ? filteredSessionStart : undefined;
          modified = true;
          console.log(`✅ Removed SessionStart hook from ${location.name} settings`);
        }
      }
      
      if (settings.hooks.SessionEnd) {
        const filteredSessionEnd = settings.hooks.SessionEnd.filter((matcher: any) => 
          !matcher.hooks?.some((hook: any) => 
            hook.command === sessionEndScript ||
            hook.command?.includes('session-end.js') ||
            hook.command?.includes('claude-mem')
          )
        );
        
        if (filteredSessionEnd.length !== settings.hooks.SessionEnd.length) {
          settings.hooks.SessionEnd = filteredSessionEnd.length ? filteredSessionEnd : undefined;
          modified = true;
          console.log(`✅ Removed SessionEnd hook from ${location.name} settings`);
        }
      }
      
      if (settings.hooks.PreCompact === undefined) delete settings.hooks.PreCompact;
      if (settings.hooks.SessionStart === undefined) delete settings.hooks.SessionStart;
      if (settings.hooks.SessionEnd === undefined) delete settings.hooks.SessionEnd;
      if (!Object.keys(settings.hooks).length) delete settings.hooks;
      
      if (modified) {
        const backupPath = location.path + '.backup.' + Date.now();
        writeFileSync(backupPath, content);
        console.log(`📋 Created backup: ${backupPath}`);
        
        writeFileSync(location.path, JSON.stringify(settings, null, 2));
        removedCount++;
        console.log(`✅ Updated ${location.name} settings: ${location.path}`);
      } else {
        console.log(`ℹ️  No Claude Memory System hooks found in ${location.name} settings`);
      }
      
    } catch (error: any) {
      console.log(`⚠️  Could not process ${location.name} settings: ${error.message}`);
    }
  }
  
  console.log('');
  if (removedCount > 0) {
    console.log('✨ Uninstallation complete!');
    console.log('The Claude Memory System hooks have been removed from your settings.');
    console.log('');
    console.log('Note: Your compressed transcripts and archives are preserved.');
    console.log('To reinstall: claude-mem install');
  } else {
    console.log('ℹ️  No Claude Memory System hooks were found to remove.');
  }
}