import { getLocale } from '../../i18n';

export function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleString(getLocale());
}
