import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAuth, warnIfInsecureAuthPosture } from '../functions/src/auth';

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
});