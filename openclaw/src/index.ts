interface OpenClawPluginApi {
  getConfig: () => Record<string, any>;
  log: (message: string) => void;
  registerService: (service: {
    id: string;
    start: (ctx: any) => Promise<void>;
    stop: (ctx: any) => Promise<void>;
  }) => void;
  registerCommand: (command: {
    name: string;
    description: string;
    handler: (args: string[], ctx: any) => Promise<string>;
  }) => void;
  runtime: {
    channel: Record<string, Record<string, (to: string, text: string) => Promise<any>>>;
  };
}

export default function claudeMemPlugin(api: OpenClawPluginApi): void {
  api.registerService({
    id: "claude-mem-observation-feed",
    start: async (ctx) => {
      const config = api.getConfig();
      const feedConfig = config.observationFeed as any;
      if (!feedConfig?.enabled) {
        api.log("[claude-mem] Observation feed disabled");
        return;
      }
      api.log(`[claude-mem] Observation feed starting — channel: ${feedConfig.channel}, target: ${feedConfig.to}`);
      // SSE connection logic added in Phase 2
    },
    stop: async (ctx) => {
      api.log("[claude-mem] Observation feed stopping");
      // SSE disconnect logic added in Phase 2
    }
  });

  api.registerCommand({
    name: "claude-mem-feed",
    description: "Show or toggle Claude-Mem observation feed status",
    handler: async (args, ctx) => {
      const config = api.getConfig();
      const feedConfig = config.observationFeed as any;
      if (!feedConfig) {
        return "Observation feed not configured. Add observationFeed to your plugin config.";
      }
      return `Claude-Mem Observation Feed\nEnabled: ${feedConfig.enabled ? "yes" : "no"}\nChannel: ${feedConfig.channel || "not set"}\nTarget: ${feedConfig.to || "not set"}`;
    }
  });

  api.log("[claude-mem] OpenClaw plugin loaded — v1.0.0");
}
