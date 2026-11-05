import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftIcon, CheckIcon, FileTextIcon, FolderIcon, PaintbrushIcon, PencilIcon, RefreshCwIcon, SearchIcon, Undo2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { useWorkModel, useWorkspace } from '@/store'
import type { SourceKind } from '@/live/work-data-source'
import { skillMetadata } from '../../../../shared/skill-document'
import { editTextareaValue, type SkillMode } from '@/skills/skill-draft'
import { getSkillSource, type SkillEntry } from '@/skills/skill-source'
import { useSkillLibrary } from '@/skills/use-skill-library'

function SkillListRow({ skill, active, dirty, select }: { skill: SkillEntry; active: boolean; dirty: boolean; select: () => void }) {
  return (
    <button type="button" aria-current={active ? 'true' : undefined} onClick={select}
      className={cn('block w-full rounded-lg border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'border-accent-border bg-accent/80' : 'border-transparent hover:bg-muted/75')}>
      <span className="flex items-center gap-2 text-sm font-semibold">
        <FileTextIcon aria-hidden="true" className={cn('size-4 shrink-0', active ? 'text-accent-foreground' : 'text-muted-foreground')} />
        <span className="min-w-0 break-words">{skill.name}</span>
        {dirty && <span className="ml-auto shrink-0 rounded-full bg-primary size-2" title="Unsaved changes"><span className="sr-only">Unsaved changes</span></span>}
      </span>
      <span className="mt-1 block text-xs text-muted-foreground break-words">{skill.source}</span>
      {skill.description && <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-foreground/80">{skill.description}</span>}
      {!skill.editable && <span className="mt-1 block text-xs text-muted-foreground">{skill.problem ? 'Unavailable' : 'Read-only'}</span>}
    </button>
  )
}

export function MySkills() {
  const { sourceKind } = useWorkModel()
  const { team } = useWorkspace()
  if (team) return <Empty><EmptyHeader><EmptyTitle>My Skills is personal</EmptyTitle><EmptyDescription>Switch to your personal workspace to edit your skills.</EmptyDescription></EmptyHeader></Empty>
  return <SkillsPage key={sourceKind} kind={sourceKind} />
}

function SkillsPage({ kind }: { kind: SourceKind }) {
  const library = useSkillLibrary(getSkillSource(kind))
  const { listing, selected, select, editors, opening, openError } = library
  const draft = selected ? editors[selected] : null
  const entry = draft?.entry ?? listing?.skills.find(skill => skill.id === selected)
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<SkillMode>('edit')
  const editorHeading = useRef<HTMLHeadingElement>(null)
  const searchBox = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return listing?.skills.filter(skill => !query || [skill.name, skill.description, skill.source, skill.relativePath]
      .some(value => value.toLocaleLowerCase().includes(query))) ?? []
  }, [listing, search])
  const draftText = draft?.text, draftName = draft?.entry.name, draftAgent = draft?.entry.agent
  const problem = useMemo(() => draftText !== undefined && draftName && draftAgent
    ? skillMetadata(draftText, draftName, draftAgent).problem : null, [draftText, draftName, draftAgent])
  const dirty = !!draft && draft.text !== draft.baseText
  const canSave = !!draft?.entry.editable && dirty && !draft.saving && !draft.conflict && !problem

  useEffect(() => {
    if (selected && !opening) editorHeading.current?.focus({ preventScroll: true })
  }, [selected, opening])

  const open = (skillId: string) => {
    setMode('edit')
    void select(skillId)
  }
  const back = () => {
    void select(null)
    requestAnimationFrame(() => searchBox.current?.focus())
  }
  const noResults = search.trim() ? 'No matching skills' : 'No custom skills found'

  return (
    <section className="space-y-4" aria-labelledby="skills-page-title">
      <div className={cn("flex items-center justify-between gap-3", selected && "hidden md:flex")}>
        <h2 id="skills-page-title" className="text-2xl font-semibold tracking-tight">My Skills</h2>
        <Button size="sm" variant="outline" onClick={() => void library.refresh()} disabled={library.refreshing} aria-label="Refresh skills">
          <RefreshCwIcon className={library.refreshing ? 'motion-safe:animate-spin' : ''} />Refresh
        </Button>
      </div>
      {library.listError && <p role="alert" className="text-sm text-attention-foreground">Couldn’t load skills. {library.listError}</p>}
      {!!listing?.issues.length && <details className="rounded-lg border bg-card p-3 text-sm">
        <summary className="cursor-pointer font-medium">Folder issues ({listing.issues.length})</summary>
        <ul className="mt-2 space-y-2 text-xs text-muted-foreground">{listing.issues.map((issue, i) => <li key={i} className="break-words"><strong>{issue.source}</strong> · {issue.message}</li>)}</ul>
      </details>}
      <div className="grid min-w-0 items-start gap-4 md:grid-cols-[minmax(12rem,0.37fr)_minmax(0,1fr)]">
        <aside aria-label="Skill library" className={cn('min-w-0 rounded-xl border bg-card p-2 shadow-panel', selected && 'hidden md:block')}>
          <label className="relative block p-1"><span className="sr-only">Search skills</span><SearchIcon aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input ref={searchBox} type="search" placeholder="Search skills" value={search} onChange={event => setSearch(event.target.value)} className="pl-9" />
          </label>
          {listing ? filtered.length ? <ul className="mt-1 max-h-[65svh] space-y-1 overflow-y-auto">{filtered.map(skill =>
            <li key={skill.id}><SkillListRow skill={skill} active={selected === skill.id} dirty={!!editors[skill.id] && editors[skill.id].text !== editors[skill.id].baseText} select={() => open(skill.id)} /></li>
          )}</ul> : <Empty className="px-3 py-5"><EmptyHeader><EmptyTitle>{noResults}</EmptyTitle>
            <EmptyDescription>{search.trim() ? 'Try a different name, description, or project.' : kind === 'cloud' ? 'Saved skills appear here after personal sync.' : 'Add a SKILL.md in your Claude Code, Codex, or configured skills folder, then refresh.'}</EmptyDescription>
          </EmptyHeader></Empty> : !library.listError && <p role="status" className="p-3 text-sm text-muted-foreground">Loading skills…</p>}
        </aside>

        <section aria-label="Skill editor" className={cn('min-w-0 overflow-hidden rounded-xl border bg-card shadow-panel', !selected && 'hidden md:block')}>
          {!selected ? <Empty className="min-h-72"><EmptyHeader><FileTextIcon aria-hidden="true" className="size-6 text-muted-foreground" /><EmptyTitle>Select a skill</EmptyTitle></EmptyHeader></Empty> : <>
            <div className="space-y-3 border-b p-4 md:p-5">
              <Button variant="ghost" size="sm" className="-ml-2 md:hidden" onClick={back}><ArrowLeftIcon />My Skills</Button>
              <div><h3 tabIndex={-1} ref={editorHeading} className="break-words text-xl font-semibold tracking-tight outline-none">{entry?.name ?? 'Skill'}</h3>
                {entry && <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                  <p className="flex items-start gap-1.5"><FolderIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{entry.source} · {entry.relativePath}</span></p>
                  {entry.location && entry.location !== entry.relativePath && <details>
                    <summary className="w-fit cursor-pointer rounded py-1 focus-visible:ring-2 focus-visible:ring-ring">Full path</summary>
                    <code className="block select-all break-all py-1">{entry.location}</code>
                  </details>}
                </div>}
              </div>
              {draft && !openError && !opening && <div className="flex flex-wrap items-center gap-2">
                <ToggleGroup type="single" value={mode} aria-label="Editing mode" size="sm" variant="outline" spacing={0}
                  onValueChange={value => { if (value === 'edit' || value === 'paint') { library.endTyping(selected); setMode(value) } }}>
                  <ToggleGroupItem value="edit"><PencilIcon />Edit</ToggleGroupItem>
                  <ToggleGroupItem value="paint" disabled title={problem ?? 'Paint editor'}><PaintbrushIcon />Paint</ToggleGroupItem>
                </ToggleGroup>
                <div className="ml-auto flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => library.undo(selected)} disabled={!draft.history.length || draft.saving || !draft.entry.editable}><Undo2Icon />Undo</Button>
                  <Button size="sm" onClick={() => void library.save(selected)} disabled={!canSave}>{draft.saving ? 'Saving…' : 'Save'}</Button>
                </div>
              </div>}
            </div>
            {opening ? <p role="status" className="p-4 text-sm text-muted-foreground">Opening skill…</p> : openError ? <div className="space-y-3 p-4">
              <p role="alert" className="text-sm text-attention-foreground">{entry?.problem ?? openError}</p>
              <Button size="sm" variant="outline" onClick={() => void select(selected)}>Retry</Button>
            </div> : draft && <div className="space-y-3 p-4 md:p-5">
              {problem && <p role="alert" className="text-sm text-attention-foreground">{problem}</p>}
              {draft.error && <p role="alert" className="text-sm text-attention-foreground">{draft.error}</p>}
              {draft.conflict && <div className="space-y-3 rounded-lg border border-attention-border bg-attention/20 p-3">
                <p role="alert" className="text-sm font-medium">A newer version was saved. Your draft is below.</p>
                <details><summary className="cursor-pointer text-sm">Compare saved version</summary><pre className="mt-2 max-h-64 overflow-auto rounded border bg-card p-3 text-xs whitespace-pre-wrap">{draft.conflict.text}</pre></details>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => library.resolveConflict(selected,'keep-draft')}>Keep my draft</Button>
                  <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('Discard your draft and use the newer saved version?')) library.resolveConflict(selected,'use-latest') }}>Use saved version</Button>
                </div>
              </div>}
              <label className="block"><span className="sr-only">Skill Markdown</span>
                <Textarea aria-invalid={!!problem} readOnly={!draft.entry.editable || draft.saving} spellCheck={false} value={draft.text}
                  onChange={event => library.change(selected, editTextareaValue(draft.text, event.currentTarget.value), 'typing')}
                  onBlur={() => library.endTyping(selected)}
                  onKeyDown={event => {
                    if (!event.metaKey && !event.ctrlKey) return
                    if (event.key.toLowerCase() === 's') { event.preventDefault(); if (canSave) void library.save(selected) }
                    if (event.key.toLowerCase() === 'z' && !event.shiftKey && draft.entry.editable && !draft.saving) { event.preventDefault(); library.undo(selected) }
                  }}
                  className="field-sizing-fixed min-h-[42svh] resize-y font-mono text-[0.88rem] leading-relaxed md:min-h-96" />
              </label>
              <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {draft.saved && !dirty && <CheckIcon className="size-3.5" />}
                {draft.saving ? 'Saving…' : dirty ? 'Unsaved changes' : !draft.entry.editable ? 'Read-only' : draft.saved ? kind === 'sample' ? 'Saved in this sample' : kind === 'cloud' ? 'Saved to your account' : 'Saved on this device' : null}
              </p>
            </div>}
          </>}
        </section>
      </div>
    </section>
  )
}
