import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";

const pathToFolder = "/Users/alexnewman/Scripts/claude-mem/datasets/epstein-mode/";
const pathToPlugin = "/Users/alexnewman/Scripts/claude-mem/plugin/";

// Or read from a directory
const filesToProcess = fs
  .readdirSync(pathToFolder)
  .filter((f) => f.endsWith(".md"))
  .map((f) => path.join(pathToFolder, f));

// var i = 0;

for (const file of filesToProcess) {
  // i++;
  // Limit for testing
  // if (i > 3) break;

  console.log(`\n=== Processing ${file} ===\n`);

  for await (const message of query({
    prompt: `Read ${file} and think about how it relates to the injected context above (if any).`,
    options: {
      cwd: pathToFolder,
      plugins: [{ type: "local", path: pathToPlugin }],
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log("Plugins:", message.plugins);
      console.log("Commands:", message.slash_commands);
    }

    if (message.type === "assistant") {
      console.log("Assistant:", message.message.content);
    }
  }
}
