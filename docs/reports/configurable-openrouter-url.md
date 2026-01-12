# Configurable OpenRouter Base URL Implementation

## Changes

1.  **Modified `src/shared/SettingsDefaultsManager.ts`**
    *   Added `CLAUDE_MEM_OPENROUTER_BASE_URL` to `SettingsDefaults` interface.
    *   Added default value `'https://openrouter.ai/api/v1/chat/completions'` to `SettingsDefaultsManager.DEFAULTS`.

2.  **Modified `src/services/worker/OpenRouterAgent.ts`**
    *   Removed hardcoded `OPENROUTER_API_URL` constant.
    *   Updated `getOpenRouterConfig` to retrieve `baseUrl` from settings.
    *   Updated `queryOpenRouterMultiTurn` to accept and use `baseUrl`.
    *   Updated `startSession` to pass `baseUrl` to `queryOpenRouterMultiTurn` calls (initial, observation, and summary prompts).

3.  **Modified `src/ui/viewer/types.ts`**
    *   Added `CLAUDE_MEM_OPENROUTER_BASE_URL` to `Settings` interface.

## Verification

*   Created a new unit test `tests/openrouter_agent.test.ts` (subsequently removed).
*   Verified that `OpenRouterAgent` correctly reads the custom base URL from settings and uses it in the `fetch` call.
*   Verified that default behavior remains unchanged (uses official OpenRouter API).

## Usage

To use a custom OpenRouter-compatible endpoint (e.g., local proxy or alternative provider):

1.  Edit `~/.claude-mem/settings.json`.
2.  Add or update `CLAUDE_MEM_OPENROUTER_BASE_URL`:
    ```json
    {
      "CLAUDE_MEM_PROVIDER": "openrouter",
      "CLAUDE_MEM_OPENROUTER_BASE_URL": "http://localhost:8317/v1/chat/completions",
      ...
    }
    ```
