import { OptionValues } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as p from '@clack/prompts';
import gradient from 'gradient-string';
import chalk from 'chalk';
import boxen from 'boxen';
import { PACKAGE_NAME } from '../shared/config.js';
import type { Settings } from '../shared/types.js';
import { PathDiscovery } from '../services/path-discovery.js';
import { Platform } from '../utils/platform.js';


// Enhanced animation utilities
function createLoadingAnimation(message: string) {
  let interval: NodeJS.Timeout;
  let frame = 0;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  
  return {
    start() {
      interval = setInterval(() => {
        process.stdout.write(`\r${chalk.cyan(frames[frame % frames.length])} ${message}`);
        frame++;
      }, 50); // Faster spinner animation (was 80ms)
    },
    stop(result: string, success: boolean = true) {
      clearInterval(interval);
      const icon = success ? chalk.green('✓') : chalk.red('✗');
      process.stdout.write(`\r${icon} ${result}\n`);
    }
  };
}

// Create animated rainbow text with adjustable speed
function animatedRainbow(text: string, speed: number = 100): Promise<void> {
  return new Promise((resolve) => {
    let offset = 0;
    const maxFrames = 10;
    
    const interval = setInterval(() => {
      // Create a shifted gradient by rotating through different presets
      const gradients = [fastRainbow, vibrantRainbow, gradient.rainbow, gradient.pastel];
      const shifted = gradients[offset % gradients.length](text);
      process.stdout.write('\r' + shifted);
      offset++;
      
      if (offset >= maxFrames) {
        clearInterval(interval);
        resolve();
      }
    }, speed);
  });
}

