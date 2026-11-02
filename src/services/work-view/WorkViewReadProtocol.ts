import type { WorkViewSnapshot } from './data-source.mjs';

export type WorkViewReadResult = {
  agentView: WorkViewSnapshot;
  agentRevision: number;
};

export interface WorkViewReadRequest {
  id: number;
  maxActivityAgeMs: number;
  localDeviceId: string;
}

export interface WorkViewReadReply {
  id: number;
  ok: true;
  result: WorkViewReadResult;
}

export interface WorkViewReadErrorReply {
  id: number;
  ok: false;
  error: { name: string; message: string };
}

export type WorkViewReadResponse = WorkViewReadReply | WorkViewReadErrorReply;
