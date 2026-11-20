// Imported first by each UI entry, so the wrappers are in place before any module that
// fetches while it loads. See local-api-token-client.ts.
import { installLocalApiToken } from './local-api-token-client';

installLocalApiToken();
