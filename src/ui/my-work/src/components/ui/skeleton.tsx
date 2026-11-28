import { cn } from "@/lib/utils"

/**
 * The shape of content that is still loading (D b18 M 373: waits over a second show the page's shape, not a lone
 * ring). shadcn registry source; the fill is 10% of the text colour so the shapes show on the card in both themes
 * (the registry's bg-muted is 1.1:1 on the dark card), the pulse runs only when motion is allowed, and it is hidden
 * from screen readers: the region around it says it is loading (aria-busy and a status line).
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("rounded-md bg-foreground/10 motion-safe:animate-pulse", className)}
      {...props}
    />
  )
}

export { Skeleton }
