import { Command } from 'commander';

export const shellCommand = new Command('shell')
  .description('Shell completion setup')
  .addCommand(
    new Command('completion')
      .description('Generate shell completion script')
      .argument('<shell>', 'Shell type (bash|zsh|fish)')
      .action((shell) => {
        const script = generateCompletion(shell);
        if (script) {
          console.log(script);
        } else {
          console.error(`Unsupported shell: ${shell}`);
          console.error('Supported shells: bash, zsh, fish');
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('install')
      .description('Install shell completion')
      .argument('<shell>', 'Shell type (bash|zsh|fish)')
      .action((shell) => {
        const script = generateCompletion(shell);
        if (!script) {
          console.error(`Unsupported shell: ${shell}`);
          process.exit(1);
        }

        const { homedir } = require('os');
        const { join } = require('path');
        const { writeFileSync, mkdirSync, existsSync } = require('fs');

        let installPath: string;

        switch (shell) {
          case 'bash':
            installPath = join(homedir(), '.bash_completion');
            break;
          case 'zsh':
            installPath = join(homedir(), '.zsh', 'completions', '_claude-mem');
            mkdirSync(join(homedir(), '.zsh', 'completions'), { recursive: true });
            break;
          case 'fish':
            installPath = join(homedir(), '.config', 'fish', 'completions', 'claude-mem.fish');
            mkdirSync(join(homedir(), '.config', 'fish', 'completions'), { recursive: true });
            break;
          default:
            console.error(`Unsupported shell: ${shell}`);
            process.exit(1);
        }

        writeFileSync(installPath, script);
        console.log(`✓ Installed completion to ${installPath}`);
        console.log(`  Restart your shell or run: source ${installPath}`);
      })
  );

function generateCompletion(shell: string): string | null {
  switch (shell) {
    case 'bash':
      return `# Bash completion for claude-mem
_claude_mem_completion() {
    local cur=\${COMP_WORDS[COMP_CWORD]}
    local prev=\${COMP_WORDS[COMP_CWORD-1]}
    local commands="doctor repair logs backup stats search config clean export import shell"
    
    case \${prev} in
        claude-mem)
            COMPREPLY=( $(compgen -W "\${commands}" -- \${cur}) )
            ;;
        config)
            COMPREPLY=( $(compgen -W "get set list reset validate" -- \${cur}) )
            ;;
        logs)
            COMPREPLY=( $(compgen -W "--tail --follow --level --list --clean" -- \${cur}) )
            ;;
        *)
            COMPREPLY=()
            ;;
    esac
}
complete -F _claude_mem_completion claude-mem
`;

    case 'zsh':
      return `#compdef claude-mem
# Zsh completion for claude-mem

_claude_mem() {
    local curcontext="$curcontext" state line
    typeset -A opt_args

    local -a commands=(
        'doctor:Run health checks'
        'repair:Fix common issues'
        'logs:View worker logs'
        'backup:Create backup'
        'stats:Show statistics'
        'search:Search memories'
        'config:Manage settings'
        'clean:Clean up old data'
        'export:Export observations'
        'import:Import observations'
        'shell:Shell completion setup'
    )

    _arguments -C \\
        '1: :->command' \\
        '*:: :->args'

    case "$state" in
        command)
            _describe -t commands 'commands' commands
            ;;
        args)
            case "$line[1]" in
                config)
                    local -a config_cmds=(get set list reset validate)
                    _describe -t commands 'config commands' config_cmds
                    ;;
                logs)
                    _arguments \\
                        '(-t --tail)'{-t,--tail}'[Show last N lines]' \\
                        '(-f --follow)'{-f,--follow}'[Follow log output]' \\
                        '(-l --level)'{-l,--level}'[Filter by level]:level:(DEBUG INFO WARN ERROR)'
                    ;;
            esac
            ;;
    esac
}

compdef _claude_mem claude-mem
`;

    case 'fish':
      return `# Fish completion for claude-mem
complete -c claude-mem -f

# Commands
complete -c claude-mem -n "__fish_use_subcommand" -a "doctor" -d "Run health checks"
complete -c claude-mem -n "__fish_use_subcommand" -a "repair" -d "Fix common issues"
complete -c claude-mem -n "__fish_use_subcommand" -a "logs" -d "View worker logs"
complete -c claude-mem -n "__fish_use_subcommand" -a "backup" -d "Create backup"
complete -c claude-mem -n "__fish_use_subcommand" -a "stats" -d "Show statistics"
complete -c claude-mem -n "__fish_use_subcommand" -a "search" -d "Search memories"
complete -c claude-mem -n "__fish_use_subcommand" -a "config" -d "Manage settings"
complete -c claude-mem -n "__fish_use_subcommand" -a "clean" -d "Clean up old data"
complete -c claude-mem -n "__fish_use_subcommand" -a "export" -d "Export observations"
complete -c claude-mem -n "__fish_use_subcommand" -a "import" -d "Import observations"
complete -c claude-mem -n "__fish_use_subcommand" -a "shell" -d "Shell completion setup"

# Options
complete -c claude-mem -n "__fish_seen_subcommand_from logs" -l tail -d "Show last N lines"
complete -c claude-mem -n "__fish_seen_subcommand_from logs" -l follow -d "Follow log output"
complete -c claude-mem -n "__fish_seen_subcommand_from logs" -l level -d "Filter by level" -xa "DEBUG INFO WARN ERROR"
`;

    default:
      return null;
  }
}
