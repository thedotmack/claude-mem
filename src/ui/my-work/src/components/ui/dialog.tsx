"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Dialog as DialogPrimitive } from "radix-ui"
import { useControllableState } from "@radix-ui/react-use-controllable-state"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n"
import { XIcon } from "lucide-react"
import { assignRef, useReturnFocusToOpener } from "./interaction-behavior"

/**
 * Asking before typed text is dropped (D b8 M 173). DialogContent says whether it holds unsaved text; any way of
 * closing (Escape, the corner X, a click outside, a Cancel button) then asks first instead of closing.
 */
const DialogDiscardGuardContext = React.createContext<{
  setHasUnsavedText: (hasUnsavedText: boolean) => void
  confirmingDiscard: boolean
  keepEditing: () => void
  discardAndClose: () => void
} | null>(null)

function Dialog({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
    caller: "Dialog",
  })
  const hasUnsavedTextRef = React.useRef(false)
  const [confirmingDiscard, setConfirmingDiscard] = React.useState(false)
  // The parent closed the dialog itself (a save, its own Cancel, a route change): the question goes with it, so a
  // reopened dialog never starts by asking. Set while rendering, React's way to follow a prop.
  if (!open && confirmingDiscard) setConfirmingDiscard(false)
  const requestOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen && hasUnsavedTextRef.current) {
      setConfirmingDiscard(true)
      return
    }
    setConfirmingDiscard(false)
    setOpen(nextOpen)
  }, [setOpen])
  const setHasUnsavedText = React.useCallback((hasUnsavedText: boolean) => {
    hasUnsavedTextRef.current = hasUnsavedText
  }, [])
  const discardGuard = React.useMemo(() => ({
    setHasUnsavedText,
    confirmingDiscard,
    keepEditing: () => setConfirmingDiscard(false),
    discardAndClose: () => {
      hasUnsavedTextRef.current = false
      setConfirmingDiscard(false)
      setOpen(false)
    },
  }), [confirmingDiscard, setHasUnsavedText, setOpen])
  return (
    <DialogDiscardGuardContext.Provider value={discardGuard}>
      <DialogPrimitive.Root data-slot="dialog" open={open} onOpenChange={requestOpenChange} {...props} />
    </DialogDiscardGuardContext.Provider>
  )
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

/**
 * Dims the page and does not blur it (D b8 M 172): the page stays readable behind, and the dialog's ≥3:1 edge carries
 * the separation. The dim is the --overlay-dim token (index.css), stronger in dark mode.
 */
function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-overlay-dim duration-100 motion-safe:data-open:animate-in data-open:fade-in-0 motion-safe:data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

/** Fields a person types into: where "Keep editing" puts them back. */
function isTextEntry(element: EventTarget | null): element is HTMLElement {
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLInputElement) return !NOT_TEXT_INPUT_TYPES.has(element.type)
  return element instanceof HTMLElement && element.isContentEditable
}
const NOT_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"])

/**
 * `hasUnsavedText`: true while the dialog holds text the person typed and has not saved; closing then asks first, and
 * "Keep editing" puts focus back in the field they last typed in. Focus returns to whatever opened the dialog
 * (D b8 M 173), even when that was a plain button or a menu item, not a DialogTrigger.
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  hasUnsavedText = false,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onFocus,
  ref,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  hasUnsavedText?: boolean
}) {
  const { t } = useI18n()
  const discardGuard = React.useContext(DialogDiscardGuardContext)
  const setHasUnsavedText = discardGuard?.setHasUnsavedText
  const focusReturn = useReturnFocusToOpener({ onOpenAutoFocus, onCloseAutoFocus })
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const setContentElement = React.useCallback((element: HTMLDivElement | null) => {
    contentRef.current = element
    assignRef(ref, element)
  }, [ref])
  const lastTextEntryRef = React.useRef<HTMLElement | null>(null)
  const keepEditing = () => {
    const field = lastTextEntryRef.current?.isConnected ? lastTextEntryRef.current
      : Array.from(contentRef.current?.querySelectorAll<HTMLElement>("input, textarea, [contenteditable]") ?? []).find(isTextEntry)
    // Focus moves before the question unmounts, so it never drops to the dialog itself.
    field?.focus()
    discardGuard?.keepEditing()
  }
  React.useLayoutEffect(() => {
    if (!setHasUnsavedText) return
    setHasUnsavedText(hasUnsavedText)
    return () => setHasUnsavedText(false)
  }, [setHasUnsavedText, hasUnsavedText])
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        ref={setContentElement}
        onOpenAutoFocus={focusReturn.onOpenAutoFocus}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        onFocus={(event) => {
          onFocus?.(event)
          if (isTextEntry(event.target)) lastTextEntryRef.current = event.target
        }}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl border border-control-edge bg-popover p-6 text-sm text-popover-foreground shadow-popover duration-100 outline-none sm:max-w-sm motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        {discardGuard?.confirmingDiscard && (
          <div
            data-slot="dialog-discard-confirmation"
            role="alert"
            className="flex flex-wrap items-center justify-end gap-2 rounded-xl border border-control-edge bg-surface p-3"
          >
            <p className="mr-auto">{t('Discard what you typed?')}</p>
            <Button variant="outline" autoFocus onClick={keepEditing}>{t('Keep editing')}</Button>
            <Button variant="destructive" onClick={discardGuard.discardAndClose}>{t('Discard')}</Button>
          </div>
        )}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="outline"
              className="absolute top-3 right-3"
              size="icon"
            >
              <XIcon
              />
              <span className="sr-only">{t('Close')}</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

/** Leaves room on the right for the 44px close button. */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 pr-12", className)}
      {...props}
    />
  )
}

/** `showCloseButton` adds Cancel beside the dialog's one primary action (D b8 M 170). */
function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  const { t } = useI18n()
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-6 -mb-6 flex flex-col-reverse gap-2 rounded-b-2xl border-t bg-surface/70 px-6 py-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">{t('Cancel')}</Button>
        </DialogPrimitive.Close>
      )}
      {children}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
