/**
 * Parser Regression Tests
 * Ensures v4.2.5 and v4.2.6 bugfixes remain stable
 */

import { parseObservations, parseSummary } from './parser.js';

// ANSI color codes for output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, testName: string, errorMsg?: string): void {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`${GREEN}✓${RESET} ${testName}`);
  } else {
    testsFailed++;
    console.log(`${RED}✗${RESET} ${testName}`);
    if (errorMsg) {
      console.log(`  ${RED}${errorMsg}${RESET}`);
    }
  }
}

function assertEqual<T>(actual: T, expected: T, testName: string): void {
  const isEqual = JSON.stringify(actual) === JSON.stringify(expected);
  if (!isEqual) {
    assert(false, testName, `Expected: ${JSON.stringify(expected)}, Got: ${JSON.stringify(actual)}`);
  } else {
    assert(true, testName);
  }
}

console.log('\n' + YELLOW + '='.repeat(60) + RESET);
console.log(YELLOW + 'Parser Regression Tests (v4.2.5 & v4.2.6)' + RESET);
console.log(YELLOW + '='.repeat(60) + RESET + '\n');

// ============================================================================
// v4.2.6: Observation Parsing - NEVER Skip Observations
// ============================================================================

console.log(YELLOW + '\nv4.2.6: Observation Validation Fixes' + RESET);
console.log('─'.repeat(60) + '\n');

// Test 1: Observation with missing title should be saved
const missingTitleXml = `
<observation>
  <type>feature</type>
  <subtitle>Added new feature</subtitle>
  <narrative>Implemented the feature successfully</narrative>
  <facts>
    <fact>Created new file</fact>
  </facts>
  <concepts>
    <concept>authentication</concept>
  </concepts>
  <files_read></files_read>
  <files_modified>
    <file>src/app.ts</file>
  </files_modified>
</observation>
`;

const missingTitleResult = parseObservations(missingTitleXml);
assert(missingTitleResult.length === 1, 'Should parse observation with missing title');
assert(missingTitleResult[0].title === null, 'Missing title should be null');
assertEqual(missingTitleResult[0].type, 'feature', 'Should preserve type when title missing');

// Test 2: Observation with missing subtitle should be saved
const missingSubtitleXml = `
<observation>
  <type>bugfix</type>
  <title>Fixed critical bug</title>
  <narrative>Resolved the issue</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;

const missingSubtitleResult = parseObservations(missingSubtitleXml);
assert(missingSubtitleResult.length === 1, 'Should parse observation with missing subtitle');
assert(missingSubtitleResult[0].subtitle === null, 'Missing subtitle should be null');
assertEqual(missingSubtitleResult[0].title, 'Fixed critical bug', 'Should preserve title when subtitle missing');

// Test 3: Observation with missing narrative should be saved
const missingNarrativeXml = `
<observation>
  <type>refactor</type>
  <title>Code cleanup</title>
  <subtitle>Improved structure</subtitle>
  <facts>
    <fact>Removed dead code</fact>
  </facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;

const missingNarrativeResult = parseObservations(missingNarrativeXml);
assert(missingNarrativeResult.length === 1, 'Should parse observation with missing narrative');
assert(missingNarrativeResult[0].narrative === null, 'Missing narrative should be null');
assertEqual(missingNarrativeResult[0].facts, ['Removed dead code'], 'Should preserve facts when narrative missing');

// Test 4: Observation with ALL fields missing (except type) should be saved
const minimalObservationXml = `
<observation>
  <type>change</type>
  <title></title>
  <subtitle></subtitle>
  <narrative></narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;

const minimalResult = parseObservations(minimalObservationXml);
assert(minimalResult.length === 1, 'Should parse minimal observation with only type');
assertEqual(minimalResult[0].type, 'change', 'Should preserve type for minimal observation');
assert(minimalResult[0].title === null, 'Empty title should be null');
assert(minimalResult[0].subtitle === null, 'Empty subtitle should be null');
assert(minimalResult[0].narrative === null, 'Empty narrative should be null');

// Test 5: Observation with missing type should use "change" as fallback
const missingTypeXml = `
<observation>
  <title>Something happened</title>
  <subtitle>Details here</subtitle>
  <narrative>More info</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;

