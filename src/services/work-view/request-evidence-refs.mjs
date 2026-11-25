/** Evidence behind a request, collected identically on a local worker and in Cloud Sync. */
export function requestEvidenceRefs(request) {
  const refs = new Map();
  const add = ref => {
    if (ref && ['work-state', 'observation', 'prompt', 'summary', 'session'].includes(ref.kind)
      && Number.isSafeInteger(ref.id) && ref.id > 0) refs.set(`${ref.kind}:${ref.id}`, ref);
  };
  const addUrl = url => {
    const match = /^\/api\/work-view\/evidence\/([\w-]+)\/(\d+)$/.exec(url ?? '');
    if (match) add({ kind: match[1], id: Number(match[2]) });
  };
  addUrl(request.original?.url);
  for (const update of request.scopeUpdates) addUrl(update.url);
  for (const item of request.items) {
    addUrl(item.url);
    addUrl(item.request?.url);
    addUrl(item.request?.original?.url);
    for (const field of [item.nextStep, item.outcome]) {
      if (field?.source === 'session-summary') add({ kind: 'summary', id: field.sourceId });
    }
    for (const ref of item.sourceRefs ?? []) add(ref);
  }
  for (const activity of [...request.activity, ...request.workstreams.flatMap(stream => stream.activity)]) add(activity.sourceRef);
  return refs;
}
