export function formatStarCount(count: number): string {
  if (count < 1000) {
    return count.toString();
  }

  if (count < 1000000) {
    const thousands = count / 1000;
    return `${thousands.toFixed(1)}k`;
  }

  const millions = count / 1000000;
  return `${millions.toFixed(1)}M`;
}
