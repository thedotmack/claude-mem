import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useStore } from '@/store'
import { REQUIREMENTS_BY_ID } from './requirements'


/**
 * Tags a wireframe element with the spec requirements it satisfies.
 * `npm run coverage` reads these ids from the source; the Spec overlay shows them on screen.
 */
export function Req({ ids, children, className }: { ids: string[]; children: ReactNode; className?: string }) {
  const showSpec = useStore((state) => state.view.showSpec)
  for (const id of ids) if (!REQUIREMENTS_BY_ID.has(id)) throw new Error(`Unknown requirement id ${id}`)
  // A wrapper element would break parent spacing (space-y, grid), so tags are invisible until the overlay is on.
  if (!showSpec) return <>{children}</>
  return (
    <div className={cn('relative rounded-md outline outline-1 outline-dashed outline-sky-500/70', className)} data-req={ids.join(' ')}>
      <div className="absolute -top-2.5 right-1 z-20 flex gap-0.5">
        {ids.map((id) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <span className="cursor-help rounded bg-sky-600 px-1 font-mono text-[10px] leading-4 text-white">{id}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              §{REQUIREMENTS_BY_ID.get(id)!.section}: {REQUIREMENTS_BY_ID.get(id)!.text}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      {children}
    </div>
  )
}
