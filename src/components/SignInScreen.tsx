import { type FormEvent, useState } from 'react';
import { api } from '../lib/api';

export function SignInScreen({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [accessKey, setAccessKey] = useState('');
  const [error, setError] = useState('');

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api<void>('/session', { method: 'POST', body: JSON.stringify({ apiKey: accessKey }) });
      setAccessKey('');
      await onSignedIn();
    } catch {
      setError('That access key was not accepted.');
    }
  }

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={signIn}>
        <span className="eyebrow">Omoha Solutions</span>
        <h1>Follow-Up Agent</h1>
        <p>Enter the dashboard access key. It is exchanged for a secure, same-origin session cookie and is not stored in the browser.</p>
        <label className="field">
          <span>Dashboard access key</span>
          <input type="password" autoComplete="current-password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} required />
        </label>
        {error && <span className="error-badge">{error}</span>}
        <button className="button primary" type="submit">Sign in</button>
      </form>
    </main>
  );
}
