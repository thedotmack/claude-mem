
export type CursorInstallTarget = 'project' | 'user' | 'enterprise';

export interface CursorHooksJson {
  version: number;
  hooks: {
    beforeSubmitPrompt?: Array<{ command: string }>;
    afterMCPExecution?: Array<{ command: string }>;
    afterShellExecution?: Array<{ command: string }>;
    afterFileEdit?: Array<{ command: string }>;
    postToolUse?: Array<{ command: string; matcher?: string }>;
    postToolUseFailure?: Array<{ command: string; matcher?: string }>;
    stop?: Array<{ command: string }>;
  };
}
