import { OptionValues } from 'commander';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, copyFileSync, statSync, readdirSync } from 'fs';
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

// <Block> Silent Prerequisites validation - no visual output unless error
async function validatePrerequisites(): Promise<boolean> {
  // No announcement, just run checks silently
  
  const checks = [
    {
      name: 'Node.js version',
      check: async () => {
        const nodeVersion = process.versions.node;
        const [major] = nodeVersion.split('.').map(Number);
        return { 
          success: major >= 18, 
          message: major >= 18 ? '' : `Node.js ${nodeVersion} is below required version 18.0.0` 
        };
      }
    },
    {
      name: 'Claude Code CLI',
      check: async () => {
        try {
          execSync('which claude', { stdio: 'ignore' });
          return { success: true, message: '' };
        } catch {
          return { success: false, message: 'Claude Code CLI not found. Please install: https://docs.anthropic.com/claude/docs/claude-code' };
        }
      }
    },
    {
      name: 'uv (Python package manager)',
      check: async () => {
        try {
          execSync('which uv', { stdio: 'ignore' });
          return { success: true, message: '' };
        } catch {
          // uv not found - we'll install it automatically
          return { success: true, message: '', needsInstall: true };
        }
      }
    },
    {
      name: 'Write permissions',
      check: async () => {
        const testDir = join(PathDiscovery.getDataDirectory(), 'test-permissions');
        try {
          mkdirSync(testDir, { recursive: true });
          writeFileSync(join(testDir, 'test'), 'test');
          execSync(`rm -rf ${testDir}`, { stdio: 'ignore' });
          return { success: true, message: '' };
        } catch {
          return { success: false, message: 'No write permissions to claude-mem data directory' };
        }
      }
    }
  ];
  
  // Run all checks silently
  let needsUvInstall = false;
  for (const { name, check } of checks) {
    const result = await check();
    if (!result.success) {
      // Only show output if there's an error
      console.log(boxen(chalk.red(`❌ ${name} check failed!\n\n${result.message}`), {
        padding: 1,
        margin: 1,
        borderStyle: 'double',
        borderColor: 'red'
      }));
      return false;
    }
    if ((result as any).needsInstall && name === 'uv (Python package manager)') {
      needsUvInstall = true;
    }
  }
  
  // Install uv if needed
  if (needsUvInstall) {
    const loader = createLoadingAnimation('Installing uv (Python package manager)...');
    loader.start();
    try {
      // Use the official uv installer script
      execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', { 
        stdio: 'pipe',
        shell: '/bin/sh'
      });
      
      // Add uv to PATH for current session
      process.env.PATH = `${homedir()}/.cargo/bin:${process.env.PATH}`;
      
      loader.stop('uv installed successfully', true);
    } catch (error) {
      loader.stop('Failed to install uv automatically', false);
      console.log(boxen(chalk.yellow(`⚠️  Please install uv manually:\n\n${chalk.cyan('curl -LsSf https://astral.sh/uv/install.sh | sh')}\n\nOr visit: ${chalk.cyan('https://docs.astral.sh/uv/getting-started/installation/')}`), {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'yellow'
      }));
      return false;
    }
  }
  
  // Success - no output, just return true
  return true;
}
// </Block>

// <Block> Claude binary path detection
function detectClaudePath(): string | null {
  try {
    const path = execSync('which claude', { 
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'] 
    }).trim();
    return path || null;
  } catch {
    return null;
  }
}
// </Block>

// <Block> Installation status detection
function detectExistingInstallation(): {
  hasHooks: boolean;
  hasChromaMcp: boolean;
  hasSettings: boolean;
  scope?: InstallScope;
} {
  const result = {
    hasHooks: false,
    hasChromaMcp: false,
    hasSettings: false,
    scope: undefined as InstallScope | undefined
  };
  
  // Check for hooks
  const hooksDir = PathDiscovery.getHooksDirectory();
  result.hasHooks = existsSync(hooksDir) && 
    existsSync(join(hooksDir, 'pre-compact.js')) &&
    existsSync(join(hooksDir, 'session-start.js'));
  
  // Check for Chroma MCP server configuration
  const pathDiscovery = PathDiscovery.getInstance();
  const userMcpPath = pathDiscovery.getMcpConfigPath();
  const projectMcpPath = pathDiscovery.getProjectMcpConfigPath();
  
  if (existsSync(userMcpPath)) {
    try {
      const config = JSON.parse(readFileSync(userMcpPath, 'utf8'));
      if (config.mcpServers?.['claude-mem']) {
        result.hasChromaMcp = true;
        result.scope = 'user';
      }
    } catch {}
  }
  
  if (existsSync(projectMcpPath)) {
    try {
      const config = JSON.parse(readFileSync(projectMcpPath, 'utf8'));
      if (config.mcpServers?.['claude-mem']) {
        result.hasChromaMcp = true;
        result.scope = 'project';
      }
    } catch {}
  }
  
  // Check for settings
  const userSettingsPath = pathDiscovery.getUserSettingsPath();
  result.hasSettings = existsSync(userSettingsPath);
  
  return result;
}
// </Block>

