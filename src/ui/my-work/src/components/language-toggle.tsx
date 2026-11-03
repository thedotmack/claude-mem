import { Languages } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SUPPORTED_LANGUAGES, type Language } from '@/i18n'
import { useTranslation } from '@/i18n/use-translation'
import { cn } from '@/lib/utils'

interface LanguageToggleProps {
  className?: string
  variant?: 'header' | 'banner'
}

export function LanguageToggle({ className, variant = 'header' }: LanguageToggleProps) {
  const { language, setLanguage, t } = useTranslation()

  const current = SUPPORTED_LANGUAGES.find((lang) => lang.id === language) ?? SUPPORTED_LANGUAGES[0]

  const toggle = () => {
    const next: Language = language === 'zh-CN' ? 'en' : 'zh-CN'
    setLanguage(next)
  }

  if (variant === 'banner') {
    return (
      <div className={cn('flex items-center gap-1.5', className)}>
        <Languages className="size-3 text-muted-foreground" />
        <button
          type="button"
          onClick={toggle}
          aria-label={t('header.language')}
          title={language === 'zh-CN' ? 'Switch to English' : '切换为简体中文'}
          className="text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
        >
          {current.shortLabel}
        </button>
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-7 gap-1.5 px-2 text-xs', className)}
          aria-label={t('header.language')}
          title={language === 'zh-CN' ? '切换语言 / Switch language' : 'Switch language / 切换语言'}
        >
          <Languages className="size-3.5" />
          <span className="hidden sm:inline">{current.label}</span>
          <span className="sm:hidden">{current.shortLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-32">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.id}
            onClick={() => setLanguage(lang.id)}
            className={cn('cursor-pointer text-xs justify-between', language === lang.id && 'font-semibold text-primary')}
          >
            <span>{lang.label}</span>
            {language === lang.id && <span className="text-[10px] text-muted-foreground">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
