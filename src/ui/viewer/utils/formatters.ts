
export function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleString();
}
