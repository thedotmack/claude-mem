import { interpolate } from './i18n/locale'

/** Only explicit UI messages are translated; string parameters are always verbatim. */
export interface UiMessage {
  source: string
  values?: Record<string, string | number | UiMessage>
}

export function uiMessage(source: string, values?: UiMessage['values']): UiMessage {
  return { source, values }
}

export function renderUiMessage(message: UiMessage | string, t: (source: string) => string): string {
  if (typeof message === 'string') return message
  const values = Object.fromEntries(Object.entries(message.values ?? {}).map(([key, value]) =>
    [key, typeof value === 'object' ? renderUiMessage(value, t) : value]))
  return interpolate(t(message.source), values)
}
