import { randomUUID } from 'crypto';
import { randomUUID } from 'crypto';
import { getStore } from '@netlify/blobs';

const CSRF_TTL_MS = 30 * 60 * 1000;

function getTokenStore() {
  return getStore({ name: 'csrf-tokens', consistency: 'strong' });
}

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token, x-csrf-token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });
}

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/csrf', '').replace(/^\/+/, '') || 'token';

  if (req.method === 'GET' && path === 'token') {
    const token = randomUUID();
    const store = getTokenStore();
    await store.setJSON(`csrf_${token}`, { created: Date.now() });
    return cors({ token });
  }

  if (req.method === 'POST' && path === 'validate') {
    const token = req.headers.get('x-csrf-token');
    if (!token) return cors({ valid: false, error: 'Missing token' }, 400);
    const store = getTokenStore();
    try {
      const record = await store.get(`csrf_${token}`, { type: 'json' }) as any;
      if (!record || Date.now() - record.created > CSRF_TTL_MS) {
        await store.delete(`csrf_${token}`).catch(() => {});
        return cors({ valid: false, error: 'Token expired' }, 403);
      }
      await store.delete(`csrf_${token}`).catch(() => {});
      return cors({ valid: true });
    } catch {
      return cors({ valid: false, error: 'Invalid token' }, 403);
    }
  }

  return cors({ error: 'Not found' }, 404);
};

export async function validateCsrfToken(req: Request): Promise<boolean> {
  const token = req.headers.get('x-csrf-token');
  if (!token) return false;
  const store = getTokenStore();
  try {
    const record = await store.get(`csrf_${token}`, { type: 'json' }) as any;
    if (!record || Date.now() - record.created > CSRF_TTL_MS) {
      await store.delete(`csrf_${token}`).catch(() => {});
      return false;
    }
    await store.delete(`csrf_${token}`).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export const config = {
  path: ['/api/csrf', '/api/csrf/*'],
};
