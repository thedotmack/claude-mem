import type { WorkViewSharedState } from './work-view-api-types.ts'

export function presentSharedState(state: WorkViewSharedState | undefined) {
  if (!state) return null
  if (!state.enabled) return {
    state: 'disabled', label: 'My Work sharing off', attention: false,
    detail: 'Shared My Work state is not enabled. Replicated facts can be displayed, but this installation does not publish new My Work records.',
  }
  if (state.error || state.files?.length || state.conflicts?.length || state.invalid || state.unsupported) return {
    state: 'attention', label: 'My Work needs attention', attention: true,
    detail: 'Some shared My Work changes could not be accepted. The previous complete state is retained.',
  }
  if (state.pending) return {
    state: 'pending', label: 'My Work receiving', attention: false,
    detail: 'Shared My Work records are still arriving. The previous complete state remains visible.',
  }
  return {
    state: 'enabled', label: 'My Work sharing on', attention: false,
    detail: 'This installation publishes My Work records. Cloud freshness is shown separately.',
  }
}
