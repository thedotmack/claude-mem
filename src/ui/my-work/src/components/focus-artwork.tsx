import type { FocusArea } from '@/data'
import workspace from '@/assets/focus/workspace.webp'
import sync from '@/assets/focus/sync.webp'
import knowledge from '@/assets/focus/knowledge.webp'
import collaboration from '@/assets/focus/collaboration.webp'
import metrics from '@/assets/focus/metrics.webp'
import storytelling from '@/assets/focus/storytelling.webp'
import momentum from '@/assets/focus/momentum.webp'
import wellbeing from '@/assets/focus/wellbeing.webp'
import { useI18n } from '@/lib/i18n'

/** Bundled concept illustrations. A render/refresh never makes a paid image-generation request. */
function artworkFor(area: FocusArea) {
  const bySubject = (subject: string) => {
    if (/wellbeing|wellness|routine|health/.test(subject)) return wellbeing
    if (/metric|analytic|dashboard|cost|billing|pricing|budget/.test(subject)) return metrics
    if (/deck|slide|video|storyboard|presentation|promo/.test(subject)) return storytelling
    if (/release|launch|onboard|open loops|cleanup/.test(subject)) return momentum
    if (/sync|device|cloud/.test(subject)) return sync
    if (/search|knowledge|memory|research|learn|context/.test(subject)) return knowledge
    if (/agent|team|collaborat|behavio[u]?r|community|harness|skill/.test(subject)) return collaboration
    return null
  }
  return bySubject(area.name.toLowerCase()) ?? bySubject((area.goal ?? '').toLowerCase()) ?? workspace
}

export function FocusArtwork({ area, priority = false }: { area: FocusArea; priority?: boolean }) {
  const { t } = useI18n()
  return <figure className="focus-artwork">
    <img src={artworkFor(area)} alt="" width={1000} height={667} loading={priority ? 'eager' : 'lazy'} decoding="async" onError={(event) => { event.currentTarget.hidden = true }} />
    <figcaption>{t('Concept illustration')}</figcaption>
  </figure>
}
