// SPDX-License-Identifier: Apache-2.0
//
// Bounded tail read of a log file. Shared by the worker's LogsRoutes and the
// server runtime's viewer routes, so neither pulls the other's route module.

import { openSync, fstatSync, readSync, closeSync } from 'fs';

export function readLastLines(filePath: string, lineCount: number): { lines: string; totalEstimate: number } {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize === 0) {
      return { lines: '', totalEstimate: 0 };
    }

    const INITIAL_CHUNK_SIZE = 64 * 1024; 
    const MAX_READ_SIZE = 10 * 1024 * 1024; 

    let readSize = Math.min(INITIAL_CHUNK_SIZE, fileSize);
    let content = '';
    let newlineCount = 0;

    while (readSize <= fileSize && readSize <= MAX_READ_SIZE) {
      const startPosition = Math.max(0, fileSize - readSize);
      const bytesToRead = fileSize - startPosition;
      const buffer = Buffer.alloc(bytesToRead);
      readSync(fd, buffer, 0, bytesToRead, startPosition);
      content = buffer.toString('utf-8');

      newlineCount = 0;
      for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') newlineCount++;
      }

      // A trailing newline terminates the last line; it is not the boundary
      // before the first requested line when the chunk starts mid-line.
      const requiredNewlines = lineCount + (content.endsWith('\n') ? 1 : 0);
      if (newlineCount >= requiredNewlines || startPosition === 0 || readSize === MAX_READ_SIZE) {
        break;
      }

      readSize = Math.min(readSize * 2, fileSize, MAX_READ_SIZE);
    }

    const allLines = content.split('\n');
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }

    const startIndex = Math.max(0, allLines.length - lineCount);
    const resultLines = allLines.slice(startIndex);

    let totalEstimate: number;
    if (fileSize <= readSize) {
      totalEstimate = allLines.length;
    } else {
      const avgLineLength = content.length / Math.max(newlineCount, 1);
      totalEstimate = Math.round(fileSize / avgLineLength);
    }

    return {
      lines: resultLines.join('\n'),
      totalEstimate,
    };
  } finally {
    closeSync(fd);
  }
}
