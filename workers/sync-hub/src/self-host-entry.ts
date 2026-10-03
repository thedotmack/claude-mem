// Entry module for the self-hosted hub (wrangler.self-host.jsonc).
// Current workerd treats every named export of the main module as an
// entrypoint and rejects index.ts's exported constants/helpers at startup, so
// this module exposes only the fetch/scheduled handler and the Durable Object.
export { default, SyncHub } from "./index";