const missingTypeResult = parseObservations(missingTypeXml);
assert(missingTypeResult.length === 1, 'Should parse observation with missing type');
assertEqual(missingTypeResult[0].type, 'change', 'Missing type should default to "change"');

// Test 6: Observation with invalid type should use "change" as fallback
const invalidTypeXml = `
<observation>
  <type>invalid_type_here</type>
  <title>Something happened</title>
  <subtitle>Details here</subtitle>
  <narrative>More info</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;

const invalidTypeResult = parseObservations(invalidTypeXml);
assert(invalidTypeResult.length === 1, 'Should parse observation with invalid type');
assertEqual(invalidTypeResult[0].type, 'change', 'Invalid type should default to "change"');

// Test 7: Multiple observations with mixed completeness should all be saved
const mixedObservationsXml = `
<observation>
  <type>feature</type>
  <title>Full observation</title>
  <subtitle>Complete</subtitle>
  <narrative>All fields present</narrative>
  <facts><fact>Fact 1</fact></facts>
  <concepts><concept>concept1</concept></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
<observation>
  <type>bugfix</type>
  <subtitle>Only subtitle and type</subtitle>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
<observation>
  <title>Only title, no type</title>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;

const mixedResult = parseObservations(mixedObservationsXml);
assertEqual(mixedResult.length, 3, 'Should parse all three observations regardless of completeness');
assertEqual(mixedResult[0].type, 'feature', 'First observation should have correct type');
assertEqual(mixedResult[1].type, 'bugfix', 'Second observation should have correct type');
assertEqual(mixedResult[2].type, 'change', 'Third observation should default to "change"');

// ============================================================================
// v4.2.5: Summary Parsing - NEVER Skip Summaries
// ============================================================================

console.log(YELLOW + '\nv4.2.5: Summary Validation Fixes' + RESET);
console.log('─'.repeat(60) + '\n');

// Test 8: Summary with missing request field should be saved
const missingRequestXml = `
<summary>
  <investigated>Looked into the codebase</investigated>
  <learned>Found the issue</learned>
  <completed>Fixed the bug</completed>
  <next_steps>Deploy to production</next_steps>
</summary>
`;

const missingRequestResult = parseSummary(missingRequestXml);
assert(missingRequestResult !== null, 'Should parse summary with missing request');
assert(missingRequestResult!.request === null, 'Missing request should be null');
assertEqual(missingRequestResult!.investigated, 'Looked into the codebase', 'Should preserve other fields');

// Test 9: Summary with missing investigated field should be saved
const missingInvestigatedXml = `
<summary>
  <request>Fix the bug</request>
  <learned>Root cause identified</learned>
  <completed>Applied the fix</completed>
  <next_steps>Monitor production</next_steps>
</summary>
`;

const missingInvestigatedResult = parseSummary(missingInvestigatedXml);
assert(missingInvestigatedResult !== null, 'Should parse summary with missing investigated');
assert(missingInvestigatedResult!.investigated === null, 'Missing investigated should be null');

// Test 10: Summary with missing learned field should be saved
const missingLearnedXml = `
<summary>
  <request>Add new feature</request>
  <investigated>Reviewed the requirements</investigated>
  <completed>Implemented the feature</completed>
  <next_steps>Write tests</next_steps>
</summary>
`;

const missingLearnedResult = parseSummary(missingLearnedXml);
assert(missingLearnedResult !== null, 'Should parse summary with missing learned');
assert(missingLearnedResult!.learned === null, 'Missing learned should be null');

// Test 11: Summary with missing completed field should be saved
const missingCompletedXml = `
<summary>
  <request>Refactor code</request>
  <investigated>Analyzed the structure</investigated>
  <learned>Found improvement opportunities</learned>
  <next_steps>Continue refactoring</next_steps>
</summary>
`;

const missingCompletedResult = parseSummary(missingCompletedXml);
assert(missingCompletedResult !== null, 'Should parse summary with missing completed');
assert(missingCompletedResult!.completed === null, 'Missing completed should be null');

