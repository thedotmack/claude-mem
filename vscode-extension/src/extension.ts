/**
 * Claude Mem VSCode Extension
 * Provides persistent memory for GitHub Copilot conversations
 */

import * as vscode from 'vscode';
import { SessionManager } from './session-manager';
import * as workerClient from './worker-client';

let sessionManager: SessionManager;
let statusBarItem: vscode.StatusBarItem;
let workerHealthCheckInterval: NodeJS.Timeout | undefined;

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
  console.log('Claude Mem extension is now active');

  // Initialize session manager
  sessionManager = new SessionManager();

  // Register Language Model Tools
  registerTools(context);

  // Register commands
  registerCommands(context);

  // Setup status bar
  setupStatusBar(context);

  // Start worker health checks
  startWorkerHealthChecks();
}

/**
 * Register Language Model Tools
 */
function registerTools(context: vscode.ExtensionContext) {
  // Tool 1: mem_session_init
  const initTool = vscode.lm.registerTool('mem_session_init', {
    prepareInvocation: async (
      options: vscode.LanguageModelToolInvocationPrepareOptions<{
        project: string;
        userPrompt: string;
        conversationId: string;
      }>,
      token: vscode.CancellationToken
    ) => {
      // Check worker health
      if (!(await workerClient.isWorkerHealthy())) {
        throw new Error('Claude-mem worker is not running. Please start the worker service first.');
      }

      return {
        invocationMessage: `Initializing memory session for project: ${options.input.project}`
      };
    },
    invoke: async (
      options: vscode.LanguageModelToolInvocationOptions<{
        project: string;
        userPrompt: string;
        conversationId: string;
      }>,
      token: vscode.CancellationToken
    ) => {
      try {
        const { project, userPrompt, conversationId } = options.input;

        // Create session in database
        const session = await sessionManager.createSession(conversationId, project, userPrompt);

        // Initialize session via worker
        await workerClient.initSession(session.sessionDbId, project, userPrompt, session.promptNumber);

        // Save user prompt
        await sessionManager.saveUserPrompt(conversationId, session.promptNumber, userPrompt);

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Memory session initialized successfully (ID: ${session.sessionDbId}, Project: ${project})`
          )
        ]);
      } catch (error: any) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Failed to initialize memory session: ${error.message}`
          )
        ]);
      }
    }
  });

  // Tool 2: mem_user_prompt_log
  const promptLogTool = vscode.lm.registerTool('mem_user_prompt_log', {
    prepareInvocation: async (options, token) => {
      return {
        invocationMessage: 'Logging user prompt to memory'
      };
    },
    invoke: async (
      options: vscode.LanguageModelToolInvocationOptions<{
        prompt: string;
      }>,
      token: vscode.CancellationToken
    ) => {
      try {
        const { prompt } = options.input;

        // Get conversation ID from context (would need to extract from Copilot context)
        // For now, we'll need to track this separately or use the most recent session
        const activeSessions = sessionManager.getActiveSessions();
        if (activeSessions.length === 0) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('No active session found. Initialize session first.')
          ]);
        }

        const session = activeSessions[activeSessions.length - 1];
        const promptNumber = sessionManager.incrementPromptCounter(session.conversationId);

        // Save prompt
        await sessionManager.saveUserPrompt(session.conversationId, promptNumber, prompt);

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('User prompt logged successfully')
        ]);
      } catch (error: any) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Failed to log prompt: ${error.message}`)
        ]);
      }
    }
  });

  // Tool 3: mem_observation_record
  const observationTool = vscode.lm.registerTool('mem_observation_record', {
    prepareInvocation: async (options, token) => {
      return {
        invocationMessage: 'Recording observation to memory'
      };
    },
    invoke: async (
      options: vscode.LanguageModelToolInvocationOptions<{
        tool_name: string;
        tool_input: string;
        tool_response: string;
        cwd?: string;
      }>,
      token: vscode.CancellationToken
    ) => {
      try {
        const { tool_name, tool_input, tool_response, cwd } = options.input;

        // Get active session
        const activeSessions = sessionManager.getActiveSessions();
        if (activeSessions.length === 0) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('No active session found. Initialize session first.')
          ]);
        }

        const session = activeSessions[activeSessions.length - 1];
        const promptNumber = sessionManager.getPromptCounter(session.conversationId);

        // Record observation
        await workerClient.recordObservation(
          session.sessionDbId,
          tool_name,
          tool_input,
          tool_response,
          promptNumber,
          cwd
        );

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Observation recorded successfully')
        ]);
      } catch (error: any) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Failed to record observation: ${error.message}`)
        ]);
      }
    }
  });

  // Tool 4: mem_summary_finalize
  const summaryTool = vscode.lm.registerTool('mem_summary_finalize', {
    prepareInvocation: async (options, token) => {
      return {
        invocationMessage: 'Generating session summary'
      };
    },
    invoke: async (
      options: vscode.LanguageModelToolInvocationOptions<{
        last_user_message?: string;
      }>,
      token: vscode.CancellationToken
    ) => {
      try {
        const { last_user_message } = options.input;

        // Get active session
        const activeSessions = sessionManager.getActiveSessions();
        if (activeSessions.length === 0) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('No active session found.')
          ]);
        }

        const session = activeSessions[activeSessions.length - 1];
        const promptNumber = sessionManager.getPromptCounter(session.conversationId);

        // Generate summary
        await workerClient.generateSummary(
          session.sessionDbId,
          promptNumber,
          last_user_message
        );

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Session summary generated successfully')
        ]);
      } catch (error: any) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Failed to generate summary: ${error.message}`)
        ]);
      }
    }
  });

  // Tool 5: mem_session_cleanup
  const cleanupTool = vscode.lm.registerTool('mem_session_cleanup', {
    prepareInvocation: async (options, token) => {
      return {
        invocationMessage: 'Cleaning up memory session',
        confirmationMessages: {
          title: 'Confirm Session Cleanup',
          message: 'Mark this memory session as complete?'
        }
      };
    },
    invoke: async (
      options: vscode.LanguageModelToolInvocationOptions<{
        reason?: string;
      }>,
      token: vscode.CancellationToken
    ) => {
      try {
        // Get active session
        const activeSessions = sessionManager.getActiveSessions();
        if (activeSessions.length === 0) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('No active session to cleanup.')
          ]);
        }

        const session = activeSessions[activeSessions.length - 1];

        // Complete session
        await workerClient.completeSession(session.sessionDbId);
        await sessionManager.completeSession(session.conversationId);

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Session cleaned up successfully')
        ]);
      } catch (error: any) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Failed to cleanup session: ${error.message}`)
        ]);
      }
    }
  });

  // Register disposables
  context.subscriptions.push(initTool, promptLogTool, observationTool, summaryTool, cleanupTool);
}

