/**
 * The viewer's one search rule, for "Find in loaded memories", "Find in this session", "Find a session" and "Find in
 * logs": true when every word of the query is somewhere in the text, in any case. An empty query matches everything.
 */
export function hasEveryWord(text: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = text.toLowerCase();
  return words.every(word => haystack.includes(word));
}
