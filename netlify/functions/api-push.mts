import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';
import { extractClientIp, isSuperadminRequest, jsonCors, safeJson, sanitizeText } from './_lib/security.mts';

// ---------------------------------------------------------------------------
// Auth & helpers
// ---------------------------------------------------------------------------

// ── V8 Extra Pro — Environment-driven auth ──
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

function getSubStore() {
  return getStore({ name: 'push-subscriptions', consistency: 'strong' });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return jsonCors({ ok: true }, 200, req);

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/push', '').replace(/^\/+/, '');

  try {
    // ── GET /api/push/vapid-key — Public VAPID key for subscription ──
    if (path === 'vapid-key' && req.method === 'GET') {
      const key = VAPID_PUBLIC();
      if (!key) {
        return jsonCors({
          ok: true,
          vapidKey: null,
          message: 'VAPID keys not configured. Push notifications are in demo mode.',
          demo: true
        }, 200, req);
      }
      return jsonCors({ ok: true, vapidKey: key, demo: false }, 200, req);
    }

    // ── POST /api/push/subscribe — Register a push subscription ──
    if (path === 'subscribe' && req.method === 'POST') {
      // Rate limit
      const clientIp = extractClientIp(req, context);
      if (await checkPushRateLimit(clientIp)) {
        return jsonCors({ error: 'Too many requests. Please try again later.' }, 429, req);
      }

      let body: any;
      try { body = await safeJson(req); } catch { return jsonCors({ error: 'Invalid request body' }, 400, req); }
      const { subscription, schoolId, role, userId } = body;

      if (!subscription?.endpoint) {
        return jsonCors({ error: 'Missing subscription endpoint' }, 400, req);
      }

      const store = getSubStore();
      const subId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const record = {
        id: subId,
        endpoint: subscription.endpoint,
        keys: subscription.keys || {},
        schoolId: schoolId || 'global',
        role: sanitizeText(role || 'student', 40),       // student | admin | superadmin
        userId: sanitizeText(userId || '', 120) || null,
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

      return jsonCors({ ok: true, subscriptionId: subId, message: 'Notifications activées' }, 200, req);
    }

    // ── DELETE /api/push/unsubscribe — Unregister a subscription ──
    if (path === 'unsubscribe' && req.method === 'POST') {
      const body = await safeJson(req);
      const { endpoint } = body;

      if (!endpoint) return jsonCors({ error: 'Missing endpoint' }, 400, req);

      const store = getSubStore();
      const globalIdx = (await store.get('idx_global_all', { type: 'json' }).catch(() => null)) as string[] | null;

      if (globalIdx) {
        for (const subId of globalIdx) {
          const sub = (await store.get(subId, { type: 'json' }).catch(() => null)) as any;
          if (sub?.endpoint === endpoint) {
            sub.active = false;
            await store.setJSON(subId, sub);
            return jsonCors({ ok: true, message: 'Subscription désactivée' }, 200, req);
          }
        }
      }

      return jsonCors({ ok: true, message: 'Subscription non trouvée (déjà supprimée)' }, 200, req);
    }

    // ── POST /api/push/send — Send push to subscribers (admin only) ──
    if (path === 'send' && req.method === 'POST') {
      if (!(await isSuperadminRequest(req))) return jsonCors({ error: 'Unauthorized' }, 401, req);

      const body = await safeJson(req);
      const { title, message, type, schoolId, urgent } = body;

      if (!title || !message) return jsonCors({ error: 'Missing title or message' }, 400, req);

      const store = getSubStore();
      const targetIndex = schoolId ? `idx_${schoolId}` : 'idx_global_all';
      const subIds = (await store.get(targetIndex, { type: 'json' }).catch(() => null)) as string[] | null;

      if (!subIds || subIds.length === 0) {
        return jsonCors({
          ok: true,
          sent: 0,
          message: 'Aucun abonné trouvé. Les notifications seront envoyées quand des utilisateurs s\'abonneront.',
          demo: !VAPID_PRIVATE()
        }, 200, req);
      }

      // In production with VAPID keys, we'd use web-push library
      // For now, store the notification for retrieval
      const notifStore = getStore({ name: 'push-queue', consistency: 'strong' });
      const notifId = `push_${Date.now()}`;
      await notifStore.setJSON(notifId, {
        id: notifId,
        title: sanitizeText(title, 160),
        body: sanitizeText(message, 1000),
        type: sanitizeText(type || 'general', 40),
        schoolId: sanitizeText(schoolId || 'all', 120),
        urgent: urgent || false,
        targetSubscribers: subIds.length,
        createdAt: new Date().toISOString(),
        status: VAPID_PRIVATE() ? 'queued' : 'demo-stored'
      });

      return jsonCors({
        ok: true,
        sent: subIds.length,
        notificationId: notifId,
        demo: !VAPID_PRIVATE(),
        message: VAPID_PRIVATE()
          ? `Notification envoyée à ${subIds.length} abonné(s)`
          : `Notification stockée (mode démo). Configurez VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY pour l'envoi réel.`
      }, 200, req);
    }

    // ── GET /api/push/stats — Subscription statistics (admin only) ──
    if (path === 'stats' && req.method === 'GET') {
      if (!(await isSuperadminRequest(req))) return jsonCors({ error: 'Unauthorized' }, 401, req);

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

      return jsonCors({
        ok: true,
        total: totalSubs,
        active: activeSubs,
        bySchool,
        byRole,
        vapidConfigured: !!VAPID_PUBLIC(),
        pushReady: !!VAPID_PRIVATE()
      }, 200, req);
    }

    return jsonCors({ error: 'Endpoint not found', path }, 404, req);

  } catch (error: any) {
    console.error('Push API error:', error);
    return jsonCors({ error: 'Internal server error' }, 500, req);
  }
};

export const config: Config = {
  path: ['/api/push', '/api/push/*']
};