/**
 * Register commands
 */
function registerCommands(context: vscode.ExtensionContext) {
  // Check worker health
  const checkHealthCmd = vscode.commands.registerCommand('claudeMem.checkWorkerHealth', async () => {
    const isHealthy = await workerClient.isWorkerHealthy();
    if (isHealthy) {
      vscode.window.showInformationMessage('✅ Claude-mem worker is healthy');
    } else {
      vscode.window.showWarningMessage(
        '⚠️ Claude-mem worker is not responding',
        'Restart Worker'
      ).then(selection => {
        if (selection === 'Restart Worker') {
          vscode.commands.executeCommand('claudeMem.restartWorker');
        }
      });
    }
  });

  // Restart worker
  const restartWorkerCmd = vscode.commands.registerCommand('claudeMem.restartWorker', async () => {
    const terminal = vscode.window.createTerminal('Claude Mem Worker');
    terminal.sendText('pm2 restart claude-mem-worker');
    terminal.show();

    vscode.window.showInformationMessage('Worker restart command sent. Check terminal for output.');
  });

  // Open viewer
  const openViewerCmd = vscode.commands.registerCommand('claudeMem.openViewer', () => {
    const url = workerClient.getViewerUrl();
    vscode.env.openExternal(vscode.Uri.parse(url));
  });

  // Open settings
  const openSettingsCmd = vscode.commands.registerCommand('claudeMem.openSettings', () => {
    vscode.commands.executeCommand('workbench.action.openSettings', 'claudeMem');
  });

  context.subscriptions.push(checkHealthCmd, restartWorkerCmd, openViewerCmd, openSettingsCmd);
}

/**
 * Setup status bar
 */
function setupStatusBar(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('claudeMem');
  if (!config.get('showStatusBar', true)) {
    return;
  }

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudeMem.checkWorkerHealth';
  statusBarItem.text = '$(database) Claude Mem';
  statusBarItem.show();

  context.subscriptions.push(statusBarItem);
}

/**
 * Start worker health checks
 */
function startWorkerHealthChecks() {
  const updateStatus = async () => {
    if (!statusBarItem) return;

    const isHealthy = await workerClient.isWorkerHealthy();
    if (isHealthy) {
      statusBarItem.text = '$(database) Claude Mem';
      statusBarItem.tooltip = 'Worker is healthy';
      statusBarItem.backgroundColor = undefined;
    } else {
      statusBarItem.text = '$(database) Claude Mem $(warning)';
      statusBarItem.tooltip = 'Worker is not responding. Click to check.';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
  };

  // Update immediately
  updateStatus();

  // Update every 30 seconds
  workerHealthCheckInterval = setInterval(updateStatus, 30000);
}

/**
 * Extension deactivation
 */
export function deactivate() {
  if (workerHealthCheckInterval) {
    clearInterval(workerHealthCheckInterval);
  }

  // Complete any active sessions
  const activeSessions = sessionManager.getActiveSessions();
  for (const session of activeSessions) {
    workerClient.completeSession(session.sessionDbId).catch(err => {
      console.error('Failed to complete session on deactivation:', err);
    });
  }
}
