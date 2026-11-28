import { createCn } from "cn/config"

/**
 * The font sizes index.css adds to Tailwind's (each `--text-<name>` in its @theme). cn() must know them: it reads a
 * `text-<name>` it does not know as a colour, so `cn('text-muted-foreground', 'text-place')` dropped the colour (design
 * pass Phase 3: the bar's places drew in full ink, not muted). tests/ui/my-work/class-merge.test.ts checks this list
 * against index.css, so a new size there fails until it is added here.
 */
export const CUSTOM_FONT_SIZES = ["page-title", "page-title-phone", "place", "place-narrow", "brand", "brand-phone"] as const

/**
 * Joins class names and resolves Tailwind conflicts (the later class wins), knowing this app's own font sizes. Every
 * component takes it from here, not from the `cn` package (the same test checks that), so all of them merge alike.
 */
export const cn = createCn({ extend: { classGroups: { "font-size": [{ text: [...CUSTOM_FONT_SIZES] }] } } })
