export const FILE_CONTENT_TYPES: Readonly<Record<string, string>>;
/** The kind of a local file a person would open (image, video, document, deck, spreadsheet, page), or null for code and data. */
export function fileKind(path: string): string | null;
/** A work-state field that names work product: work_product(s), deliverable(s), or any *_url field. */
export function isWorkProductField(field: string): boolean;
/** True for an absolute path on this platform with no `..` part. */
export function isLocalPath(value: unknown): boolean;
/** The bucket copy a `deliverables` row records, as a work product that opens through /api/deliverables/:id/:filename. */
export function productsFromDeliverable(row: {
  id: number; title?: string | null; kind?: string | null; bucket_path: string; source_path?: string | null; created_at_epoch?: number | null;
}): Array<Record<string, unknown>>;
