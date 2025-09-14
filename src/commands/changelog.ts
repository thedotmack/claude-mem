import { OptionValues } from 'commander';
import { query } from '@anthropic-ai/claude-code';
import fs from 'fs';
import path from 'path';
import { getClaudePath } from '../shared/settings.js';
import { execSync } from 'child_process';

interface ChangelogEntry {
  version: string;
  date: string;
  type: 'Added' | 'Changed' | 'Fixed' | 'Removed' | 'Deprecated' | 'Security';
  description: string;
  timestamp: string;
  generatedAt?: string; // When this changelog entry was created
}

interface MemorySearchResult {
  version: string;
  text: string;
  metadata: any;
}

export async function changelog(options: OptionValues): Promise<void> {
  try {
    // Handle --update flag to regenerate CHANGELOG.md from JSONL
    if (options.update) {
      await updateChangelogFromJsonl(options);
      return;
    }

    // Get current version and project name from package.json
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    let currentVersion = 'unknown';
    let projectName = 'unknown';
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageData = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        currentVersion = packageData.version || 'unknown';
        projectName = packageData.name || path.basename(process.cwd());
      } catch (e) {
        projectName = path.basename(process.cwd());
      }
    }

    // Calculate versions to search for based on flags
    const versionsToSearch: string[] = [];
    let historicalCount = options.historical || 1; // Default to current version only
    
    // Handle --generate flag for specific version
    if (options.generate) {
      versionsToSearch.push(options.generate);
      historicalCount = 1; // Single version mode
      console.log(`🎯 Generating changelog for specific version: ${options.generate}`);
    } else if (currentVersion !== 'unknown') {
      // Normal mode: use current version or historical versions
      const parts = currentVersion.split('.');
      if (parts.length === 3) {
        let major = parseInt(parts[0]);
        let minor = parseInt(parts[1]);
        let patch = parseInt(parts[2]);
        
        for (let i = 0; i < historicalCount; i++) {
          versionsToSearch.push(`${major}.${minor}.${patch}`);
          
          // Decrement version
          if (patch === 0) {
            if (minor === 0) {
              // Can't go lower than x.0.0
              break;
            }
            minor--;
            patch = 9;
          } else {
            patch--;
          }
        }
      }
    }

    if (versionsToSearch.length === 0) {
      console.log('⚠️  Could not determine versions to search. Please check package.json');
      process.exit(1);
    }

    // Check if current version already has a changelog entry
    const projectChangelogDir = path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.claude-mem',
      'projects'
    );
    const changelogJsonlPath = path.join(projectChangelogDir, `${projectName}-changelog.jsonl`);
    
    let hasCurrentVersion = false;
    
    if (fs.existsSync(changelogJsonlPath)) {
      const existingLines = fs.readFileSync(changelogJsonlPath, 'utf-8').split('\n').filter(l => l.trim());
      
      for (const line of existingLines) {
        try {
          const entry = JSON.parse(line);
          if (entry.version === currentVersion) {
            hasCurrentVersion = true;
          }
        } catch (e) {
          // Skip invalid lines
        }
      }
      
      if (!options.historical && !options.generate && historicalCount === 1) {
        if (hasCurrentVersion) {
          console.log(`❌ Version ${currentVersion} already has changelog entries.`);
          console.log('\n📝 Workflow:');
          console.log('  1. Make your code updates');
          console.log('  2. Build and test: bun run build');
          console.log('  3. Bump version: npm version patch');
          console.log('  4. Generate changelog: claude-mem changelog');
          console.log('  5. Commit and push\n');
          console.log(`💡 Or use --historical 1 to regenerate this version's changelog`);
          process.exit(1);
        }
      }
    }

    // Get npm publish times for all versions we need
    let versionTimeRanges: Array<{version: string, startTime: string, endTime: string}> = [];
    
    // Check if custom time range is provided
    if (options.start && options.end) {
      // Use custom time range for the specified version
      const version = options.generate || currentVersion;
      versionTimeRanges.push({
        version,
        startTime: options.start,
        endTime: options.end
      });
      
      console.log(`📅 Using custom time range for ${version}:`);
      console.log(`   Start: ${new Date(options.start).toLocaleString()}`);
      console.log(`   End: ${new Date(options.end).toLocaleString()}`);
    } else {
      try {
        const npmTimeData = execSync(`npm view ${projectName} time --json`, { 
          encoding: 'utf-8',
          timeout: 5000 
        });
        const publishTimes = JSON.parse(npmTimeData);
      
      // For historical mode, we need one extra previous version to get proper time ranges
      // E.g., for 3 versions, we need 4 timestamps to create 3 ranges
      let extraPrevVersion = '';
      if (historicalCount > 1) {
        // Get the version before our oldest version in the search list
        const oldestVersion = versionsToSearch[versionsToSearch.length - 1];
        const parts = oldestVersion.split('.');
        const major = parseInt(parts[0]);
        const minor = parseInt(parts[1]);
        const patch = parseInt(parts[2]);
        
        if (patch > 0) {
          extraPrevVersion = `${major}.${minor}.${patch - 1}`;
        } else if (minor > 0) {
          // Look for highest patch of previous minor
          const prevMinorPrefix = `${major}.${minor - 1}.`;
          const prevMinorVersions = Object.keys(publishTimes)
            .filter(v => v.startsWith(prevMinorPrefix))
            .sort((a, b) => {
              const aPatch = parseInt(a.split('.')[2] || '0');
              const bPatch = parseInt(b.split('.')[2] || '0');
              return bPatch - aPatch;
            });
          if (prevMinorVersions.length > 0) {
            extraPrevVersion = prevMinorVersions[0];
          }
        } else if (major > 0) {
          // Look for highest version of previous major
          const prevMajorPrefix = `${major - 1}.`;
          const prevMajorVersions = Object.keys(publishTimes)
            .filter(v => v.startsWith(prevMajorPrefix))
            .sort((a, b) => {
              const [, aMinor, aPatch] = a.split('.').map(Number);
              const [, bMinor, bPatch] = b.split('.').map(Number);
              if (aMinor !== bMinor) return bMinor - aMinor;
              return bPatch - aPatch;
            });
          if (prevMajorVersions.length > 0) {
            extraPrevVersion = prevMajorVersions[0];
          }
        }
        
        if (options.verbose && extraPrevVersion && publishTimes[extraPrevVersion]) {
          console.log(`📍 Using ${extraPrevVersion} as start boundary for time ranges`);
        }
      }
      
      // Build time ranges for each version
      for (let i = 0; i < versionsToSearch.length; i++) {
        const version = versionsToSearch[i];
        
        // Start time: 
        // - For the first (newest) version, use the publish time of the version before it
        // - For middle versions, use the publish time of the next version in our list
        // - For the last (oldest) version, use the extra previous version we found
        let startTime = '2000-01-01T00:00:00Z'; // Default to old date
        
        if (i === 0) {
          // First (newest) version - find its immediate predecessor
          const versionParts = version.split('.');
          const major = parseInt(versionParts[0]);
          const minor = parseInt(versionParts[1]);
          const patch = parseInt(versionParts[2]);
          
          let prevVersion = '';
          if (patch > 0) {
            prevVersion = `${major}.${minor}.${patch - 1}`;
          } else if (minor > 0) {
            // Look for highest patch of previous minor
            const prevMinorPrefix = `${major}.${minor - 1}.`;
            const prevMinorVersions = Object.keys(publishTimes)
              .filter(v => v.startsWith(prevMinorPrefix))
              .sort((a, b) => {
                const aPatch = parseInt(a.split('.')[2] || '0');
                const bPatch = parseInt(b.split('.')[2] || '0');
                return bPatch - aPatch;
              });
            if (prevMinorVersions.length > 0) {
              prevVersion = prevMinorVersions[0];
            }
          }
          
          if (publishTimes[prevVersion]) {
            startTime = publishTimes[prevVersion];
          }
        } else if (i < versionsToSearch.length - 1) {
          // Middle versions - use the next version in our list
          const prevVersionInList = versionsToSearch[i + 1];
          if (publishTimes[prevVersionInList]) {
            startTime = publishTimes[prevVersionInList];
          }
        } else {
          // Last (oldest) version - use the extra previous version
          if (extraPrevVersion && publishTimes[extraPrevVersion]) {
            startTime = publishTimes[extraPrevVersion];
          }
        }
        
        // End time is this version's publish time (or now for unreleased)
        let endTime = publishTimes[version] || new Date().toISOString();
        
        versionTimeRanges.push({ version, startTime, endTime });
        
        if (options.verbose) {
          console.log(`📅 Version ${version}: ${new Date(startTime).toLocaleString()} - ${new Date(endTime).toLocaleString()}`);
        }
      }
      
      // Always log what we're doing for single version
      if (historicalCount === 1) {
        const latestRange = versionTimeRanges[0];
        if (latestRange) {
          console.log(`📦 Using npm time range for ${latestRange.version}: ${new Date(latestRange.startTime).toLocaleString()} - ${new Date(latestRange.endTime).toLocaleString()}`);
        }
      }
      } catch (e) {
        console.log('❌ Could not fetch npm publish times. Cannot proceed without time ranges.');
        process.exit(1);
      }
    }
    
    console.log(`🔍 Searching memories for versions: ${versionsToSearch.join(', ')}`);
    console.log(`📦 Project: ${projectName}\n`);

    // Phase 1: Search for version-related memories using MCP tools
    // ALWAYS use time range search - no other method
    const searchPrompt = versionTimeRanges.length > 0 ?
    `You are helping generate a changelog by searching for memories within specific time ranges for multiple versions.

PROJECT: ${projectName}
VERSION TIME RANGES:
${versionTimeRanges.map(r => `- Version ${r.version}: ${new Date(r.startTime).toLocaleDateString()} to ${new Date(r.endTime).toLocaleDateString()}`).join('\n')}

YOUR TASK:
Use mcp__claude-mem__chroma_query_documents to search for memories for each version time range.

SEARCH STRATEGY:
${versionTimeRanges.map(r => {
  const startDate = new Date(r.startTime);
  const endDate = new Date(r.endTime);
  
  // Generate all date prefixes between start and end
  const datePrefixes: string[] = [];
  const currentDate = new Date(startDate);
  
  while (currentDate <= endDate) {
    // Add day prefix like "2025-09-09"
    const dayPrefix = currentDate.toISOString().split('T')[0];
    datePrefixes.push(dayPrefix);
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return `
Version ${r.version} (${new Date(r.startTime).toLocaleDateString()} to ${new Date(r.endTime).toLocaleDateString()}):
1. Search for memories from these dates: ${datePrefixes.join(', ')}
2. Make multiple calls to mcp__claude-mem__chroma_query_documents:
   - collection_name: "claude_memories"
   - query_texts: Include the project name AND date in each query:
     * "${projectName} ${datePrefixes[0]} feature"
     * "${projectName} ${datePrefixes[0]} fix"  
     * "${projectName} ${datePrefixes[0]} change"
     * "${projectName} ${datePrefixes[0]} improvement"
     * "${projectName} ${datePrefixes[0]} refactor"
   - n_results: 50