// Sleep utility for smooth animations
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Fast rainbow gradient preset with tighter color transitions
const fastRainbow = gradient(['#ff0000', '#ff4500', '#ffa500', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#8b00ff']);
const vibrantRainbow = gradient(['#ff006e', '#fb5607', '#ffbe0b', '#8338ec', '#3a86ff']);

// Installation scope type
type InstallScope = 'user' | 'project' | 'local';

// Installation configuration from wizard
interface InstallConfig {
  scope: InstallScope;
  customPath?: string;
  hookTimeout: number;
  forceReinstall: boolean;
  enableSmartTrash?: boolean;
  saveMemoriesOnClear?: boolean;
}


function installUv(): void {
  Platform.installUv();
  process.env.PATH = `${homedir()}/.cargo/bin:${process.env.PATH}`;
}

function detectClaudePath(): string {
  return Platform.findExecutable('claude');
}

function hasExistingInstallation(): boolean {
  const pathDiscovery = PathDiscovery.getInstance();
  return existsSync(pathDiscovery.getHooksDirectory());
}

async function runInstallationWizard(existingInstall: boolean): Promise<InstallConfig | null> {
  const config: Partial<InstallConfig> = {};

  if (existingInstall) {
    const shouldReinstall = await p.confirm({
      message: '🧠 Existing claude-mem installation detected. Your memories and data are safe!\n\nReinstall to update hooks and configuration?',
      initialValue: true
    });

    if (p.isCancel(shouldReinstall) || !shouldReinstall) {
      p.cancel('Installation cancelled');
      return null;
    }

    config.forceReinstall = true;
  } else {
    config.forceReinstall = false;
  }
  
  // Select installation scope
  const scope = await p.select({
    message: 'Select installation scope',
    options: [
      { 
        value: 'user', 
        label: 'User (Recommended)', 
        hint: 'Install for current user (~/.claude)' 
      },
      { 
        value: 'project', 
        label: 'Project', 
        hint: 'Install for current project only (./.mcp.json)' 
      },
      { 
        value: 'local', 
        label: 'Local', 
        hint: 'Custom local installation' 
      }
    ],
    initialValue: 'user'
  });
  
  if (p.isCancel(scope)) {
    p.cancel('Installation cancelled');
    return null;
  }
  
  config.scope = scope as InstallScope;
  
  // If local scope, ask for custom path
  if (scope === 'local') {
    const customPath = await p.text({
      message: 'Enter custom installation directory',
      placeholder: join(process.cwd(), '.claude-mem'),
      validate: (value) => {
        if (!value) return 'Path is required';
        if (!value.startsWith('/') && !value.startsWith('~')) {
          return 'Please provide an absolute path';
        }
      }
    });
    
    if (p.isCancel(customPath)) {
      p.cancel('Installation cancelled');
      return null;
    }
    
    config.customPath = customPath as string;
  }
  
  // Use default hook timeout (3 minutes)
  config.hookTimeout = 180000;
  
  // Always install/reinstall Chroma MCP - it's required for claude-mem to work
  
  // Ask about smart trash alias
  const enableSmartTrash = await p.confirm({
    message: 'Enable Smart Trash? This creates an alias for "rm" that moves files to ~/.claude-mem/trash instead of permanently deleting them. You can restore files anytime by typing "claude-mem restore".',
    initialValue: true
  });
  
  if (p.isCancel(enableSmartTrash)) {
    p.cancel('Installation cancelled');
    return null;
  }
  
  config.enableSmartTrash = enableSmartTrash;
  
  // Ask about save-on-clear
  const saveMemoriesOnClear = await p.confirm({
    message: 'Would you like to save memories when you type "/clear" in Claude Code? When running /clear with this on, it takes about a minute to save memories before your new session starts.',
    initialValue: false
  });
  
  if (p.isCancel(saveMemoriesOnClear)) {
    p.cancel('Installation cancelled');
    return null;
  }
  
  config.saveMemoriesOnClear = saveMemoriesOnClear;
  
  return config as InstallConfig;
}
// </Block>


// <Block> Directory structure creation - natural setup flow
function ensureDirectoryStructure(): void {
  const pathDiscovery = PathDiscovery.getInstance();
  
  // Create all data directories
  pathDiscovery.ensureAllDataDirectories();
  
  // Create all Claude integration directories
  pathDiscovery.ensureAllClaudeDirectories();
  
  // Create package.json in .claude-mem to fix ESM module issues
  const packageJsonPath = join(pathDiscovery.getDataDirectory(), 'package.json');
  if (!existsSync(packageJsonPath)) {
    const packageJson = {
      name: "claude-mem-data",
      type: "module"
    };
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
  }
}
// </Block>

function copyFileRecursively(src: string, dest: string): void {
  const stat = statSync(src);
  if (stat.isDirectory()) {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }
    const files = readdirSync(src);
    files.forEach((file: string) => {
      copyFileRecursively(join(src, file), join(dest, file));
    });
  } else {
    copyFileSync(src, dest);
  }
}

function writeHookFiles(timeout: number = 180000): void {
  const pathDiscovery = PathDiscovery.getInstance();
  const runtimeHooksDir = pathDiscovery.getHooksDirectory();
  const packageHookTemplatesDir = pathDiscovery.findPackageHookTemplatesDirectory();

  const hookFiles = ['session-start.js', 'stop.js', 'user-prompt-submit.js', 'post-tool-use.js'];

  for (const hookFile of hookFiles) {
    const sourceTemplatePath = join(packageHookTemplatesDir, hookFile);
    const runtimeHookPath = join(runtimeHooksDir, hookFile);
    copyFileSync(sourceTemplatePath, runtimeHookPath);
    Platform.makeExecutable(runtimeHookPath);
  }

  const sourceSharedTemplateDir = join(packageHookTemplatesDir, 'shared');
  const runtimeSharedDir = join(runtimeHooksDir, 'shared');
  if (existsSync(sourceSharedTemplateDir)) {
    copyFileRecursively(sourceSharedTemplateDir, runtimeSharedDir);
  }

  const hookConfig = {
    packageName: PACKAGE_NAME,
    cliCommand: PACKAGE_NAME,
    backend: 'chroma',
    timeout
  };
  writeFileSync(join(runtimeHooksDir, 'config.json'), JSON.stringify(hookConfig, null, 2));

  // Create package.json and install dependencies in hooks directory
  const hookPackageJson = {
    name: "claude-mem-hooks",
    type: "module",
    dependencies: {
      "@anthropic-ai/claude-agent-sdk": "^0.1.0",
      "better-sqlite3": "^11.8.0"
    }
  };
  writeFileSync(join(runtimeHooksDir, 'package.json'), JSON.stringify(hookPackageJson, null, 2));

  // Install dependencies
  try {
    execSync('npm install --silent', {
      cwd: runtimeHooksDir,
      stdio: 'pipe'
    });
  } catch (error: any) {
    // Log error but continue - user might have dependencies globally available
    console.error(chalk.yellow('⚠ Warning: Failed to install hook dependencies. Hooks may not work properly.'));
    console.error(chalk.gray(`  Run manually: cd ${runtimeHooksDir} && npm install`));
  }
}


function ensureClaudeMdInstructions(): void {
  const pathDiscovery = PathDiscovery.getInstance();
  const claudeMdPath = pathDiscovery.getClaudeMdPath();
  const claudeMdDir = dirname(claudeMdPath);
  
  // Ensure .claude directory exists
  if (!existsSync(claudeMdDir)) {
    mkdirSync(claudeMdDir, { recursive: true });
  }
  
  const instructions = `
<!-- CLAUDE-MEM QUICK REFERENCE -->
## 🧠 Memory System Quick Reference

### Search Your Memories (SIMPLE & POWERFUL)
- **Semantic search is king**: \`mcp__claude-mem__chroma_query_documents(["search terms"])\`
- **🔒 ALWAYS include project name in query**: \`["claude-mem feature authentication"]\` not just \`["feature authentication"]\`
- **Include dates for temporal search**: \`["project-name 2025-09-09 bug fix"]\` finds memories from that date
- **Get specific memory**: \`mcp__claude-mem__chroma_get_documents(ids: ["document_id"])\`

### Search Tips That Actually Work
- **Project isolation**: Always prefix queries with project name to avoid cross-contamination
- **Temporal search**: Include dates (YYYY-MM-DD) in query text to find memories from specific times
- **Intent-based**: "implementing oauth" > "oauth implementation code function"
- **Multiple queries**: Search with different phrasings for better coverage
- **Session-specific**: Include session ID in query when you know it

### What Doesn't Work (Don't Do This!)
- ❌ Complex where filters with $and/$or - they cause errors
- ❌ Timestamp comparisons ($gte/$lt) - Chroma stores timestamps as strings
- ❌ Mixing project filters in where clause - causes "Error finding id"

### Storage
- Collection: "claude_memories"
- Archives: ~/.claude-mem/archives/
<!-- /CLAUDE-MEM QUICK REFERENCE -->`;
  
  // Check if file exists and read content
  let content = '';
  if (existsSync(claudeMdPath)) {
    content = readFileSync(claudeMdPath, 'utf8');
    
    // Check if instructions already exist (handle both old and new format)
    const hasOldInstructions = content.includes('<!-- CLAUDE-MEM INSTRUCTIONS -->');
    const hasNewInstructions = content.includes('<!-- CLAUDE-MEM QUICK REFERENCE -->');
    
    if (hasOldInstructions || hasNewInstructions) {
      // Replace existing instructions (handle both old and new markers)
      let startMarker, endMarker;
      if (hasOldInstructions) {
        startMarker = '<!-- CLAUDE-MEM INSTRUCTIONS -->';
        endMarker = '<!-- /CLAUDE-MEM INSTRUCTIONS -->';
      } else {
        startMarker = '<!-- CLAUDE-MEM QUICK REFERENCE -->';
        endMarker = '<!-- /CLAUDE-MEM QUICK REFERENCE -->';
      }
      
      const startIndex = content.indexOf(startMarker);
      const endIndex = content.indexOf(endMarker) + endMarker.length;
      
      if (startIndex !== -1 && endIndex !== -1) {
        content = content.substring(0, startIndex) + instructions.trim() + content.substring(endIndex);
      }
    } else {
      // Append instructions to the end
      content = content.trim() + '\n' + instructions;
    }
  } else {
    // Create new file with instructions
    content = instructions.trim();
  }
  
  // Write the updated content
  writeFileSync(claudeMdPath, content);
}

function installChromaMcp(forceReinstall: boolean = false): void {
  const uvPath = `${homedir()}/.cargo/bin`;
  if (existsSync(uvPath) && !process.env.PATH?.includes(uvPath)) {
    process.env.PATH = `${uvPath}:${process.env.PATH}`;
  }

  if (forceReinstall) {
    try {
      execSync('claude mcp remove claude-mem', { stdio: 'pipe' });
    } catch (error) {
      // Ignore errors if claude-mem doesn't exist
    }
  }

  const chromaMcpCommand = `claude mcp add claude-mem -- uvx chroma-mcp --client-type persistent --data-dir ${PathDiscovery.getInstance().getChromaDirectory()}`;
  execSync(chromaMcpCommand, { stdio: 'inherit' });
}

function createHookConfig(scriptPath: string, timeout: number, matcher?: string) {
  const config: any = {
    hooks: [{ type: "command", command: scriptPath, timeout }]
  };
  if (matcher) config.matcher = matcher;
  return config;
}

function configureHooks(settingsPath: string): void {
  const pathDiscovery = PathDiscovery.getInstance();
  const hooksDir = pathDiscovery.getHooksDirectory();

  let settings: any = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, 'utf8'))
    : { hooks: {} };

  mkdirSync(dirname(settingsPath), { recursive: true });

  if (!settings.hooks) settings.hooks = {};

  const hookTypes = ['SessionStart', 'Stop', 'UserPromptSubmit', 'PostToolUse'];
  hookTypes.forEach(type => {
    if (settings.hooks[type]) {
      settings.hooks[type] = settings.hooks[type].filter(
        (cfg: any) => !cfg.hooks?.some((h: any) => h.command?.includes(PACKAGE_NAME))
      );
    }
  });

  settings.hooks.SessionStart = [createHookConfig(join(hooksDir, 'session-start.js'), 180)];
  settings.hooks.Stop = [createHookConfig(join(hooksDir, 'stop.js'), 60)];
  settings.hooks.UserPromptSubmit = [createHookConfig(join(hooksDir, 'user-prompt-submit.js'), 60)];
  settings.hooks.PostToolUse = [createHookConfig(join(hooksDir, 'post-tool-use.js'), 180, "*")];

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function getSettingsPath(config: InstallConfig): string {
  if (config.scope === 'local' && config.customPath) {
    return join(config.customPath, 'settings.local.json');
  } else if (config.scope === 'project') {
    return join(process.cwd(), '.claude', 'settings.json');
  } else {
    return PathDiscovery.getInstance().getClaudeSettingsPath();
  }
}

