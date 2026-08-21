const defaultApiBase = (() => {
  const { protocol, hostname } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `${protocol}//127.0.0.1:8787/api`;
  }
  return '/api';
})();

export const API_BASE = import.meta.env.VITE_API_BASE_URL || defaultApiBase;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function webhookEndpoint(path = '/webhooks/lead'): string {
  if (API_BASE.startsWith('http')) return `${API_BASE}${path}`;
  return `${window.location.origin}${API_BASE}${path}`;
}
