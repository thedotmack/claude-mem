import * as React from "react"
import { cn } from "cn"
import { Label as LabelPrimitive } from "radix-ui"
import { useI18n } from "@/lib/i18n"

/*
 * One field-label size, 14px medium at the 16px root (D b13 M272), and the hand cursor, since a click on a label
 * moves to its control (F266). A label wrapped around a switch shares one hit area with it, at least 44px tall
 * (M273): <Label><Switch /> Dark</Label>. `optional` and `required` draw the one shared mark (M274): the word
 * "optional" in muted text, or an asterisk that screen readers hear as "required" (also set required or
 * aria-required on the control itself). Disabled keeps pointer events so the not-allowed cursor shows (G16).
 */
function Label({
  className,
  optional = false,
  required = false,
  children,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & { optional?: boolean; required?: boolean }) {
  const { t } = useI18n()
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex cursor-pointer items-center gap-2 text-sm leading-none font-medium select-none has-data-[slot=switch]:min-h-11 group-data-[disabled=true]:cursor-not-allowed group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 has-disabled:cursor-not-allowed has-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
      {optional && <span data-slot="label-optional" className="font-normal text-muted-foreground">{t("optional")}</span>}
      {required && (
        <>
          <span data-slot="label-required" aria-hidden="true" className="text-destructive">*</span>
          <span className="sr-only">{t("required")}</span>
        </>
      )}
    </LabelPrimitive.Root>
  )
}

export { Label }
