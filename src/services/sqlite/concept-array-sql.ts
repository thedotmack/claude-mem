/**
 * SQL that reads `o.concepts` as a JSON array for `json_each`, whatever shape
 * the row holds: a JSON array as is, a JSON string or a legacy plain string
 * (rows written before concepts were normalized) wrapped as one element.
 * Non-JSON text is wrapped too, so a malformed value cannot fail the query.
 * Every concept filter uses this one expression, so the keyword reader and
 * context injection match the same rows (#6389).
 */
export const CONCEPT_ARRAY_JSON_SQL = `CASE WHEN json_valid(o.concepts) THEN CASE
    WHEN json_type(o.concepts) = 'array' THEN o.concepts
    WHEN json_type(o.concepts) = 'text' THEN json_array(json_extract(o.concepts, '$'))
    ELSE json_array(o.concepts) END ELSE json_array(o.concepts) END`;
