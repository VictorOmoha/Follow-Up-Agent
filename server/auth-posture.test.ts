import { describe, it, expect, vi, afterEach } from 'vitest';
import { warnIfInsecureAuthPosture } from '../functions/src/auth';

afterEach(() => vi.restoreAllMocks());

describe('warnIfInsecureAuthPosture', () => {
  it('warns when running in the cloud without an API key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnIfInsecureAuthPosture({ FUNCTION_TARGET: 'api' } as NodeJS.ProcessEnv)).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('stays quiet when an API key is configured in the cloud', () => {
    expect(warnIfInsecureAuthPosture({ FUNCTION_TARGET: 'api', AGENT_API_KEY: 'secret' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('stays quiet in local dev (no cloud markers)', () => {
    expect(warnIfInsecureAuthPosture({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
