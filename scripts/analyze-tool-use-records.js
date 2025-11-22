#!/usr/bin/env node

import fs from 'fs';
import readline from 'readline';
import path from 'path';

// Configuration
const JSONL_PATH = '/Users/alexnewman/.claude/projects/-Users-alexnewman-Scripts-DuhPaper/f11b0170-6157-4324-a479-66c35686eb69.jsonl';
const OUTPUT_JSON = '/tmp/tool-use-analysis.json';
const OUTPUT_REPORT = '/tmp/tool-use-report.txt';

// Regex pattern for toolu_ IDs
const TOOLU_PATTERN = /toolu_[a-zA-Z0-9]{24}/g;

// Auto-discover agent transcripts linked to main session
async function discoverAgentFiles(mainTranscriptPath) {
  console.log('Discovering linked agent transcripts...');

  const agentIds = new Set();
  const fileStream = fs.createReadStream(mainTranscriptPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.includes('agentId')) continue;

    try {
      const obj = JSON.parse(line);

      // Check for agentId in toolUseResult
      if (obj.toolUseResult?.agentId) {
        agentIds.add(obj.toolUseResult.agentId);
      }
    } catch (e) {
      // Skip malformed lines
    }
  }

  // Build agent file paths
  const directory = path.dirname(mainTranscriptPath);
  const agentFiles = Array.from(agentIds).map(id =>
    path.join(directory, `agent-${id}.jsonl`)
  ).filter(filePath => fs.existsSync(filePath));

  console.log(`  → Found ${agentIds.size} agent IDs`);
  console.log(`  → ${agentFiles.length} agent files exist on disk\n`);

  return agentFiles;
}

// Analysis data structure
const analysis = {
  totalLines: 0,
  linesWithToolUse: 0,
  uniqueToolUseIds: new Set(),
  categories: {
    tool_use_declarations: new Set(),
    tool_result_references: new Set(),
    nested_in_content: new Set(),
    sourceToolUseID: new Set(),
    other_locations: new Set()
  },
  transformedRecords: {
    markdown: [],
    json_observations: []
  },
  schemaPatterns: new Map(),
  lineDetails: []
};

function extractToolUseIds(jsonLine, lineNumber) {
  try {
    const obj = JSON.parse(jsonLine);
    const lineData = {
      lineNumber,
      ids: [],
      categories: [],
      isTransformed: false,
      transformType: null
    };

    // Convert entire object to string for comprehensive regex search
    const objString = JSON.stringify(obj);
    const allMatches = objString.match(TOOLU_PATTERN) || [];

    // Deduplicate IDs found in this line
    const idsInLine = [...new Set(allMatches)];
    lineData.ids = idsInLine;

    // Add all IDs to global set
    idsInLine.forEach(id => analysis.uniqueToolUseIds.add(id));

    // Categorize by location in JSON structure
    if (obj.message?.content) {
      for (const item of obj.message.content) {
        // Direct tool_use declarations
        if (item.type === 'tool_use' && item.id) {
          analysis.categories.tool_use_declarations.add(item.id);
          lineData.categories.push('tool_use_declaration');
        }

        // Direct tool_result references
        if (item.type === 'tool_result' && item.tool_use_id) {
          analysis.categories.tool_result_references.add(item.tool_use_id);
          lineData.categories.push('tool_result_reference');

          // Check if this is a transformed record
          if (typeof item.content === 'string') {
            // Markdown transformation check
            if (item.content.includes('**') || item.content.includes('# ')) {
              lineData.isTransformed = true;
              lineData.transformType = 'markdown';
              analysis.transformedRecords.markdown.push({
                lineNumber,
                tool_use_id: item.tool_use_id,
                preview: item.content.substring(0, 200)
              });
            }
            // JSON observation data check
            else if (item.content.startsWith('{') || item.content.includes('"tool_use_id"')) {
              lineData.isTransformed = true;
              lineData.transformType = 'json_observation';
              analysis.transformedRecords.json_observations.push({
                lineNumber,
                tool_use_id: item.tool_use_id,
                preview: item.content.substring(0, 200)
              });
            }
          }
        }

        // Nested in content strings
        if (item.content && typeof item.content === 'string') {
          const nestedMatches = item.content.match(TOOLU_PATTERN);
          if (nestedMatches) {
            nestedMatches.forEach(id => {
              analysis.categories.nested_in_content.add(id);
            });
            lineData.categories.push('nested_in_content');
          }
        }
      }
    }

    // sourceToolUseID field
    if (obj.sourceToolUseID) {
      analysis.categories.sourceToolUseID.add(obj.sourceToolUseID);
      lineData.categories.push('sourceToolUseID');
    }

    // Check for IDs in other locations
    const categorizedIds = new Set([
      ...analysis.categories.tool_use_declarations,
      ...analysis.categories.tool_result_references,
      ...analysis.categories.nested_in_content,
      ...analysis.categories.sourceToolUseID
    ]);

    idsInLine.forEach(id => {
      if (!categorizedIds.has(id)) {
        analysis.categories.other_locations.add(id);
        lineData.categories.push('other_location');
      }
    });

    // Track schema patterns
    const schemaKey = obj.message?.role || 'unknown';
    analysis.schemaPatterns.set(schemaKey, (analysis.schemaPatterns.get(schemaKey) || 0) + 1);

    analysis.lineDetails.push(lineData);
    analysis.linesWithToolUse++;

  } catch (error) {
    console.error(`Error parsing line ${lineNumber}: ${error.message}`);
  }
}

