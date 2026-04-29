
import { homedir } from 'os';
import { basename } from 'path';

function globToRegex(pattern: string): RegExp {
  let expanded = pattern.startsWith('~')
    ? homedir() + pattern.slice(1)
    : pattern;

  expanded = expanded.replace(/\\/g, '/');

  let regex = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  regex = regex
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')  
    .replace(/\*/g, '[^/]*')              
    .replace(/\?/g, '[^/]')               
    .replace(/<<<GLOBSTAR>>>/g, '.*');    

  return new RegExp(`^${regex}$`);
}

export function isProjectExcluded(projectPath: string, exclusionPatterns: string): boolean {
  if (!exclusionPatterns || !exclusionPatterns.trim()) {
    return false;
  }

  const normalizedProjectPath = projectPath.replace(/\\/g, '/');
  const projectBasename = basename(normalizedProjectPath);

  const patternList = exclusionPatterns
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  for (const pattern of patternList) {
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalizedProjectPath) || regex.test(projectBasename)) {
        return true;
      }
    } catch (error: unknown) {
      console.warn(`[project-filter] Invalid exclusion pattern "${pattern}":`, error instanceof Error ? error.message : String(error));
      continue;
    }
  }

  return false;
}
