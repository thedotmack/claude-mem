import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ParsedObservation } from '../../src/sdk/parser.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';
import { notifyTelegram } from '../../src/services/integrations/TelegramNotifier.js';

const originalFetch = global.fetch;

function matchingObservation(): ParsedObservation {
  return {
    type: 'security_alert',
    title: 'Matching security alert',
    subtitle: 'Should only notify when alerts are enabled',
    facts: [],
    narrative: null,
    concepts: [],
    files_read: [],
    files_modified: [],
  };
}

function settings(overrides: Partial<SettingsDefaults> = {}): SettingsDefaults {
  return {
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_TELEGRAM_ENABLED: 'true',
    CLAUDE_MEM_TELEGRAM_BOT_TOKEN: 'bot-token',
    CLAUDE_MEM_TELEGRAM_CHAT_ID: 'chat-id',
    CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert',
    CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS: '',
    ...overrides,
  };
}

async function notifyMatchingObservation(): Promise<void> {
  await notifyTelegram({
    observations: [matchingObservation()],
    observationIds: [42],
    project: 'project-a',
    memorySessionId: 'memory-a',
  });
}

describe('Telegram observation alerts', () => {
  afterEach(() => {
    mock.restore();
    global.fetch = originalFetch;
  });

  it('does not send when the observation-alert setting is unset', async () => {
    const configured = settings();
    delete (configured as Partial<SettingsDefaults>).CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED;
    const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) => (
      Promise.resolve(new Response('', { status: 200 }))
    )) as unknown as typeof fetch;
    global.fetch = fetchMock;
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue(configured);

    await notifyMatchingObservation();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send when observation alerts are false', async () => {
    const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) => (
      Promise.resolve(new Response('', { status: 200 }))
    )) as unknown as typeof fetch;
    global.fetch = fetchMock;
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue(settings({
      CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED: 'false',
    }));

    await notifyMatchingObservation();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends once when observation alerts are true and an observation matches', async () => {
    const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) => (
      Promise.resolve(new Response('', { status: 200 }))
    )) as unknown as typeof fetch;
    global.fetch = fetchMock;
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue(settings({
      CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED: 'true',
    }));

    await notifyMatchingObservation();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
