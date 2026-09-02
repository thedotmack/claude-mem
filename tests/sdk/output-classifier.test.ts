import { describe, it, expect } from 'bun:test';
import {
  classifyObserverOutput,
  isAuthFailureObserverOutput,
  isContextOverflowObserverOutput,
  isTransportFailureObserverOutput,
  isQuotaLimitedObserverOutput,
  previewOutput,
} from '../../src/sdk/output-classifier.js';

describe('classifyObserverOutput (plan-11 #2485)', () => {
  it('classifies valid <observation> XML as xml', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>A real finding</title>
    </observation>`;
    expect(classifyObserverOutput(xml)).toBe('xml');
  });

  it('classifies <summary> XML as xml', () => {
    expect(classifyObserverOutput('<summary><request>do x</request></summary>')).toBe('xml');
  });

  it('classifies <skip_summary/> as xml', () => {
    expect(classifyObserverOutput('<skip_summary reason="nothing to do"/>')).toBe('xml');
  });

  it('classifies empty string as idle', () => {
    expect(classifyObserverOutput('')).toBe('idle');
  });

  it('classifies whitespace-only output as idle', () => {
    expect(classifyObserverOutput('   \n\t  ')).toBe('idle');
  });

  it('classifies a non-string as idle (fail-safe)', () => {
    expect(classifyObserverOutput(undefined)).toBe('idle');
    expect(classifyObserverOutput(null)).toBe('idle');
  });

  it('classifies conversational prose as prose', () => {
    expect(classifyObserverOutput('Skipping — repeated log scan with no new findings.')).toBe('prose');
  });

  it('classifies former poison marker strings as ordinary prose', () => {
    expect(classifyObserverOutput('This session has been exhausted, I cannot continue.')).toBe('prose');
    expect(classifyObserverOutput('Error: prompt is too long for this model.')).toBe('prose');
    expect(classifyObserverOutput('I hit the context window, so there is no XML.')).toBe('prose');
  });

  it('does not let former poison markers override XML-shaped output', () => {
    expect(classifyObserverOutput('session exhausted <observation></observation>')).toBe('xml');
  });
});

describe('isQuotaLimitedObserverOutput', () => {
  it('detects Claude weekly-limit prose', () => {
    expect(
      isQuotaLimitedObserverOutput('Claude usage limit reached. Your weekly limit will reset soon.'),
    ).toBe(true);
  });

  it('detects subscription quota prose', () => {
    expect(
      isQuotaLimitedObserverOutput('Your subscription quota has been exhausted. Please try again after it resets.'),
    ).toBe(true);
  });

  it('detects the wordings Claude Code actually writes on a limit hit', () => {
    expect(
      isQuotaLimitedObserverOutput("You've hit your session limit · resets 5:50pm (America/Los_Angeles)"),
    ).toBe(true);
    expect(
      isQuotaLimitedObserverOutput(
        "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
      ),
    ).toBe(true);
    expect(
      isQuotaLimitedObserverOutput(
        "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
      ),
    ).toBe(true);
  });

  it('does not treat XML that mentions a limit as quota prose', () => {
    expect(
      isQuotaLimitedObserverOutput(
        '<observation><title>Hit the session limit while testing</title></observation>',
      ),
    ).toBe(false);
  });

  it('does not treat context-window prose as quota prose', () => {
    expect(
      isQuotaLimitedObserverOutput('I hit the context window and cannot produce valid XML.'),
    ).toBe(false);
  });

  it('does not treat ordinary observer prose as quota prose', () => {
    expect(isQuotaLimitedObserverOutput('No observations to record.')).toBe(false);
  });
});

describe('isAuthFailureObserverOutput', () => {
  it('detects common authentication-failure prose', () => {
    expect(isAuthFailureObserverOutput('Failed to authenticate. API Error: 401')).toBe(true);
    expect(isAuthFailureObserverOutput('Authentication failed with HTTP 403.')).toBe(true);
    expect(isAuthFailureObserverOutput('Authentication failure; please run /login.')).toBe(true);
    expect(isAuthFailureObserverOutput('Please run /login to authenticate again.')).toBe(true);
    expect(isAuthFailureObserverOutput('Authentication required, run /login to continue.')).toBe(true);
    expect(isAuthFailureObserverOutput('401 Unauthorized')).toBe(true);
    expect(isAuthFailureObserverOutput('403 Forbidden')).toBe(true);
    expect(isAuthFailureObserverOutput('Status: 401')).toBe(true);
    expect(isAuthFailureObserverOutput('Request failed with 403')).toBe(true);
  });

  it('does not classify XML, ordinary prose, or unrelated numeric output as auth failure', () => {
    expect(isAuthFailureObserverOutput('<observation><title>HTTP 401</title></observation>')).toBe(false);
    expect(isAuthFailureObserverOutput('The request returned 500 and produced no XML.')).toBe(false);
    expect(isAuthFailureObserverOutput('No observations to record.')).toBe(false);
    expect(isAuthFailureObserverOutput('Please run /login in the observed project instructions.')).toBe(false);
    expect(isAuthFailureObserverOutput('The project authentication guide says to run /login before testing.')).toBe(false);
  });
});

describe('isContextOverflowObserverOutput (#3800)', () => {
  it('recognises the exact wording reported in the field', () => {
    // The reporter logged this verbatim, 2,264 times in one day.
    expect(isContextOverflowObserverOutput('Prompt is too long')).toBe(true);
  });

  it('recognises other provider phrasings of a context-window overflow', () => {
    expect(isContextOverflowObserverOutput('Input is too long')).toBe(true);
    expect(isContextOverflowObserverOutput('The conversation is too long.')).toBe(true);
    expect(isContextOverflowObserverOutput(
      "This model's maximum context length is 200000 tokens."
    )).toBe(true);
    expect(isContextOverflowObserverOutput('context window exceeded')).toBe(true);
    expect(isContextOverflowObserverOutput(
      'Your messages exceed the context window for this model.'
    )).toBe(true);
    expect(isContextOverflowObserverOutput(
      'Please reduce the length of the messages and try again.'
    )).toBe(true);
  });

  it('does not classify XML output as overflow, even when it discusses long prompts', () => {
    expect(isContextOverflowObserverOutput(
      '<observation><title>Prompt is too long</title></observation>'
    )).toBe(false);
    expect(isContextOverflowObserverOutput('<skip_summary/>')).toBe(false);
  });

  it('does not classify empty, unrelated, quota, or auth prose as overflow', () => {
    expect(isContextOverflowObserverOutput('')).toBe(false);
    expect(isContextOverflowObserverOutput('   ')).toBe(false);
    expect(isContextOverflowObserverOutput(42)).toBe(false);
    expect(isContextOverflowObserverOutput('No observations to record.')).toBe(false);
    expect(isContextOverflowObserverOutput('The file is too long to read in one go.')).toBe(false);
    expect(isContextOverflowObserverOutput(
      'You have reached your Claude usage limit. Try again later.'
    )).toBe(false);
    expect(isContextOverflowObserverOutput('Authentication failed; run /login.')).toBe(false);
  });

  it('is disjoint from the quota and auth classifiers on real overflow text', () => {
    const overflow = 'Prompt is too long';
    expect(isContextOverflowObserverOutput(overflow)).toBe(true);
    expect(isQuotaLimitedObserverOutput(overflow)).toBe(false);
    expect(isAuthFailureObserverOutput(overflow)).toBe(false);
  });
});

describe('isTransportFailureObserverOutput (#3752)', () => {
  it('classifies the CLI error the child returns instead of crashing', () => {
    // Verbatim from the issue report.
    expect(isTransportFailureObserverOutput(
      'API Error: Connection refused - a firewall or proxy may be blocking it (ConnectionRefused)'
    )).toBe(true);
  });

  it('classifies the common transport surfaces', () => {
    expect(isTransportFailureObserverOutput('connect ECONNREFUSED 127.0.0.1:443')).toBe(true);
    expect(isTransportFailureObserverOutput('getaddrinfo ENOTFOUND api.anthropic.com')).toBe(true);
    expect(isTransportFailureObserverOutput('fetch failed')).toBe(true);
    expect(isTransportFailureObserverOutput('Error: socket hang up ECONNRESET')).toBe(true);
    expect(isTransportFailureObserverOutput('API Error: 503 Service Unavailable')).toBe(true);
    expect(isTransportFailureObserverOutput('Request failed with 502')).toBe(true);
  });

  // A false positive requeues the batch AND pauses the generator, so the
  // detector has to stay off observer narrative that merely discusses network
  // failure — exactly the kind of thing this project's own observations say.
  it('does not classify observer prose that merely talks about connectivity', () => {
    expect(isTransportFailureObserverOutput(
      'Traced the flake to a proxy that drops idle sockets; the retry now handles the connection reset.'
    )).toBe(false);
    expect(isTransportFailureObserverOutput('No observations to record.')).toBe(false);
    expect(isTransportFailureObserverOutput('')).toBe(false);
    expect(isTransportFailureObserverOutput(null)).toBe(false);
  });

  it('does not steal XML output', () => {
    expect(isTransportFailureObserverOutput(
      '<observation><title>fetch failed on cold start</title></observation>'
    )).toBe(false);
  });

  // 401/403 must keep reaching the auth branch, which gives the user a /login
  // remediation instead of retrying against a provider that will keep refusing.
  it('leaves authentication failures to the auth detector', () => {
    expect(isTransportFailureObserverOutput('API Error: 401 Unauthorized')).toBe(false);
    expect(isTransportFailureObserverOutput('Authentication failed. Please run /login to authenticate.')).toBe(false);
  });
});

describe('previewOutput', () => {
  it('collapses whitespace and trims', () => {
    expect(previewOutput('  hello\n\n  world  ')).toBe('hello world');
  });

  it('truncates long output and reports remaining length', () => {
    const long = 'x'.repeat(300);
    const preview = previewOutput(long, 50);
    expect(preview.startsWith('x'.repeat(50))).toBe(true);
    expect(preview).toContain('+250 chars');
  });

  it('describes non-string input', () => {
    expect(previewOutput(42)).toContain('non-string');
  });
});

describe('isTransportFailureObserverOutput rejects narrative (review on #3752)', () => {
  // The three cases the reviewer reproduced. Each contains a transport term
  // that an unanchored search matched, and each is an ordinary completed
  // observation — confirming it is correct, requeueing it is a retry loop.
  const NARRATIVES = [
    'The observer noted that fetch failed during the previous deploy and the rollback restored service.',
    'The observer documented ECONNRESET on the idle pool and the fix that followed.',
    'The observer recorded that the upstream returned HTTP 503 for four minutes.',
  ];

  for (const prose of NARRATIVES) {
    it(`does not classify: ${prose.slice(0, 44)}…`, () => {
      expect(isTransportFailureObserverOutput(prose)).toBe(false);
    });
  }

  it('still classifies the same terms when they lead the response', () => {
    expect(isTransportFailureObserverOutput('fetch failed')).toBe(true);
    expect(isTransportFailureObserverOutput('ECONNRESET')).toBe(true);
    expect(isTransportFailureObserverOutput('HTTP 503 Service Unavailable')).toBe(true);
    expect(isTransportFailureObserverOutput('503 Service Unavailable')).toBe(true);
    expect(isTransportFailureObserverOutput('socket hang up')).toBe(true);
  });

  it('does not classify a narrative that merely opens with the word error', () => {
    expect(isTransportFailureObserverOutput(
      'Error handling in the fetch layer was reviewed; no changes were needed.'
    )).toBe(false);
  });
});

describe('isTransportFailureObserverOutput separates envelope from diagnosis (review on #3752)', () => {
  // `API Error:` is what the CLI prefixes to everything it failed at. It fronts
  // a dead socket and a rejected request the same way, and the two want
  // opposite handling: the transport branch resets the claimed batch to pending
  // and aborts the session for a later retry, which for a request the server
  // understood and refused is a loop that never terminates.
  const PERSISTENT = [
    'API Error: 400 Bad Request',
    'API Error: invalid model',
    'API Error: model not found: claude-nonexistent',
    'HTTP error: 404 Not Found',
    'Request error: unsupported parameter "max_tokens"',
    'API Error: 422 Unprocessable Entity',
  ];

  for (const output of PERSISTENT) {
    it(`does not requeue a persistent failure: ${output}`, () => {
      expect(isTransportFailureObserverOutput(output)).toBe(false);
    });
  }

  // The same envelope, now naming a condition that means the request never got
  // an answer. These must still requeue.
  const TRANSPORT = [
    'API Error: Connection refused - a firewall or proxy may be blocking it (ConnectionRefused)',
    'API Error: fetch failed',
    'API Error: socket hang up',
    'HTTP error: ETIMEDOUT',
    'Request error: getaddrinfo ENOTFOUND api.anthropic.com',
    'API Error: TLS handshake failed',
    'API Error: 503 Service Unavailable',
    'Request error: 502',
  ];

  for (const output of TRANSPORT) {
    it(`still requeues: ${output}`, () => {
      expect(isTransportFailureObserverOutput(output)).toBe(true);
    });
  }

  // The nouns that ARE the condition need no separate diagnosis — but they do
  // have to be reporting an error rather than naming one.
  it('keeps the self-describing envelopes free of a condition requirement', () => {
    expect(isTransportFailureObserverOutput('Fetch error: upstream closed')).toBe(true);
    expect(isTransportFailureObserverOutput('Network error')).toBe(true);
    expect(isTransportFailureObserverOutput('Connection error - ECONNRESET')).toBe(true);
    expect(isTransportFailureObserverOutput('Connection error: peer reset the stream')).toBe(true);
  });

  // Anchoring does not save the self-describing envelopes: this prose STARTS
  // with the token. Reported on the first round of this branch, and the whole
  // reason the report test exists.
  const ENVELOPE_PROSE = [
    'Connection error handling was reviewed; no changes were needed.',
    'Network error recovery is already covered by the retry wrapper.',
    'Fetch error paths were consolidated into one helper.',
    'API error handling for connection resets was reviewed.',
    'Request error messages now include the socket address.',
  ];

  for (const prose of ENVELOPE_PROSE) {
    it(`does not requeue completed prose: ${prose.slice(0, 40)}…`, () => {
      expect(isTransportFailureObserverOutput(prose)).toBe(false);
    });
  }

  // Punctuation does not make an envelope a report — the narrative can be
  // punctuated too. Reported on this branch after the rebase; the unpunctuated
  // list above was the whole test, so a colon walked straight through it.
  const PUNCTUATED_ENVELOPE_PROSE = [
    'Network error: recovery is already covered by the retry wrapper',
    'Connection error: handling was reviewed, and no changes were needed',
    'Fetch error: paths were consolidated into one helper',
    'Network error: connection handling is being refactored this sprint',
  ];

  for (const prose of PUNCTUATED_ENVELOPE_PROSE) {
    it(`does not requeue punctuated prose: ${prose.slice(0, 40)}…`, () => {
      expect(isTransportFailureObserverOutput(prose)).toBe(false);
    });
  }

  // The API and bare-`Error:` families had the same hole, and a network
  // condition did not close it: the generic noun the prose is *about* is the
  // same noun the condition list is made of.
  const PUNCTUATED_ENVELOPE_PROSE_WITH_CONDITION = [
    'API Error: connection handling was reviewed',
    'HTTP error: the socket timeout has been raised to 30s',
    'Request error: proxy support was added to the client',
    'Error: connection pooling is now handled by the driver',
  ];

  for (const prose of PUNCTUATED_ENVELOPE_PROSE_WITH_CONDITION) {
    it(`does not requeue an explained condition: ${prose.slice(0, 40)}…`, () => {
      expect(isTransportFailureObserverOutput(prose)).toBe(false);
    });
  }

  // The 5xx path is independent of all of this, which is what makes the clause
  // test affordable on the API family: a real server failure is still caught
  // however its prose reads.
  it('still reports a 5xx behind an API envelope, clause or not', () => {
    expect(
      isTransportFailureObserverOutput('API Error: 503 Service Unavailable, the gateway is down')
    ).toBe(true);
    expect(isTransportFailureObserverOutput('Request error: 502')).toBe(true);
  });

  // …and the clause test must not swallow a real failure that happens to be
  // written as one. A concrete failure word re-admits it; a generic network
  // noun deliberately does not, since that is what the prose above is made of.
  it('still reports a clause that names a concrete failure', () => {
    expect(
      isTransportFailureObserverOutput('Connection error: the connection was reset by peer')
    ).toBe(true);
    expect(
      isTransportFailureObserverOutput('Network error: the provider is unreachable')
    ).toBe(true);
    expect(
      isTransportFailureObserverOutput('Fetch error: the request has timed out')
    ).toBe(true);
  });

  // A 4xx must not slip through on the strength of an unrelated number.
  it('does not treat a 4xx as retryable because a 5xx-shaped number appears later', () => {
    expect(isTransportFailureObserverOutput('API Error: 400 Bad Request')).toBe(false);
    expect(isTransportFailureObserverOutput('API Error: 429 Too Many Requests')).toBe(false);
  });
});