// <Block> Interactive installation wizard
async function runInstallationWizard(existingInstall: ReturnType<typeof detectExistingInstallation>): Promise<InstallConfig | null> {
  const config: Partial<InstallConfig> = {};
  
  // If existing installation found, ask about reinstallation
  if (existingInstall.hasHooks || existingInstall.hasChromaMcp) {
    const shouldReinstall = await p.confirm({
      message: '🧠 Existing claude-mem installation detected. Your memories and data are safe!\n\nReinstall to update hooks and configuration?',
      initialValue: true
    });
    
    if (p.isCancel(shouldReinstall)) {
      p.cancel('Installation cancelled');
      return null;
    }
    
    if (!shouldReinstall) {
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
    initialValue: existingInstall.scope || 'user'
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
    message: 'claude-mem is designed to save "memories" when you type /compact. The official compact summary + claude-mem produces the best ongoing results, but sometimes you may want to completely clear the context and still retain the "memories" from your last conversation.\n\nWould you like to save memories when you type "/clear" in Claude Code? When running /clear with this on, it takes about a minute to save memories before your new session starts.',
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

// <Block> Backup existing configuration
async function backupExistingConfig(): Promise<string | null> {
  const pathDiscovery = PathDiscovery.getInstance();
  const backupDir = join(pathDiscovery.getBackupsDirectory(), new Date().toISOString().replace(/[:.]/g, '-'));
  
  try {
    mkdirSync(backupDir, { recursive: true });
    
    // Backup hooks if they exist
    const hooksDir = pathDiscovery.getHooksDirectory();
    if (existsSync(hooksDir)) {
      copyFileRecursively(hooksDir, join(backupDir, 'hooks'));
    }
    
    // Backup settings
    const settingsPath = pathDiscovery.getUserSettingsPath();
    if (existsSync(settingsPath)) {
      copyFileSync(settingsPath, join(backupDir, 'settings.json'));
    }
    
    // Backup Claude settings
    const claudeSettingsPath = pathDiscovery.getClaudeSettingsPath();
    if (existsSync(claudeSettingsPath)) {
      copyFileSync(claudeSettingsPath, join(backupDir, 'claude-settings.json'));
    }
    
    return backupDir;
  } catch (error) {
    return null;
  }
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
  const hooksDir = pathDiscovery.getHooksDirectory();
  
  // Find the installed package hooks directory
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  
  // DYNAMIC DISCOVERY: Find hooks by walking up from current location
  let currentDir = __dirname;
  let packageHooksDir: string | null = null;
  
  // Walk up the tree to find the hooks directory
  for (let i = 0; i < 10; i++) {
    const hooksPath = join(currentDir, 'hooks');
    
    // Check if this directory has the hook files
    if (existsSync(join(hooksPath, 'pre-compact.js'))) {
      packageHooksDir = hooksPath;
      break;
    }
    
    // Move up one directory
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // We've reached the filesystem root
      break;
    }
    currentDir = parentDir;
  }
  
  // If we still haven't found it, use PathDiscovery to find package hooks
  if (!packageHooksDir) {
    try {
      packageHooksDir = pathDiscovery.findPackageHooksDirectory();
    } catch (error) {
      throw new Error('Cannot dynamically locate hooks directory. The package may be corrupted.');
    }
  }
  
  // Copy hook files from the package instead of creating wrappers
  const hooks = ['pre-compact.js', 'session-start.js', 'session-end.js'];
  
  for (const hookName of hooks) {
    const sourcePath = join(packageHooksDir, hookName);
    const destPath = join(hooksDir, hookName);
    
    if (existsSync(sourcePath)) {
      copyFileSync(sourcePath, destPath);
      chmodSync(destPath, 0o755);
    }
  }
  
  
  // Copy shared directory if it exists
  const sourceSharedDir = join(packageHooksDir, 'shared');
  const destSharedDir = join(hooksDir, 'shared');
  
  if (existsSync(sourceSharedDir)) {
    copyFileRecursively(sourceSharedDir, destSharedDir);
  }
  
  // Write configuration with custom timeout
  const hookConfigPath = join(hooksDir, 'config.json');
  const hookConfig = {
    packageName: PACKAGE_NAME,
    cliCommand: PACKAGE_NAME,
    backend: 'chroma',
    timeout
  };
  writeFileSync(hookConfigPath, JSON.stringify(hookConfig, null, 2));
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

async function installChromaMcp(): Promise<boolean> {
  const loader = createLoadingAnimation('Installing Chroma MCP server...');
  loader.start();
  
  try {
    await sleep(400); // Realistic timing
    
    // Remove existing claude-mem MCP server if it exists (silently ignore errors)
    try {
      execSync('claude mcp remove claude-mem', { stdio: 'pipe' });
      await sleep(200);
    } catch {
      // Ignore errors - server may not exist
    }
    
    // Ensure uv is in PATH (it might be in ~/.cargo/bin if just installed)
    const uvPath = `${homedir()}/.cargo/bin`;
    if (existsSync(uvPath) && !process.env.PATH?.includes(uvPath)) {
      process.env.PATH = `${uvPath}:${process.env.PATH}`;
    }
    
    // Install fresh Chroma MCP server
    const chromaMcpCommand = `claude mcp add claude-mem -- uvx chroma-mcp --client-type persistent --data-dir ${PathDiscovery.getInstance().getChromaDirectory()}`;
    execSync(chromaMcpCommand, { 
      stdio: 'pipe',
      env: process.env 
    });
    
    await sleep(300);
    loader.stop(vibrantRainbow('Chroma MCP server installed successfully! 🚀'), true);
    return true;
  } catch (error) {
    loader.stop('Chroma MCP server installation failed', false);
    console.log(boxen(chalk.yellow(`⚠️  Manual installation required:\n\n${chalk.cyan(`claude mcp add claude-mem -- uvx chroma-mcp --client-type persistent --data-dir ${PathDiscovery.getInstance().getChromaDirectory()}`)}\n\nMake sure uv is installed: ${chalk.cyan('https://docs.astral.sh/uv/getting-started/installation/')}`), {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'yellow'
    }));
    return false;
  }
}

async function configureHooks(settingsPath: string, config: InstallConfig): Promise<void> {
  const pathDiscovery = PathDiscovery.getInstance();
  const claudeMemHooksDir = pathDiscovery.getHooksDirectory();
  const preCompactScript = join(claudeMemHooksDir, 'pre-compact.js');
  const sessionStartScript = join(claudeMemHooksDir, 'session-start.js');
  const sessionEndScript = join(claudeMemHooksDir, 'session-end.js');
  
  let settings: any = {};
  if (existsSync(settingsPath)) {
    const content = readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(content);
  }
  
  // Ensure settings directory exists
  const settingsDir = dirname(settingsPath);
  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true });
  }
  
  // Initialize hooks structure if it doesn't exist
  if (!settings.hooks) {
    settings.hooks = {};
  }
  
  // Remove existing claude-mem hooks to ensure clean installation/update
  // Non-tool hooks: filter out configs where hooks contain our commands
  if (settings.hooks.PreCompact) {
    settings.hooks.PreCompact = settings.hooks.PreCompact.filter((cfg: any) =>
      !cfg.hooks?.some((hook: any) => 
        hook.command?.includes(PACKAGE_NAME) || hook.command?.includes('pre-compact.js')
      )
    );
    if (!settings.hooks.PreCompact.length) delete settings.hooks.PreCompact;
  }
  
  if (settings.hooks.SessionStart) {
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter((cfg: any) =>
      !cfg.hooks?.some((hook: any) => 
        hook.command?.includes(PACKAGE_NAME) || hook.command?.includes('session-start.js')
      )
    );
    if (!settings.hooks.SessionStart.length) delete settings.hooks.SessionStart;
  }
  
  if (settings.hooks.SessionEnd) {
    settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter((cfg: any) =>
      !cfg.hooks?.some((hook: any) => 
        hook.command?.includes(PACKAGE_NAME) || hook.command?.includes('session-end.js')
      )
    );
    if (!settings.hooks.SessionEnd.length) delete settings.hooks.SessionEnd;
  }
  
  /**
   * 🔒 LOCKED by @docs-agent | Change to 🔑 to allow @docs-agent edits
   * 
   * OFFICIAL DOCS: Claude Code Hooks Configuration v2025
   * Last Verified: 2025-08-31
   * 
   * Hook Configuration Structure Requirements:
   * - Tool-related hooks (PreToolUse, PostToolUse): Use 'matcher' field for tool patterns
   * - Non-tool hooks (PreCompact, SessionStart, SessionEnd, etc.): NO matcher/pattern field
   * 
   * Correct Non-Tool Hook Structure:
   * {
   *   hooks: [{
   *     type: "command",
   *     command: "/path/to/script.js"
   *   }]
   * }
   * 
   * @see https://docs.anthropic.com/en/docs/claude-code/hooks
   * @see docs/claude-code/hook-configuration.md for full documentation
   */
  // Add PreCompact hook - Non-tool hook (no matcher field)
  if (!settings.hooks.PreCompact) {
    settings.hooks.PreCompact = [];
  }
  
  // ✅ CORRECT: Non-tool hooks have no 'pattern' or 'matcher' field
  settings.hooks.PreCompact.push({
    hooks: [
      {
        type: "command",
        command: preCompactScript,
        timeout: 180
      }
    ]
  });
  
  // Add SessionStart hook - Non-tool hook (no matcher field)
  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [];
  }
  
  // ✅ CORRECT: Non-tool hooks have no 'pattern' or 'matcher' field
  settings.hooks.SessionStart.push({
    hooks: [
      {
        type: "command",
        command: sessionStartScript,
        timeout: 180
      }
    ]
  });
  
  // Add SessionEnd hook (only if the file exists)
  if (existsSync(sessionEndScript)) {
    if (!settings.hooks.SessionEnd) {
      settings.hooks.SessionEnd = [];
    }
    
    // ✅ CORRECT: Non-tool hooks have no 'pattern' or 'matcher' field
    settings.hooks.SessionEnd.push({
      hooks: [{
        type: "command",
        command: sessionEndScript,
        timeout: 180
      }]
    });
  }
  
  // Write updated settings
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

