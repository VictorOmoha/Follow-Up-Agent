import { describe, expect, it } from 'vitest';
import { buildGmailOAuthStart } from './gmail-oauth';

describe('gmail oauth readiness', () => {
  it('returns setup_required without secrets when Gmail client id is missing', () => {
    const result = buildGmailOAuthStart({});

    expect(result.status).toBe('setup_required');
    expect(result.missing).toEqual(['GMAIL_CLIENT_ID']);
    expect(JSON.stringify(result)).not.toMatch(/secret|token|password/i);
    expect(result.message).toContain('GMAIL_CLIENT_ID');
  });

  it('builds a Google consent URL with least-privilege Gmail scopes when configured', () => {
    const result = buildGmailOAuthStart({
      clientId: 'client-123.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:8787/api/inboxes/gmail/callback',
      state: 'state_abc',
    });

    expect(result.status).toBe('ready');
    expect(result.provider).toBe('gmail');
    expect(result.scopes).toEqual(['gmail.readonly', 'gmail.send', 'gmail.modify']);
    expect(result.authUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');

    const url = new URL(result.authUrl);
    expect(url.searchParams.get('client_id')).toBe('client-123.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/api/inboxes/gmail/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state_abc');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.modify');
  });
});
