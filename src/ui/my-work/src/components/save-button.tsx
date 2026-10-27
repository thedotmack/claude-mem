import type { ComponentProps } from 'react'
import { StatefulButton } from '@/components/aceternity/stateful-button'
import { cn } from '@/lib/utils'

/**
 * A save you can watch: the button spins while its async onClick runs, then shows a check once it resolves.
 * An onClick that resolves false failed and rendered its own error, so no check shows; a throw also shows no check.
 * The Aceternity green pill (background and white text) is reset here so the caller's own look (shadcn variants or setup CSS) applies,
 * and the spinner and check take the button's text color.
 */
export function SaveButton({ className, ...props }: ComponentProps<typeof StatefulButton>) {
  return <StatefulButton className={cn('min-w-0 bg-transparent py-0 text-current ring-offset-0 hover:ring-0 [&_svg]:text-current', className)} {...props} />
}
