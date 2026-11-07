/** Keep bounded UTF-16 head/tail excerpts without cutting a surrogate pair. */
export function retainTextHeadTail(text: string, headChars: number, tailChars: number): { head: string; tail: string } {
  let headEnd = Math.min(text.length, Math.max(0, Math.floor(headChars)));
  let tailStart = Math.max(headEnd, text.length - Math.max(0, Math.floor(tailChars)));
  const splitsPair = (offset: number): boolean => {
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  };
  if (splitsPair(headEnd)) headEnd--;
  if (splitsPair(tailStart)) tailStart++;
  return { head: text.slice(0, headEnd), tail: text.slice(tailStart) };
}
