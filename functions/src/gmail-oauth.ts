type GmailOAuthConfig = {
  clientId?: string;
  redirectUri?: string;
  state?: string;
  loginHint?: string;
};

const gmailScopeNames = ['gmail.readonly', 'gmail.send', 'gmail.modify'] as const;
const gmailScopes = gmailScopeNames.map((scope) => `https://www.googleapis.com/auth/${scope}`);
const defaultRedirectUri = process.env.GMAIL_REDIRECT_URI || 'http://127.0.0.1:8787/api/inboxes/gmail/callback';

// The mock-auth URL is opened via `window.location.href` on the frontend, so it
// must be absolute when the frontend and API live on different origins (local
// dev: web on :5173, API on :8787) and relative when they share an origin
// (Firebase Hosting rewrites /api/** to the function). Cloud runtimes set one of
// these env vars; local dev sets none, so we fall back to the dev API origin.
function mockAuthBaseUrl(): string {
  if (process.env.OAUTH_PUBLIC_BASE_URL !== undefined) return process.env.OAUTH_PUBLIC_BASE_URL;
  const isCloud = !!(process.env.FUNCTION_TARGET || process.env.FIREBASE_CONFIG || process.env.K_SERVICE);
  return isCloud ? '' : 'http://127.0.0.1:8787';
}

function makeState() {
  return `gmail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function buildGmailOAuthStart(config: GmailOAuthConfig) {
  const state = config.state || makeState();
  const redirectUri = config.redirectUri || defaultRedirectUri;

  if (!config.clientId) {
    if (config.loginHint) {
      const params = new URLSearchParams({
        email: config.loginHint,
        state,
      });
      return {
        status: 'ready' as const,
        provider: 'gmail' as const,
        authUrl: `${mockAuthBaseUrl()}/api/inboxes/gmail/mock-auth?${params.toString()}`,
        redirectUri,
        state,
        scopes: [...gmailScopeNames],
        message: 'Running in Demo/Mock OAuth mode. Set GMAIL_CLIENT_ID in .env for real Google connection.',
      };
    } else {
      return {
        status: 'setup_required' as const,
        provider: 'gmail' as const,
        missing: ['GMAIL_CLIENT_ID'],
        message: 'Set GMAIL_CLIENT_ID before connecting Gmail. Keep credentials server-side and never enter them in the app UI.',
        scopes: [...gmailScopeNames],
      };
    }
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: gmailScopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  if (config.loginHint) {
    params.set('login_hint', config.loginHint);
  }

  return {
    status: 'ready' as const,
    provider: 'gmail' as const,
    authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    redirectUri,
    state,
    scopes: [...gmailScopeNames],
    message: 'Open this Google consent URL to connect Gmail. Authenticated tokens will be securely saved.',
  };
}

export function buildGmailOAuthStartFromEnv(env: NodeJS.ProcessEnv = process.env, loginHint?: string) {
  return buildGmailOAuthStart({
    clientId: env.GMAIL_CLIENT_ID,
    redirectUri: env.GMAIL_REDIRECT_URI,
    loginHint,
  });
}
