/**
 * Shared path utilities for CLAUDE.md file generation
 *
 * These utilities handle path normalization and matching, particularly
 * for comparing absolute and relative paths in folder CLAUDE.md generation.
 *
 * @see Issue #794 - Path format mismatch causes folder CLAUDE.md files to show "No recent activity"
 */

/**
 * Normalize path separators to forward slashes, collapse consecutive slashes,
 * and remove trailing slashes.
 *
 * @example
 * normalizePath('app\\api\\router.py') // 'app/api/router.py'
 * normalizePath('app//api///router.py') // 'app/api/router.py'
 * normalizePath('app/api/') // 'app/api'
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
}

/**
 * Check if a file is a direct child of a folder (not in a subfolder).
 *
 * Handles path format mismatches where folderPath may be absolute but
 * filePath is stored as relative in the database.
 *
 * NOTE: This uses suffix matching which assumes both paths are relative to
 * the same project root. It may produce false positives if used across
 * different project roots, but this is mitigated by project-scoped queries.
 *
 * @param filePath - Path to the file (e.g., "app/api/router.py" or "/Users/x/project/app/api/router.py")
 * @param folderPath - Path to the folder (e.g., "app/api" or "/Users/x/project/app/api")
 * @returns true if file is directly in folder, false if in a subfolder or different folder
 *
 * @example
 * // Same format (both relative)
 * isDirectChild('app/api/router.py', 'app/api') // true
 * isDirectChild('app/api/v1/router.py', 'app/api') // false (in subfolder)
 *
 * @example
 * // Mixed format (absolute folder, relative file) - fixes #794
 * isDirectChild('app/api/router.py', '/Users/dev/project/app/api') // true
 */
export function isDirectChild(filePath: string, folderPath: string): boolean {
  const normFile = normalizePath(filePath);
  const normFolder = normalizePath(folderPath);

  // Strategy 1: Direct prefix match (both paths in same format)
  if (normFile.startsWith(normFolder + '/')) {
    const remainder = normFile.slice(normFolder.length + 1);
    return !remainder.includes('/');
  }

  // Strategy 2: Handle absolute folderPath with relative filePath
  // e.g., folderPath="/Users/x/project/app/api" and filePath="app/api/router.py"
  const folderSegments = normFolder.split('/');
  const fileSegments = normFile.split('/');

  if (fileSegments.length < 2) return false; // Need at least folder/file

  const fileDir = fileSegments.slice(0, -1).join('/'); // Directory part of file
  const fileName = fileSegments[fileSegments.length - 1]; // Actual filename

  // Check if folder path ends with the file's directory path
  if (normFolder.endsWith('/' + fileDir) || normFolder === fileDir) {
    // File is a direct child (no additional subdirectories)
    return !fileName.includes('/');
  }

  // Check if file's directory is contained at the end of folder path
  // by progressively checking suffixes
  for (let i = 0; i < folderSegments.length; i++) {
    const folderSuffix = folderSegments.slice(i).join('/');
    if (folderSuffix === fileDir) {
      return true;
    }
  }

  return false;
}
