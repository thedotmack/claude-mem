import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os";

const execAsync = promisify(exec);

export interface SystemDiagnostics {
  versions: {
    claudeMem: string;
    claudeCode: string;
    node: string;
    bun: string;
  };
  platform: {
    os: string;
    osVersion: string;
    arch: string;
  };
  paths: {
    pluginPath: string;
    dataDir: string;
    cwd: string;
    isDevMode: boolean;
  };
  worker: {
    running: boolean;
    pid?: number;
    port?: number;
    uptime?: number;
    version?: string;
    health?: any;
    stats?: any;
  };
  logs: {
    workerLog: string[];
    silentLog: string[];
  };
  database: {
    path: string;
    exists: boolean;
    size?: number;
    counts?: {
      observations: number;
      sessions: number;
      summaries: number;
    };
  };
  config: {
    settingsPath: string;
    settingsExist: boolean;
    settings?: Record<string, any>;
  };
}

function sanitizePath(filePath: string): string {
  const homeDir = os.homedir();
  return filePath.replace(homeDir, "~");
}

async function getClaudememVersion(): Promise<string> {
  try {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const content = await fs.readFile(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.version || "unknown";
  } catch (error) {
    return "unknown";
  }
}

async function getClaudeCodeVersion(): Promise<string> {
  try {
    const { stdout } = await execAsync("claude --version");
    return stdout.trim();
  } catch (error) {
    return "not installed or not in PATH";
  }
}

async function getBunVersion(): Promise<string> {
  try {
    const { stdout } = await execAsync("bun --version");
    return stdout.trim();
  } catch (error) {
    return "not installed";
  }
}

async function getOsVersion(): Promise<string> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execAsync("sw_vers -productVersion");
      return `macOS ${stdout.trim()}`;
    } else if (process.platform === "linux") {
      const { stdout } = await execAsync("uname -sr");
      return stdout.trim();
    } else if (process.platform === "win32") {
      const { stdout } = await execAsync("ver");
      return stdout.trim();
    }
    return "unknown";
  } catch (error) {
    return "unknown";
  }
}

async function checkWorkerHealth(port: number): Promise<any> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return await response.json();
  } catch (error) {
    return null;
  }
}

async function getWorkerStats(port: number): Promise<any> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      signal: AbortSignal.timeout(2000),
    });
    return await response.json();
  } catch (error) {
    return null;
  }
}

