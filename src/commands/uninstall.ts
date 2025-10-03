import { OptionValues } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { PathDiscovery } from '../services/path-discovery.js';

async function removeSmartTrashAlias(): Promise<boolean> {
  const homeDir = homedir();
  const shellConfigs = [
    join(homeDir, '.bashrc'),
    join(homeDir, '.zshrc'),
    join(homeDir, '.bash_profile')
  ];

  const aliasLine = 'alias rm="claude-mem trash"';
  // Handle both variations of the comment line
  const commentPatterns = [
    '# claude-mem smart trash alias',
    '# claude-mem trash bin alias'
  ];
  let removedFromAny = false;

  for (const configPath of shellConfigs) {
    if (!existsSync(configPath)) continue;

    let content = readFileSync(configPath, 'utf8');

    // Check if alias exists
    if (!content.includes(aliasLine)) {
      continue; // Not configured in this file
    }

    // Remove the alias and its comment
    const lines = content.split('\n');
    const filteredLines = lines.filter((line, index) => {
      // Skip the alias line
      if (line.trim() === aliasLine) return false;
      // Skip any claude-mem comment line if it's right before the alias
      for (const commentPattern of commentPatterns) {
        if (line.trim() === commentPattern &&
            index + 1 < lines.length &&
            lines[index + 1].trim() === aliasLine) {
          return false;
        }
      }
      return true;
    });

    const newContent = filteredLines.join('\n');

    // Only write if content actually changed
    if (newContent !== content) {
      // Create backup
      const backupPath = configPath + '.backup.' + Date.now();
      writeFileSync(backupPath, content);

      // Write updated content
      writeFileSync(configPath, newContent);
      console.log(`✅ Removed Smart Trash alias from ${configPath.replace(homeDir, '~')}`);
      removedFromAny = true;
    }
  }

  return removedFromAny;
}

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
  const runtimeHooksDir = pathDiscovery.getHooksDirectory();
  const preCompactScript = join(runtimeHooksDir, 'pre-compact.js');
  const sessionStartScript = join(runtimeHooksDir, 'session-start.js');
  const sessionEndScript = join(runtimeHooksDir, 'session-end.js');
  
  let removedCount = 0;
  
  for (const location of locations) {
    if (!existsSync(location.path)) {
      console.log(`⏭️  No settings found at ${location.name} location`);
      continue;
    }
    
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
  }
  
  // Remove Smart Trash alias from shell configs
  const removedAlias = await removeSmartTrashAlias();

  console.log('');
  if (removedCount > 0 || removedAlias) {
    console.log('✨ Uninstallation complete!');
    if (removedCount > 0) {
      console.log('The Claude Memory System hooks have been removed from your settings.');
    }
    if (removedAlias) {
      console.log('The Smart Trash alias has been removed from your shell configuration.');
      console.log('⚠️  Restart your terminal for the alias removal to take effect.');
    }
    console.log('');
    console.log('Note: Your compressed transcripts and archives are preserved.');
    console.log('To reinstall: claude-mem install');
  } else {
    console.log('ℹ️  No Claude Memory System hooks or aliases were found to remove.');
  }
}