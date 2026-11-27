/**
 * The one visible state of the host's OpenCode model for the observer, and the
 * words for it. `doctor` prints the line; the worker takes the translated ids
 * from the same result, so neither program can drift from the other's wording
 * (docs/architecture/state-machines.md).
 *
 * Pure and light: it reads only the host config file and the settings handed
 * to it. No database, no worker import and no network call, so the Node CLI can
 * import it. The state machine is flat and has one writer, `diagnoseHostModel`:
 *
 *   off ──gate on──▶ masked ──explicit cleared──▶ resolved / identity / unmapped / none
 *
 * `unmapped` and `none` keep the caller's fallback model; `identity` means the
 * host provider named this endpoint but did not declare the model, so its key
 * is assumed to be endpoint-ready.
 */

import type { SettingsDefaults } from './SettingsDefaultsManager.js';
import {
  HOST_CONFIG_SOURCE_LABELS,
  readOpenCodeHostConfig,
  type HostConfigSource,
} from './opencode-host-config.js';
import { resolveEndpointModelIdWithIdentity } from './opencode-model-id.js';

export type HostModelStatus = 'off' | 'masked' | 'none' | 'unmapped' | 'resolved' | 'identity';

/** The only wordings and doctor statuses; every consumer imports this table. */
export const HOST_MODEL_STATUS_WORDS: Record<HostModelStatus, { label: string; check: 'ok' | 'warn' }> = {
  off: { label: 'host model: off', check: 'ok' },
  masked: { label: 'host model: masked', check: 'warn' },
  none: { label: 'host model: none', check: 'ok' },
  unmapped: { label: 'host model: unmapped', check: 'warn' },
  resolved: { label: 'host model: resolved', check: 'ok' },
  identity: { label: 'host model: identity', check: 'warn' },
};

export interface HostModelDiagnostic {
  status: HostModelStatus;
  /** The display key the host's config named, before translation. */
  hostId?: string;
  /** The endpoint-ready id for the observer model, when one can be used. */
  endpointId?: string;
  /** The endpoint-ready id for the summary tier, when one can be used. */
  summaryId?: string;
  /** Provenance of `sources.model`, present only when a host file was read. */
  source?: HostConfigSource;
  /** `${HOST_MODEL_STATUS_WORDS[status].label} ${detail}`, ready to print. */
  line: string;
  /**
   * The host's small-model display key when it cannot be translated, with a
   * separate summary-tier line already worded. A notice, not a status: the
   * six `HostModelStatus` values stay the one visible state machine, and the
   * worker deduplicates this line in its own bounded set.
   */
  smallModelNotice?: { hostId: string; line: string };
}

/** Why there is no fallback id: an operator setting, or refusals by the endpoint. */
export type HostModelFallbackReason = 'none' | 'refused';

export interface HostModelDiagnosisInput {
  settings: SettingsDefaults;
  fallbackModel: string;
  hostOptions?: { cwd?: string };
  apiUrl?: string;
  /** A host-chosen id this endpoint already refused is not usable. */
  isRefused?: (id: string) => boolean;
  /** Only used when `fallbackModel` is empty; never blames the endpoint for `none`. */
  fallbackReason?: HostModelFallbackReason;
}

/** Describe the host's observer model without changing or retrying anything. */
export function diagnoseHostModel(input: HostModelDiagnosisInput): HostModelDiagnostic {
  const { settings, fallbackModel, hostOptions, apiUrl, isRefused, fallbackReason } = input;
  const worded = (status: HostModelStatus, detail: string): HostModelDiagnostic => ({
    status,
    line: `${HOST_MODEL_STATUS_WORDS[status].label} ${detail}`,
  });

  if (settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST !== 'true') {
    return worded('off', 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST is not true; the observer uses its own model');
  }

  // PR 1 returns `sources` only on request: without this flag there is no
  // provenance to name in the doctor line.
  const host = readOpenCodeHostConfig({
    cwd: hostOptions?.cwd,
    includeProject: Boolean(hostOptions?.cwd),
    includeSources: true,
  });
  const source = host.sources?.model;
  const sourcePhrase = source
    ? ` from ${HOST_CONFIG_SOURCE_LABELS[source.kind]} at ${source.path}`
    : '';
  const fallback = fallbackModel
    ? `"${fallbackModel}"`
    : fallbackReason === 'refused'
      ? 'no model (this endpoint refused every fallback)'
      : fallbackReason === 'none'
        ? 'no model (CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL is none)'
        : 'no model available';

  // The small model serves the summary tier independently of the observer
  // model, so it is translated even when the main id is masked or unusable.
  const summary = host.smallModel
    ? resolveEndpointModelIdWithIdentity(host.smallModel, host.provider, apiUrl)
    : undefined;
  const summaryId = summary && !isRefused?.(summary.id) ? summary.id : undefined;
  const withSummary = summaryId ? { summaryId } : {};
  // An untranslatable small model is a notice of its own: on a resolved main
  // model the diagnosis line says nothing about summaries, and the worker has
  // no other chance to warn before the tier quietly uses another id.
  const withNotice = host.smallModel && !summary
    ? {
      smallModelNotice: {
        hostId: host.smallModel,
        line: `${HOST_MODEL_STATUS_WORDS.unmapped.label} small model "${host.smallModel}" is not declared in the OpenCode provider config; summaries keep the fallback model`,
      },
    }
    : {};

  const hostId = host.model;
  if (!hostId) {
    return { ...worded('none', `the host config declares no model; keeping ${fallback}`), ...withSummary, ...withNotice };
  }

  const explicit = settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL?.trim();
  // A pinned id this endpoint refused cannot hide the host model any more: it
  // is dropped from resolution, so it must not keep masking a usable host id.
  const explicitRefused = explicit ? isRefused?.(explicit) === true : false;
  if (explicit && !explicitRefused) {
    return {
      ...worded('masked', `CLAUDE_MEM_OPENAI_COMPAT_MODEL="${explicit}" hides the host model "${hostId}"${sourcePhrase}`),
      hostId,
      ...(source ? { source } : {}),
      ...withSummary,
      ...withNotice,
    };
  }
  const refusedPinned = explicitRefused
    ? `CLAUDE_MEM_OPENAI_COMPAT_MODEL="${explicit}" was refused by this endpoint; `
    : '';

  const resolved = resolveEndpointModelIdWithIdentity(hostId, host.provider, apiUrl);
  const identity = resolved?.identity === true;
  if (!resolved || isRefused?.(resolved.id)) {
    const detail = resolved
      ? `${refusedPinned}host model "${hostId}" resolves to "${resolved.id}", which this endpoint refused; keeping ${fallback}`
      : `${refusedPinned}host model "${hostId}" is not declared in the OpenCode provider config; keeping ${fallback}`;
    return {
      ...worded('unmapped', detail),
      hostId,
      ...(source ? { source } : {}),
      ...withSummary,
      ...withNotice,
    };
  }

  const detail = `${refusedPinned}${identity
    ? `host model "${hostId}" is not declared in the OpenCode provider config, but its provider points at this endpoint; assuming the model key is endpoint-ready and sending "${resolved.id}"${sourcePhrase}`
    : `host model "${hostId}" resolves to endpoint id "${resolved.id}"${sourcePhrase}`}`;
  return {
    ...worded(identity ? 'identity' : 'resolved', detail),
    hostId,
    endpointId: resolved.id,
    ...(source ? { source } : {}),
    ...withSummary,
    ...withNotice,
  };
}
