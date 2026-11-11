/** Defaults shared by the router, the account viewer and the rollout script. */

/** Account apps are named this plus a keyed hash of the user id (token.ts). Must match cmem.ai's prefix. */
export const DEFAULT_REPLICA_FLY_APP_NAME_PREFIX = 'cmem-vw-';
/** This host's public origin when VIEWER_PUBLIC_ORIGIN is not set. */
export const DEFAULT_VIEWER_PUBLIC_ORIGIN = 'https://cmem-viewer.fly.dev';
/** Where a visitor without a session signs in when VIEWER_SIGN_IN_URL is not set: cmem.ai's /work mints the link. */
export const DEFAULT_VIEWER_SIGN_IN_URL = 'https://cmem.ai/work';
/** Where an account machine's worker listens, on loopback only, behind the gate (index.ts). The rollout script probes it there. */
export const ACCOUNT_WORKER_PORT = '37777';
