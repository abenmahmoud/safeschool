import { getStore } from '@netlify/blobs';
import { jsonCors } from './_lib/security.mts';

// ---------------------------------------------------------------------------
// CSRF Token Utility — SafeSchool
// ---------------------------------------------------------------------------
// Generates and validates CSRF tokens stored in Netlify Blobs.
// Usage:
//   GET  /api/csrf/token  → returns { token: "..." }
//   POST requests should include header `x-csrf-token` with the token.
//   Validate in other functions via: await validateCsrf(req)
// ---------------------------------------------------------------------------

const CSRF_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getTokenStore() {
  return getStore({ name: 'csrf-tokens', consistency: 'strong' });
}

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return jsonCors({ ok: true }, 200, req);

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/csrf', '').replace(/^\/+/, '') || 'token';

  if (req.method === 'GET' && path === 'token') {
    const token = crypto.randomUUID();
    const store = getTokenStore();
    await store.setJSON(`csrf_${token}`, { created: Date.now() });
    return jsonCors({ token }, 200, req);
  }

  if (req.method === 'POST' && path === 'validate') {
    const token = req.headers.get('x-csrf-token');
    if (!token) return jsonCors({ valid: false, error: 'Missing token' }, 400, req);
    const store = getTokenStore();
    try {
      const record = await store.get(`csrf_${token}`, { type: 'json' }) as any;
      if (!record || Date.now() - record.created > CSRF_TTL_MS) {
        await store.delete(`csrf_${token}`).catch(() => {});
        return jsonCors({ valid: false, error: 'Token expired' }, 403, req);
      }
      // Single-use: delete after validation
      await store.delete(`csrf_${token}`).catch(() => {});
      return jsonCors({ valid: true }, 200, req);
    } catch {
      return jsonCors({ valid: false, error: 'Invalid token' }, 403, req);
    }
  }

  return jsonCors({ error: 'Not found' }, 404, req);
};

// ---------------------------------------------------------------------------
// Exported helper for other functions to validate CSRF inline
// ---------------------------------------------------------------------------
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
