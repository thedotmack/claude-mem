import { describe, it, expect } from 'bun:test';
import { redactSensitive, redactJsonStrings, loadRedactionConfig, hasRedactionMarker, OVERSIZE_MARKER } from '../../src/utils/redaction.js';

describe('redactSensitive', () => {
  it('returns input unchanged when config.enabled is false', () => {
    const input = 'plain text AKIAIOSFODNN7EXAMPLE more text';
    const result = redactSensitive(input, { enabled: false });
    expect(result.redacted).toBe(input);
    expect(result.counts).toEqual({});
    expect(result.oversize).toBe(false);
  });

  it('returns empty string and empty counts for empty input', () => {
    const result = redactSensitive('', { enabled: true });
    expect(result.redacted).toBe('');
    expect(result.counts).toEqual({});
    expect(result.oversize).toBe(false);
  });
});

describe('redactSensitive built-in patterns', () => {
  const cfg = { enabled: true };

  it.each([
    ['aws_access_key',  'export X=AKIAIOSFODNN7EXAMPLE done',                                          "<redacted type='aws_access_key'/>"],
    ['aws_access_key',  'export AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE done',                          "<redacted type='aws_access_key'/>"],
    ['github_pat',      'token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 trailing',                  "<redacted type='github_pat'/>"],
    ['github_pat',      'oauth: gho_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 tail',                      "<redacted type='github_pat'/>"],
    ['github_pat',      'refresh: ghr_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 tail',                    "<redacted type='github_pat'/>"],
    ['github_pat',      'app user: ghu_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 tail',                   "<redacted type='github_pat'/>"],
    ['openai_key',      'Authorization: Bearer sk-ABCDEFGHIJ1234567890abcdef',                        "<redacted type='openai_key'/>"],
    ['anthropic_key',   'key=sk-ant-api03-abcdef1234567890ABCDEF',                                    "<redacted type='anthropic_key'/>"],
    // Split string literals here and below so GitHub's secret-push-protection
    // scanner doesn't flag these fake test fixtures as real secrets.
    ['slack_token',     'Slack: ' + 'xox' + 'b-1234567890-0987654321-abcdefghijklmnop',             "<redacted type='slack_token'/>"],
    ['jwt',             'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.AbCdEf0123456789',               "<redacted type='jwt'/>"],
    ['stripe_key',      'Stripe ' + 'sk' + '_live_abcdefghijklmnopqrstuvwx',                         "<redacted type='stripe_key'/>"],
    ['stripe_key',      'STRIPE_WEBHOOK_SECRET=' + 'wh' + 'sec_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345 tail', "<redacted type='stripe_key'/>"],
    ['google_api_key',  'key=AIzaSyA-0123456789abcdefghijklmnopqrstu',                                "<redacted type='google_api_key'/>"],
  ])('redacts %s', (name, input, marker) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(marker);
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  // A closing `\b` after a trailing `-` needs a word character to follow, so
  // these keys were missed entirely (Google) or kept their final `-`.
  it.each([
    ['google_api_key', 'key=AIzaSyA-0123456789abcdefghijklmnopqrst- tail', "<redacted type='google_api_key'/>"],
    ['google_api_key', '"AIzaSyA-0123456789abcdefghijklmnopqrst-"', "<redacted type='google_api_key'/>"],
    ['openai_key', 'key=sk-ABCDEFGHIJ1234567890abcdef- tail', "<redacted type='openai_key'/>"],
    ['anthropic_key', 'key=sk-ant-api03-abcdef1234567890ABCDEF- tail', "<redacted type='anthropic_key'/>"],
    ['slack_token', 'Slack: ' + 'xox' + 'b-1234567890-0987654321-abcdefghijklmnop- tail', "<redacted type='slack_token'/>"],
    ['jwt', 'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.AbCdEf0123456789- tail', "<redacted type='jwt'/>"],
  ])('redacts a %s whose last character is a dash', (name, input, marker) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(marker);
    expect(result.redacted).not.toContain('-' + ' tail');
    expect(result.redacted).not.toMatch(/'\/>-/);
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  // Slack also issues app-level tokens (`xapp-`, Socket Mode) and refresh
  // tokens (`xoxe-`, token rotation); both grant access like a bot token.
  it.each([
    ['app-level', 'SLACK_APP_TOKEN=' + 'xa' + 'pp-1-A0123456789-1234567890123-abcdef0123456789abcdef0123456789'],
    ['refresh', 'refresh_token: ' + 'xo' + 'xe-1-My0xLTEyMzQ1Njc4OTAtMTIzNDU2Nzg5MDEyMy1hYmNkZWY'],
  ])('redacts a Slack %s token', (_kind, input) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain("<redacted type='slack_token'/>");
    expect(result.redacted).not.toMatch(/x(?:app|oxe)-1-/);
    expect(Object.keys(result.counts)).toEqual(['slack_token']);
  });

  // Access tokens of the registries a coding agent talks to; fixtures are
  // split so push protection doesn't flag them.
  it.each([
    ['gitlab_token', 'GITLAB_TOKEN=' + 'glp' + 'at-aBcDeFgHiJkLmNoPqRsT tail'],
    ['gitlab_token', 'token ' + 'glp' + 'at-aBcDeFgHiJkLmNoPqRsT_-9.01.0abcdefgh1 tail'],
    ['gitlab_token', 'GITLAB_DEPLOY_TOKEN=' + 'gl' + 'dt-aBcDeFgHiJkLmNoPqRsT tail'],
    ['gitlab_token', 'GITLAB_RUNNER_TOKEN=' + 'gl' + 'rt-aBcDeFgHiJkLmNoPqRsT tail'],
    ['huggingface_token', 'HF_TOKEN=' + 'h' + 'f_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 tail'],
    ['npm_token', '//registry.npmjs.org/:_authToken=' + 'np' + 'm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 tail'],
    ['docker_pat', 'DOCKER_PAT=' + 'dckr_' + 'pat_aBcDeFgHiJkLmNoPqRsTuVwXyZ0 tail'],
    ['docker_pat', 'docker login -u user -p ' + 'dckr_' + 'pat_aBcDeFgHiJkLmNoPqRsTuVwXyZ0 tail'],
  ])('redacts a %s', (name, input) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(`<redacted type='${name}'/>`);
    expect(result.redacted).toMatch(/^.*'\/> tail$/);
    expect(result.redacted).not.toMatch(/gl(?:pat|dt|rt)-|hf_a|npm_a|dckr_pat_/);
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  // A PyPI token is the macaroon after `pypi-`; split for push protection too.
  const pypiMacaroon = 'AgE' + 'IcHlwaS5vcmcCJGQ1ZjE2NzBkLTk0NWUtNGNhYS1iMDhkLTI5ZDc2ZTA1MWQ2YwACKlsz-_9';
  it.each([
    ['password = ' + 'pyp' + 'i-' + pypiMacaroon + ' tail'],
    ['UV_PUBLISH_TOKEN=' + 'pyp' + 'i-' + pypiMacaroon + ' tail'],
    ['twine upload -u __token__ -p ' + 'pyp' + 'i-' + pypiMacaroon + ' tail'],
  ])('redacts a pypi_token in %s', (input) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain("<redacted type='pypi_token'/> tail");
    expect(result.redacted).not.toContain('AgEIcHlwaS5vcmc');
    expect(Object.keys(result.counts)).toEqual(['pypi_token']);
  });

  // Databricks PATs (`dapi` + 32 hex) and HashiCorp Vault service/batch
  // tokens (`hvs.` / `hvb.` + base64url). Fixtures are split for push
  // protection too.
  const DATABRICKS_HEX = '0123456789abcdef'.repeat(2);
  const VAULT_SERVICE_BODY = 'CAESIJ' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-'.repeat(2) + 'aBcDeFgHiJkLmNo';
  const VAULT_BATCH_BODY = 'AAAAAQ' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-'.repeat(4);
  it.each([
    ['databricks_token', 'DATABRICKS_TOKEN=' + 'da' + 'pi' + DATABRICKS_HEX + ' tail'],
    ['databricks_token', 'token = ' + 'da' + 'pi' + DATABRICKS_HEX + '-2 tail'],
    ['databricks_token', '{"token_value": "' + 'da' + 'pi' + DATABRICKS_HEX + '"} tail'],
    ['vault_token', 'VAULT_TOKEN=' + 'hv' + 's.' + VAULT_SERVICE_BODY + ' tail'],
    ['vault_token', 'token                  ' + 'hv' + 's.' + VAULT_SERVICE_BODY + ' tail'],
    ['vault_token', 'export VAULT_TOKEN=' + 'hv' + 'b.' + VAULT_BATCH_BODY + ' tail'],
  ])('redacts a %s', (name, input) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(`<redacted type='${name}'/>`);
    expect(result.redacted).toMatch(/'\/>(?:"\})? tail$/);
    expect(result.redacted).not.toMatch(/dapi0123|hv[sb]\.[A-Z]/);
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  it.each([
    'dapi' + 'short',
    'the dapi' + 'deadbeef helper',
    'da' + 'pi' + DATABRICKS_HEX + 'ff',
    'hv' + 's.' + 'short',
    'hv' + 's.' + VAULT_SERVICE_BODY.repeat(2),
    'hv' + 'b.' + 'aBcDeFgHiJkLmNo',
  ])('leaves %s alone', (input) => {
    expect(redactSensitive(input, cfg).redacted).toBe(input);
  });

  // Two providers claude-mem's own OpenAI-compatible presets onboard users for
  // (src/shared/openai-compat-presets.ts): the NVIDIA NIM hint says the key
  // starts with `nvapi-`, Runcrate's says `rc_live_`. Neither prefix was
  // claimed by openai_key (`sk-`), so such a key pasted into a session was
  // stored verbatim. Fixtures are split for push protection too.
  const NVAPI_BODY = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ' + '0123456789aBcDeFgHiJkLmNoP';
  const RUNCRATE_BODY = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ' + '0123456789aBcDeF';
  it.each([
    ['nvidia_nim_key', 'CLAUDE_MEM_OPENAI_COMPAT_API_KEY=' + 'nva' + 'pi-' + NVAPI_BODY + ' tail'],
    ['nvidia_nim_key', 'curl -H "Authorization: Bearer ' + 'nva' + 'pi-' + NVAPI_BODY + '" tail'],
    ['runcrate_key', 'OPENAI_COMPAT_API_KEY=' + 'rc_' + 'live_' + RUNCRATE_BODY + ' tail'],
    ['runcrate_key', '{"apiKey":"' + 'rc_' + 'live_' + RUNCRATE_BODY + '"} tail'],
  ])('redacts a %s', (name, input) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(`<redacted type='${name}'/>`);
    expect(result.redacted).toMatch(/ tail$/);
    expect(result.redacted).not.toContain('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  // Linear and Notion keys; split for push protection too.
  const LINEAR_BODY = 'aBcDeFgHiJkLmNoPqRsT' + 'uVwXyZ0123456789aBcD';
  const NOTION_BODY = '1234567890aBcDeFgHiJkLmNoPqRsT' + 'uVwXyZ0123456789';
  const NOTION_LEGACY_BODY = 'aBcDeFgHiJkLmNoPqRsTuVw' + 'XyZ0123456789aBcDeFg';
  it.each([
    ['linear_key', 'export LINEAR_API_KEY=' + 'lin_' + 'api_' + LINEAR_BODY + ' tail', LINEAR_BODY],
    ['linear_key', 'curl -H "Authorization: ' + 'lin_' + 'api_' + LINEAR_BODY + '" tail', LINEAR_BODY],
    ['notion_token', 'NOTION_TOKEN=' + 'nt' + 'n_' + NOTION_BODY + ' tail', NOTION_BODY],
    ['notion_token', '{"OPENAPI_MCP_HEADERS":"Bearer ' + 'nt' + 'n_' + NOTION_BODY + '"} tail', NOTION_BODY],
    ['notion_token', 'NOTION_API_KEY=' + 'sec' + 'ret_' + NOTION_LEGACY_BODY + ' tail', NOTION_LEGACY_BODY],
  ])('redacts a %s in %s', (name, input, body) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(`<redacted type='${name}'/>`);
    expect(result.redacted).toMatch(/ tail$/);
    expect(result.redacted).not.toContain(body);
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  it.each([
    'lin_api_short',
    'ntn_short',
    'secret_sauce',
    'the secret_key_base setting',
    'lin_api_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ',
  ])('leaves %s alone', (input) => {
    expect(redactSensitive(input, cfg).redacted).toBe(input);
  });

  // Groq and xAI API keys; split for push protection too.
  const GROQ_BODY = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ' + '0123456789aBcDeFgHiJkLmNoP';
  const XAI_BODY = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcD' + 'eFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgH';
  it.each([
    ['groq_key', 'export GROQ_API_KEY=' + 'gs' + 'k_' + GROQ_BODY + ' tail'],
    ['groq_key', 'curl -H "Authorization: Bearer ' + 'gs' + 'k_' + GROQ_BODY + '" tail'],
    ['xai_key', 'XAI_API_KEY=' + 'xa' + 'i-' + XAI_BODY + ' tail'],
    ['xai_key', '{"apiKey":"' + 'xa' + 'i-' + XAI_BODY + '"} tail'],
  ])('redacts a %s in %s', (name, input) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(`<redacted type='${name}'/>`);
    expect(result.redacted).toMatch(/ tail$/);
    expect(result.redacted).not.toContain('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  it.each([
    'gsk_short',
    'xai-short',
    'the xai-sdk package',
    'gsk_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ',
  ])('leaves %s alone', (input) => {
    expect(redactSensitive(input, cfg).redacted).toBe(input);
  });

  // Perplexity API keys (`pplx-` + 48 alphanumerics); split for push
  // protection like the fixtures above.
  const PPLX_BODY = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' + 'AbCdEfGhIjKl';
  it.each([
    ['perplexity_key', 'export PERPLEXITY_API_KEY=' + 'ppl' + 'x-' + PPLX_BODY + ' tail'],
    ['perplexity_key', 'curl -H "Authorization: Bearer ' + 'ppl' + 'x-' + PPLX_BODY + '" tail'],
    ['perplexity_key', '{"api_key":"' + 'ppl' + 'x-' + PPLX_BODY + '"} tail'],
  ])('redacts a %s in %s', (name, input) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(`<redacted type='${name}'/>`);
    expect(result.redacted).toMatch(/ tail$/);
    expect(result.redacted).not.toContain('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  // Every vendor key printed at the start of a line: the worker scans
  // JSON.stringify(toolResponse), where that newline (or a tab/CR) arrives as
  // the two characters `\n`, which a bare `\b` can't match after. Split
  // literals keep GitHub push protection off these fake fixtures.
  const A36 = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
  const HEX64 = '0123456789abcdef'.repeat(4);
  const AFTER_NEWLINE_KEYS: [string, string][] = [
    ['github_pat', 'gh' + 'p_' + A36],
    ['openai_key', 's' + 'k-ABCDEFGHIJ1234567890abcdef'],
    ['anthropic_key', 's' + 'k-ant-api03-abcdef1234567890ABCDEF'],
    ['slack_token', 'xox' + 'b-1234567890-0987654321-abcdefghijklmnop'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.AbCdEf0123456789'],
    ['stripe_key', 'sk' + '_live_abcdefghijklmnopqrstuvwx'],
    ['google_api_key', 'AI' + 'zaSyA-0123456789abcdefghijklmnopqrstu'],
    ['google_oauth_token', 'ya' + '29.' + A36],
    ['gitlab_token', 'gl' + 'pat-' + 'aBcDeFgHiJkLmNoPqRsT'],
    ['huggingface_token', 'h' + 'f_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567'],
    ['npm_token', 'np' + 'm_' + A36],
    ['docker_pat', 'dckr' + '_pat_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0'],
    ['linear_key', 'lin_' + 'api_' + A36 + 'abcd'],
    ['notion_token', 'nt' + 'n_' + '1234567890' + A36],
    ['sendgrid_key', 'S' + 'G.' + 'aBcDeFgHiJkLmNoPqRsTuV' + '.' + A36 + 'aBcDeFg'],
    ['digitalocean_token', 'do' + 'p_v1_' + HEX64],
    ['shopify_token', 'shp' + 'at_' + HEX64.slice(0, 32)],
    ['pypi_token', 'py' + 'pi-AgE' + A36 + A36],
    ['databricks_token', 'da' + 'pi' + HEX64.slice(0, 32)],
    ['vault_token', 'hv' + 's.' + A36.repeat(3)],
    ['nvidia_nim_key', 'nv' + 'api-' + A36],
    ['runcrate_key', 'rc_' + 'live_' + A36],
    ['groq_key', 'gs' + 'k_' + A36 + 'aBcDeFgHiJkLmNoP'],
    ['xai_key', 'xa' + 'i-' + A36 + A36 + 'aBcDeFgH'],
    ['perplexity_key', 'ppl' + 'x-' + A36 + 'AbCdEfGhIjKl'],
    ['supabase_token', 'sb' + 'p_' + HEX64.slice(0, 40)],
    ['sentry_token', 'sntr' + 'yu_' + HEX64],
    ['claude_mem_key', 'cm' + 'em_' + A36 + 'abcdefg'],
  ];
  it.each(AFTER_NEWLINE_KEYS)('redacts a %s printed right after a newline, raw and JSON-escaped', (name, key) => {
    for (const separator of ['\n', '\t', '\r\n']) {
      const output = `Deployment ready.${separator}${key}`;
      for (const text of [output, JSON.stringify({ stdout: output })]) {
        const result = redactSensitive(text, cfg);
        expect(result.counts[name]).toBe(1);
        expect(result.redacted).not.toContain(key);
      }
      const stored = redactSensitive(JSON.stringify({ stdout: output }), cfg).redacted;
      expect(JSON.parse(stored).stdout).toBe(`Deployment ready.${separator}<redacted type='${name}'/>`);
    }
  });

  it('still leaves a key-shaped run inside a longer word alone', () => {
    const word = 'xgh' + 'p_' + A36;
    expect(redactSensitive(word, cfg).redacted).toBe(word);
    expect(redactSensitive(JSON.stringify({ stdout: `a ${word}` }), cfg).redacted).toBe(JSON.stringify({ stdout: `a ${word}` }));
  });

  // The worker scans JSON.stringify(toolResponse), so a newline right before
  // the key arrives as the two characters `\n`; the `n` is a word character,
  // so a bare `\b` cannot match there and the key survived redaction.
  it('redacts a perplexity_key printed right after a newline (worker capture path)', () => {
    const output = `Deployment ready.\n${'ppl' + 'x-' + PPLX_BODY}`;
    for (const text of [output, JSON.stringify({ stdout: output })]) {
      const result = redactSensitive(text, cfg);
      expect(result.counts.perplexity_key).toBe(1);
      expect(result.redacted).not.toContain(PPLX_BODY);
    }
    const stored = redactSensitive(JSON.stringify({ stdout: output }), cfg).redacted;
    expect(JSON.parse(stored).stdout).toBe(`Deployment ready.\n<redacted type='perplexity_key'/>`);
  });

  // Perplexity model ids share the `pplx-` prefix; their `-`/`.` separators
  // and short bodies keep them out of the 48-alphanumeric key pattern.
  it.each([
    'pplx-embed-v1-4b',
    'pplx-decider-v1.2',
    'the pplx- prefix',
    'pplx_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCdEfGhIjKl',
  ])('leaves %s alone', (input) => {
    expect(redactSensitive(input, cfg).redacted).toBe(input);
  });

  // Supabase and Sentry tokens; split for push protection too.
  const SUPABASE_BODY = '0123456789abcdef0123' + '456789abcdef01234567';
  const SENTRY_USER_BODY = '0123456789abcdef0123456789abcdef' + '0123456789abcdef0123456789abcdef';
  const SENTRY_ORG_PAYLOAD = 'eyJpYXQiOjE3MDAwMDAwMDAuMDAwMDAwLCJ1cmwiOiJodHRwczovL3NlbnRyeS5pbyIs' + 'Im9yZyI6ImV4YW1wbGUtb3JnIn0=';
  const SENTRY_ORG_SECRET = 'aBcDeFgHiJkLmNoPqRsTuVwXy' + 'Z0123456789+/aBcDe';
  it.each([
    ['supabase_token', 'export SUPABASE_ACCESS_TOKEN=' + 'sb' + 'p_' + SUPABASE_BODY + ' tail', SUPABASE_BODY],
    ['supabase_token', '{"env":{"SUPABASE_ACCESS_TOKEN":"' + 'sb' + 'p_' + SUPABASE_BODY + '"}} tail', SUPABASE_BODY],
    ['sentry_token', 'SENTRY_AUTH_TOKEN=' + 'sntr' + 'yu_' + SENTRY_USER_BODY + ' tail', SENTRY_USER_BODY],
    ['sentry_token', 'sentry-cli sourcemaps upload --auth-token ' + 'sntr' + 'ys_' + SENTRY_ORG_PAYLOAD + '_' + SENTRY_ORG_SECRET + ' tail', SENTRY_ORG_SECRET],
    ['sentry_token', '[auth]\ntoken=' + 'sntr' + 'ys_' + SENTRY_ORG_PAYLOAD + '_' + SENTRY_ORG_SECRET + ' tail', SENTRY_ORG_PAYLOAD],
  ])('redacts a %s in %s', (name, input, body) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(`<redacted type='${name}'/>`);
    expect(result.redacted).toMatch(/ tail$/);
    expect(result.redacted).not.toContain(body);
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  it.each([
    'sbp_short',
    'sntryu_short',
    'sntrys_short_token',
    'sbp_' + '0123456789abcdef0123456789abcdef',
    'sntryu_' + '0123456789abcdef0123456789abcdef',
    'the sntrys_ prefix',
  ])('leaves %s alone', (input) => {
    expect(redactSensitive(input, cfg).redacted).toBe(input);
  });

  it.each([
    'glpat-short',
    'gldt-short',
    'glrt-short',
    'hf_short',
    'npm_short',
    'dckr_pat_short',
    'the hf_transformers module',
    'npm_config_cache=/tmp/x',
    'pypi-AgEshort',
    'pypi-simple index',
  ])(
    'leaves %s alone',
    (input) => {
      expect(redactSensitive(input, cfg).redacted).toBe(input);
    },
  );

  // Provider API keys that CLIs and `.env` files print; fixtures are split so
  // push protection doesn't flag them.
  it.each([
    ['sendgrid_key', 'SENDGRID_API_KEY=' + 'S' + 'G.aBcDeFgHiJkLmNoPqRsTuV.aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-aBcDe tail'],
    ['digitalocean_token', 'DIGITALOCEAN_TOKEN=' + 'do' + 'p_v1_' + '0123456789abcdef'.repeat(4) + ' tail'],
    ['digitalocean_token', 'refresh_token: ' + 'do' + 'r_v1_' + 'fedcba9876543210'.repeat(4) + ' tail'],
    ['shopify_token', 'SHOPIFY_ACCESS_TOKEN=' + 'sh' + 'pat_' + '0123456789abcdef'.repeat(2) + ' tail'],
    ['shopify_token', 'secret ' + 'sh' + 'pss_' + 'ABCDEF0123456789'.repeat(2) + ' tail'],
  ])('redacts a %s', (name, input) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(`<redacted type='${name}'/>`);
    expect(result.redacted).toMatch(/^.*'\/> tail$/);
    expect(result.redacted).not.toMatch(/SG\.a|_v1_|shp(?:at|ss)_/);
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  // Google OAuth 2.0 access tokens (`ya29.`), what `gcloud auth
  // print-access-token` and the metadata server print. Split for push
  // protection like the fixtures above.
  it.each([
    ['$ gcloud auth print-access-token\n' + 'ya' + '29.a0AfB_byC1x2Y3z4-W5v6U7t8S9r0QpOnMlKjIhGfEdCbA tail'],
    ['curl -H "Authorization: Bearer ' + 'ya' + '29.a0AfB_byC1x2Y3z4-W5v6U7t8S9r0QpOnMlKjIhGfEdCbA" tail'],
    ['{"access_token":"' + 'ya' + '29.c.Elt0BxAbCdEfGhIjKlMnOpQrStUvWxYz0123456789","expires_in":3599} tail'],
  ])('redacts a google_oauth_token in %s', (input) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain("<redacted type='google_oauth_token'/>");
    expect(result.redacted).toMatch(/ tail$/);
    expect(result.redacted).not.toMatch(/a0AfB_|Elt0Bx/);
    expect(Object.keys(result.counts)).toEqual(['google_oauth_token']);
  });

  it.each(['ya29.short', 'the ya29. prefix'])('leaves %s alone', (input) => {
    expect(redactSensitive(input, cfg).redacted).toBe(input);
  });

  it.each(['SG.short.key', 'dop_v1_short', 'shpat_short', 'the shpat_ prefix'])(
    'leaves %s alone',
    (input) => {
      expect(redactSensitive(input, cfg).redacted).toBe(input);
    },
  );

  // Incoming webhook URLs hold their secret in the last path segment; only
  // that segment is replaced. Fixtures are split so push protection doesn't
  // flag them.
  const SLACK_SECRET = 'aBcDeFgHiJkLmNoP' + 'qRsTuVwX';
  const DISCORD_TOKEN = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ' + '0123456789_-aBcDeFgHiJkLmNoPqRsTuVwXyZ01234';
  it.each([
    ['slack_webhook', 'SLACK_WEBHOOK_URL=https://' + 'hooks.slack' + '.com/services/T01ABCDEF/B02GHIJKL/' + SLACK_SECRET + ' tail',
      "SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/<redacted type='slack_webhook'/> tail"],
    ['slack_webhook', 'curl -X POST https://' + 'hooks.slack' + '.com/workflows/T01ABCDEF/A02GHIJKL/123456789012345678/' + SLACK_SECRET + ' tail',
      "curl -X POST https://hooks.slack.com/workflows/T01ABCDEF/A02GHIJKL/123456789012345678/<redacted type='slack_webhook'/> tail"],
    ['discord_webhook', '{"url":"https://' + 'discord' + '.com/api/webhooks/123456789012345678/' + DISCORD_TOKEN + '"} tail',
      `{"url":"https://discord.com/api/webhooks/123456789012345678/<redacted type='discord_webhook'/>"} tail`],
    ['discord_webhook', 'https://' + 'canary.discordapp' + '.com/api/v10/webhooks/123456789012345678/' + DISCORD_TOKEN + ' tail',
      "https://canary.discordapp.com/api/v10/webhooks/123456789012345678/<redacted type='discord_webhook'/> tail"],
    // DNS host names are case-insensitive, so an upper-case host still posts.
    ['slack_webhook', 'https://' + 'HOOKS.Slack' + '.COM/services/T01ABCDEF/B02GHIJKL/' + SLACK_SECRET,
      "https://HOOKS.Slack.COM/services/T01ABCDEF/B02GHIJKL/<redacted type='slack_webhook'/>"],
    ['discord_webhook', 'https://' + 'Discord' + '.com/api/webhooks/123456789012345678/' + DISCORD_TOKEN,
      "https://Discord.com/api/webhooks/123456789012345678/<redacted type='discord_webhook'/>"],
  ])('redacts the secret of a %s URL', (name, input, expected) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toBe(expected);
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  it.each([
    'https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/short',
    'https://hooks.slack.com/services/',
    'https://discord.com/api/webhooks/123456789012345678/short',
    'https://discord.com/api/webhooks/123456789012345678',
    'https://example.com/services/T01ABCDEF/B02GHIJKL/' + 'aBcDeFgHiJkLmNoPqRsTuVwX',
    // The provider host inside another URL's path is not a webhook host.
    'https://example.com/' + 'hooks.slack' + '.com/services/T01ABCDEF/B02GHIJKL/' + 'aBcDeFgHiJkLmNoPqRsTuVwX',
    'https://example.com/proxy/' + 'discord' + '.com/api/webhooks/123456789012345678/' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ' + '0123456789_-aBcDeFgHiJkLmNoPqRsTuVwXyZ01234',
    'https://mirror.' + 'hooks.slack' + '.com.example.net/x',
  ])('leaves %s alone', (input) => {
    expect(redactSensitive(input, cfg).redacted).toBe(input);
  });

  // A password in a URL's userinfo is what `git remote -v` and a DATABASE_URL
  // print; only the password is replaced.
  it.each([
    ['postgres://app:hunter2pass@db.internal:5432/prod', "postgres://app:<redacted type='url_credentials'/>@db.internal:5432/prod"],
    ['origin https://alice:s3cr3t%21x@git.example.com/org/repo.git (fetch)', "origin https://alice:<redacted type='url_credentials'/>@git.example.com/org/repo.git (fetch)"],
    ['redis://:hunter2pass@localhost:6379/0', "redis://:<redacted type='url_credentials'/>@localhost:6379/0"],
    // A vendor-shaped start must not split the password and leave the rest visible.
    ['https://app:' + 'cm_' + 'pro_abcdefgh!suffix@host/repo', "https://app:<redacted type='url_credentials'/>@host/repo"],
    ['{"url":"mongodb+srv://u:p4ss.w0rd@c0.example.net/db"}', `{"url":"mongodb+srv://u:<redacted type='url_credentials'/>@c0.example.net/db"}`],
  ])('redacts only the password of %s', (input, expected) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toBe(expected);
    expect(Object.keys(result.counts)).toEqual(['url_credentials']);
  });

  it.each([
    'https://example.com:8080/path',
    'https://user@example.com/repo.git',
    'http://localhost:3000/@scope/pkg',
    'postgres://app:${DB_PASS}@db/prod',
    'postgres://app:<password>@db/prod',
  ])('leaves %s alone', (input) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toBe(input);
    expect(result.counts.url_credentials).toBeUndefined();
  });

  it('still requires a Google key to end after its 35 characters', () => {
    const result = redactSensitive('AIzaSyA-0123456789abcdefghijklmnopqrstuv', cfg);
    expect(result.counts.google_api_key).toBeUndefined();
  });

  it('redacts a full PEM private key block', () => {
    const input = `text before
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAxxxx
yyyy
-----END RSA PRIVATE KEY-----
text after`;
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain("<redacted type='private_key_pem'/>");
    expect(result.redacted).toContain('text before');
    expect(result.redacted).toContain('text after');
    expect(result.counts.private_key_pem).toBe(1);
  });

  it('redacts a PGP private key block and an encrypted PKCS#8 key', () => {
    const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF8wP0sBCADH\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----';
    const pkcs8 = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG\n-----END ENCRYPTED PRIVATE KEY-----';
    for (const block of [pgp, pkcs8]) {
      const result = redactSensitive(`text before\n${block}\ntext after`, cfg);
      expect(result.redacted).toBe("text before\n<redacted type='private_key_pem'/>\ntext after");
      expect(result.counts.private_key_pem).toBe(1);
    }
  });

  it('redacts aws_secret_key only when anchored to AWS_SECRET_ACCESS_KEY', () => {
    const anchored = 'AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const r1 = redactSensitive(anchored, cfg);
    expect(r1.counts.aws_secret_key).toBe(1);

    const standalone = 'random base64 abcdefghijklmnopqrstuvwxyz0123456789ABCD here';
    const r2 = redactSensitive(standalone, cfg);
    expect(r2.counts.aws_secret_key).toBeUndefined();
  });

  it('redacts aws_secret_key under the lowercase key of the AWS credentials file', () => {
    const credentials = '[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n';
    const result = redactSensitive(credentials, cfg);
    expect(result.redacted).toBe("[default]\naws_access_key_id = <redacted type='aws_access_key'/>\naws_secret_access_key = <redacted type='aws_secret_key'/>\n");

    const sdkArgument = "boto3.client('s3', aws_secret_access_key='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')";
    expect(redactSensitive(sdkArgument, cfg).counts.aws_secret_key).toBe(1);
  });

  it('redacts the SecretAccessKey of aws sts JSON output', () => {
    const marker = "<redacted type='aws_secret_key'/>";
    const stsJson = '{"Credentials": {"AccessKeyId": "ASIAIOSFODNN7EXAMPLE", "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "Expiration": "2026-10-26T00:00:00Z"}}';
    const result = redactSensitive(stsJson, cfg);
    expect(result.redacted).toBe(`{"Credentials": {"AccessKeyId": "<redacted type='aws_access_key'/>", "SecretAccessKey": "${marker}", "Expiration": "2026-10-26T00:00:00Z"}}`);
    expect(result.counts.aws_secret_key).toBe(1);

    // JSON-escaped, as the worker scans JSON.stringify(toolInput), and the
    // env-style key written as a JSON property.
    expect(redactSensitive(JSON.stringify(stsJson), cfg).counts.aws_secret_key).toBe(1);
    expect(redactSensitive('{"AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}', cfg).redacted)
      .toBe(`{"AWS_SECRET_ACCESS_KEY": "${marker}"}`);
  });

  it('redacts a SecretAccessKey value stored apart from its key', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const marker = "<redacted type='aws_secret_key'/>";
    expect(redactJsonStrings({ Credentials: { SecretAccessKey: secret } }, cfg)).toEqual({ Credentials: { SecretAccessKey: marker } });
    expect(redactJsonStrings({ env: { AWS_SECRET_ACCESS_KEY: secret } }, cfg)).toEqual({ env: { AWS_SECRET_ACCESS_KEY: marker } });
    expect(redactJsonStrings({ SecretAccessKey: 'changeme' }, cfg)).toEqual({ SecretAccessKey: 'changeme' });
    const disabled = { enabled: true, disabledBuiltinPatterns: ['aws_secret_key'] };
    expect(redactJsonStrings({ SecretAccessKey: secret }, disabled)).toEqual({ SecretAccessKey: secret });
  });

  it('redacts the AWS session token of temporary credentials', () => {
    const token = 'IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQDexample+sessiontokenvalue0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij==';
    const marker = "<redacted type='aws_session_token'/>";

    const env = `export AWS_SESSION_TOKEN=${token}\n`;
    expect(redactSensitive(env, cfg).redacted).toBe(`export AWS_SESSION_TOKEN=${marker}\n`);

    const credentials = `[default]\naws_session_token = ${token}\n`;
    expect(redactSensitive(credentials, cfg).redacted).toBe(`[default]\naws_session_token = ${marker}\n`);

    const stsJson = `{"Credentials": {"SessionToken": "${token}", "Expiration": "2026-10-26T00:00:00Z"}}`;
    const result = redactSensitive(stsJson, cfg);
    expect(result.redacted).toBe(`{"Credentials": {"SessionToken": "${marker}", "Expiration": "2026-10-26T00:00:00Z"}}`);
    expect(result.counts.aws_session_token).toBe(1);

    // JSON-escaped, as the worker scans JSON.stringify(toolInput).
    expect(redactSensitive(JSON.stringify(stsJson), cfg).counts.aws_session_token).toBe(1);

    // Short placeholders and unanchored base64 stay as written.
    expect(redactSensitive('AWS_SESSION_TOKEN=changeme', cfg).counts.aws_session_token).toBeUndefined();
    expect(redactSensitive(`random ${token} here`, cfg).counts.aws_session_token).toBeUndefined();
  });

  describe('AWS session token in structured payloads (generic patterns off)', () => {
    const token = 'IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQDexample+sessiontokenvalue0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij==';
    const marker = "<redacted type='aws_session_token'/>";

    it('redacts a nested SessionToken value stored apart from its key', () => {
      const event = { Credentials: { AccessKeyId: 'not-a-key', SessionToken: token, Expiration: '2026-10-26T00:00:00Z' } };
      expect(redactJsonStrings(event, cfg)).toEqual({
        Credentials: { AccessKeyId: 'not-a-key', SessionToken: marker, Expiration: '2026-10-26T00:00:00Z' },
      });
    });

    it('redacts aws_session_token and AWS_SESSION_TOKEN keys', () => {
      expect(redactJsonStrings({ profile: { aws_session_token: token } }, cfg)).toEqual({ profile: { aws_session_token: marker } });
      expect(redactJsonStrings({ env: { AWS_SESSION_TOKEN: token } }, cfg)).toEqual({ env: { AWS_SESSION_TOKEN: marker } });
    });

    it('keeps a short value under the same key as written', () => {
      expect(redactJsonStrings({ SessionToken: 'changeme' }, cfg)).toEqual({ SessionToken: 'changeme' });
    });

    it('keeps the value as written when aws_session_token is a disabled built-in', () => {
      const disabled = { enabled: true, disabledBuiltinPatterns: ['aws_session_token'] };
      expect(redactJsonStrings({ SessionToken: token }, disabled)).toEqual({ SessionToken: token });
    });
  });

  it('does NOT match near-miss strings', () => {
    const negatives = [
      'sk-short',                                  // openai_key too short
      'AKIA12345',                                 // aws_access_key too short
      'ghp_short',                                 // github_pat too short
      'whsec_xxx',                                 // stripe_key webhook placeholder under the 32-char floor
      'eyJhbGciOiJIUzI1NiJ9 some text',            // jwt missing 2nd/3rd segment
      '-----BEGIN PUBLIC KEY-----\nfoo\n-----END PUBLIC KEY-----',  // PEM but not PRIVATE
    ];
    for (const input of negatives) {
      const result = redactSensitive(input, cfg);
      expect(Object.keys(result.counts)).toHaveLength(0);
    }
  });
});

// Issue #4745: the vendor-shaped built-ins missed generic credentials such as
// `password=…`, `*_TOKEN=…` / `*_SECRET=…` / `*_API_KEY=…` and
// `Authorization: Bearer …`. The generic built-ins run AFTER every vendor
// pattern, so a vendor-shaped value keeps its specific marker (pinned by the
// `Authorization: Bearer sk-…` case above).
describe('redactSensitive generic built-in patterns', () => {
  const cfg = { enabled: true, genericEnabled: true };

  it.each([
    ['shell assignment',      'login password=Hunter22Example done',        'Hunter22Example'],
    ['yaml value',            'db_password: hunter22Example',               'hunter22Example'],
    ['json style',            '{"password": "hunter22Example"}',            'hunter22Example'],
    ['quoted shell value',    "set DB_PASSWD='hunter22Example' here",       'hunter22Example'],
    ['uppercase key',         'DB_PASSWORD=Sup3rSecretValue',               'Sup3rSecretValue'],
  ])('generic_password redacts a %s', (_style, input, secret) => {
    const result = redactSensitive(input, cfg);
    expect(result.counts.generic_password).toBe(1);
    expect(result.redacted).not.toContain(secret);
  });

  it.each([
    ['json style',   '{"client_secret": "GOCSPXabc12345"}',   'GOCSPXabc12345'],
    ['shell export', 'export AUTH_TOKEN=abc12345defghi',      'abc12345defghi'],
    ['yaml value',   'MY_API_KEY: uvwxyz123456',              'uvwxyz123456'],
    // Bare key names, which redactJsonStrings already pairs as structured
    // keys, but only in config-shaped positions (see the code lookalikes below).
    ['bare api_key',           'api_key=uvwxyz123456',                        'uvwxyz123456'],
    ['bare export secret',     'export secret=uvwxyz123456',                  'uvwxyz123456'],
    ['bare query token',       'curl https://x.test/api?token=abc12345defghi', 'abc12345defghi'],
    ['bare json secret',       '{"secret": "GOCSPXabc12345"}',                'GOCSPXabc12345'],
    ['bare escaped json token', String.raw`{\"token\": \"abc12345defghi\"}`,  'abc12345defghi'],
    ['bare yaml token',        'token: abc12345defghi',                       'abc12345defghi'],
    ['bare nested yaml token', 'auth:\n  token: abc12345defghi\n  user: me',  'abc12345defghi'],
    ['bare escaped yaml token', String.raw`auth:\n  token: abc12345defghi\n`, 'abc12345defghi'],
    ['bare --token= flag',     'cli login --token=abc12345defghi',            'abc12345defghi'],
    ['bare --api-key flag',    'cli login --api-key abc12345defghi',          'abc12345defghi'],
    ['prefixed --auth-token flag',    'npm publish --auth-token abc12345defghi',  'abc12345defghi'],
    ['prefixed --client-secret= flag', 'az login --client-secret=abc12345defghi', 'abc12345defghi'],
    ['prefixed --hf-token flag',      'cli download --hf-token abc12345defghi',   'abc12345defghi'],
  ])('generic_token redacts a %s', (_style, input, secret) => {
    // The worker scans tool output as JSON.stringify(response), so each
    // position must also hold as the start of a stringified value.
    for (const text of [input, JSON.stringify({ stdout: input })]) {
      const result = redactSensitive(text, cfg);
      expect(result.counts.generic_token).toBe(1);
      expect(result.redacted).not.toContain(secret);
    }
  });

  it.each([
    ['in a curl header', 'curl -H "Authorization: Bearer abc12345defghi" https://x', 'abc12345defghi'],
    ['lowercase header', 'authorization: bearer ABCDEFGH123456',                     'ABCDEFGH123456'],
  ])('bearer_token redacts a %s', (_style, input, secret) => {
    const result = redactSensitive(input, cfg);
    expect(result.counts.bearer_token).toBe(1);
    expect(result.redacted).not.toContain(secret);
  });

  it.each([
    ['in a curl header', 'curl -H "Authorization: Basic dXNlcjpodW50ZXIy" https://x', 'dXNlcjpodW50ZXIy'],
    ['lowercase header', 'proxy-authorization: basic YWxhZGRpbjpvcGVuc2VzYW1l',     'YWxhZGRpbjpvcGVuc2VzYW1l'],
  ])('basic_auth redacts a %s', (_style, input, secret) => {
    for (const text of [input, JSON.stringify({ stdout: input })]) {
      const result = redactSensitive(text, cfg);
      expect(result.counts.basic_auth).toBe(1);
      expect(result.redacted).not.toContain(secret);
    }
  });

  it('basic_auth leaves prose and short or numeric values alone', () => {
    for (const text of ['Basic configuration is covered below', 'Authorization: Basic', 'Authorization: Basic 12345678']) {
      expect(redactSensitive(text, cfg).redacted).toBe(text);
    }
  });

  it('does NOT redact numeric, short or non-secret lookalikes', () => {
    const inputs = [
      'password=12345678',        // purely numeric
      'password=abc',             // under the 8-char minimum
      'max_tokens=4096',          // `_TOKENS`, not `*_TOKEN`
      'tokens=abcdefghij',        // `tokens`, not `token`
      'csrftoken=abcdefghij',     // no `_` before `token`, as for structured keys
      '--token-file /home/me/token.txt', // the flag names a file, not the token
      '--max-tokens abcdefghij',  // `tokens`, not `token`
      'nosecret=abcdefghij',
      // Source code that names a bare token/secret: only config-shaped
      // positions (quoted JSON keys, env assignments, flags, yaml lines)
      // count for the bare key names.
      'const token = getToken();',
      'token: TokenType;',
      'interface Auth {\n  token: TokenType;\n  secret: SecretValue;\n}',
      'secret = process.env.SECRET',
      'let token = req.headers.authorization',
      'the next token: undefined',
      'headers = {"token": api_token_value}',
      'if (x) token=getAuthToken()',
      'max_password_length=32',  // the key merely contains "password"
      'Bearer 12345678',          // numeric, and not anchored to Authorization
      'AUTH_TOKEN=short',         // under the minimum
      'PWD=/Users/x/project',     // the working directory, not a password
      'OLDPWD=/tmp/a',
      'declare -x PWD="/home/someone/projects/app"',
    ];
    for (const input of inputs.flatMap((raw) => [raw, JSON.stringify({ stdout: raw })])) {
      const result = redactSensitive(input, cfg);
      expect(result.redacted).toBe(input);
      expect(Object.keys(result.counts)).toHaveLength(0);
    }
  });

  it('still redacts a vendor-shaped value with only its specific marker', () => {
    const result = redactSensitive('Authorization: Bearer sk-ABCDEFGHIJ1234567890abcdef', cfg);
    expect(Object.keys(result.counts)).toEqual(['openai_key']);
  });

  it('lets a generic built-in be disabled by name while vendor patterns stay on', () => {
    const result = redactSensitive('password=Hunter22Example AKIAIOSFODNN7EXAMPLE', {
      enabled: true,
      genericEnabled: true,
      disabledBuiltinPatterns: ['generic_password'],
    });
    expect(result.redacted).toContain('Hunter22Example');
    expect(result.counts.generic_password).toBeUndefined();
    expect(result.counts.aws_access_key).toBe(1);
  });

  it('is idempotent on its own markers', () => {
    const r1 = redactSensitive('echo password=Hunter22Example', cfg);
    expect(r1.counts.generic_password).toBe(1);
    const r2 = redactSensitive(r1.redacted, cfg);
    expect(r2.redacted).toBe(r1.redacted);
    expect(r2.counts).toEqual({});
  });

  it('redacts generic credentials flowing through redactJsonStrings', () => {
    const payload = { tool_input: { command: 'echo password=Hunter22Example' } };
    const result = redactJsonStrings(payload, cfg);
    expect(JSON.stringify(result)).not.toContain('Hunter22Example');
  });

  it('redacts DB_PWD-style keys', () => {
    const result = redactSensitive('MYSQL_PWD=Hunter22Example mysql -u root', cfg);
    expect(result.counts.generic_password).toBe(1);
    expect(result.redacted).not.toContain('Hunter22Example');
  });

  // The worker scans stripMemoryTags(JSON.stringify(toolInput)), so quotes
  // inside a command arrive backslash-escaped.
  it.each([
    ['escaped shell quotes', { command: 'echo DB_PASSWORD="Sup3rSecretValue"' }, 'Sup3rSecretValue', 'generic_password'],
    ['escaped JSON body',    { command: `curl -d '{"password":"Hunter22Example"}'` }, 'Hunter22Example', 'generic_password'],
    ['escaped JSON token',   { command: `curl -d '{"client_secret": "GOCSPXabc12345"}'` }, 'GOCSPXabc12345', 'generic_token'],
    ['escaped bearer',       { headers: { Authorization: 'Bearer abc12345defghi' } }, 'abc12345defghi', 'bearer_token'],
  ])('redacts inside a JSON-stringified payload: %s', (_style, payload, secret, name) => {
    const serialized = JSON.stringify(payload);
    const result = redactSensitive(serialized, cfg);
    expect(result.counts[name]).toBe(1);
    expect(result.redacted).not.toContain(secret);
    expect(() => JSON.parse(result.redacted)).not.toThrow();
  });

  it('is off unless genericEnabled is set, while the vendor patterns stay on', () => {
    const input = 'password=Hunter22Example AUTH_TOKEN=abc12345defghi AKIAIOSFODNN7EXAMPLE';
    const result = redactSensitive(input, { enabled: true });
    expect(result.redacted).toContain('Hunter22Example');
    expect(result.redacted).toContain('abc12345defghi');
    expect(Object.keys(result.counts)).toEqual(['aws_access_key']);
    expect(JSON.stringify(redactJsonStrings({ client_secret: 'GOCSPXabc12345' }, { enabled: true })))
      .toContain('GOCSPXabc12345');
  });

  it('redacts a credential-named key whose value sits apart from it (structured events)', () => {
    const event = { client_secret: 'GOCSPXabc12345', nested: [{ db_password: 'Hunter22Example' }], token: 'abc12345defghi' };
    const result = redactJsonStrings(event, cfg) as typeof event;
    expect(result.client_secret).toBe("<redacted type='generic_token'/>");
    expect(result.nested[0].db_password).toBe("<redacted type='generic_password'/>");
    expect(result.token).toBe("<redacted type='generic_token'/>");
  });

  it('redacts the bearer token of an Authorization header object (structured events)', () => {
    const event = { request: { headers: { Authorization: 'Bearer abc12345defghi', accept: 'application/json' } }, authorization: 'bearer ABCDEFGH123456' };
    const result = redactJsonStrings(event, cfg) as typeof event;
    expect(result.request.headers.Authorization).toBe("Bearer <redacted type='bearer_token'/>");
    expect(result.request.headers.accept).toBe('application/json');
    expect(result.authorization).toBe("bearer <redacted type='bearer_token'/>");
  });

  it.each([
    ['trailing whitespace', 'Bearer abc12345defghi \n', "Bearer <redacted type='bearer_token'/> \n"],
    ['leading whitespace',  '  Bearer abc12345defghi',  "  Bearer <redacted type='bearer_token'/>"],
    ['text after the token', 'Bearer abc12345defghi, realm="api"', "Bearer <redacted type='bearer_token'/>, realm=\"api\""],
  ])('redacts an Authorization header object value with %s', (_style, value, expected) => {
    const result = redactJsonStrings({ headers: { Authorization: value } }, cfg) as { headers: { Authorization: string } };
    expect(result.headers.Authorization).toBe(expected);
    expect(redactSensitive(`Authorization: ${value}`, cfg).redacted).toBe(`Authorization: ${expected}`);
  });

  it('redacts the Basic credentials of an Authorization header object (structured events)', () => {
    const event = { headers: { Authorization: 'Basic dXNlcjpodW50ZXIy', accept: 'application/json' } };
    const result = redactJsonStrings(event, cfg) as typeof event;
    expect(result.headers.Authorization).toBe("Basic <redacted type='basic_auth'/>");
    expect(result.headers.accept).toBe('application/json');
    const off = { ...cfg, disabledBuiltinPatterns: ['basic_auth'] };
    expect(redactJsonStrings(event, off)).toEqual(event);
    expect(redactJsonStrings(event, { enabled: true })).toEqual(event);
  });

  it.each([
    ['Basic',  'Basic dXNlcjpodW50ZXIy',  "Basic <redacted type='basic_auth'/>"],
    ['Bearer', 'Bearer abc12345defghi',   "Bearer <redacted type='bearer_token'/>"],
  ])('redacts the %s credentials of a Proxy-Authorization header object (structured events)', (_scheme, value, expected) => {
    for (const key of ['Proxy-Authorization', 'proxy-authorization']) {
      expect(redactJsonStrings({ [key]: value }, cfg)).toEqual({ [key]: expected });
      expect(redactJsonStrings({ [key]: value }, { enabled: true })).toEqual({ [key]: value });
    }
  });

  it('leaves non-secret or opted-out Authorization header values alone', () => {
    expect(redactJsonStrings({ Authorization: 'Bearer 12345678' }, cfg)).toEqual({ Authorization: 'Bearer 12345678' });
    expect(redactJsonStrings({ Authorization: 'Basic' }, cfg)).toEqual({ Authorization: 'Basic' });
    expect(redactJsonStrings({ note: 'Bearer abc12345defghi' }, cfg)).toEqual({ note: 'Bearer abc12345defghi' });
    const off = { ...cfg, disabledBuiltinPatterns: ['bearer_token'] };
    expect(redactJsonStrings({ Authorization: 'Bearer abc12345defghi' }, off)).toEqual({ Authorization: 'Bearer abc12345defghi' });
    expect(redactJsonStrings({ Authorization: 'Bearer abc12345defghi' }, { enabled: true })).toEqual({ Authorization: 'Bearer abc12345defghi' });
    expect(redactJsonStrings({ Authorization: 'Bearer sk-ABCDEFGHIJ1234567890abcdef' }, cfg))
      .toEqual({ Authorization: "Bearer <redacted type='openai_key'/>" });
  });

  it('pairs the same password key spellings as the text pattern (structured events)', () => {
    const event = { env: { MYSQL_PWD: 'Hunter22Example', PGPASSWORD: 'Sup3rSecretValue' }, dbPassword: 'Hunter22Example', PWD: '/home/user/project' };
    const result = redactJsonStrings(event, cfg) as typeof event;
    expect(result.env.MYSQL_PWD).toBe("<redacted type='generic_password'/>");
    expect(result.env.PGPASSWORD).toBe("<redacted type='generic_password'/>");
    expect(result.dbPassword).toBe("<redacted type='generic_password'/>");
    expect(result.PWD).toBe('/home/user/project');
    for (const [key, value] of [['MYSQL_PWD', 'Hunter22Example'], ['PGPASSWORD', 'Sup3rSecretValue'], ['dbPassword', 'Hunter22Example']]) {
      expect(redactSensitive(`${key}=${value}`, cfg).counts.generic_password).toBe(1);
    }
  });

  it('leaves non-secret values under credential-named keys alone', () => {
    const event = { max_tokens: 'abcdefghij', password: '12345678', session_token: 'short', api_key: 'sk-ABCDEFGHIJ1234567890abcdef' };
    const result = redactJsonStrings(event, cfg) as typeof event;
    expect(result.max_tokens).toBe('abcdefghij');
    expect(result.password).toBe('12345678');
    expect(result.session_token).toBe('short');
    expect(result.api_key).toBe("<redacted type='openai_key'/>");
    const disabled = redactJsonStrings({ client_secret: 'GOCSPXabc12345' }, { ...cfg, disabledBuiltinPatterns: ['generic_token'] });
    expect(disabled.client_secret).toBe('GOCSPXabc12345');
  });

  it('stays linear on long whitespace runs (no quadratic lookbehind)', () => {
    const padded = `password=${' '.repeat(200_000)}AWS_SECRET_ACCESS_KEY${' '.repeat(200_000)}=x`;
    const started = performance.now();
    redactSensitive(padded, cfg);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('redactSensitive custom patterns', () => {
  it('applies a valid custom pattern', () => {
    const result = redactSensitive(
      'reference: INTERNAL-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 done',
      {
        enabled: true,
        customPatterns: [
          { name: 'company_token', regex: 'INTERNAL-[A-Z0-9]{32}' },
        ],
      },
    );
    expect(result.redacted).toContain("<redacted type='company_token'/>");
    expect(result.counts.company_token).toBe(1);
  });

  it('runs custom patterns BEFORE built-ins (custom wins on overlap)', () => {
    // Custom pattern shadows the AKIA prefix
    const result = redactSensitive(
      'override AKIAIOSFODNN7EXAMPLE end',
      {
        enabled: true,
        customPatterns: [{ name: 'my_aws', regex: 'AKIA[0-9A-Z]{16}' }],
      },
    );
    expect(result.redacted).toContain("<redacted type='my_aws'/>");
    expect(result.counts.my_aws).toBe(1);
    expect(result.counts.aws_access_key).toBeUndefined();
  });

  it('skips a custom pattern with an invalid regex without throwing', () => {
    const result = redactSensitive(
      'AKIAIOSFODNN7EXAMPLE here',
      {
        enabled: true,
        customPatterns: [
          { name: 'broken', regex: '(unclosed[group' },
          { name: 'ok',     regex: 'here' },
        ],
      },
    );
    expect(result.redacted).toContain("<redacted type='ok'/>");
    expect(result.redacted).toContain("<redacted type='aws_access_key'/>");
    expect(result.counts.broken).toBeUndefined();
  });

  it('skips a custom pattern with empty/missing name', () => {
    const result = redactSensitive(
      'AKIAIOSFODNN7EXAMPLE foo',
      {
        enabled: true,
        customPatterns: [{ name: '', regex: 'foo' }],
      },
    );
    expect(result.redacted).toContain("<redacted type='aws_access_key'/>");
    expect(result.redacted).toContain('foo'); // unredacted because pattern was skipped
  });
});

describe('redactSensitive robustness', () => {
  it('fails closed on an input over the 1M-char cap: the whole field becomes an oversize marker', () => {
    const huge = 'a'.repeat(1024 * 1024 + 1);
    const result = redactSensitive(huge + ' AKIAIOSFODNN7EXAMPLE', { enabled: true });
    expect(result.redacted).toBe(OVERSIZE_MARKER);
    expect(result.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.oversize).toBe(true);
    expect(result.counts).toEqual({ oversize: 1 });
  });

  it('redacts every match, with no cap that would let the tail through', () => {
    const oneKey = 'AKIAIOSFODNN7EXAMPLE ';
    const input = oneKey.repeat(500);
    const result = redactSensitive(input, { enabled: true });
    const placeholderCount = (result.redacted.match(/<redacted type='aws_access_key'\/>/g) ?? []).length;
    expect(placeholderCount).toBe(500);
    expect(result.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.counts.aws_access_key).toBe(500);
  });

  it("redacts claude-mem's own server and Pro keys", () => {
    const serverKey = 'cmem_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';
    const input = `CLAUDE_MEM_SERVER_API_KEY=${serverKey} pro=cm_pro_abcDEF123456xyz`;
    const result = redactSensitive(input, { enabled: true });
    expect(result.redacted).toBe(
      "CLAUDE_MEM_SERVER_API_KEY=<redacted type='claude_mem_key'/> pro=<redacted type='claude_mem_key'/>",
    );
  });

  it('detects raw and XML-escaped markers so prompts explain them only when present', () => {
    expect(hasRedactionMarker("key <redacted type='jwt'/> here")).toBe(true);
    expect(hasRedactionMarker('key &lt;redacted type=&apos;jwt&apos;/&gt; here')).toBe(true);
    expect(hasRedactionMarker('nothing redacted')).toBe(false);
  });

  it('is idempotent: running twice produces the same output', () => {
    const input = 'a AKIAIOSFODNN7EXAMPLE b ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 c';
    const r1 = redactSensitive(input, { enabled: true });
    const r2 = redactSensitive(r1.redacted, { enabled: true });
    expect(r2.redacted).toBe(r1.redacted);
    expect(r2.counts).toEqual({});
  });
});

describe('loadRedactionConfig', () => {
  function settingsFrom(overrides: Record<string, string>): any {
    return {
      CLAUDE_MEM_REDACT_ENABLED: 'false',
      CLAUDE_MEM_REDACT_DISABLED_BUILTINS: '',
      CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '[]',
      CLAUDE_MEM_REDACT_LOG_MATCHES: 'false',
      ...overrides,
    };
  }

  it('parses enabled and logMatches as booleans', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_ENABLED: 'true',
      CLAUDE_MEM_REDACT_LOG_MATCHES: 'true',
    }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.logMatches).toBe(true);
  });

  it('keeps the generic group off by default and on with CLAUDE_MEM_REDACT_GENERIC_ENABLED=true', () => {
    expect(loadRedactionConfig(settingsFrom({ CLAUDE_MEM_REDACT_ENABLED: 'true' })).genericEnabled).toBe(false);
    expect(loadRedactionConfig(settingsFrom({ CLAUDE_MEM_REDACT_GENERIC_ENABLED: 'true' })).genericEnabled).toBe(true);
  });

  it('splits CSV of disabled built-ins', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_DISABLED_BUILTINS: 'jwt, slack_token ,  ',
    }));
    expect(cfg.disabledBuiltinPatterns).toEqual(['jwt', 'slack_token']);
  });

  it('parses customPatterns as JSON', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '[{"name":"foo","regex":"bar"}]',
    }));
    expect(cfg.customPatterns).toEqual([{ name: 'foo', regex: 'bar' }]);
  });

  it('falls back to empty list on malformed customPatterns JSON', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '{not valid json',
    }));
    expect(cfg.customPatterns).toEqual([]);
  });
});
