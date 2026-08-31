export function chunkText(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new RangeError(`maxChars must be a positive integer, got ${maxChars}`);
  }

  const paragraphs = text.split('\n\n').map(paragraph => paragraph.trim()).filter(paragraph => paragraph.length > 0);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += maxChars) {
        chunks.push(paragraph.slice(offset, offset + maxChars));
      }
      continue;
    }
    const packedLength = current.length === 0 ? paragraph.length : current.length + 2 + paragraph.length;
    if (packedLength > maxChars) {
      flush();
    }
    current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
  }

  flush();
  return chunks;
}
