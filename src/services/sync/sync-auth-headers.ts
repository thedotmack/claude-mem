/**
 * The sync-hub auth header set, shared between CloudSync's push surface and
 * BackupManager's cloud-upload step (pro-backup plan Phase 3) so the contract
 * lives in one place: `Authorization: Bearer <token>`, `X-User-Id`, and the
 * optional device headers (`X-Device-Id`, `X-Device-Name`).
 *
 * SECURITY: the returned object contains the raw token. Never log it — the
 * repo convention is to log `tokenLength` only (CloudSync.ts).
 */

export interface SyncAuthCredentials {
  token: string;
  userId: string;
  deviceId?: string;
  deviceName?: string;
}

export function buildSyncAuthHeaders(credentials: SyncAuthCredentials): Record<string, string> {
  return {
    'Authorization': `Bearer ${credentials.token}`,
    'X-User-Id': credentials.userId,
    ...(credentials.deviceId ? { 'X-Device-Id': credentials.deviceId } : {}),
    ...(credentials.deviceName ? { 'X-Device-Name': credentials.deviceName } : {}),
  };
}
