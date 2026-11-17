import * as React from "react"
import { cn } from "cn"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { assignRef, rememberMenuOpener } from "./interaction-behavior"

/**
 * The element that opens a menu (the trigger, or a sub-menu's row), shared with that menu's content, which records it:
 * a dialog opened from one of the menu's items returns focus to it when it closes (D b8), as the item itself is gone.
 */
const MenuOpenerContext = React.createContext<{
  openerRef: React.RefObject<HTMLElement | null>
  setOpener: (element: HTMLElement | null) => void
} | null>(null)

/** One menu's opener record; DropdownMenu and DropdownMenuSub each keep their own. */
function useMenuOpenerRecord() {
  const openerRef = React.useRef<HTMLElement | null>(null)
  return React.useMemo(() => ({
    openerRef,
    setOpener: (element: HTMLElement | null) => { openerRef.current = element },
  }), [])
}

function useMenuOpenerRef<T extends HTMLElement>(ref: React.Ref<T> | undefined) {
  const record = React.useContext(MenuOpenerContext)
  return React.useCallback((element: T | null) => {
    record?.setOpener(element)
    assignRef(ref, element)
  }, [record, ref])
}

function useMenuContentRef<T extends HTMLElement>(ref: React.Ref<T> | undefined) {
  const record = React.useContext(MenuOpenerContext)
  return React.useCallback((element: T | null) => {
    if (element && record) rememberMenuOpener(element, record.openerRef)
    assignRef(ref, element)
  }, [record, ref])
}

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const opener = useMenuOpenerRecord()
  return (
    <MenuOpenerContext.Provider value={opener}>
      <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
    </MenuOpenerContext.Provider>
  )
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return (
    <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
  )
}

function DropdownMenuTrigger({
  ref,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  const setOpener = useMenuOpenerRef(ref)
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      ref={setOpener}
      {...props}
    />
  )
}

function DropdownMenuContent({
  className,
  align = "start",
  sideOffset = 4,
  ref,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const setContent = useMenuContentRef(ref)
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        ref={setContent}
        sideOffset={sideOffset}
        align={align}
        className={cn("z-50 max-h-(--radix-dropdown-menu-content-available-height) max-w-(--radix-dropdown-menu-content-available-width) min-w-[max(8rem,var(--radix-dropdown-menu-trigger-width))] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-popover duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", className )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

/**
 * One menu row (D b9). 40px tall on desktop (M 191: text line plus py-2.5), 44px on touch (touch-target-size), the
 * pointer cursor, and a highlight clearly apart from the menu (M 192): the --input fill Select rows use, edged in
 * --muted-foreground. The fill alone is 1.41:1 (light) and 1.51:1 (dark) against the menu, where the old accent fill
 * was 1.09:1; the edge is the mark, ≥5.3:1 against the menu and ≥3.7:1 against the fill in both themes (token contrast
 * test, rule 7). Text on the fill is ≥9:1, and a row's hint turns to the text colour with it. Disabled rows keep
 * pointer events so the not-allowed cursor shows (G16).
 */
const MENU_ROW_CLASS_NAME =
  "relative flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-2.5 text-sm outline-hidden select-none touch-target-size focus:bg-input focus:text-foreground focus:inset-ring focus:inset-ring-muted-foreground data-inset:pl-7 data-disabled:cursor-not-allowed data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  )
}

/** `hint`: one short line saying what the action does ("moves to Past focus"), at the row's right end (D b9 M 193). */
function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  hint,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
  hint?: React.ReactNode
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        MENU_ROW_CLASS_NAME,
        "group/dropdown-menu-item not-data-[variant=destructive]:focus:**:text-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/15 data-[variant=destructive]:*:[svg]:text-destructive",
        className
      )}
      {...props}
    >
      {children}
      {hint !== undefined && hint !== null && (
        <span data-slot="dropdown-menu-item-hint" className="ml-auto pl-4 text-xs text-muted-foreground">
          {hint}
        </span>
      )}
    </DropdownMenuPrimitive.Item>
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        MENU_ROW_CLASS_NAME,
        "pr-8 focus:**:text-foreground",
        className
      )}
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon
          />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        MENU_ROW_CLASS_NAME,
        "pr-8 focus:**:text-foreground",
        className
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon
          />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1.5 my-1.5 h-px bg-border", className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  const opener = useMenuOpenerRecord()
  return (
    <MenuOpenerContext.Provider value={opener}>
      <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
    </MenuOpenerContext.Provider>
  )
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ref,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  const setOpener = useMenuOpenerRef(ref)
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      ref={setOpener}
      data-inset={inset}
      className={cn(
        MENU_ROW_CLASS_NAME,
        "focus:**:text-foreground data-open:bg-input data-open:text-foreground data-open:inset-ring data-open:inset-ring-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const setContent = useMenuContentRef(ref)
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      ref={setContent}
      className={cn("z-50 min-w-[96px] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-popover duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", className )}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
