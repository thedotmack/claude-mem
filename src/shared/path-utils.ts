
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
}

export function isDirectChild(filePath: string, folderPath: string): boolean {
  const normFile = normalizePath(filePath);
  const normFolder = normalizePath(folderPath);

  if (normFile.startsWith(normFolder + '/')) {
    const remainder = normFile.slice(normFolder.length + 1);
    return !remainder.includes('/');
  }

  const folderSegments = normFolder.split('/');
  const fileSegments = normFile.split('/');

  if (fileSegments.length < 2) {
    return normFolder === '' || normFolder === '.';
  }

  const fileDir = fileSegments.slice(0, -1).join('/'); 
  const fileName = fileSegments[fileSegments.length - 1]; 

  if (normFolder.endsWith('/' + fileDir) || normFolder === fileDir) {
    return !fileName.includes('/');
  }

  for (let i = 0; i < folderSegments.length; i++) {
    const folderSuffix = folderSegments.slice(i).join('/');
    if (folderSuffix === fileDir) {
      return true;
    }
  }

  return false;
}
