"use strict";

function parseFileList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch (error) {
    return [value];
  }
}

module.exports = { parseFileList };
