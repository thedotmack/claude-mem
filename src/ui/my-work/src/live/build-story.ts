// The build story as My Work's recap and sheet draw it (pages/focus-area.tsx TodayPanel, components/build-story-sheet.tsx StorySheet): its chapters with
// their headings, the date at the front of a heading, and the three numbers both lead with. Pure, with .ts imports, so
// `node --test` loads it and the worker's mapper can share the types.
import { needsYou, type Request } from '../data.ts'
import type { BuildStory, StoryChapter } from './work-data-source.ts'

/**
 * The story's chapters in the order request-progress wrote them (oldest first, so the last is the newest). A worker
 * from 16.0.0 sends them (to-work-model.ts toBuildStory). An older one sends the paragraphs with the heading marks
 * already removed (G19), so there a line that does not end a sentence (no closing . ! ? or …, before any closing
 * quote or bracket) is read as a heading: in the owner's story every heading is such a line and every paragraph ends
 * one (checked on the real story, 2026-11-16: 24 headings, 25 paragraphs).
 */
export function storyChapters(story: Pick<BuildStory, 'paragraphs' | 'chapters'>): StoryChapter[] {
  if (story.chapters) return story.chapters
  const chapters: StoryChapter[] = []
  for (const paragraph of story.paragraphs) {
    if (!ENDS_A_SENTENCE.test(paragraph.trim())) chapters.push({ heading: paragraph.trim(), paragraphs: [] })
    else if (chapters.length) chapters[chapters.length - 1].paragraphs.push(paragraph)
    else chapters.push({ heading: null, paragraphs: [paragraph] })
  }
  return chapters
}
const ENDS_A_SENTENCE = /[.!?…]["”’)\]]*$/

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
/** "Nov 9", "Nov 9-10", "Oct 5-Nov 9", "Nov 9 10:07", then ": " and what happened. */
const DATED_HEADING = new RegExp(`^(${MONTH} \\d{1,2}(?:\\s?[–-]\\s?(?:${MONTH} )?\\d{1,2})?(?: \\d{1,2}:\\d{2})?):\\s+(.+)$`)

/** A heading's date, when it starts with one, and the words after it ("Nov 9-10: ponytail review"). */
export function datedHeading(heading: string): { date: string | null; title: string } {
  const match = DATED_HEADING.exec(heading.trim())
  return match ? { date: match[1], title: match[2] } : { date: null, title: heading.trim() }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A heading's day and 24-hour time with nothing else: "Nov 17 01:13". */
const DAY_AND_TIME = new RegExp(`^(${MONTH}) (\\d{1,2}) ([01]?\\d|2[0-3]):([0-5]\\d)$`)

/**
 * The instant a dated heading names. request-progress writes a heading's day and time in UTC, as `show` and
 * `story-input` give them, with no year (plugin/skills/request-progress/SKILL.md, step 4). Its year is the latest one
 * that puts it at or before `writtenAt`, the story's writing, so a December heading in a January story is last year's.
 * Null for a heading with only a day or a range of days ("Nov 9-10"), and for a day that year does not have ("Feb 29").
 */
export function storyHeadingInstant(date: string, writtenAt: number): number | null {
  const match = DAY_AND_TIME.exec(date.trim())
  if (!match || !Number.isFinite(writtenAt)) return null
  const [month, day, hours, minutes] = [MONTHS.indexOf(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
  const inYear = (year: number) => Date.UTC(year, month, day, hours, minutes)
  const year = new Date(writtenAt).getUTCFullYear()
  const at = inYear(year) <= writtenAt ? inYear(year) : inYear(year - 1)
  const named = new Date(at)
  return named.getUTCMonth() === month && named.getUTCDate() === day ? at : null
}

/**
 * A dated heading in the reader's own date and clock (G9, plan rule 9), in the English twelve-hour notation the page's
 * other times have before displayTime words them for the reader ("Nov 16, 5:13 pm"; lib/display-time.ts
 * displayRecordedDate). The heading's time is UTC (storyHeadingInstant): shown as written, the 15.19.0 story's
 * "Nov 17 01:13" (01:13 UTC) read as 1:13 am under "written 6:12 pm" local, hours after the story was written.
 * `writtenAtIso` is the story's writing time. A worker before 16.0.0 sends none (G19), so `now` stands in, which can
 * pick a later year; the year shows nowhere, and it moves the time only on a day daylight saving starts or ends in one
 * of the two years and not the other. `timeZone` is the reader's own when left out. Null when the heading has no time
 * to convert, so it stays as written.
 */
export function storyHeadingInReaderClock(date: string, writtenAtIso: string | null | undefined, now: number, timeZone?: string): string | null {
  const written = Date.parse(writtenAtIso ?? '')
  const at = storyHeadingInstant(date, Number.isFinite(written) ? written : now)
  if (at === null) return null
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(new Date(at)).map((part) => [part.type, part.value]))
  return `${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${String(parts.dayPeriod).toLowerCase()}`
}

/**
 * The numbers the recap and the sheet lead with (c-work-today-panel, c-work-story-sheet), counted from the requests
 * on the page: waiting on you, and still open (working or idle, and not closed). The plan's third number, requests
 * shipped within the story's period, is left out, because it cannot be derived: the story carries only its narrative
 * and when it was written (work-view-api-types.ts WorkViewBuildStory), no period, and counting every shipped request
 * on the page put a different number under the story's heading (68 on the owner's data, Nov 16).
 */
export function storyNumbers(requests: readonly Request[]): { waiting: number; stillOpen: number } {
  const open = requests.filter((request) => !request.closed)
  return {
    waiting: open.filter(needsYou).length,
    stillOpen: open.filter((request) => request.state === 'working' || request.state === 'idle').length,
  }
}

/** UI UX Pro Max line-length-control: 60 to 75 characters a line. A recap line longer than 75 ends in an ellipsis. */
export const RECAP_LINE_MAX_CHARACTERS = 75

/** Cut at the last word boundary that fits, with an ellipsis; the whole line stays in the sheet. */
export function fitLine(text: string, max = RECAP_LINE_MAX_CHARACTERS): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max - 1)
  const boundary = cut.lastIndexOf(' ')
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).replace(/[,:;\-–\s]+$/, '')}…`
}
