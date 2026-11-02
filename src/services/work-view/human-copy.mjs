import { createHash } from 'node:crypto';

export const HUMAN_COPY_MAX_CHARS = 18_000;
export const HUMAN_COPY_INSTRUCTIONS = `Write concise human-level copy for one human request and its workstreams. Explain the user's goal, current meaningful progress, and a recorded next step. Translate implementation jargon into understandable outcomes without adding facts. Ground every statement in the supplied original request, scope updates, current work, or observation evidence. Do not claim completion, approval, a blocker, a deadline, an agent's presence, or a next step unless the evidence supports it. Finished subtasks do not prove the overall request complete; only explicit requestLifecycle can establish that. If no next step is recorded, next must be an empty string. Do not rewrite each observation separately. Never alter a workstream id or emit status fields. Return only a JSON object with title (at most 100 characters), summary (at most 240), next (at most 160), stage (at most 40 characters, a short plain-language stage supported by recordedStage; empty if unclear), and workstreams containing exactly every supplied id once, each with title (at most 90) and summary (at most 200). Never infer that something shipped from a completed task.`;

function text(value, max) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…` : clean;
}

function sourceRef(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = typeof (value.kind ?? value.source) === 'string' ? value.kind ?? value.source : null;
  const id = value.id ?? value.sourceId;
  if (!kind || !['string', 'number'].includes(typeof id)) return null;
  return { kind: text(kind, 60), id };
}

function refsFor(stream) {
  const refs = new Map();
  for (const item of stream.items ?? []) for (const value of item.sourceRefs ?? []) {
    const ref = sourceRef(value);
    if (ref) refs.set(JSON.stringify(ref), ref);
    if (refs.size === 6) return [...refs.values()];
  }
  return [...refs.values()];
}

function itemContent(item, caps) {
  return {
    status: text(item.status, 40),
    title: text(item.title, caps.title),
    progress: text(item.progress?.text, caps.detail),
    next: text(item.nextStep?.text, caps.detail),
    outcome: text(item.outcome?.text, caps.detail),
  };
}

/** Bounded source-only payload: generated/cache labels and clock fields never enter it. */
export function createHumanCopyInput(request) {
  if (!request || typeof request !== 'object' || !request.original || typeof request.original.text !== 'string') throw new TypeError('A recorded original request is required.');
  const streams = [...(request.workstreams ?? [])];
  if (streams.some((stream) => typeof stream?.id !== 'string' || !stream.id) || new Set(streams.map((stream) => stream.id)).size !== streams.length) throw new TypeError('Workstreams require unique nonempty string ids.');
  streams.sort((a, b) => a.id.localeCompare(b.id));
  let itemLimit = 8, observationLimit = 3, detailCap = 240, titleCap = 160, originalCap = 1600, scopeCap = 320, refLimit = 6;
  const build = () => ({
    version: 1,
    original: { text: text(request.original.text, originalCap), sourceRef: sourceRef(request.original) },
    recordedStage: text(request.stageSourceText, 300),
    requestLifecycle: request.lifecycle?.explicit === true ? { status: text(request.lifecycle.status, 40), field: text(request.lifecycle.field, 40) } : null,
    scopeUpdates: (request.scopeUpdates ?? []).slice(-6).map((update) => ({ text: text(update.text, scopeCap), sourceRef: sourceRef({ source: 'user-prompt', sourceId: update.sourceId }) })).filter((update) => update.text),
    workstreams: streams.map((stream) => ({
      id: stream.id,
      sourceRefs: refsFor(stream).slice(0, refLimit),
      currentItems: (stream.items ?? []).slice(0, itemLimit).map((item) => itemContent(item, { title: titleCap, detail: detailCap })),
      observations: (stream.activity ?? []).filter((activity) => activity.kind === 'observation').slice(0, observationLimit).map((activity) => ({
        title: text(activity.title, titleCap), summary: text(activity.detail, detailCap), sourceRef: sourceRef(activity.sourceRef),
      })),
    })),
  });
  let input = build();
  while (JSON.stringify(input).length > HUMAN_COPY_MAX_CHARS) {
    if (detailCap > 80) { detailCap = Math.max(80, Math.floor(detailCap * .7)); titleCap = Math.max(80, Math.floor(titleCap * .8)); }
    else if (itemLimit > 1) itemLimit--;
    else if (observationLimit > 0) observationLimit--;
    else if (scopeCap > 80 || originalCap > 400) { scopeCap = 80; originalCap = 400; }
    else if (refLimit > 1) refLimit--;
    else throw new RangeError('Workstream identities exceed the bounded human-copy input budget.');
    input = build();
  }
  return input;
}

/** Evidence-location changes do not need a new wording generation. Stream ids do. */
export function humanCopyFingerprint(input) {
  const meaningful = {
    version: input.version,
    original: input.original.text,
    recordedStage: input.recordedStage || '',
    requestLifecycle: input.requestLifecycle ?? null,
    scopeUpdates: input.scopeUpdates.map((update) => update.text),
    workstreams: input.workstreams.map((stream) => ({
      id: stream.id, currentItems: [...stream.currentItems].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      observations: stream.observations.map(({ title, summary }) => ({ title, summary })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    })),
  };
  return createHash('sha256').update(JSON.stringify(meaningful)).digest('hex');
}

function exactKeys(object, keys, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) throw new TypeError(`${label} has an invalid shape.`);
}

function copyText(value, limit, label, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit) throw new TypeError(`${label} must be ${empty ? '0' : '1'}–${limit} characters.`);
  return value.trim();
}

export function validateHumanCopy(output, input) {
  exactKeys(output, ['title', 'summary', 'next', 'workstreams', ...(Object.hasOwn(output || {}, 'stage') ? ['stage'] : [])], 'Human copy');
  if (!Array.isArray(output.workstreams)) throw new TypeError('workstreams must be an array.');
  const wanted = new Set(input.workstreams.map((stream) => stream.id));
  if (output.workstreams.length !== wanted.size) throw new TypeError('Every supplied workstream must appear exactly once.');
  const seen = new Set();
  const workstreams = output.workstreams.map((stream) => {
    exactKeys(stream, ['id', 'title', 'summary'], 'Workstream copy');
    if (!wanted.has(stream.id) || seen.has(stream.id)) throw new TypeError('Unknown or duplicate workstream id.');
    seen.add(stream.id);
    return { id: stream.id, title: copyText(stream.title, 90, 'Workstream title'), summary: copyText(stream.summary, 200, 'Workstream summary') };
  });
  return { title: copyText(output.title, 100, 'Request title'), summary: copyText(output.summary, 240, 'Request summary'), next: copyText(output.next, 160, 'Next step', true), ...(Object.hasOwn(output, 'stage') ? { stage: copyText(output.stage, 40, 'Stage', true) } : {}), workstreams };
}

/** The caller supplies transport/model policy. This module never reads credentials. */
export async function generateHumanCopy(request, provider) {
  if (typeof provider !== 'function') throw new TypeError('An injected provider function is required.');
  const input = createHumanCopyInput(request);
  const fingerprint = humanCopyFingerprint(input);
  const response = await provider(input);
  const output = typeof response === 'string' ? JSON.parse(response) : response;
  return { fingerprint, copy: validateHumanCopy(output, input) };
}
