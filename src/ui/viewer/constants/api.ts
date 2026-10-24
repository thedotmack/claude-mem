export const API_ENDPOINTS = {
  OBSERVATIONS: '/api/observations',
  SUMMARIES: '/api/summaries',
  PROMPTS: '/api/prompts',
  SETTINGS: '/api/settings',
  SESSIONS: '/api/sessions',
  STREAM: '/stream',
  // The Wire page (plan Phase 15). The worker forwards status, routes, trace
  // and call to the wire gateway over loopback; the page never calls the
  // gateway's port.
  WIRE_STATUS: '/api/wire/status',
  WIRE_ROUTES: '/api/wire/routes',
  WIRE_TRACE: '/api/wire/trace',
  WIRE_CALL: '/api/wire/call',
  WIRE_CONSENT: '/api/wire/consent',
  WIRE_CONSENT_CLEAR: '/api/wire/consent/clear',
  WIRE_USAGE: '/api/wire/usage',
} as const;
