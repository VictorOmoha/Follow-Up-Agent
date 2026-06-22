import { describe, it, expect } from 'vitest';
import twilio from 'twilio';
import { validateTwilioSignature } from '../functions/src/twilio';

const TOKEN = 'test_auth_token_12345';
const URL = 'https://example.com/api/sms/inbound';
const PARAMS = { From: '+15551112222', Body: 'hello there', To: '+15553334444' };

function sign(params: Record<string, string>) {
  return twilio.getExpectedTwilioSignature(TOKEN, URL, params);
}

describe('validateTwilioSignature', () => {
  it('accepts a correctly signed request', () => {
    expect(validateTwilioSignature({ signature: sign(PARAMS), url: URL, params: PARAMS, authToken: TOKEN })).toBe(true);
  });

  it('rejects a forged signature', () => {
    expect(validateTwilioSignature({ signature: 'totally-bogus', url: URL, params: PARAMS, authToken: TOKEN })).toBe(false);
  });

  it('rejects when the params are tampered after signing', () => {
    const signature = sign(PARAMS);
    expect(validateTwilioSignature({ signature, url: URL, params: { ...PARAMS, Body: 'tampered' }, authToken: TOKEN })).toBe(false);
  });

  it('rejects an empty signature', () => {
    expect(validateTwilioSignature({ signature: '', url: URL, params: PARAMS, authToken: TOKEN })).toBe(false);
  });

  it('returns false when no auth token is available', () => {
    expect(validateTwilioSignature({ signature: sign(PARAMS), url: URL, params: PARAMS, authToken: '' })).toBe(false);
  });
});
