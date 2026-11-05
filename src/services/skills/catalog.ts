import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { skillMetadata, type SkillEntry, type SkillListing } from '../../shared/skill-document.js';
export { skillMetadata, type SkillEntry, type SkillListing } from '../../shared/skill-document.js';
import { containsPath, readSkillFile, sha256, SkillCatalogError } from './files.js';
import { excludedPath, skillRoots, type ScanIssue, type SkillCatalogOptions, type SkillRoot } from './roots.js';

export { MAX_SKILL_BYTES, SkillCatalogError, sha256 } from './files.js';
export type { ScanIssue, SkillCatalogOptions, SkillRoot } from './roots.js';

const MAX_ENTRIES_PER_ROOT = 4000;
const MAX_ENTRIES_PER_SCAN = 24000;
const MAX_SKILLS = 1000;

function entryFor(file: string, root: SkillRoot): SkillEntry {
  return {
    id: sha256(file), name: path.basename(path.dirname(file)), description: '',
    scope: root.scope, agent: root.agent, source: root.label, location: file, editable: false, problem: null,
    portableRoot: root.portableRoot, relativePath: path.relative(root.path, file).split(path.sep).join('/'),
  };
}

interface Binding { entry: SkillEntry; root: string; originalRoot: string; }
interface Inventory { listing: SkillListing; bindings: Map<string, Binding>; }

/** Construct once in the local worker. Filesystem discovery is lazy and refreshes replace snapshots atomically. */
export class SkillCatalog {
  private inventory?: Inventory;
  private scanning?: Promise<Inventory>;
  constructor(private readonly options: SkillCatalogOptions = {}) {}

  async refresh(): Promise<SkillListing> {
    this.scanning ??= this.scan().then(result => this.inventory = result).finally(() => { this.scanning = undefined; });
    return (await this.scanning).listing;
  }

  async read(id: string) {
    if (!this.inventory) await this.refresh();
    const binding = this.inventory?.bindings.get(id);
    if (!binding) throw new SkillCatalogError(404, 'This skill is unavailable. Refresh My Skills to find it.');
    const { entry, root } = binding;
    if (await realpath(binding.originalRoot).catch(() => null) !== root) {
      throw new SkillCatalogError(409, 'The skill folder moved. Refresh My Skills to locate it.');
    }
    const read = await readSkillFile(entry.location, root);
    const metadata = skillMetadata(read.text, path.basename(path.dirname(entry.location)), entry.agent);
    return { ...read, entry: { ...entry, ...metadata, editable: read.editable }, path: entry.location, root };
  }

  private async scan(): Promise<Inventory> {
    const issues: ScanIssue[] = [];
    const roots: Array<SkillRoot & { originalRoot: string }> = [];
    const aliases: Array<{ source: string; target: string }> = [];
    for (const root of await skillRoots(this.options, issues)) {
      if (excludedPath(root.path)) continue;
      try {
        const actual = await realpath(root.path);
        if (actual !== root.path) {
          aliases.push({ source: root.label, target: actual });
          continue;
        }
        if (!roots.some(existing => existing.path === actual)) roots.push({ ...root, originalRoot: root.path });
      } catch (error) {
        if (root.scope === 'configured' || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
          issues.push({ source: root.label, message: 'Cannot read skill folder ' + root.path });
        }
      }
    }
    for (const alias of aliases) {
      if (!roots.some(root => containsPath(root.path, alias.target))) {
        issues.push({ source: alias.source, message: 'This skill root is linked. Add its real folder to EXTRA_SKILL_FOLDERS.' });
      }
    }

    const entries = new Map<string, SkillEntry>();
    const bindings = new Map<string, Binding>();
    let remaining = MAX_ENTRIES_PER_SCAN;
    for (const root of roots) {
      const pending = [{ directory: root.path, depth: 0 }];
      const visited = new Set<string>();
      let budget = MAX_ENTRIES_PER_ROOT;
      while (pending.length && budget > 0 && remaining > 0 && entries.size < MAX_SKILLS) {
        const { directory, depth } = pending.pop()!;
        if (visited.has(directory)) continue;
        visited.add(directory);
        try {
          // Recheck each canonical directory after traversal events that could race an earlier stat.
          if (await realpath(directory) !== directory || !containsPath(root.path, directory)) continue;
          for await (const dirent of await opendir(directory)) {
            if (--budget < 0 || --remaining < 0 || entries.size >= MAX_SKILLS) break;
            const file = path.join(directory, dirent.name);
            if (excludedPath(file) || dirent.name.startsWith('.')) continue;
            if (dirent.isSymbolicLink()) {
              // Authorized targets are independently scanned as their own canonical roots.
              // Never enumerate children of an unknown directory or read a linked file outside those roots.
              let target: string | undefined;
              try { target = await realpath(file); } catch {}
              if (target && roots.some(allowed => containsPath(allowed.path, target)) && !excludedPath(target)) continue;
              if (dirent.name !== 'SKILL.md') {
                // An unrelated reference link inside a skill is not itself a skill.
                if (root.scope !== 'configured' && depth !== 0) continue;
                try { if (!(await lstat(path.join(file, 'SKILL.md'))).isFile()) continue; }
                catch { continue; }
              }
              const placeholder = entryFor(dirent.name === 'SKILL.md' ? file : path.join(file, 'SKILL.md'), root);
              placeholder.problem = 'Linked source unavailable. Add its real skill folder to EXTRA_SKILL_FOLDERS.';
              entries.set(placeholder.id, placeholder);
            } else if (dirent.name === 'SKILL.md' && dirent.isFile()) {
              const entry = entryFor(file, root);
              if (entries.has(entry.id)) continue;
              try {
                const read = await readSkillFile(file, root.path);
                Object.assign(entry, skillMetadata(read.text, entry.name, entry.agent), { editable: read.editable });
                bindings.set(entry.id, { entry, root: root.path, originalRoot: root.originalRoot });
              } catch (error) {
                entry.problem = error instanceof SkillCatalogError ? error.message : 'Could not read this skill.';
              }
              entries.set(entry.id, entry);
            } else if (dirent.isDirectory() && depth < 8) {
              // Native agents look for <skill>/SKILL.md. Only custom roots accept arbitrary repo nesting.
              if (root.scope === 'configured' || depth === 0) pending.push({ directory: file, depth: depth + 1 });
            }
          }
        } catch {
          issues.push({ source: root.label, message: 'Could not scan ' + directory });
        }
      }
      if (budget <= 0 || remaining <= 0 || entries.size >= MAX_SKILLS) {
        issues.push({ source: root.label, message: 'Skill scan limit reached. Configure a narrower folder.' });
      }
      if (remaining <= 0 || entries.size >= MAX_SKILLS) break;
    }
    const skills = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location));
    return { listing: { skills, issues }, bindings };
  }
}
