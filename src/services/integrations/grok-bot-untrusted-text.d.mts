export declare function stripUnsafeChars(value: unknown): string;
export declare function sanitizeUntrustedText(value: unknown): string;
export declare function truncateCodePoints(value: string, maxChars: number): string;
export declare function fencedLine(lead: string, recalled: unknown, maxChars: number): string;
export interface RecalledObservation {
  type: string;
  title?: string | null;
  subtitle?: string | null;
  facts?: readonly string[] | null;
}
export declare function formatRecalledObservationLine(
  tag: string,
  observation: RecalledObservation,
  now: Date,
  maxChars: number,
): string;
