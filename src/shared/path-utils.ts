
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
}

export function isDirectChild(filePath: string, folderPath: string): boolean {
  const normFile = normalizePath(filePath);
  const normFolder = normalizePath(folderPath);

  const lastSlash = normFile.lastIndexOf('/');
  const fileDir = lastSlash === -1 ? '' : normFile.slice(0, lastSlash);

  if (fileDir === '') {
    return normFolder === '' || normFolder === '.';
  }

  // Same-form paths: a direct child's directory IS the folder. Mixed forms
  // (observations often store repo-relative file paths queried against an
  // absolute folder): the folder path ending with the file's directory also
  // counts as a direct child.
  return normFolder === fileDir || normFolder.endsWith('/' + fileDir);
}
