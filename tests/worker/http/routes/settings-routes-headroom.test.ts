import { describe, expect, it } from 'bun:test';
import { validateHeadroomUrlSetting } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';

describe('SettingsRoutes Headroom URL validation', () => {
  it('accepts empty defaults and HTTP(S) proxy URLs', () => {
    expect(validateHeadroomUrlSetting(undefined)).toBeNull();
    expect(validateHeadroomUrlSetting('')).toBeNull();
    expect(validateHeadroomUrlSetting('   ')).toBeNull();
    expect(validateHeadroomUrlSetting('http://127.0.0.1:8787')).toBeNull();
    expect(validateHeadroomUrlSetting('https://headroom.example.test/proxy')).toBeNull();
  });

  it('rejects unsupported schemes, credentials, invalid ports, and non-strings', () => {
    expect(validateHeadroomUrlSetting('file:///tmp/headroom.sock')).toContain('http:// or https://');
    expect(validateHeadroomUrlSetting('http://user:secret@127.0.0.1:8787')).toContain('must not include credentials');
    expect(validateHeadroomUrlSetting('http://127.0.0.1:8787?mode=proxy')).toContain('query string or fragment');
    expect(validateHeadroomUrlSetting('http://127.0.0.1:0')).toContain('port must be between');
    expect(validateHeadroomUrlSetting('not a url')).toContain('valid URL');
    expect(validateHeadroomUrlSetting(8787)).toContain('string URL');
  });
});
