// "‹ Workspace" above a page's title (Codex's `.crumbs`): the one page it was reached from, one press back. A real link,
// so it opens in a new tab and can be copied; a plain press moves there in the page.
import { ChevronLeftIcon } from 'lucide-react'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList } from '@/components/ui/breadcrumb'
import { useI18n } from '@/lib/i18n'
import { placeLinkPress, usePageHref } from '@/lib/place-link'
import { useStore, type Section } from '@/store'
import { pageHeading } from './app-bar'

export function PageCrumb({ to }: { to: Section }) {
  const { t } = useI18n()
  const href = usePageHref(to)
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
          <BreadcrumbLink href={href} onClick={placeLinkPress(() => useStore.getState().goToPage(to))}>{pageHeading(to, t)}</BreadcrumbLink>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}
