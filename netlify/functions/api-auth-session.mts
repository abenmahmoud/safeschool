import type { Config } from '@netlify/functions';
import { getUser } from '@netlify/identity';
import { jsonCors } from './_lib/security.mts';

type SafeRole = 'user' | 'staff' | 'establishment_admin' | 'superadmin';

function normalizeRole(raw: unknown): SafeRole {
  const v = String(raw || '').toLowerCase();
  if (v === 'superadmin') return 'superadmin';
  if (v === 'establishment_admin' || v === 'admin') return 'establishment_admin';
  if (v === 'staff' || v === 'personnel') return 'staff';
  return 'user';
}

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return jsonCors({ ok: true }, 200, req);
  if (req.method !== 'GET') return jsonCors({ error: 'Method not allowed' }, 405, req);

  try {
    const user = await getUser();
    if (!user) return jsonCors({ authenticated: false }, 200, req);

    const role = normalizeRole(user.userMetadata?.role);
    return jsonCors({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        role,
        email_verified: !!user.emailVerified
      }
    }, 200, req);
  } catch {
    // Identity not enabled or unavailable in current context
    return jsonCors({ authenticated: false, reason: 'identity_unavailable' }, 200, req);
  }
};

export const config: Config = {
  path: '/api/auth/session'
};