3. The date in the query text helps semantic search find memories from that day
4. Assign memories to this version if their timestamp falls within:
   - Start: ${r.startTime}
   - End: ${r.endTime}`;
}).join('\n')}

IMPORTANT:
- Always include project name and date in query_texts for best results
- Semantic search will naturally find memories near those dates
- Group returned memories by version based on their timestamp metadata

Return a JSON object with this structure:
{
  "memories": [
    {
      "version": "version_number",
      "text": "memory content", 
      "metadata": {metadata object with timestamp},
      "relevance": "high/medium/low"
    }
  ]
}

Group memories by the version they belong to based on timestamp.
Start searching now.` : 
    `ERROR: No time ranges available. This should never happen.`;

    if (versionTimeRanges.length === 0) {
      console.log('❌ No time ranges available. Cannot search memories.');
      process.exit(1);
    }
    
    if (options.verbose) {
      console.log('📝 Calling Claude to search memories...');
    }

    // Call Claude with MCP tools to search memories
    const searchResponse = await query({
      prompt: searchPrompt,
      options: {
        allowedTools: [
          'mcp__claude-mem__chroma_query_documents',
          'mcp__claude-mem__chroma_get_documents'
        ],
        pathToClaudeCodeExecutable: getClaudePath()
      }
    });

    // Extract memories from response
    let memoriesJson = '';
    if (searchResponse && typeof searchResponse === 'object' && Symbol.asyncIterator in searchResponse) {
      for await (const message of searchResponse) {
        if (message?.type === 'assistant' && message?.message?.content) {
          const content = message.message.content;
          if (typeof content === 'string') {
            memoriesJson += content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                memoriesJson += block.text;
              }
            }
          }
        }
      }
    }

    // Parse memories
    let memories: MemorySearchResult[] = [];
    try {
      // Extract JSON from response (might be wrapped in markdown)
      const jsonMatch = memoriesJson.match(/```json\n([\s\S]*?)\n```/) || 
                       memoriesJson.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        if (parsed.memories && Array.isArray(parsed.memories)) {
          memories = parsed.memories;
        }
      }
    } catch (e) {
      console.error('⚠️  Could not parse memory search results:', e);
    }

    if (memories.length === 0) {
      console.log('\n⚠️  No version-related memories found for this version.');
      console.log('   This is normal for the first release or when no changes were tracked.');
      console.log('   Creating a placeholder changelog entry...');

      // Create a minimal placeholder entry
      const placeholderEntry: ChangelogEntry = {
        version: versionsToSearch[0], // Use the first (current) version
        date: todayStr,
        type: 'Changed',
        description: 'Initial release or minor updates',
        timestamp: new Date().toISOString(),
        generatedAt: new Date().toISOString()
      };

      // Save the placeholder entry
      if (!fs.existsSync(projectChangelogDir)) {
        fs.mkdirSync(projectChangelogDir, { recursive: true });
      }

      const jsonlContent = JSON.stringify(placeholderEntry) + '\n';
      fs.appendFileSync(changelogJsonlPath, jsonlContent);

      console.log(`✅ Created placeholder changelog entry for v${versionsToSearch[0]}`);

      // Generate the CHANGELOG.md with the placeholder
      await updateChangelogFromJsonl(options);

      return; // Exit successfully
    }

    console.log(`✅ Found ${memories.length} version-related memories\n`);

    // Get system date for accuracy
    const systemDate = execSync('date "+%Y-%m-%d %H:%M:%S %Z"').toString().trim();
    const todayStr = systemDate.split(' ')[0]; // YYYY-MM-DD format

    // Phase 2: Generate changelog entries from memories
    const changelogPrompt = `Analyze these memories and generate changelog entries.

PROJECT: ${projectName}
DATE: ${todayStr}

MEMORIES BY VERSION:
${versionsToSearch.map(version => {
  const versionMemories = memories.filter(m => m.version === version);
  if (versionMemories.length === 0) return `### Version ${version}\nNo memories found.`;
  return `### Version ${version} (${versionMemories.length} memories):
${versionMemories.map((m, i) => `${i + 1}. ${m.text}`).join('\n')}`;
}).join('\n\n')}

