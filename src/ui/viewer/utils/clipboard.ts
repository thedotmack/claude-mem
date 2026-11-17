/**
 * Copy text to the clipboard. Resolves null once it is copied, or the reason it
 * was not: an Error whose `cause` is what the browser threw (no clipboard
 * permission, not a secure context), so the caller can say "Copy failed" and
 * still record why.
 */
export async function copyText(text: string): Promise<Error | null> {
  let refused: unknown = null;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return null;
    } catch (error) {
      // Kept as the cause; the selection-based copy below may still work.
      refused = error;
    }
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  try {
    if (document.execCommand('copy')) return null;
    return new Error('The browser refused to copy the text.', { cause: refused });
  } catch (error) {
    return new Error('The browser refused to copy the text.', { cause: refused ?? error });
  } finally {
    field.remove();
  }
}