async function readPidFile(dataDir: string): Promise<any> {
  try {
    const pidPath = path.join(dataDir, "worker.pid");
    const content = await fs.readFile(pidPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

async function readLogLines(logPath: string, lines: number): Promise<string[]> {
  try {
    const content = await fs.readFile(logPath, "utf-8");
    const allLines = content.split("\n").filter((line) => line.trim());
    return allLines.slice(-lines);
  } catch (error) {
    return [];
  }
}

async function getSettings(
  dataDir: string
): Promise<{ exists: boolean; settings?: Record<string, any> }> {
  try {
    const settingsPath = path.join(dataDir, "settings.json");
    const content = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    return { exists: true, settings };
  } catch (error) {
    return { exists: false };
  }
}

async function getDatabaseInfo(
  dataDir: string
): Promise<{ exists: boolean; size?: number }> {
  try {
    const dbPath = path.join(dataDir, "claude-mem.db");
    const stats = await fs.stat(dbPath);
    return { exists: true, size: stats.size };
  } catch (error) {
    return { exists: false };
  }
}

export async function collectDiagnostics(
  options: { includeLogs?: boolean } = {}
): Promise<SystemDiagnostics> {
  const homeDir = os.homedir();
  const dataDir = path.join(homeDir, ".claude-mem");
  const pluginPath = path.join(
    homeDir,
    ".claude",
    "plugins",
    "marketplaces",
    "thedotmack"
  );
  const cwd = process.cwd();
  const isDevMode = cwd.includes("claude-mem") && !cwd.includes(".claude");

  // Collect version information
  const [claudeMem, claudeCode, bun, osVersion] = await Promise.all([
    getClaudememVersion(),
    getClaudeCodeVersion(),
    getBunVersion(),
    getOsVersion(),
  ]);

  const versions = {
    claudeMem,
    claudeCode,
    node: process.version,
    bun,
  };

  const platform = {
    os: process.platform,
    osVersion,
    arch: process.arch,
  };

  const paths = {
    pluginPath: sanitizePath(pluginPath),
    dataDir: sanitizePath(dataDir),
    cwd: sanitizePath(cwd),
    isDevMode,
  };

  // Check worker status
  const pidInfo = await readPidFile(dataDir);
  const workerPort = pidInfo?.port || 37777;

  const [health, stats] = await Promise.all([
    checkWorkerHealth(workerPort),
    getWorkerStats(workerPort),
  ]);

  const worker = {
    running: health !== null,
    pid: pidInfo?.pid,
    port: workerPort,
    uptime: stats?.worker?.uptime,
    version: stats?.worker?.version,
    health,
    stats,
  };

  // Collect logs if requested
  let workerLog: string[] = [];
  let silentLog: string[] = [];

  if (options.includeLogs !== false) {
    const today = new Date().toISOString().split("T")[0];
    const workerLogPath = path.join(dataDir, "logs", `worker-${today}.log`);
    const silentLogPath = path.join(dataDir, "silent.log");

    [workerLog, silentLog] = await Promise.all([
      readLogLines(workerLogPath, 50),
      readLogLines(silentLogPath, 50),
    ]);
  }

  const logs = {
    workerLog: workerLog.map(sanitizePath),
    silentLog: silentLog.map(sanitizePath),
  };

  // Database info
  const dbInfo = await getDatabaseInfo(dataDir);
  const database = {
    path: sanitizePath(path.join(dataDir, "claude-mem.db")),
    exists: dbInfo.exists,
    size: dbInfo.size,
    // TODO: Add table counts if we want to query the database
  };

  // Configuration
  const settingsInfo = await getSettings(dataDir);
  const config = {
    settingsPath: sanitizePath(path.join(dataDir, "settings.json")),
    settingsExist: settingsInfo.exists,
    settings: settingsInfo.settings,
  };

  return {
    versions,
    platform,
    paths,
    worker,
    logs,
    database,
    config,
  };
}

export function formatDiagnostics(diagnostics: SystemDiagnostics): string {
  let output = "";

  output += "## Environment\n\n";
  output += `- **Claude-mem**: ${diagnostics.versions.claudeMem}\n`;
  output += `- **Claude Code**: ${diagnostics.versions.claudeCode}\n`;
  output += `- **Node.js**: ${diagnostics.versions.node}\n`;
  output += `- **Bun**: ${diagnostics.versions.bun}\n`;
  output += `- **OS**: ${diagnostics.platform.osVersion} (${diagnostics.platform.arch})\n`;
  output += `- **Platform**: ${diagnostics.platform.os}\n\n`;

  output += "## Paths\n\n";
  output += `- **Plugin**: ${diagnostics.paths.pluginPath}\n`;
  output += `- **Data Directory**: ${diagnostics.paths.dataDir}\n`;
  output += `- **Current Directory**: ${diagnostics.paths.cwd}\n`;
  output += `- **Dev Mode**: ${diagnostics.paths.isDevMode ? "Yes" : "No"}\n\n`;

  output += "## Worker Status\n\n";
  output += `- **Running**: ${diagnostics.worker.running ? "Yes" : "No"}\n`;
  if (diagnostics.worker.running) {
    output += `- **PID**: ${diagnostics.worker.pid || "unknown"}\n`;
    output += `- **Port**: ${diagnostics.worker.port}\n`;
    if (diagnostics.worker.uptime !== undefined) {
      const uptimeMinutes = Math.floor(diagnostics.worker.uptime / 60);
      output += `- **Uptime**: ${uptimeMinutes} minutes\n`;
    }
    if (diagnostics.worker.stats) {
      output += `- **Active Sessions**: ${diagnostics.worker.stats.worker?.activeSessions || 0}\n`;
      output += `- **SSE Clients**: ${diagnostics.worker.stats.worker?.sseClients || 0}\n`;
    }
  }
  output += "\n";

  output += "## Database\n\n";
  output += `- **Path**: ${diagnostics.database.path}\n`;
  output += `- **Exists**: ${diagnostics.database.exists ? "Yes" : "No"}\n`;
  if (diagnostics.database.size) {
    const sizeKB = (diagnostics.database.size / 1024).toFixed(2);
    output += `- **Size**: ${sizeKB} KB\n`;
  }
  output += "\n";

  output += "## Configuration\n\n";
  output += `- **Settings File**: ${diagnostics.config.settingsPath}\n`;
  output += `- **Settings Exist**: ${diagnostics.config.settingsExist ? "Yes" : "No"}\n`;
  if (diagnostics.config.settings) {
    output += "- **Key Settings**:\n";
    const keySettings = [
      "CLAUDE_MEM_MODEL",
      "CLAUDE_MEM_WORKER_PORT",
      "CLAUDE_MEM_WORKER_HOST",
      "CLAUDE_MEM_LOG_LEVEL",
      "CLAUDE_MEM_CONTEXT_OBSERVATIONS",
    ];
    for (const key of keySettings) {
      if (diagnostics.config.settings[key]) {
        output += `  - ${key}: ${diagnostics.config.settings[key]}\n`;
      }
    }
  }
  output += "\n";

  // Add logs if present
  if (diagnostics.logs.workerLog.length > 0) {
    output += "## Recent Worker Logs (Last 50 Lines)\n\n";
    output += "```\n";
    output += diagnostics.logs.workerLog.join("\n");
    output += "\n```\n\n";
  }

  if (diagnostics.logs.silentLog.length > 0) {
    output += "## Silent Debug Log (Last 50 Lines)\n\n";
    output += "```\n";
    output += diagnostics.logs.silentLog.join("\n");
    output += "\n```\n\n";
  }

  return output;
}
