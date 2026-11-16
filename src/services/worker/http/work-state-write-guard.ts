import { execFile } from 'node:child_process';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { WorkStateFields } from '../../sqlite/work-state.js';

const configSchema = z.object({
  version: z.literal(1),
  scopes: z.array(z.object({
    project: z.string().min(1),
    list: z.string().min(1),
  }).strict()).min(1),
  command: z.array(z.string().min(1).refine(value => !value.includes('\0'))).min(1)
    .refine(command => isAbsolute(command[0])),
}).strict();

const answerSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().trim().min(1).max(1_000).optional(),
}).strict().refine(answer => answer.allowed || answer.reason !== undefined);

export interface WorkStateWriteContext {
  project: string;
  projects: string[];
  list: string;
  fields: WorkStateFields;
  current: WorkStateFields;
  proposed: WorkStateFields;
  closing: boolean;
  currentClosing: boolean;
  lastClosed: WorkStateFields | null;
}

export interface WorkStateWriteCheck {
  checked: boolean;
  refusal?: string;
}

export async function checkWorkStateWrite(
  configPath: string,
  scope: Pick<WorkStateWriteContext, 'project' | 'projects' | 'list'>,
  readContext: () => WorkStateWriteContext,
): Promise<WorkStateWriteCheck> {
  let config: z.infer<typeof configSchema>;
  let configured = false;
  try {
    lstatSync(configPath);
    configured = true;
    const stat = statSync(configPath);
    if (!stat.isFile() || stat.size > 32_768) throw new Error('Invalid guard configuration');
    config = configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch (error) {
    if (!configured && (error as NodeJS.ErrnoException).code === 'ENOENT') return { checked: false };
    return { checked: true, refusal: 'Repair the local work-state write guard configuration before retrying.' };
  }
  const foldProject = (name: string) => name.replace(/[A-Z]/g, character => character.toLowerCase());
  const projects = new Set(scope.projects.map(foldProject));
  if (!config.scopes.some(entry => projects.has(foldProject(entry.project)) && entry.list === scope.list)) {
    return { checked: false };
  }

  return new Promise(resolve => {
    const failed = { checked: true, refusal: 'The work-state write check did not complete. Repair its local command before retrying.' };
    try {
      const input = JSON.stringify(readContext());
      let delivered = false;
      const child = execFile(config.command[0], config.command.slice(1), {
        cwd: dirname(configPath),
        timeout: 2_000,
        maxBuffer: 16_384,
        killSignal: 'SIGKILL',
        windowsHide: true,
      }, (error, stdout) => {
        if (error || !delivered) { resolve(failed); return; }
        try {
          const answer = answerSchema.parse(JSON.parse(stdout));
          resolve({ checked: true, ...(answer.allowed ? {} : { refusal: answer.reason }) });
        } catch {
          resolve(failed);
        }
      });
      child.stdin?.on('error', () => resolve(failed));
      child.stdin?.end(input, () => { delivered = true; });
    } catch {
      resolve(failed);
    }
  });
}
