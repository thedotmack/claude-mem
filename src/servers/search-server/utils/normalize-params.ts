/**
 * Helper to normalize query parameters from URL-friendly format
 * Converts comma-separated strings to arrays and flattens date params
 */
export function normalizeParams(args: any): any {
  const normalized: any = { ...args };

  // Parse comma-separated concepts into array
  if (normalized.concepts && typeof normalized.concepts === 'string') {
    normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  // Parse comma-separated files into array
  if (normalized.files && typeof normalized.files === 'string') {
    normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  // Parse comma-separated obs_type into array
  if (normalized.obs_type && typeof normalized.obs_type === 'string') {
    normalized.obs_type = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  // Parse comma-separated type (for filterSchema) into array
  if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
    normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  // Flatten dateStart/dateEnd into dateRange object
  if (normalized.dateStart || normalized.dateEnd) {
    normalized.dateRange = {
      start: normalized.dateStart,
      end: normalized.dateEnd
    };
    delete normalized.dateStart;
    delete normalized.dateEnd;
  }

  return normalized;
}
