type GmailOAuthConfig = {
  clientId?: string;
  redirectUri?: string;
  state?: string;
};

const gmailScopeNames = ['gmail.readonly', 'gmail.send', 'gmail.modify'] as const;
const gmailScopes = gmailScopeNames.map((scope) => `https://www.googleapis.com/auth/${scope}`);
const defaultRedirectUri = 'http://127.0.0.1:8787/api/inboxes/gmail/callback';

function makeState() {
  return `gmail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function buildGmailOAuthStart(config: GmailOAuthConfig) {
  if (!config.clientId) {
    return {
      status: 'setup_required' as const,
      provider: 'gmail' as const,
      missing: ['GMAIL_CLIENT_ID'],
      message: 'Set GMAIL_CLIENT_ID before connecting Gmail. Keep credentials server-side and never enter them in the app UI.',
      scopes: [...gmailScopeNames],
    };
  }

  const redirectUri = config.redirectUri || defaultRedirectUri;
  const state = config.state || makeState();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: gmailScopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  return {
    status: 'ready' as const,
    provider: 'gmail' as const,
    authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    redirectUri,
    state,
    scopes: [...gmailScopeNames],
    message: 'Open this Google consent URL to connect Gmail. The callback exchange is not enabled until server-side token storage is added.',
  };
}

export function buildGmailOAuthStartFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return buildGmailOAuthStart({
    clientId: env.GMAIL_CLIENT_ID,
    redirectUri: env.GMAIL_REDIRECT_URI,
  });
}
