import { skillMetadata, type SkillEntry, type SkillListing } from '../../../../shared/skill-document.ts'
import type { SourceKind } from '../live/work-data-source.ts'

export type { SkillEntry, SkillListing }
export type AiStamp = 'human' | 'einstein'
export type RewritePassage = (id: string, stamp: AiStamp, text: string, firstIndex: number, lastIndex: number, signal: AbortSignal) => Promise<string>

export interface SavedSkill { entry: SkillEntry; revision: string }
export interface OpenSkill extends SavedSkill { text: string }

export interface SkillSource {
  rewrite?: RewritePassage
  list(): Promise<SkillListing>
  open(id: string): Promise<OpenSkill>
  save(id: string, expectedRevision: string, text: string): Promise<SavedSkill>
}

export class SkillRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init })
  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    const message = detail && typeof detail === 'object' && 'error' in detail && typeof detail.error === 'string'
      ? detail.error : `The skill request failed (HTTP ${response.status}).`
    throw new SkillRequestError(response.status, message)
  }
  return response.json() as Promise<T>
}

function httpSource(base: string): SkillSource {
  const documentUrl = (id: string) => base + '/' + encodeURIComponent(id)
  return {
    list: () => request(base),
    open: id => request(documentUrl(id)),
    save: (id, expectedRevision, text) => request(documentUrl(id) + '/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision, text }),
    }),
  }
}

const samples: OpenSkill[] = [
  { id: 'sample-release-checklist', name: 'release-checklist', description: 'Prepare and verify a release.', agent: 'claude',
    body: '## Prepare the release\n\nRead the changes since the last release. Group the changes by what someone using the project will notice.\n\n## Verify\n\n- Run the build and tests.\n- Install the package in a clean directory.\n- Record how to roll back.\n' },
  { id: 'sample-review-changes', name: 'review-changes', description: 'Review a change before merging.', agent: 'codex',
    body: '## Read the change\n\nStart with the user-visible behavior. Check what happens on a retry and after an error.\n\n## Report\n\nDescribe the finding and include a way to reproduce it.\n' },
].map(({ id, name, description, agent, body }) => ({
  entry: { id, name, description, scope: 'personal', agent: agent as 'claude' | 'codex', source: agent === 'claude' ? 'Claude Code · Personal' : 'Codex · Personal',
    location: `~/${agent === 'claude' ? '.claude' : '.agents'}/skills/${name}/SKILL.md`, relativePath: `${name}/SKILL.md`, portableRoot: null, editable: true, problem: null },
  revision: 'sample-0', text: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
}))

const sampleDocuments = new Map(samples.map(document => [document.entry.id, document]))
let sampleRevision = 0
const sample: SkillSource = {
  list: async () => ({ skills: [...sampleDocuments.values()].map(d => d.entry), issues: [] }),
  open: async id => {
    const found = sampleDocuments.get(id)
    if (!found) throw new SkillRequestError(404, 'This sample skill is unavailable.')
    return found
  },
  save: async (id, expectedRevision, text) => {
    const previous = await sample.open(id)
    if (previous.revision !== expectedRevision) throw new SkillRequestError(409, 'This sample skill changed. Compare the saved version.')
    const parsed = skillMetadata(text, previous.entry.name, previous.entry.agent)
    if (parsed.problem) throw new SkillRequestError(422, parsed.problem)
    const next = { text, entry: { ...previous.entry, ...parsed }, revision: 'sample-' + ++sampleRevision }
    sampleDocuments.set(id, next)
    return next
  },
}

const local = httpSource('/api/work-view/skills')
local.rewrite = async (id, stamp, text, firstIndex, lastIndex, signal) => {
  const result = await request<{ replacementMarkdown: string }>('/api/work-view/skills/' + encodeURIComponent(id) + '/rewrite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ stamp, text, firstIndex, lastIndex }),
  })
  return result.replacementMarkdown
}
const account = httpSource('/api/account/skills')

export function getSkillSource(kind: SourceKind): SkillSource {
  return kind === 'sample' ? sample : kind === 'cloud' ? account : local
}
