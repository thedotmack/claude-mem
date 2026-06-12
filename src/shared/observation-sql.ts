// SPDX-License-Identifier: Apache-2.0

import { NO_OP_OBSERVATION_TEXT_EXAMPLES } from './observation-content.js';

const SQL_NO_OP_TEXTS = NO_OP_OBSERVATION_TEXT_EXAMPLES.flatMap(text => [text, `${text}.`]);
const SQL_NO_OP_LIST = SQL_NO_OP_TEXTS.map(text => `'${text.replace(/'/g, "''")}'`).join(', ');

function normalizedSqlText(field: string): string {
  return `lower(trim(replace(replace(replace(coalesce(${field}, ''), char(13), ' '), char(10), ' '), char(9), ' ')))`;
}

function jsonTextArrayIsEmpty(field: string): string {
  return `(trim(coalesce(${field}, '[]')) = '' OR trim(coalesce(${field}, '[]')) = '[]')`;
}

export function durableObservationWhere(alias: string = 'o'): string {
  const title = `${alias}.title`;
  const subtitle = `${alias}.subtitle`;
  const text = `${alias}.text`;
  const narrative = `${alias}.narrative`;
  const facts = `${alias}.facts`;
  const concepts = `${alias}.concepts`;

  return `(
    (
      nullif(trim(coalesce(${title}, '')), '') IS NOT NULL
      OR nullif(trim(coalesce(${subtitle}, '')), '') IS NOT NULL
      OR nullif(trim(coalesce(${text}, '')), '') IS NOT NULL
      OR nullif(trim(coalesce(${narrative}, '')), '') IS NOT NULL
      OR NOT ${jsonTextArrayIsEmpty(facts)}
      OR NOT ${jsonTextArrayIsEmpty(concepts)}
    )
    AND NOT (
      ${jsonTextArrayIsEmpty(facts)}
      AND ${jsonTextArrayIsEmpty(concepts)}
      AND (
        ${normalizedSqlText(title)} = ''
        OR ${normalizedSqlText(title)} IN (${SQL_NO_OP_LIST})
      )
      AND (
        ${normalizedSqlText(subtitle)} = ''
        OR ${normalizedSqlText(subtitle)} IN (${SQL_NO_OP_LIST})
      )
      AND (
        ${normalizedSqlText(text)} = ''
        OR ${normalizedSqlText(text)} IN (${SQL_NO_OP_LIST})
      )
      AND (
        ${normalizedSqlText(narrative)} = ''
        OR ${normalizedSqlText(narrative)} IN (${SQL_NO_OP_LIST})
      )
      AND (
        ${normalizedSqlText(title)} != ''
        OR ${normalizedSqlText(subtitle)} != ''
        OR ${normalizedSqlText(text)} != ''
        OR ${normalizedSqlText(narrative)} != ''
      )
    )
  )`;
}
