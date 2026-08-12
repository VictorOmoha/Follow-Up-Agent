import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import { validateTwilioSignature } from '../functions/src/twilio';

const token = 'test_auth_token_12345';
const url = 'https://example.com/api/sms/inbound';
const params = { From: '+155****2222', Body: 'hello there', To: '+155****4444' };

describe('Twilio webhook signature validation', () => {
  it('accepts valid signatures and rejects forged or tampered requests', () => {
    const signature = twilio.getExpectedTwilioSignature(token, url, params);
    expect(validateTwilioSignature({ signature, url, params, authToken: token })).toBe(true);
    expect(validateTwilioSignature({ signature: 'forged', url, params, authToken: token })).toBe(false);
    expect(validateTwilioSignature({ signature, url, params: { ...params, Body: 'tampered' }, authToken: token })).toBe(false);
  });
});