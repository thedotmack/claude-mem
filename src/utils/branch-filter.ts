export interface BranchFilterResult {
  sql: string;
  params: any[];
}

export function buildBranchFilter(
  branches?: string[] | null,
  tableAlias?: string
): BranchFilterResult {
  if (!branches || branches.length === 0) {
    return { sql: '', params: [] };
  }
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const placeholders = branches.map(() => '?').join(',');
  return {
    sql: `AND (${prefix}branch IS NULL OR ${prefix}branch IN (${placeholders}))`,
    params: [...branches]
  };
}
