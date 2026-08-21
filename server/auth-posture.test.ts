import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAuth, createDashboardSession, verifyDashboardSession, warnIfInsecureAuthPosture } from '../functions/src/auth';

afterEach(() => vi.restoreAllMocks());

describe('production authentication posture', () => {
  it('warns for an open cloud API and stays quiet locally', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(warnIfInsecureAuthPosture({ FUNCTION_TARGET: 'api' } as NodeJS.ProcessEnv)).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warnIfInsecureAuthPosture({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('fails closed in cloud when the API key is missing', () => {
    vi.stubEnv('FUNCTION_TARGET', 'api');
    vi.stubEnv('AGENT_API_KEY', '');
    expect(checkAuth({ headers: {}, url: '/api/state' })).toEqual({
      ok: false,
      status: 503,
      error: 'API authentication is not configured',
    });
    vi.unstubAllEnvs();
  });

  it('accepts a signed dashboard cookie and rejects expired or query-string keys', () => {
    vi.stubEnv('FUNCTION_TARGET', 'api');
    vi.stubEnv('AGENT_API_KEY', 'operator-secret');
    const issuedAt = Date.now();
    const token = createDashboardSession('operator-secret', issuedAt);
    expect(verifyDashboardSession(token, 'operator-secret', issuedAt + 1_000)).toBe(true);
    expect(checkAuth({ headers: { cookie: `follow_up_session=${token}` }, url: '/api/state' })).toEqual({ ok: true });
    expect(checkAuth({ headers: {}, url: '/api/state?key=operator-secret' })).toMatchObject({ ok: false, status: 401 });
    expect(verifyDashboardSession(token, 'operator-secret', issuedAt + 13 * 60 * 60 * 1000)).toBe(false);
    vi.unstubAllEnvs();
  });
});