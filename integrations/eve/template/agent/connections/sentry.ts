import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

// SENTRY_CONNECTOR is the UID returned by Vercel Connect. For local setup,
// create a connector with `vercel connect create https://mcp.sentry.dev/mcp --name sentry`.
const sentryConnector = process.env.SENTRY_CONNECTOR ?? "sentry";

export default defineMcpClientConnection({
  url: "https://mcp.sentry.dev/mcp",
  description:
    "Sentry workspace: investigate issues, events, traces, releases, and project health.",
  auth: connect(sentryConnector),
});
