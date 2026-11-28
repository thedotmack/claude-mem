// The build story's sheet (c-work-story-sheet): shipping velocity, the narrative and the preferences it found. Home opens
// it from its "Build story" link and a focus area's recap from "Read the build story" (pages/my-work.tsx,
// pages/focus-area.tsx TodayPanel), until the design pass gives the story a page of its own (Phase 7).
import { useRef, useState } from 'react'
import { displayRecordedDate, recordedTimeWords } from '@/lib/display-time'
import { interpolate, t } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { TracingBeam } from '@/components/aceternity/tracing-beam'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { type Request } from '@/data'
import { useWorkModel } from '@/store'
import type { BuildStory, StoryChapter } from '@/live/work-data-source'
import { datedHeading, storyChapters, storyNumbers } from '@/live/build-story'

/**
 * The numbers the recap and the sheet lead with (c-work-today-panel, c-work-story-sheet), in monospace. The plan's
 * "shipped within the story's period" is left out: the story records no period (live/build-story.ts storyNumbers).
 */
export function StoryNumbers({ requests }: { requests: Request[] }) {
  const { waiting, stillOpen } = storyNumbers(requests)
  const numbers = [
    { label: t('waiting on you'), count: waiting, dot: 'bg-attention-foreground' },
    { label: t('still open'), count: stillOpen, dot: 'bg-working-foreground' },
  ]
  return (
    <dl className="grid grid-cols-2 gap-2">
      {numbers.map(({ label, count, dot }) => (
        <div key={label} className="flex flex-col-reverse gap-0.5 rounded-lg border border-border/70 px-3 py-2">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground"><span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', dot)} />{label}</dt>
          <dd className="text-2xl font-semibold mono-number">{count}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A chapter's date (monospace; a UTC day and time in the reader's own clock, display-time.ts displayRecordedDate) and
 * what happened, from its heading.
 */
function ChapterHeading({ heading, writtenAtIso }: { heading: string; writtenAtIso: string | undefined }) {
  const { date, title } = datedHeading(heading)
  return <>{date && <span className="mr-2 text-xs font-normal text-muted-foreground mono-number">{displayRecordedDate(date, writtenAtIso)}</span>}<span>{title}</span></>
}

/**
 * Learned rules the sheet names before "Review in My Rules": with four, that button ends at 663px of a 900px sheet on
 * the owner's data (1440, Nov 16), so "What it learned" and its way to My Rules stay on the first screen
 * (c-work-story-sheet M). The rest are counted beside the button, and all of them are in My Rules.
 */
const STORY_LEARNED_NAMED = 4

/**
 * Shipping velocity, the narrative, and the preferences it found (§7, c-work-story-sheet, c-aceternity-tracing-beam).
 * The three numbers and the latest paragraph first, then what it learned with "Review in My Rules" (it was 3,900px
 * down), then the dated chapters in the story's own order, each a real heading over its paragraphs: the newest open,
 * the rest folded, every word still there. The entry being read (the one opened last) is marked on the rail.
 * Preferences are the same records My Rules shows. `requests`: the ones its numbers count (Home: every request; a
 * focus area's recap: the area's).
 */
export function StorySheet({ open, story, requests, onClose, onOpenRules }: { open: boolean; story: BuildStory; requests: Request[]; onClose: () => void; onOpenRules: () => void }) {
  const { rules } = useWorkModel()
  const allLearned = rules.filter((rule) => rule.source === 'request-progress' && (rule.status === 'on' || rule.status === 'suggested'))
  const learned = allLearned.slice(0, STORY_LEARNED_NAMED)
  const moreLearned = allLearned.length - learned.length
  const chapters = storyChapters(story)
  const opening = chapters.filter((chapter) => chapter.heading === null).flatMap((chapter) => chapter.paragraphs)
  const entries = chapters.filter((chapter): chapter is StoryChapter & { heading: string } => chapter.heading !== null)
  // request-progress writes the story oldest first, so its last dated chapter is the newest: it starts open and marked.
  // (A closing chapter with no date, such as the owner's "What the record teaches", is not an entry of its own date.)
  const newest = entries.findLastIndex((chapter) => datedHeading(chapter.heading).date !== null)
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set([newest >= 0 ? newest : entries.length - 1]))
  const [reading, setReading] = useState(newest >= 0 ? newest : entries.length - 1)
  const [latestWhole, setLatestWhole] = useState(false)
  // The sheet scrolls, not the window, so the tracing beam follows the sheet's scroll.
  const scrollRef = useRef<HTMLDivElement>(null)
  const toggle = (index: number, next: boolean) => {
    setOpened((current) => { const changed = new Set(current); if (next) changed.add(index); else changed.delete(index); return changed })
    if (next) setReading(index)
  }
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      {/* The one sheet width and the scrolling come from SheetContent (D b17 M 355); this panel adds only its spacing. */}
      <SheetContent ref={scrollRef}>
        <SheetHeader className="pr-14">
          <SheetTitle>{t("Build story")}</SheetTitle>
          <SheetDescription>{interpolate(t('From request-progress, reviewed from memory{writtenAt}.'), { writtenAt: story.writtenAt ? `, ${interpolate(t('written {date}'), { date: recordedTimeWords(story.writtenAtIso, story.writtenAt, 'time-or-day') })}` : '' })}</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-6 pb-8">
          <Req ids={['R7.1']}><StoryNumbers requests={requests} /></Req>
          {opening.length > 0 && (
            <Req ids={['R7.2']}>
              <section className="space-y-2">
                <h3 className="section-label">{t('Latest')}</h3>
                {/* Three lines, then the rest in place under the shared fold row (G5, progressive-disclosure): the opening
                    ran about 800 characters of numbers. */}
                <Collapsible open={latestWhole} onOpenChange={setLatestWhole} className="space-y-2">
                  {!latestWhole && <p className="line-clamp-3 text-sm">{opening.join(' ')}</p>}
                  <CollapsibleContent className="space-y-3 text-sm">
                    {opening.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                  </CollapsibleContent>
                  <CollapsibleFoldTrigger>{latestWhole ? t('Show less') : t('Read all')}</CollapsibleFoldTrigger>
                </Collapsible>
              </section>
            </Req>
          )}
          <Req ids={['R7.3']}>
            <section className="space-y-2">
              <h3 className="section-label">{t("What it learned about how you work")}</h3>
              {learned.length === 0 && <p className="text-sm text-muted-foreground">{t("No preferences learned yet.")}</p>}
              <ul className="space-y-2">
                {learned.map((rule) => (
                  <li key={rule.id} className="text-sm">
                    {rule.when ? interpolate(t('When {when}: {then}'), { when: rule.when, then: rule.then }) : rule.then}
                    {rule.status === 'suggested' && <span className="ml-1.5 text-xs text-muted-foreground">{t("· suggested, not approved yet")}</span>}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button variant="outline" onClick={onOpenRules}>{t("Review in My Rules")}</Button>
                {moreLearned > 0 && <span className="text-xs text-muted-foreground tabular">{interpolate(t('{count} more in My Rules'), { count: moreLearned })}</span>}
              </div>
            </section>
          </Req>
          {entries.length > 0 && (
            <Req ids={['R7.2']}>
              <section className="space-y-2">
                <h3 className="section-label">{t('By date')}</h3>
                <TracingBeam scrollContainer={scrollRef} className="pl-[32px]">
                  {/* Starts below the beam's own dot (its top 12–28px), so that dot is not read as an entry's mark. */}
                  <ol className="space-y-2 pt-8">
                    {entries.map((chapter, index) => (
                      <li key={`${index}:${chapter.heading}`} aria-current={reading === index ? 'true' : undefined} className="relative">
                        {/* The rail mark: filled for the entry being read, a ring for the rest. */}
                        {/* On the beam's line: TracingBeam draws it 19px in from its left edge, in px at every root size, so the
                            list starts 32px in and the 10px mark's centre is 32 − 18 + 5 = 19px in (rem sizes put it 2.3px off
                            at the 17px desktop root). */}
                        <span aria-hidden="true" className={cn('absolute top-[17px] -left-[18px] size-[10px] rounded-full border-[1.5px]', reading === index ? 'border-primary bg-primary' : 'border-control-edge bg-card')} />
                        <Collapsible open={opened.has(index)} onOpenChange={(next) => toggle(index, next)}>
                          <h4>
                            <CollapsibleFoldTrigger count={chapter.paragraphs.length > 1 ? interpolate(t('{count} paragraphs'), { count: chapter.paragraphs.length }) : undefined}>
                              <ChapterHeading heading={chapter.heading} writtenAtIso={story.writtenAtIso} />
                            </CollapsibleFoldTrigger>
                          </h4>
                          <CollapsibleContent className="space-y-2 px-3 pt-2 pb-1 text-sm text-muted-foreground">
                            {chapter.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}
                          </CollapsibleContent>
                        </Collapsible>
                      </li>
                    ))}
                  </ol>
                </TracingBeam>
              </section>
            </Req>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