// Test 12: Summary with missing next_steps field should be saved
const missingNextStepsXml = `
<summary>
  <request>Review code</request>
  <investigated>Examined all files</investigated>
  <learned>Code quality is good</learned>
  <completed>Review complete</completed>
</summary>
`;

const missingNextStepsResult = parseSummary(missingNextStepsXml);
assert(missingNextStepsResult !== null, 'Should parse summary with missing next_steps');
assert(missingNextStepsResult!.next_steps === null, 'Missing next_steps should be null');

// Test 13: Summary with only notes field should be saved
const onlyNotesXml = `
<summary>
  <notes>Some random notes</notes>
</summary>
`;

const onlyNotesResult = parseSummary(onlyNotesXml);
assert(onlyNotesResult !== null, 'Should parse summary with only notes field');
assertEqual(onlyNotesResult!.notes, 'Some random notes', 'Should preserve notes field');

// Test 14: Completely empty summary should be saved
const emptySummaryXml = `
<summary>
  <request></request>
  <investigated></investigated>
  <learned></learned>
  <completed></completed>
  <next_steps></next_steps>
</summary>
`;

const emptySummaryResult = parseSummary(emptySummaryXml);
assert(emptySummaryResult !== null, 'Should parse completely empty summary');
assert(emptySummaryResult!.request === null, 'Empty request should be null');
assert(emptySummaryResult!.investigated === null, 'Empty investigated should be null');

// Test 15: Summary with skip_summary should return null (valid use case)
const skipSummaryXml = `
<skip_summary reason="Not enough context yet" />
`;

const skipSummaryResult = parseSummary(skipSummaryXml);
assert(skipSummaryResult === null, 'Should return null for skip_summary directive');

// ============================================================================
// Edge Cases & Data Integrity
// ============================================================================

console.log(YELLOW + '\nEdge Cases & Data Integrity' + RESET);
console.log('─'.repeat(60) + '\n');

// Test 16: Observation with whitespace-only fields should be null
const whitespaceObservationXml = `
<observation>
  <type>change</type>
  <title>   </title>
  <subtitle>

  </subtitle>
  <narrative></narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;

const whitespaceResult = parseObservations(whitespaceObservationXml);
assert(whitespaceResult.length === 1, 'Should parse observation with whitespace fields');
assert(whitespaceResult[0].title === null || whitespaceResult[0].title!.trim() === '', 'Whitespace title should be null or empty');

// Test 17: Observation with concepts including type should filter out type
const conceptsWithTypeXml = `
<observation>
  <type>feature</type>
  <title>New feature</title>
  <subtitle>Details</subtitle>
  <narrative>Description</narrative>
  <facts></facts>
  <concepts>
    <concept>feature</concept>
    <concept>authentication</concept>
  </concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;

const conceptsWithTypeResult = parseObservations(conceptsWithTypeXml);
assert(conceptsWithTypeResult.length === 1, 'Should parse observation with type in concepts');
assertEqual(conceptsWithTypeResult[0].concepts, ['authentication'], 'Should filter out type from concepts');

// Test 18: Observation with all valid types
const validTypes = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];
validTypes.forEach(type => {
  const typeXml = `
<observation>
  <type>${type}</type>
  <title>Test</title>
  <subtitle>Test</subtitle>
  <narrative>Test</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;
  const result = parseObservations(typeXml);
  assertEqual(result[0].type, type, `Should accept valid type: ${type}`);
});

// ============================================================================
// Results Summary
// ============================================================================

console.log('\n' + YELLOW + '='.repeat(60) + RESET);
console.log(YELLOW + 'Test Results Summary' + RESET);
console.log(YELLOW + '='.repeat(60) + RESET + '\n');

console.log(`Total Tests: ${testsRun}`);
console.log(`${GREEN}Passed: ${testsPassed}${RESET}`);
console.log(`${RED}Failed: ${testsFailed}${RESET}`);

if (testsFailed > 0) {
  console.log(`\n${RED}❌ TESTS FAILED${RESET}\n`);
  process.exit(1);
} else {
  console.log(`\n${GREEN}✅ ALL TESTS PASSED${RESET}\n`);
  process.exit(0);
}
