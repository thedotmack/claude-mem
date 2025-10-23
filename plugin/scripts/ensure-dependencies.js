#!/usr/bin/env node

// src/bin/ensure-dependencies.ts
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
function getDirname() {
  return typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
}
var scriptDir = getDirname();
var isBuilt = scriptDir.includes("plugin/scripts") || scriptDir.includes("plugin\\scripts");
var targetDir = isBuilt ? scriptDir : join(scriptDir, "../../plugin/scripts");
var nodeModulesPath = join(targetDir, "node_modules");
var packageJsonPath = join(targetDir, "package.json");
if (existsSync(nodeModulesPath)) {
  const betterSqlitePath = join(nodeModulesPath, "better-sqlite3");
  if (existsSync(betterSqlitePath)) {
    process.exit(0);
  }
}
if (!existsSync(targetDir)) {
  mkdirSync(targetDir, { recursive: true });
}
if (!existsSync(packageJsonPath)) {
  const packageJson = {
    name: "claude-mem-scripts",
    version: "4.2.1",
    description: "Runtime dependencies for claude-mem plugin hooks",
    private: true,
    type: "module",
    dependencies: {
      "better-sqlite3": "^11.0.0"
    }
  };
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
}
try {
  console.log("Installing claude-mem dependencies...");
  execSync("npm install --prefer-offline --no-audit --no-fund --loglevel error", {
    cwd: targetDir,
    stdio: "inherit"
  });
  console.log("Dependencies installed successfully.");
  process.exit(0);
} catch (error) {
  console.error("Failed to install dependencies:", error.message);
  process.exit(1);
}