INSTRUCTIONS:
1. Extract concrete changes, fixes, and additions from the memories
2. Categorize each change as: Added, Changed, Fixed, Removed, Deprecated, or Security
3. Write clear, user-facing descriptions
4. Start each entry with an action verb
5. Focus on what matters to users, not internal implementation details

Return ONLY a JSON array with this structure:
[
  {
    "version": "3.6.1",
    "type": "Added",
    "description": "New feature description"
  },
  {
    "version": "3.6.1", 
    "type": "Fixed",
    "description": "Bug fix description"
  }
]`;

    console.log('🔄 Generating changelog entries...');

    // Call Claude to generate changelog entries
    const changelogResponse = await query({
      prompt: changelogPrompt,
      options: {
        allowedTools: [],
        pathToClaudeCodeExecutable: getClaudePath()
      }
    });

    // Extract JSON from response
    let entriesJson = '';
    if (changelogResponse && typeof changelogResponse === 'object' && Symbol.asyncIterator in changelogResponse) {
      for await (const message of changelogResponse) {
        if (message?.type === 'assistant' && message?.message?.content) {
          const content = message.message.content;
          if (typeof content === 'string') {
            entriesJson += content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                entriesJson += block.text;
              }
            }
          }
        }
      }
    }

    // Parse changelog entries
    let entries: ChangelogEntry[] = [];
    try {
      // Extract JSON (might be wrapped in markdown)
      const jsonMatch = entriesJson.match(/```json\n([\s\S]*?)\n```/) || 
                       entriesJson.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        if (Array.isArray(parsed)) {
          const generatedAt = new Date().toISOString();
          entries = parsed.map(e => ({
            ...e,
            date: todayStr,
            timestamp: e.timestamp || generatedAt, // Memory timestamp if available
            generatedAt: generatedAt // When this changelog was generated
          }));
        }
      }
    } catch (e) {
      console.error('⚠️  Could not parse changelog entries:', e);
    }

    if (entries.length === 0) {
      console.log('⚠️  No changelog entries generated.');
      process.exit(1);
    }

    // Ensure project changelog directory exists
    if (!fs.existsSync(projectChangelogDir)) {
      fs.mkdirSync(projectChangelogDir, { recursive: true });
    }

    // Save entries to project JSONL file
    console.log(`\n💾 Saving ${entries.length} changelog entries to ${path.basename(changelogJsonlPath)}`);
    
    // When using --historical or --generate, remove old entries for the versions being regenerated
    if ((options.historical && historicalCount > 1) || options.generate) {
      let existingEntries: ChangelogEntry[] = [];
      if (fs.existsSync(changelogJsonlPath)) {
        const lines = fs.readFileSync(changelogJsonlPath, 'utf-8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            // Keep entries that are NOT in the versions we're regenerating
            if (!versionsToSearch.includes(entry.version)) {
              existingEntries.push(entry);
            }
          } catch (e) {
            // Skip invalid lines
          }
        }
      }
      // Rewrite the file with filtered entries plus new ones
      const allEntries = [...existingEntries, ...entries];
      const jsonlContent = allEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      fs.writeFileSync(changelogJsonlPath, jsonlContent);
      console.log(`🔄 Regenerated entries for versions: ${versionsToSearch.join(', ')}`);
    } else {
      // Append new entries to JSONL
      const jsonlContent = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      fs.appendFileSync(changelogJsonlPath, jsonlContent);
    }

    // Now generate markdown from all JSONL entries
    console.log('\n📝 Generating CHANGELOG.md from entries...');
    
    // Read all entries from JSONL
    let allEntries: ChangelogEntry[] = [];
    if (fs.existsSync(changelogJsonlPath)) {
      const lines = fs.readFileSync(changelogJsonlPath, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          allEntries.push(JSON.parse(line));
        } catch (e) {
          // Skip invalid lines
        }
      }
    }

    // Group entries by version
    const entriesByVersion = new Map<string, ChangelogEntry[]>();
    for (const entry of allEntries) {
      if (!entriesByVersion.has(entry.version)) {
        entriesByVersion.set(entry.version, []);
      }
      entriesByVersion.get(entry.version)!.push(entry);
    }

    // Generate markdown
    let markdown = '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).\n\n';
    
    // Sort versions in descending order
    const sortedVersions = Array.from(entriesByVersion.keys()).sort((a, b) => {
      const aParts = a.split('.').map(Number);
      const bParts = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if (aParts[i] !== bParts[i]) return bParts[i] - aParts[i];
      }
      return 0;
    });

    for (const version of sortedVersions) {
      const versionEntries = entriesByVersion.get(version)!;
      const date = versionEntries[0].date || todayStr;
      
      markdown += `\n## [${version}] - ${date}\n\n`;
      
      // Group by type
      const types: Array<ChangelogEntry['type']> = ['Added', 'Changed', 'Fixed', 'Removed', 'Deprecated', 'Security'];
      for (const type of types) {
        const typeEntries = versionEntries.filter(e => e.type === type);
        if (typeEntries.length > 0) {
          markdown += `### ${type}\n`;
          for (const entry of typeEntries) {
            markdown += `- ${entry.description}\n`;
          }
          markdown += '\n';
        }
      }
    }

    // Write the CHANGELOG.md
    const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
    fs.writeFileSync(changelogPath, markdown);
    
    console.log(`✅ Generated CHANGELOG.md with ${allEntries.length} total entries across ${entriesByVersion.size} versions!`);
    
    if (options.preview) {
      console.log('\n📄 Preview:\n');
      console.log(markdown.split('\n').slice(0, 30).join('\n'));
      if (markdown.split('\n').length > 30) {
        console.log('\n... (truncated for preview)');
      }
    }

  } catch (error) {
    console.error('❌ Error generating changelog:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

async function updateChangelogFromJsonl(options: OptionValues): Promise<void> {
  try {
    // Get project name from package.json
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    let projectName = 'unknown';
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageData = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        projectName = packageData.name || path.basename(process.cwd());
      } catch (e) {
        projectName = path.basename(process.cwd());
      }
    }
    
    const projectChangelogDir = path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.claude-mem',
      'projects'
    );
    const changelogJsonlPath = path.join(projectChangelogDir, `${projectName}-changelog.jsonl`);
    
    if (!fs.existsSync(changelogJsonlPath)) {
      console.log('❌ No changelog entries found. Generate some first with: claude-mem changelog');
      process.exit(1);
    }
    
    console.log('📝 Updating CHANGELOG.md from JSONL entries...');
    
    // Read all entries from JSONL
    let allEntries: ChangelogEntry[] = [];
    const lines = fs.readFileSync(changelogJsonlPath, 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        allEntries.push(JSON.parse(line));
      } catch (e) {
        // Skip invalid lines
      }
    }
    
    if (allEntries.length === 0) {
      console.log('❌ No valid entries found in JSONL file');
      process.exit(1);
    }
    
    // Group entries by version
    const entriesByVersion = new Map<string, ChangelogEntry[]>();
    for (const entry of allEntries) {
      if (!entriesByVersion.has(entry.version)) {
        entriesByVersion.set(entry.version, []);
      }
      entriesByVersion.get(entry.version)!.push(entry);
    }
    
    // Generate markdown
    let markdown = '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).\n\n';
    
    // Sort versions in descending order
    const sortedVersions = Array.from(entriesByVersion.keys()).sort((a, b) => {
      const aParts = a.split('.').map(Number);
      const bParts = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if (aParts[i] !== bParts[i]) return bParts[i] - aParts[i];
      }
      return 0;
    });
    
    for (const version of sortedVersions) {
      const versionEntries = entriesByVersion.get(version)!;
      const date = versionEntries[0].date;
      
      markdown += `\n## [${version}] - ${date}\n\n`;
      
      // Group by type
      const types: Array<ChangelogEntry['type']> = ['Added', 'Changed', 'Fixed', 'Removed', 'Deprecated', 'Security'];
      for (const type of types) {
        const typeEntries = versionEntries.filter(e => e.type === type);
        if (typeEntries.length > 0) {
          markdown += `### ${type}\n`;
          for (const entry of typeEntries) {
            markdown += `- ${entry.description}\n`;
          }
          markdown += '\n';
        }
      }
    }
    
    // Write the CHANGELOG.md
    const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
    fs.writeFileSync(changelogPath, markdown);
    
    console.log(`✅ Updated CHANGELOG.md with ${allEntries.length} entries across ${entriesByVersion.size} versions!`);
    
    if (options.preview) {
      console.log('\n📄 Preview:\n');
      console.log(markdown.split('\n').slice(0, 30).join('\n'));
      if (markdown.split('\n').length > 30) {
        console.log('\n... (truncated for preview)');
      }
    }
  } catch (error) {
    console.error('❌ Error updating changelog:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}