function configureUserSettings(config: InstallConfig): void {
  const pathDiscovery = PathDiscovery.getInstance();
  const userSettingsPath = pathDiscovery.getUserSettingsPath();

  let userSettings: Settings = existsSync(userSettingsPath)
    ? JSON.parse(readFileSync(userSettingsPath, 'utf8'))
    : {};

  userSettings.backend = 'chroma';
  userSettings.installed = true;
  userSettings.embedded = true;
  userSettings.saveMemoriesOnClear = config.saveMemoriesOnClear || false;
  userSettings.claudePath = detectClaudePath();

  writeFileSync(userSettingsPath, JSON.stringify(userSettings, null, 2));
}

function configureSmartTrashAlias(): void {
  const shellConfigs = Platform.getShellConfigPaths();
  const aliasDefinition = Platform.getAliasDefinition('rm', 'claude-mem trash');
  const commentLine = Platform.isWindows()
    ? '# claude-mem smart trash alias'
    : '# claude-mem smart trash alias';

  for (const configPath of shellConfigs) {
    if (!existsSync(configPath)) {
      // Create the file if it doesn't exist (especially for PowerShell profiles)
      const dir = dirname(configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(configPath, '');
    }

    let content = readFileSync(configPath, 'utf8');
    if (content.includes(aliasDefinition)) continue;

    const aliasBlock = `\n${commentLine}\n${aliasDefinition}\n`;
    content += aliasBlock;
    writeFileSync(configPath, content);
  }
}


function installClaudeCommands(): void {
  const pathDiscovery = PathDiscovery.getInstance();
  const claudeCommandsDir = pathDiscovery.getClaudeCommandsDirectory();
  const packageCommandsDir = pathDiscovery.findPackageCommandsDirectory();

  mkdirSync(claudeCommandsDir, { recursive: true });

  const commandFiles = ['save.md', 'remember.md', 'claude-mem.md'];

  for (const fileName of commandFiles) {
    const sourcePath = join(packageCommandsDir, fileName);
    const destPath = join(claudeCommandsDir, fileName);
    if (existsSync(sourcePath)) {
      copyFileSync(sourcePath, destPath);
    }
  }
}


export async function install(options: OptionValues = {}): Promise<void> {
  console.log(fastRainbow('\n═══════════════════════════════════════'));
  console.log(fastRainbow('         CLAUDE-MEM INSTALLER          '));
  console.log(fastRainbow('═══════════════════════════════════════'));

  console.log(boxen(vibrantRainbow('🧠 Persistent Memory System for Claude Code\n\n✨ Transform your Claude experience with seamless context preservation\n🚀 Never lose your conversation history again'), {
    padding: 2,
    margin: 1,
    borderStyle: 'double',
    borderColor: 'magenta',
    textAlignment: 'center'
  }));

  await sleep(500);

  installUv();

  const isNonInteractive = options.user || options.project || options.local || options.force;

  let config: InstallConfig;

  if (isNonInteractive) {
    config = {
      scope: options.local ? 'local' : options.project ? 'project' : 'user',
      customPath: options.path,
      hookTimeout: options.timeout ? parseInt(options.timeout) : 180,
      forceReinstall: !!options.force,
      enableSmartTrash: false,
      saveMemoriesOnClear: false
    };
  } else {
    const existingInstall = hasExistingInstallation();
    const wizardConfig = await runInstallationWizard(existingInstall);
    if (!wizardConfig) {
      process.exit(0);
    }
    config = wizardConfig;
  }

  console.log(vibrantRainbow('\n🚀 Beginning Installation Process\n'));

  const steps = [
    { name: 'Creating directory structure', fn: () => ensureDirectoryStructure() },
    { name: 'Installing Chroma MCP server', fn: () => installChromaMcp(config.forceReinstall) },
    { name: 'Adding CLAUDE.md instructions', fn: () => ensureClaudeMdInstructions() },
    { name: 'Installing Claude commands', fn: () => installClaudeCommands() },
    { name: 'Installing memory hooks', fn: () => writeHookFiles(config.hookTimeout) },
    { name: 'Configuring Claude settings', fn: () => configureHooks(getSettingsPath(config)) },
    { name: 'Configuring user settings', fn: () => configureUserSettings(config) }
  ];

  if (config.enableSmartTrash) {
    steps.push({ name: 'Configuring Smart Trash alias', fn: () => configureSmartTrashAlias() });
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const progress = `[${i + 1}/${steps.length}]`;

    const loader = createLoadingAnimation(`${chalk.gray(progress)} ${step.name}...`);
    loader.start();

    step.fn();
    loader.stop(`${chalk.gray(progress)} ${step.name} ${vibrantRainbow('completed! ✨')}`);

    await sleep(150);
  }
  
  
  // Beautiful success message
  const successTitle = fastRainbow('🎉 INSTALLATION COMPLETE! 🎉');

  const successMessage = `
${chalk.bold('How your new memory system works:')}

${chalk.green('•')} When you start Claude Code, claude-mem loads your latest memories automatically
${chalk.green('•')} Memories are saved automatically as you work
${chalk.green('•')} Ask Claude to search your memories anytime with natural language
${chalk.green('•')} Instructions added to ${chalk.cyan('~/.claude/CLAUDE.md')} teach Claude how to use the system

${chalk.bold('Slash Commands Available:')}
${chalk.cyan('/claude-mem help')} - Show all memory commands and features
${chalk.cyan('/save')} - Quick save of current conversation overview
${chalk.cyan('/remember')} - Search your saved memories

${chalk.bold('Quick Start:')}
${chalk.yellow('1.')} Restart Claude Code to activate your memory system
${chalk.yellow('2.')} Start using Claude normally - memories save automatically
${chalk.yellow('3.')} Search memories by asking: ${chalk.italic('"Search my memories for X"')}`;
  
  
  const finalSmartTrashNote = config.enableSmartTrash ? 
    `\n\n${chalk.blue('🗑️  Smart Trash Enabled:')}
${chalk.gray('  • rm commands now move files to ~/.claude-mem/trash')}
${chalk.gray('  • View trash:')} ${chalk.cyan('claude-mem trash view')}
${chalk.gray('  • Restore files:')} ${chalk.cyan('claude-mem restore')}
${chalk.gray('  • Empty trash:')} ${chalk.cyan('claude-mem trash empty')}
${chalk.yellow('  • Restart terminal for alias to activate')}` : '';
  
  const finalClearHookNote = config.saveMemoriesOnClear ?
    `\n\n${chalk.magenta('💾 Save-on-clear enabled:')}
${chalk.gray('  • /clear now saves memories automatically (takes ~1 minute)')}` : '';
    
  console.log(boxen(successTitle + successMessage + finalSmartTrashNote + finalClearHookNote, {
    padding: 2,
    margin: 1,
    borderStyle: 'double',
    borderColor: 'green',
    backgroundColor: '#001122'
  }));
  
  // Final flourish
  console.log(fastRainbow('\n✨ Welcome to the future of persistent AI conversations! ✨\n'));
}