async function configureSmartTrashAlias(): Promise<void> {
  const homeDir = homedir();
  const shellConfigs = [
    join(homeDir, '.bashrc'),
    join(homeDir, '.zshrc'),
    join(homeDir, '.bash_profile')
  ];
  
  const aliasLine = 'alias rm="claude-mem trash"';
  const commentLine = '# claude-mem smart trash alias';
  
  for (const configPath of shellConfigs) {
    if (!existsSync(configPath)) continue;
    
    try {
      let content = readFileSync(configPath, 'utf8');
      
      // Check if alias already exists
      if (content.includes(aliasLine)) {
        continue; // Already configured
      }
      
      // Add the alias
      const aliasBlock = `\n${commentLine}\n${aliasLine}\n`;
      content += aliasBlock;
      
      writeFileSync(configPath, content);
    } catch (error) {
      // Silent fail - not critical
    }
  }
}


function createBackupFilename(originalPath: string): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/T/, '-')
    .replace(/:/g, '')
    .replace(/\..+/, '')
    .replace(/-/g, '');
  const formatted = `${timestamp.slice(0,8)}-${timestamp.slice(8)}`;
  return `${originalPath}.backup.${formatted}`;
}

function installClaudeCommands(force: boolean = false): void {
  const pathDiscovery = PathDiscovery.getInstance();
  const claudeCommandsDir = pathDiscovery.getClaudeCommandsDirectory();
  
  // DYNAMIC DISCOVERY: Find where THIS code is actually running from
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  
  // Walk up from current location until we find the package root
  let currentDir = __dirname;
  let packageCommandsDir: string | null = null;
  
  // Walk up the tree to find the commands directory
  for (let i = 0; i < 10; i++) {
    const commandsPath = join(currentDir, 'commands');
    
    // Check if this directory has the command files
    if (existsSync(join(commandsPath, 'save.md'))) {
      packageCommandsDir = commandsPath;
      break;
    }
    
    // Move up one directory
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // We've reached the filesystem root
      break;
    }
    currentDir = parentDir;
  }
  
  // If we still haven't found it, use PathDiscovery to find package commands
  if (!packageCommandsDir) {
    try {
      packageCommandsDir = pathDiscovery.findPackageCommandsDirectory();
    } catch (error) {
      throw new Error('Cannot dynamically locate commands directory. The package may be corrupted.');
    }
  }
  
  // Create ~/.claude/commands/ directory if it doesn't exist
  if (!existsSync(claudeCommandsDir)) {
    mkdirSync(claudeCommandsDir, { recursive: true });
  }
  
  // Copy command files
  const commandFiles = ['save.md', 'remember.md', 'claude-mem.md'];
  const copiedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const backedUpFiles: string[] = [];
  
  for (const fileName of commandFiles) {
    const sourcePath = join(packageCommandsDir, fileName);
    const destPath = join(claudeCommandsDir, fileName);
    
    if (existsSync(sourcePath)) {
      if (existsSync(destPath)) {
        if (force) {
          // Create backup and copy new version
          const backupPath = createBackupFilename(destPath);
          copyFileSync(destPath, backupPath);
          copyFileSync(sourcePath, destPath);
          backedUpFiles.push(fileName);
        } else {
          // File already exists, skip it
          skippedFiles.push(fileName);
        }
      } else {
        // Copy the file
        copyFileSync(sourcePath, destPath);
        copiedFiles.push(fileName);
      }
    }
  }
  
  // Provide feedback about what happened
  if (copiedFiles.length > 0) {
    console.log(`  ${chalk.green('✓')} Copied commands: ${copiedFiles.join(', ')}`);
  }
  if (backedUpFiles.length > 0) {
    console.log(`  ${chalk.blue('📦')} Backed up and replaced commands: ${backedUpFiles.join(', ')}`);
  }
  if (skippedFiles.length > 0) {
    console.log(`  ${chalk.yellow('→')} Skipped existing commands: ${skippedFiles.join(', ')}`);
  }
}

