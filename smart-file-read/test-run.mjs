import { searchCodebase, formatSearchResults } from "./dist/search.js";
import { parseFile, formatFoldedView, unfoldSymbol } from "./dist/parser.js";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

const CLAUDE_MEM_SRC = resolve("../src");

console.log("=== TEST 1: smart_search — find 'worker' in claude-mem src ===\n");

const searchResult = await searchCodebase(CLAUDE_MEM_SRC, "worker", { maxResults: 10 });
console.log(formatSearchResults(searchResult, "worker"));

console.log("\n\n=== TEST 2: smart_outline — outline of worker-service.ts ===\n");

const workerPath = resolve(CLAUDE_MEM_SRC, "services/worker-service.ts");
const workerContent = await readFile(workerPath, "utf-8");
const workerParsed = parseFile(workerContent, relative(CLAUDE_MEM_SRC, workerPath));
console.log(formatFoldedView(workerParsed));

console.log("\n\n=== TEST 3: smart_unfold — unfold a specific function ===\n");

if (workerParsed.symbols.length > 0) {
  const firstSymbol = workerParsed.symbols[0];
  console.log(`Unfolding: ${firstSymbol.name}`);
  const unfolded = unfoldSymbol(workerContent, relative(CLAUDE_MEM_SRC, workerPath), firstSymbol.name);
  console.log(unfolded || "Symbol not found");
} else {
  console.log("No symbols found to unfold");
}
