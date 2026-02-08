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

interface ObservationSSEPayload {
  id: number;
  memory_session_id: string;
  session_id: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  project: string;
  prompt_number: number;
  created_at_epoch: number;
}

interface SSENewObservationEvent {
  type: "new_observation";
  observation: ObservationSSEPayload;
  timestamp: number;
}

type ConnectionState = "disconnected" | "connected" | "reconnecting";

const MAX_SSE_BUFFER_SIZE = 1024 * 1024; // 1MB

function formatObservationMessage(observation: ObservationSSEPayload): string {
  const title = observation.title || "Untitled";
  let message = `🧠 Claude-Mem Observation\n**${title}**`;
  if (observation.subtitle) {
    message += `\n${observation.subtitle}`;
  }
  return message;
}

function sendToChannel(
  api: OpenClawPluginApi,
  channel: string,
  to: string,
  text: string
): Promise<void> {
  const channelApi = api.runtime.channel[channel];
  if (!channelApi) {
    api.log(`[claude-mem] Unknown channel type: ${channel}`);
    return Promise.resolve();
  }

  const sendFunctionName = `sendMessage${channel.charAt(0).toUpperCase()}${channel.slice(1)}`;
  const senderFunction = channelApi[sendFunctionName];
  if (!senderFunction) {
    api.log(`[claude-mem] Channel "${channel}" has no ${sendFunctionName} function`);
    return Promise.resolve();
  }

  return senderFunction(to, text).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    api.log(`[claude-mem] Failed to send to ${channel}: ${message}`);
  });
}

async function connectToSSEStream(
  api: OpenClawPluginApi,
  port: number,
  channel: string,
  to: string,
  abortController: AbortController,
  setConnectionState: (state: ConnectionState) => void
): Promise<void> {
  let backoffMs = 1000;
  const maxBackoffMs = 30000;

  while (!abortController.signal.aborted) {
    try {
      setConnectionState("reconnecting");
      api.log(`[claude-mem] Connecting to SSE stream at http://localhost:${port}/stream`);

      const response = await fetch(`http://localhost:${port}/stream`, {
        signal: abortController.signal,
        headers: { Accept: "text/event-stream" },
      });

      if (!response.ok) {
        throw new Error(`SSE stream returned HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("SSE stream response has no body");
      }

      setConnectionState("connected");
      backoffMs = 1000;
      api.log("[claude-mem] Connected to SSE stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        if (buffer.length > MAX_SSE_BUFFER_SIZE) {
          api.log("[claude-mem] SSE buffer overflow, clearing buffer");
          buffer = "";
        }

        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";

        for (const frame of frames) {
          const dataLine = frame
            .split("\n")
            .find((line) => line.startsWith("data:"));
          if (!dataLine) continue;

          const jsonStr = dataLine.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.type === "new_observation") {
              const event = parsed as SSENewObservationEvent;
              const message = formatObservationMessage(event.observation);
              await sendToChannel(api, channel, to, message);
            }
          } catch (parseError: unknown) {
            const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
            api.log(`[claude-mem] Failed to parse SSE frame: ${errorMessage}`);
          }
        }
      }
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        break;
      }
      setConnectionState("reconnecting");
      const errorMessage = error instanceof Error ? error.message : String(error);
      api.log(`[claude-mem] SSE stream error: ${errorMessage}. Reconnecting in ${backoffMs / 1000}s`);
    }

    if (abortController.signal.aborted) break;

    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
  }

  setConnectionState("disconnected");
}

export default function claudeMemPlugin(api: OpenClawPluginApi): void {
  let sseAbortController: AbortController | null = null;
  let connectionState: ConnectionState = "disconnected";
  let connectionPromise: Promise<void> | null = null;

  api.registerService({
    id: "claude-mem-observation-feed",
    start: async (_ctx) => {
      // Abort any existing connection before starting a new one
      if (sseAbortController) {
        sseAbortController.abort();
        if (connectionPromise) {
          await connectionPromise;
          connectionPromise = null;
        }
      }

      const config = api.getConfig();
      const workerPort = (config.workerPort as number) || 37777;
      const feedConfig = config.observationFeed as
        | { enabled?: boolean; channel?: string; to?: string }
        | undefined;

      if (!feedConfig?.enabled) {
        api.log("[claude-mem] Observation feed disabled");
        return;
      }

      if (!feedConfig.channel || !feedConfig.to) {
        api.log("[claude-mem] Observation feed misconfigured — channel or target missing");
        return;
      }

      api.log(`[claude-mem] Observation feed starting — channel: ${feedConfig.channel}, target: ${feedConfig.to}`);

      sseAbortController = new AbortController();
      connectionPromise = connectToSSEStream(
        api,
        workerPort,
        feedConfig.channel,
        feedConfig.to,
        sseAbortController,
        (state) => { connectionState = state; }
      );
    },
    stop: async (_ctx) => {
      if (sseAbortController) {
        sseAbortController.abort();
        sseAbortController = null;
      }
      if (connectionPromise) {
        await connectionPromise;
        connectionPromise = null;
      }
      connectionState = "disconnected";
      api.log("[claude-mem] Observation feed stopped — SSE connection closed");
    },
  });

  api.registerCommand({
    name: "claude-mem-feed",
    description: "Show or toggle Claude-Mem observation feed status",
    handler: async (args, _ctx) => {
      const config = api.getConfig();
      const feedConfig = config.observationFeed as
        | { enabled?: boolean; channel?: string; to?: string }
        | undefined;

      if (!feedConfig) {
        return "Observation feed not configured. Add observationFeed to your plugin config.";
      }

      if (args[0] === "on") {
        api.log("[claude-mem] Feed enable requested via command");
        return "Feed enable requested. Update observationFeed.enabled in your plugin config to persist.";
      }

      if (args[0] === "off") {
        api.log("[claude-mem] Feed disable requested via command");
        return "Feed disable requested. Update observationFeed.enabled in your plugin config to persist.";
      }

      return [
        "Claude-Mem Observation Feed",
        `Enabled: ${feedConfig.enabled ? "yes" : "no"}`,
        `Channel: ${feedConfig.channel || "not set"}`,
        `Target: ${feedConfig.to || "not set"}`,
        `Connection: ${connectionState}`,
      ].join("\n");
    },
  });

  api.log("[claude-mem] OpenClaw plugin loaded — v1.0.0");
}
