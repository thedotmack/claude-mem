/**
 * Smoke test for OpenClaw claude-mem plugin registration.
 * Validates the plugin structure works independently of the full OpenClaw runtime.
 *
 * Run: node test-sse-consumer.js
 */

import claudeMemPlugin from "./dist/index.js";

let registeredService = null;
let registeredCommand = null;
const logs = [];

const mockApi = {
  id: "claude-mem",
  name: "Claude-Mem (Persistent Memory)",
  version: "1.0.0",
  source: "/test/extensions/claude-mem/dist/index.js",
  config: {},
  pluginConfig: {},
  logger: {
    info: (message) => { logs.push(message); },
    warn: (message) => { logs.push(message); },
    error: (message) => { logs.push(message); },
    debug: (message) => { logs.push(message); },
  },
  registerService: (service) => {
    registeredService = service;
  },
  registerCommand: (command) => {
    registeredCommand = command;
  },
  runtime: {
    channel: {
      telegram: { sendMessageTelegram: async () => {} },
      discord: { sendMessageDiscord: async () => {} },
      signal: { sendMessageSignal: async () => {} },
      slack: { sendMessageSlack: async () => {} },
      whatsapp: { sendMessageWhatsApp: async () => {} },
      line: { sendMessageLine: async () => {} },
    },
  },
};

// Call the default export with mock API
claudeMemPlugin(mockApi);

// Verify service registration
let failures = 0;

if (!registeredService) {
  console.error("FAIL: No service was registered");
  failures++;
} else if (registeredService.id !== "claude-mem-observation-feed") {
  console.error(
    `FAIL: Service ID is "${registeredService.id}", expected "claude-mem-observation-feed"`
  );
  failures++;
} else {
  console.log("OK: Service registered with id 'claude-mem-observation-feed'");
}

if (!registeredCommand) {
  console.error("FAIL: No command was registered");
  failures++;
} else if (registeredCommand.name !== "claude-mem-feed") {
  console.error(
    `FAIL: Command name is "${registeredCommand.name}", expected "claude-mem-feed"`
  );
  failures++;
} else {
  console.log("OK: Command registered with name 'claude-mem-feed'");
}

if (!logs.some((l) => l.includes("plugin loaded"))) {
  console.error("FAIL: Plugin did not log a load message");
  failures++;
} else {
  console.log("OK: Plugin logged load message");
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log("\nPASS: Plugin registers service and command correctly");
}