async function verifyInstallation(): Promise<void> {
  const s = p.spinner();
  s.start('Verifying installation');
  
  const issues: string[] = [];
  
  // Check hooks
  const pathDiscovery = PathDiscovery.getInstance();
  const hooksDir = pathDiscovery.getHooksDirectory();
  if (!existsSync(join(hooksDir, 'pre-compact.js'))) {
    issues.push('Pre-compact hook not found');
  }
  if (!existsSync(join(hooksDir, 'session-start.js'))) {
    issues.push('Session-start hook not found');
  }
  
  if (issues.length > 0) {
    s.stop('Installation verification completed with issues');
    p.log.warn('The following issues were detected:');
    issues.forEach(issue => p.log.error(`  - ${issue}`));
    p.log.info('The installation may not work correctly. Consider reinstalling with --force flag.');
  } else {
    s.stop('Installation verified successfully');
  }
}

export async function install(options: OptionValues = {}): Promise<void> {
  // Simple banner
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
  
  await sleep(500); // Let the banner shine
  
  // Check if running with flags (non-interactive mode)
  const isNonInteractive = options.user || options.project || options.local || options.force;
  
  let config: InstallConfig;
  
  if (isNonInteractive) {
    // Non-interactive mode - use flags
    config = {
      scope: options.local ? 'local' : options.project ? 'project' : 'user',
      customPath: options.path,
      hookTimeout: options.timeout ? parseInt(options.timeout) : 180,
      forceReinstall: !!options.force,
    };
  } else {
    // Interactive mode
    // Validate prerequisites
    const prereqValid = await validatePrerequisites();
    if (!prereqValid) {
      p.outro('Please fix the prerequisites issues and try again');
      process.exit(1);
    }
    
    // Detect existing installation
    const existingInstall = detectExistingInstallation();
    
    // Run installation wizard
    const wizardConfig = await runInstallationWizard(existingInstall);
    if (!wizardConfig) {
      process.exit(0);
    }
    config = wizardConfig;
  }
  
  // Backup existing configuration if force reinstall
  if (config.forceReinstall) {
    const backupPath = await backupExistingConfig();
    if (backupPath) {
      p.log.info(`Backup created at: ${backupPath}`);
    }
  }
  
  // Enhanced installation steps with beautiful progress
  console.log(vibrantRainbow('\n🚀 Beginning Installation Process\n'));
  
  const installationSteps = [
    {
      name: 'Creating directory structure',
      action: async () => {
        await sleep(200);
        ensureDirectoryStructure();
        await sleep(100);
      }
    },
    {
      name: 'Installing Chroma MCP server',
      action: async () => {
        const success = await installChromaMcp();
        if (!success) throw new Error('MCP installation failed');
      }
    },
    {
      name: 'Adding CLAUDE.md instructions',
      action: async () => {
        await sleep(300);
        ensureClaudeMdInstructions();
        await sleep(200);
      }
    },
    {
      name: 'Installing Claude commands',
      action: async () => {
        await sleep(200);
        installClaudeCommands(config.forceReinstall);
        await sleep(100);
      }
    },
    {
      name: 'Installing memory hooks',
      action: async () => {
        await sleep(400);
        writeHookFiles(config.hookTimeout);
        await sleep(200);
      }
    },
    {
      name: 'Configuring Claude settings',
      action: async () => {
        await sleep(300);
        
        // Determine settings path
        let settingsPath: string;
        if (config.scope === 'local' && config.customPath) {
          settingsPath = join(config.customPath, 'settings.local.json');
        } else if (config.scope === 'project') {
          settingsPath = join(process.cwd(), '.claude', 'settings.json');
        } else {
          settingsPath = PathDiscovery.getInstance().getClaudeSettingsPath();
        }
        
        await configureHooks(settingsPath, config);
        
        // Store backend setting in user settings
        const pathDiscovery = PathDiscovery.getInstance();
        const userSettingsPath = pathDiscovery.getUserSettingsPath();
        let userSettings: Settings = {};
        
        if (existsSync(userSettingsPath)) {
          try {
            userSettings = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
          } catch {}
        }
        
        userSettings.backend = 'chroma';
        userSettings.installed = true;
        userSettings.embedded = true;
        userSettings.saveMemoriesOnClear = config.saveMemoriesOnClear || false;
        
        // Detect and store Claude CLI path
        const claudePath = detectClaudePath();
        if (claudePath) {
          userSettings.claudePath = claudePath;
        } else {
          delete userSettings.claudePath;
        }
        
        writeFileSync(userSettingsPath, JSON.stringify(userSettings, null, 2));
        await sleep(200);
      }
    }
  ];
  
  // Add Smart Trash step if enabled
  if (config.enableSmartTrash) {
    installationSteps.push({
      name: 'Configuring Smart Trash alias',
      action: async () => {
        await sleep(200);
        await configureSmartTrashAlias();
        await sleep(100);
      }
    });
  }
  
  
  // Execute all steps with enhanced progress display
  for (let i = 0; i < installationSteps.length; i++) {
    const step = installationSteps[i];
    const progress = `[${i + 1}/${installationSteps.length}]`;
    
    const loader = createLoadingAnimation(`${chalk.gray(progress)} ${step.name}...`);
    loader.start();
    
    try {
      await step.action();
      loader.stop(`${chalk.gray(progress)} ${step.name} ${vibrantRainbow('completed! ✨')}`);
    } catch (error) {
      loader.stop(`${chalk.gray(progress)} ${step.name} ${chalk.red('failed')}`, false);
      console.log(boxen(chalk.red(`❌ Installation failed at: ${step.name}\n\nError: ${error}`), {
        padding: 1,
        margin: 1,
        borderStyle: 'double',
        borderColor: 'red'
      }));
      process.exit(1);
    }
    
    await sleep(150); // Smooth progression
  }
  
  // Verification with style
  console.log(chalk.gray('\n🔍 Verifying Installation\n'));
  await verifyInstallation();
  
  // Beautiful success message
  const successTitle = fastRainbow('🎉 INSTALLATION COMPLETE! 🎉');
  const saveCommand = config.saveMemoriesOnClear 
    ? `${chalk.cyan('/compact')} or ${chalk.cyan('/clear')}`
    : chalk.cyan('/compact');
  
  const successMessage = `
${chalk.bold('How your new memory system works:')}

${chalk.green('•')} When you start Claude Code, claude-mem loads your latest memories automatically
${chalk.green('•')} Save your work by typing ${saveCommand} (takes ~30s to process)
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