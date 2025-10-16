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

    // Remove claude-mem hooks (CLI commands)
    const hookTypes = ['SessionStart', 'Stop', 'UserPromptSubmit', 'PostToolUse'];

    for (const hookType of hookTypes) {
      if (settings.hooks[hookType]) {
        const filteredHooks = settings.hooks[hookType].filter((matcher: any) =>
          !matcher.hooks?.some((hook: any) => hook.command?.includes('claude-mem'))
        );

        if (filteredHooks.length !== settings.hooks[hookType].length) {
          settings.hooks[hookType] = filteredHooks.length ? filteredHooks : undefined;
          modified = true;
          console.log(`✅ Removed ${hookType} hook from ${location.name} settings`);
        }
      }
    }

    // Clean up undefined hooks
    hookTypes.forEach(hookType => {
      if (settings.hooks[hookType] === undefined) delete settings.hooks[hookType];
    });
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