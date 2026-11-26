import { useRef, useState } from 'react'
import type { Request } from '@/data'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { deliverableName } from '@/lib/deliverables'
import { originalHttps, sendReviewCards } from '@/live/review-stack-client'
import { useWorkModel } from '@/store'

type Product = Request['workProduct'][number]

/** The selected deliverable supplies the original. The owner supplies the rest of the card's wording. */
export function AddProductToReview({ request }: { request: Request }) {
  const { focusAreas, sourceKind } = useWorkModel()
  const products = new Map<string, Product>()
  for (const product of request.workProduct) {
    const original = originalHttps(product.href)
    if (original && product.availability !== 'origin-only' && new URL(original).hostname.includes('.')) products.set(original, product)
  }
  if (sourceKind === 'sample' || !products.size) return null
  const focus = focusAreas.find(area => area.id === request.focusAreaId)?.name ?? ''
  return <ReviewProductForm products={products} focusName={focus} />
}

function ReviewProductForm({ products, focusName }: { products: Map<string, Product>; focusName: string }) {
  const { t } = useI18n()
  const first = products.keys().next().value!
  const [chosen, setChosen] = useState(first)
  const source = products.has(chosen) ? chosen : first
  const [title, setTitle] = useState(() => deliverableName(products.get(first)!))
  const [focus, setFocus] = useState(focusName)
  const [what, setWhat] = useState('')
  const [context, setContext] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const lock = useRef(false)
  const retry = useRef<{ identity: string; id: string } | null>(null)
  const field = 'block min-h-10 w-full rounded-lg border bg-background px-3 py-1.5'
  return <details className="mt-3 rounded-lg border p-3"><summary className="cursor-pointer font-medium">{t('Add a deliverable to Review Stack')}</summary>
    <form className="mt-3 grid gap-3 text-sm" onSubmit={async event => {
      event.preventDefault()
      if (lock.current) return
      lock.current = true; setBusy(true); setFeedback('')
      const card = { key: source, source, focus, title, what, context }
      const identity = JSON.stringify(card)
      if (retry.current?.identity !== identity) retry.current = { identity, id: crypto.randomUUID() }
      try {
        const receipt = await sendReviewCards([card], retry.current.id)
        retry.current = null
        setFeedback(receipt.added ? t('Added to your Review Stack.') : t('This original is already in your Review Stack.'))
      } catch (error) { setFeedback(error instanceof Error ? error.message : t('Could not add this card. Try again.')) }
      finally { lock.current = false; setBusy(false) }
    }}>
      <fieldset className="grid gap-2" disabled={busy}>
        <label>{t('Original deliverable')}<select value={source} className={field} onChange={event => {
          const value = event.target.value; setChosen(value); setTitle(deliverableName(products.get(value)!)); setWhat(''); setContext(''); setFeedback('')
        }}>{Array.from(products, ([url, product]) => <option key={url} value={url}>{deliverableName(product)}</option>)}</select></label>
        <a className="break-all underline" href={source} target="_blank" rel="noreferrer">{source}</a>
        <label>{t('Focus area')}<input required value={focus} onChange={event => setFocus(event.target.value)} className={field} /></label>
        <label>{t('Title · 3–5 words')}<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} className={field} /></label>
        <label>{t('What it shows · 10–15 words')}<textarea required maxLength={360} value={what} onChange={event => setWhat(event.target.value)} className={field} /></label>
        <label>{t('Why it belongs here · 10–15 words')}<textarea required maxLength={360} value={context} onChange={event => setContext(event.target.value)} className={field} /></label>
      </fieldset>
      {feedback && <p role="status">{feedback}</p>}<Button type="submit" variant="outline" disabled={busy}>{t('Add to Review Stack')}</Button>
    </form>
  </details>
}
