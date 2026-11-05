import { parseDocument } from 'yaml';

export type SkillAgent = 'claude' | 'codex' | 'custom';
export type SkillScope = 'personal' | 'project' | 'configured';
export interface ScanIssue { source: string; message: string; }

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  agent: SkillAgent;
  source: string;
  location: string;
  relativePath: string;
  portableRoot: string | null;
  editable: boolean;
  problem: string | null;
}
export interface SkillListing { skills: SkillEntry[]; issues: ScanIssue[]; }

/** Read the two fields needed in the list. A malformed header can still be repaired in the source editor. */
export function skillMetadata(text: string, fallbackName: string, agent: SkillAgent) {
  const source = text.replace(/^\uFEFF/, '');
  const fallback = { name: fallbackName, description: '', problem: null as string | null };
  if (!/^---[ \t]*(?:\r?\n|$)/.test(source)) {
    return { ...fallback, problem: agent === 'codex' ? 'Codex skills require name and description in front matter.' : null };
  }
  const header = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m.exec(source);
  if (!header) return { ...fallback, problem: 'Close the YAML front matter with a --- line.' };
  try {
    const document = parseDocument(header[1], { prettyErrors: false });
    if (document.errors.length) throw new Error();
    const fields = document.toJS({ maxAliasCount: 40 }) ?? {};
    if (typeof fields !== 'object' || Array.isArray(fields)) throw new Error();
    const name = typeof fields.name === 'string' ? fields.name.trim() : '';
    const description = typeof fields.description === 'string' ? fields.description.trim() : '';
    return { name: name || fallbackName, description,
      problem: agent === 'codex' && (!name || !description) ? 'Codex skills require name and description in front matter.' : null };
  } catch { return { ...fallback, problem: 'The YAML front matter could not be read. Open Edit to repair it.' }; }
}
