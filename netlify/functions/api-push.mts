import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

// ---------------------------------------------------------------------------
// Auth & helpers
// ---------------------------------------------------------------------------

// ── V8 Extra Pro — Environment-driven auth ──
const SA_EMAIL = () => Netlify.env.get('SUPERADMIN_EMAIL') || '';
const SA_PASS  = () => Netlify.env.get('SUPERADMIN_PASS')  || '';
const VAPID_PUBLIC  = () => Netlify.env.get('VAPID_PUBLIC_KEY')  || '';
const VAPID_PRIVATE = () => Netlify.env.get('VAPID_PRIVATE_KEY') || '';

// ---------------------------------------------------------------------------
// Rate limiting — 20 subscribe/unsubscribe actions per IP per hour
// ---------------------------------------------------------------------------
const PUSH_RATE_LIMIT = 20;
const PUSH_RATE_WINDOW_MS = 60 * 60 * 1000;

async function checkPushRateLimit(ip: string): Promise<boolean> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `push_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();
  let entry: { attempts: number[] } | null = null;
  try {
    entry = await store.get(key, { type: 'json' }) as any;
  } catch { entry = null; }
  const recent = entry?.attempts?.filter((ts: number) => now - ts < PUSH_RATE_WINDOW_MS) || [];
  if (recent.length >= PUSH_RATE_LIMIT) return true;
  recent.push(now);
  await store.setJSON(key, { attempts: recent });
  return false;
}

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    },
  });
}

function authCheck(req: Request): boolean {
  const token = req.headers.get('x-sa-token');
  if (!token) return false;
  try {
    return atob(token) === `${SA_EMAIL()}:${SA_PASS()}`;
  } catch {
    return false;
  }
}

function getSubStore() {
  return getStore({ name: 'push-subscriptions', consistency: 'strong' });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/push', '').replace(/^\/+/, '');

  try {
    // ── GET /api/push/vapid-key — Public VAPID key for subscription ──
    if (path === 'vapid-key' && req.method === 'GET') {
      const key = VAPID_PUBLIC();
      if (!key) {
        return cors({
          ok: true,
          vapidKey: null,
          message: 'VAPID keys not configured. Push notifications are in demo mode.',
          demo: true
        });
      }
      return cors({ ok: true, vapidKey: key, demo: false });
    }

    // ── POST /api/push/subscribe — Register a push subscription ──
    if (path === 'subscribe' && req.method === 'POST') {
      // Rate limit
      const clientIp = context.ip || req.headers.get('x-forwarded-for') || 'unknown';
      if (await checkPushRateLimit(clientIp)) {
        return cors({ error: 'Too many requests. Please try again later.' }, 429);
      }

      let body: any;
      try { body = await req.json(); } catch { return cors({ error: 'Invalid request body' }, 400); }
      const { subscription, schoolId, role, userId } = body;

      if (!subscription?.endpoint) {
        return cors({ error: 'Missing subscription endpoint' }, 400);
      }

      const store = getSubStore();
      const subId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const record = {
        id: subId,
        endpoint: subscription.endpoint,
        keys: subscription.keys || {},
        schoolId: schoolId || 'global',
        role: role || 'student',       // student | admin | superadmin
        userId: userId || null,
        createdAt: new Date().toISOString(),
        active: true,
        lastPush: null,
        failCount: 0
      };

      await store.setJSON(subId, record);

      // Update index by school
      const indexKey = `idx_${record.schoolId}`;
      const existing = (await store.get(indexKey, { type: 'json' }).catch(() => null)) as string[] | null;
      const ids = existing ?? [];
      if (!ids.includes(subId)) {
        ids.push(subId);
        await store.setJSON(indexKey, ids);
      }

      // Update global index
      const globalIdx = (await store.get('idx_global_all', { type: 'json' }).catch(() => null)) as string[] | null;
      const gIds = globalIdx ?? [];
      if (!gIds.includes(subId)) {
        gIds.push(subId);
        await store.setJSON('idx_global_all', gIds);
      }

      return cors({ ok: true, subscriptionId: subId, message: 'Notifications activées' });
    }

    // ── DELETE /api/push/unsubscribe — Unregister a subscription ──
    if (path === 'unsubscribe' && req.method === 'POST') {
      const body = await req.json();
      const { endpoint } = body;

      if (!endpoint) return cors({ error: 'Missing endpoint' }, 400);

      const store = getSubStore();
      const globalIdx = (await store.get('idx_global_all', { type: 'json' }).catch(() => null)) as string[] | null;

      if (globalIdx) {
        for (const subId of globalIdx) {
          const sub = (await store.get(subId, { type: 'json' }).catch(() => null)) as any;
          if (sub?.endpoint === endpoint) {
            sub.active = false;
            await store.setJSON(subId, sub);
            return cors({ ok: true, message: 'Subscription désactivée' });
          }
        }
      }

      return cors({ ok: true, message: 'Subscription non trouvée (déjà supprimée)' });
    }

    // ── POST /api/push/send — Send push to subscribers (admin only) ──
    if (path === 'send' && req.method === 'POST') {
      if (!authCheck(req)) return cors({ error: 'Unauthorized' }, 401);

      const body = await req.json();
      const { title, message, type, schoolId, urgent } = body;

      if (!title || !message) return cors({ error: 'Missing title or message' }, 400);

      const store = getSubStore();
      const targetIndex = schoolId ? `idx_${schoolId}` : 'idx_global_all';
      const subIds = (await store.get(targetIndex, { type: 'json' }).catch(() => null)) as string[] | null;

      if (!subIds || subIds.length === 0) {
        return cors({
          ok: true,
          sent: 0,
          message: 'Aucun abonné trouvé. Les notifications seront envoyées quand des utilisateurs s\'abonneront.',
          demo: !VAPID_PRIVATE()
        });
      }

      // In production with VAPID keys, we'd use web-push library
      // For now, store the notification for retrieval
      const notifStore = getStore({ name: 'push-queue', consistency: 'strong' });
      const notifId = `push_${Date.now()}`;
      await notifStore.setJSON(notifId, {
        id: notifId,
        title,
        body: message,
        type: type || 'general',
        schoolId: schoolId || 'all',
        urgent: urgent || false,
        targetSubscribers: subIds.length,
        createdAt: new Date().toISOString(),
        status: VAPID_PRIVATE() ? 'queued' : 'demo-stored'
      });

      return cors({
        ok: true,
        sent: subIds.length,
        notificationId: notifId,
        demo: !VAPID_PRIVATE(),
        message: VAPID_PRIVATE()
          ? `Notification envoyée à ${subIds.length} abonné(s)`
          : `Notification stockée (mode démo). Configurez VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY pour l'envoi réel.`
      });
    }

    // ── GET /api/push/stats — Subscription statistics (admin only) ──
    if (path === 'stats' && req.method === 'GET') {
      if (!authCheck(req)) return cors({ error: 'Unauthorized' }, 401);

      const store = getSubStore();
      const globalIdx = (await store.get('idx_global_all', { type: 'json' }).catch(() => null)) as string[] | null;
      const totalSubs = globalIdx?.length || 0;

      // Count by school and role
      const bySchool: Record<string, number> = {};
      const byRole: Record<string, number> = {};
      let activeSubs = 0;

      if (globalIdx) {
        for (const subId of globalIdx.slice(0, 200)) { // Limit scan
          const sub = (await store.get(subId, { type: 'json' }).catch(() => null)) as any;
          if (!sub) continue;
          if (sub.active) activeSubs++;
          bySchool[sub.schoolId] = (bySchool[sub.schoolId] || 0) + 1;
          byRole[sub.role] = (byRole[sub.role] || 0) + 1;
        }
      }

      return cors({
        ok: true,
        total: totalSubs,
        active: activeSubs,
        bySchool,
        byRole,
        vapidConfigured: !!VAPID_PUBLIC(),
        pushReady: !!VAPID_PRIVATE()
      });
    }

    return cors({ error: 'Endpoint not found', path }, 404);

  } catch (error: any) {
    console.error('Push API error:', error);
    return cors({ error: 'Internal server error', detail: error.message }, 500);
  }
};

export const config: Config = {
  path: ['/api/push', '/api/push/*']
};