async function processFile(filePath, fileLabel) {
  console.log(`Analyzing ${fileLabel}: ${filePath}`);

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;
    analysis.totalLines++;

    // Filter: only process lines containing toolu_
    if (line.includes('toolu_')) {
      extractToolUseIds(line, lineNumber);
    }
  }
}

async function processAllFiles() {
  console.log('='.repeat(80));
  console.log('PROCESSING MAIN TRANSCRIPT + AGENT FILES');
  console.log('='.repeat(80));
  console.log();

  // Auto-discover agent files
  const agentFiles = await discoverAgentFiles(JSONL_PATH);

  // Process main transcript
  await processFile(JSONL_PATH, 'Main transcript');

  // Process discovered agent files
  for (const agentFile of agentFiles) {
    const filename = path.basename(agentFile);
    await processFile(agentFile, `Agent transcript (${filename})`);
  }

  console.log('\nProcessing complete!\n');
  generateOutputs();
}

function generateOutputs() {
  // Convert Sets to Arrays for JSON serialization
  const outputData = {
    summary: {
      totalLines: analysis.totalLines,
      linesWithToolUse: analysis.linesWithToolUse,
      uniqueToolUseIds: analysis.uniqueToolUseIds.size,
      allToolUseIds: Array.from(analysis.uniqueToolUseIds).sort()
    },
    categories: {
      tool_use_declarations: {
        count: analysis.categories.tool_use_declarations.size,
        ids: Array.from(analysis.categories.tool_use_declarations).sort()
      },
      tool_result_references: {
        count: analysis.categories.tool_result_references.size,
        ids: Array.from(analysis.categories.tool_result_references).sort()
      },
      nested_in_content: {
        count: analysis.categories.nested_in_content.size,
        ids: Array.from(analysis.categories.nested_in_content).sort()
      },
      sourceToolUseID: {
        count: analysis.categories.sourceToolUseID.size,
        ids: Array.from(analysis.categories.sourceToolUseID).sort()
      },
      other_locations: {
        count: analysis.categories.other_locations.size,
        ids: Array.from(analysis.categories.other_locations).sort()
      }
    },
    transformedRecords: {
      markdown: {
        count: analysis.transformedRecords.markdown.length,
        records: analysis.transformedRecords.markdown
      },
      json_observations: {
        count: analysis.transformedRecords.json_observations.length,
        records: analysis.transformedRecords.json_observations
      }
    },
    schemaPatterns: Object.fromEntries(analysis.schemaPatterns),
    lineDetails: analysis.lineDetails
  };

  // Write JSON output
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(outputData, null, 2));
  console.log(`✓ Written structured data to: ${OUTPUT_JSON}`);

  // Generate human-readable report
  const report = generateReport(outputData);
  fs.writeFileSync(OUTPUT_REPORT, report);
  console.log(`✓ Written report to: ${OUTPUT_REPORT}\n`);

  // Print summary to console
  console.log(report);
}

function generateReport(data) {
  const lines = [];

  lines.push('=' .repeat(80));
  lines.push('TOOL USE ANALYSIS REPORT');
  lines.push('=' .repeat(80));
  lines.push('');

  lines.push('FILE STATISTICS');
  lines.push('-' .repeat(80));
  lines.push(`Total lines in JSONL:              ${data.summary.totalLines}`);
  lines.push(`Lines containing toolu_:           ${data.summary.linesWithToolUse}`);
  lines.push(`Unique tool use IDs found:         ${data.summary.uniqueToolUseIds}`);
  lines.push('');

  lines.push('CATEGORIZATION BREAKDOWN');
  lines.push('-' .repeat(80));
  lines.push(`tool_use declarations:             ${data.categories.tool_use_declarations.count}`);
  lines.push(`tool_result references:            ${data.categories.tool_result_references.count}`);
  lines.push(`Nested in content strings:         ${data.categories.nested_in_content.count}`);
  lines.push(`sourceToolUseID fields:            ${data.categories.sourceToolUseID.count}`);
  lines.push(`Other locations:                   ${data.categories.other_locations.count}`);
  lines.push('');

  lines.push('TRANSFORMED RECORDS');
  lines.push('-' .repeat(80));
  lines.push(`Markdown transformations:          ${data.transformedRecords.markdown.count}`);
  lines.push(`JSON observation data:             ${data.transformedRecords.json_observations.count}`);
  lines.push('');

  if (data.transformedRecords.markdown.count > 0) {
    lines.push('Markdown transformed lines:');
    data.transformedRecords.markdown.records.forEach(rec => {
      lines.push(`  Line ${rec.lineNumber}: ${rec.tool_use_id}`);
    });
    lines.push('');
  }

  lines.push('SCHEMA PATTERNS');
  lines.push('-' .repeat(80));
  Object.entries(data.schemaPatterns).forEach(([role, count]) => {
    lines.push(`${role.padEnd(30)} ${count}`);
  });
  lines.push('');

  lines.push('SAMPLE TOOL USE IDs (first 10)');
  lines.push('-' .repeat(80));
  data.summary.allToolUseIds.slice(0, 10).forEach(id => {
    lines.push(`  ${id}`);
  });
  if (data.summary.allToolUseIds.length > 10) {
    lines.push(`  ... and ${data.summary.allToolUseIds.length - 10} more`);
  }
  lines.push('');

  lines.push('=' .repeat(80));
  lines.push(`Full details available in: ${OUTPUT_JSON}`);
  lines.push('=' .repeat(80));

  return lines.join('\n');
}

// Run the analysis
processAllFiles().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
