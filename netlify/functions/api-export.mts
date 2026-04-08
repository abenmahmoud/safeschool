import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';
import { extractClientIp, getAllowedOrigin, isSuperadminRequest, jsonCors } from './_lib/security.mts';

// ---------------------------------------------------------------------------
// Auth & Rate Limiting
// ---------------------------------------------------------------------------
const EXPORT_RATE_LIMIT = 20;
const EXPORT_RATE_WINDOW_MS = 5 * 60 * 1000;

async function checkExportRateLimit(ip: string): Promise<boolean> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `export_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();
  let entry: { attempts: number[] } | null = null;
  try {
    entry = await store.get(key, { type: 'json' }) as any;
  } catch { entry = null; }
  const recent = entry?.attempts?.filter((ts: number) => now - ts < EXPORT_RATE_WINDOW_MS) || [];
  if (recent.length >= EXPORT_RATE_LIMIT) return true;
  recent.push(now);
  await store.setJSON(key, { attempts: recent });
  return false;
}

function cors(body: string, status = 200, contentType = 'application/json', req?: Request) {
  const origin = req ? getAllowedOrigin(req) : '*';
  return new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin'
    },
  });
}

function corsJson(body: any, status = 200, req?: Request) {
  return jsonCors(body, status, req);
}

// ---------------------------------------------------------------------------
// CSV generation helpers
// ---------------------------------------------------------------------------

function escapeCSV(val: any): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function arrayToCSV(headers: string[], rows: any[][]): string {
  const headerLine = headers.map(escapeCSV).join(',');
  const dataLines = rows.map(row => row.map(escapeCSV).join(','));
  return [headerLine, ...dataLines].join('\n');
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

async function loadAllSchools() {
  const store = getStore({ name: 'establishments', consistency: 'strong' });
  const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
  const schools: any[] = [];
  for (const entry of index) {
    const data = await store.get(`school_${entry.id}`, { type: 'json' });
    if (data) schools.push(data);
  }
  return schools;
}

async function loadAllStats() {
  const store = getStore({ name: 'lea-stats', consistency: 'strong' });
  const { blobs } = await store.list({ prefix: 'stats/' });
  const results: any[] = [];
  for (const blob of blobs) {
    const data = await store.get(blob.key, { type: 'json' });
    if (data) results.push({ schoolId: blob.key.replace('stats/', ''), ...data as any });
  }
  return results;
}

async function loadAllAlerts() {
  const store = getStore({ name: 'lea-stats', consistency: 'strong' });
  const { blobs } = await store.list({ prefix: 'alerts/' });
  const results: any[] = [];
  for (const blob of blobs) {
    const data = await store.get(blob.key, { type: 'json' }) as any[];
    if (data) results.push({ schoolId: blob.key.replace('alerts/', ''), alerts: data });
  }
  return results;
}

async function loadNotifications(day?: string) {
  const store = getStore({ name: 'notifications', consistency: 'strong' });
  const dayKey = `day_${day || new Date().toISOString().slice(0, 10)}`;
  const ids = (await store.get(dayKey, { type: 'json' }).catch(() => null)) as string[] | null ?? [];
  const records: any[] = [];
  for (const id of ids.slice(-500)) {
    const rec = await store.get(id, { type: 'json' }).catch(() => null);
    if (rec) records.push(rec);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return corsJson({ ok: true }, 200, req);

  if (!(await isSuperadminRequest(req))) return corsJson({ error: 'Non autorise' }, 401, req);

  // Rate limiting
  const clientIp = extractClientIp(req, context);
  if (await checkExportRateLimit(clientIp)) {
    return corsJson({ error: 'Trop de requetes d\'export. Reessayez dans quelques minutes.' }, 429, req);
  }

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/export', '');
  const format = url.searchParams.get('format') || 'csv';

  try {
    // =======================================================================
    // GET /api/export/schools — Export all schools data
    // =======================================================================
    if (req.method === 'GET' && path === '/schools') {
      const schools = await loadAllSchools();

      const headers = ['ID', 'Nom', 'Slug', 'Ville', 'Type', 'Plan', 'Statut', 'Actif', 'Nb Signalements', 'Nb Eleves', 'Date Creation', 'Date Expiration'];
      const rows = schools.map(s => [
        s.id, s.name, s.slug, s.city || '', s.type || '', s.plan || '',
        s.status || '', s.is_active ? 'Oui' : 'Non',
        s.report_count || 0, s.student_count || 0,
        s.created_at || '', s.expires_at || ''
      ]);

      if (format === 'json') {
        return corsJson({ count: schools.length, data: schools }, 200, req);
      }

      const csv = arrayToCSV(headers, rows);
      return cors(csv, 200, 'text/csv; charset=utf-8', req);
    }

    // =======================================================================
    // GET /api/export/reports — Export reports summary
    // =======================================================================
    if (req.method === 'GET' && path === '/reports') {
      const [schools, allStats, allAlerts] = await Promise.all([
        loadAllSchools(),
        loadAllStats(),
        loadAllAlerts(),
      ]);

      const statsMap: Record<string, any> = {};
      for (const s of allStats) statsMap[s.schoolId] = s;

      const alertsMap: Record<string, any[]> = {};
      for (const a of allAlerts) alertsMap[a.schoolId] = a.alerts;

      const headers = ['Ecole', 'Ville', 'Plan', 'Conversations', 'Messages', 'Alertes Total', 'Alertes Sev. Haute', 'Derniere MAJ'];
      const rows = schools.map(school => {
        const stats = statsMap[school.id] || {};
        const alerts = alertsMap[school.id] || [];
        const highSev = alerts.filter((a: any) => a.severity >= 2).length;
        return [
          school.name, school.city || '', school.plan || '',
          stats.totalConversations || 0, stats.totalMessages || 0,
          alerts.length, highSev,
          stats.lastUpdated || ''
        ];
      });

      if (format === 'json') {
        return corsJson({ count: rows.length, headers, data: rows }, 200, req);
      }

      const csv = arrayToCSV(headers, rows);
      return cors(csv, 200, 'text/csv; charset=utf-8', req);
    }

    // =======================================================================
    // GET /api/export/alerts — Export all alerts
    // =======================================================================
    if (req.method === 'GET' && path === '/alerts') {
      const allAlerts = await loadAllAlerts();
      const flatAlerts: any[] = [];

      for (const school of allAlerts) {
        for (const alert of school.alerts) {
          flatAlerts.push({
            schoolId: school.schoolId,
            category: alert.cat,
            severity: alert.severity,
            schoolName: alert.schoolName || '',
            timestamp: alert.ts
          });
        }
      }

      const headers = ['Ecole ID', 'Nom Ecole', 'Categorie', 'Severite', 'Date/Heure'];
      const rows = flatAlerts.map(a => [a.schoolId, a.schoolName, a.category, a.severity, a.timestamp]);

      if (format === 'json') {
        return corsJson({ count: flatAlerts.length, data: flatAlerts }, 200, req);
      }

      const csv = arrayToCSV(headers, rows);
      return cors(csv, 200, 'text/csv; charset=utf-8', req);
    }

    // =======================================================================
    // GET /api/export/notifications — Export notification history
    // =======================================================================
    if (req.method === 'GET' && path === '/notifications') {
      const day = url.searchParams.get('day') || undefined;
      const records = await loadNotifications(day);

      const headers = ['ID', 'Type', 'Ecole', 'Destinataire', 'Statut', 'Raison', 'Date Creation'];
      const rows = records.map(r => [
        r.id, r.type, r.schoolId || '', r.recipient || '',
        r.status, r.reason || '', r.created_at
      ]);

      if (format === 'json') {
        return corsJson({ count: records.length, data: records }, 200, req);
      }

      const csv = arrayToCSV(headers, rows);
      return cors(csv, 200, 'text/csv; charset=utf-8', req);
    }

    // =======================================================================
    // GET /api/export/statistics — Export global statistics summary
    // =======================================================================
    if (req.method === 'GET' && path === '/statistics') {
      const [schools, allStats, allAlerts] = await Promise.all([
        loadAllSchools(),
        loadAllStats(),
        loadAllAlerts(),
      ]);

      const totalReports = schools.reduce((sum, s) => sum + (s.report_count || 0), 0);
      const totalConversations = allStats.reduce((sum, s) => sum + (s.totalConversations || 0), 0);
      const totalMessages = allStats.reduce((sum, s) => sum + (s.totalMessages || 0), 0);
      const totalAlertsCount = allAlerts.reduce((sum, s) => sum + s.alerts.length, 0);

      const categories: Record<string, number> = {};
      for (const s of allStats) {
        if (s.categories) {
          Object.entries(s.categories).forEach(([cat, count]) => {
            categories[cat] = (categories[cat] || 0) + (count as number);
          });
        }
      }

      const byPlan: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      for (const s of schools) {
        byPlan[s.plan || 'unknown'] = (byPlan[s.plan || 'unknown'] || 0) + 1;
        byStatus[s.status || 'unknown'] = (byStatus[s.status || 'unknown'] || 0) + 1;
      }

      const summary = {
        total_schools: schools.length,
        active_schools: schools.filter(s => s.is_active).length,
        total_reports: totalReports,
        total_conversations: totalConversations,
        total_messages: totalMessages,
        total_alerts: totalAlertsCount,
        categories,
        by_plan: byPlan,
        by_status: byStatus,
        generated_at: new Date().toISOString()
      };

      if (format === 'json') {
        return corsJson(summary, 200, req);
      }

      // CSV format for statistics
      const headers = ['Metrique', 'Valeur'];
      const rows: any[][] = [
        ['Total Ecoles', summary.total_schools],
        ['Ecoles Actives', summary.active_schools],
        ['Total Signalements', summary.total_reports],
        ['Total Conversations IA', summary.total_conversations],
        ['Total Messages IA', summary.total_messages],
        ['Total Alertes', summary.total_alerts],
        ['', ''],
        ['--- Repartition par Plan ---', ''],
        ...Object.entries(byPlan).map(([plan, count]) => [`Plan ${plan}`, count]),
        ['', ''],
        ['--- Repartition par Statut ---', ''],
        ...Object.entries(byStatus).map(([status, count]) => [`Statut ${status}`, count]),
        ['', ''],
        ['--- Categories d\'alertes ---', ''],
        ...Object.entries(categories).sort((a, b) => (b[1] as number) - (a[1] as number)).map(([cat, count]) => [cat, count]),
      ];

      const csv = arrayToCSV(headers, rows);
      return cors(csv, 200, 'text/csv; charset=utf-8', req);
    }

    return corsJson({ error: 'Route d\'export inconnue. Routes disponibles: /schools, /reports, /alerts, /notifications, /statistics' }, 404, req);
  } catch (e: any) {
    console.error('[EXPORT] Error:', e?.message || e);
    return corsJson({ error: 'Erreur lors de l\'export' }, 500, req);
  }
};

export const config: Config = {
  path: '/api/export/*',
};
