// A long choice as a searchable list (plan decision G15, D b16 M 333): Popover + Command, the shadcn combobox pattern,
// with group labels and a count. Move to… (31 focus areas on real data) and the reply card's conversation picker past
// SEARCHABLE_CHOICES_AFTER conversations use it; a short choice stays a Select.
import { Fragment, useState, type ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** G15: "Long, searchable choices (Move to…, 31 areas; any list over ~10) use Popover + Command." Ten or fewer stay a Select. */
export const SEARCHABLE_CHOICES_AFTER = 10

/** One choice: what it says, and the words a search finds it by (its value is never shown or searched). */
export interface SearchableChoice { value: string; label: ReactNode; searchWords: string[] }

/** A labelled group of choices ("Your focus areas", "Suggested"). A group with no heading lists its choices plainly. */
export interface SearchableChoiceGroup { heading?: string; choices: SearchableChoice[] }

/**
 * A choice matches when one of its search words contains what was typed, ignoring case. cmdk's own scoring also matches
 * the value (an area id, a session id) and scattered letters, so a search for a name would keep unrelated rows.
 */
const matchesSearchWords = (_value: string, search: string, searchWords: string[] = []) =>
  searchWords.some((words) => words.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ? 1 : 0

/**
 * The trigger is an outlined Button (36px at the desktop size, 44px on touch by the Button's own rule, rule 6) that
 * shows `trigger`; give it an id and put a visible label beside it with htmlFor (F 270). The list opens in a modal
 * popover: inside the request drawer, which is itself modal, only the topmost layer may scroll, so a non-modal list
 * there could not be scrolled with a wheel. `countLine` sits under the list ("31 areas · type to narrow").
 * The trigger is one line, so words too long for it are cut there: `triggerTitle` gives them whole as its hover text,
 * and a screen reader hears them too (rule 5: a cut says what it hides; fix round L5). In the list, choices wrap whole.
 */
export function SearchablePicker({ id, trigger, triggerTitle, groups, chosenValue, onChoose, searchPlaceholder, nothingFound, countLine, cannotChoose = false, className }: {
  id?: string
  trigger: ReactNode
  /** The trigger's words in full, when they can be longer than its line. */
  triggerTitle?: string
  groups: SearchableChoiceGroup[]
  chosenValue?: string | null
  onChoose: (value: string) => void
  searchPlaceholder: string
  nothingFound: string
  countLine?: ReactNode
  /** A choice is saving: the trigger stays focusable and says so, and does not open (G16, aria-disabled). */
  cannotChoose?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const shownGroups = groups.filter((group) => group.choices.length > 0)
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" size="sm" title={triggerTitle} aria-disabled={cannotChoose || undefined}
          className={cn('min-w-0 justify-between gap-2 font-normal', className)}>
          <span className="min-w-0 truncate">{trigger}</span>
          <ChevronDownIcon aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <Command filter={matchesSearchWords}>
          <CommandInput placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{nothingFound}</CommandEmpty>
            {shownGroups.map((group, index) => (
              <Fragment key={group.heading ?? index}>
                {index > 0 && <CommandSeparator />}
                <CommandGroup heading={group.heading}>
                  {group.choices.map((choice) => (
                    <CommandItem key={choice.value} value={choice.value} keywords={choice.searchWords} data-checked={choice.value === chosenValue}
                      onSelect={() => { setOpen(false); onChoose(choice.value) }}>
                      <span className="min-w-0 flex-1 break-words">{choice.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </Fragment>
            ))}
          </CommandList>
          {countLine && <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground tabular">{countLine}</p>}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
