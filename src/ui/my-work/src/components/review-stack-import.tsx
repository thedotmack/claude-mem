import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { interpolate, useI18n } from '@/lib/i18n'
import { reviewStackThumbnail } from '@/lib/review-stack-thumbnail'
import { importReviewManifest, readReviewManifest, type ReviewImport } from '@/live/review-stack-import'

export function ImportReviewCards({ close, onImported }: { close: () => void; onImported: () => void }) {
  const { t } = useI18n()
  const [files, setFiles] = useState<File[]>([])
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const job = useRef<ReviewImport | undefined>(undefined)
  const lock = useRef(false)
  async function importCards() {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const pending = job.current ??= await readReviewManifest(files)
      const update = () => setProgress(interpolate(t('{processed} of {total} processed · {added} added · {existing} already in your stack'), {
        processed: pending.offset, total: pending.cards.length, added: pending.added, existing: pending.existing,
      }))
      update()
      await importReviewManifest(pending, update, reviewStackThumbnail)
      setDone(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('Import failed. Try again.')) }
    finally { if (job.current?.offset) onImported(); lock.current = false; setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close() }}>
    <DialogContent showCloseButton={!busy} className="sm:max-w-md">
      <DialogHeader><DialogTitle>{t('Import review cards')}</DialogTitle>
        <DialogDescription>{t('Choose cards.json from your deck. Select any images it names alongside it.')}</DialogDescription></DialogHeader>
      {!done && <label className="space-y-1"><span>{t('Manifest and images')}</span>
        <input type="file" multiple disabled={busy} accept=".json,.png,.jpg,.jpeg,.webp,.gif" className="block w-full text-sm" onChange={event => {
          setFiles(Array.from(event.target.files ?? [])); job.current = undefined; setProgress(''); setError('')
        }} /></label>}
      {progress && <p role="status">{progress}</p>}{error && <p role="alert" className="text-destructive">{error}</p>}
      {done ? <Button onClick={close}>{t('View cards')}</Button> : <Button disabled={!files.length || busy} onClick={() => void importCards()}>
        {busy ? t('Importing…') : error && job.current ? t('Retry remaining cards') : t('Import cards')}</Button>}
    </DialogContent>
  </Dialog>
}
