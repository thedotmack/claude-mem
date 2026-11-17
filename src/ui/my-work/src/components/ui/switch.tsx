"use client"

import * as React from "react"
import { cn } from "cn"
import { CheckIcon } from "lucide-react"
import { Switch as SwitchPrimitive } from "radix-ui"

/*
 * D b19: a 44×24px track (in px, so the thumb's travel matches at the 16px and 17px roots) with a ≥3:1 edge when off
 * (--control-edge) and the deep orange edge when on (≥3:1 on light surfaces, where the orange fill alone is 2.5:1).
 * On and off differ by position, colour and a check mark in the thumb (M394). The root is the hit area and ::before
 * draws the track, so on touch the root grows to 44px tall (touch-target-size, plan rule 6) while the track keeps
 * its look; on desktop expanded-hit-area takes presses across 44×44px. The focus ring sits on the track. `sm` keeps
 * its small look (K396). Disabled keeps pointer events so the not-allowed cursor shows (G16). A disabled switch
 * dims itself, except inside a Label, which dims the whole row once (the two halvings made it 25%).
 */
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full outline-none expanded-hit-area touch-target-size data-[size=default]:h-[24px] data-[size=default]:w-[44px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] data-disabled:cursor-not-allowed data-disabled:not-in-data-[slot=label]:opacity-50",
        "before:absolute before:top-1/2 before:left-0 before:-translate-y-1/2 before:rounded-full before:border before:transition-colors data-[size=default]:before:h-[24px] data-[size=default]:before:w-[44px] data-[size=sm]:before:h-[14px] data-[size=sm]:before:w-[24px]",
        "data-checked:before:border-primary-deep data-checked:before:bg-linear-to-b data-checked:before:from-primary-bright data-checked:before:to-primary-deep data-unchecked:before:border-control-edge data-unchecked:before:bg-input data-unchecked:before:shadow-[inset_0_1px_2px_rgb(74_46_20/0.12)] dark:data-unchecked:before:bg-input/80",
        "focus-visible:before:border-ring focus-visible:before:ring-3 focus-visible:before:ring-ring/50 group-has-[:focus-visible]/field-label:before:border-transparent group-has-[:focus-visible]/field-label:before:ring-0 aria-invalid:before:border-destructive aria-invalid:before:ring-3 aria-invalid:before:ring-destructive/20 dark:aria-invalid:before:border-destructive/50 dark:aria-invalid:before:ring-destructive/40",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none relative flex items-center justify-center rounded-full bg-white text-primary-foreground shadow-[0_1px_2px_rgb(40_24_10/0.25)] ring-0 transition-transform motion-reduce:transition-none group-data-[size=default]/switch:size-[18px] group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-unchecked:translate-x-[3px] group-data-[size=default]/switch:data-checked:translate-x-[23px] group-data-[size=sm]/switch:data-unchecked:translate-x-px group-data-[size=sm]/switch:data-checked:translate-x-[11px] dark:data-unchecked:bg-muted-foreground"
      >
        <CheckIcon data-slot="switch-check" aria-hidden="true" strokeWidth={3} className="opacity-0 group-data-[size=default]/switch:size-3 group-data-[size=sm]/switch:size-2 group-data-[state=checked]/switch:opacity-100" />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  )
}

export { Switch }
