import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';
import crypto from 'node:crypto';

// ── V10 EU — Environment-driven auth — NO hardcoded fallbacks ──
const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || '';
const SUPERADMIN_PASS = Netlify.env.get('SUPERADMIN_PASS') || '';
const SUPABASE_URL = Netlify.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY =
  Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  Netlify.env.get('SUPABASE_ANON_KEY') ||
  '';

// Base domain used for tenant URLs.
// Recommended for your current OVH + Netlify setup:
//   app.safeschool.fr
const TENANT_BASE_DOMAIN = Netlify.env.get('TENANT_BASE_DOMAIN') || 'safeschool.fr';
const NETLIFY_TARGET = Netlify.env.get('NETLIFY_TARGET') || 'safeschoolproject.netlify.app';

// ---------------------------------------------------------------------------
// Rate limiting — 5 login attempts per IP per 15 minutes
// ---------------------------------------------------------------------------
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;

async function checkLoginRateLimit(ip: string): Promise<{ blocked: boolean; remaining: number }> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `school_login_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();
  let entry: { attempts: number[] } | null = null;
  try {
    entry = (await store.get(key, { type: 'json' })) as any;
  } catch {
    entry = null;
  }
  const recent = entry?.attempts?.filter((ts: number) => now - ts < LOGIN_RATE_WINDOW_MS) || [];
  if (recent.length >= LOGIN_RATE_LIMIT) return { blocked: true, remaining: 0 };
  return { blocked: false, remaining: LOGIN_RATE_LIMIT - recent.length };
}

async function recordLoginAttempt(ip: string): Promise<void> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `school_login_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();
  let entry: { attempts: number[] } | null = null;
  try {
    entry = (await store.get(key, { type: 'json' })) as any;
  } catch {
    entry = null;
  }
  const recent = entry?.attempts?.filter((ts: number) => now - ts < LOGIN_RATE_WINDOW_MS) || [];
  recent.push(now);
  await store.setJSON(key, { attempts: recent });
}

function authCheck(req: Request): boolean {
  if (!SUPERADMIN_EMAIL || !SUPERADMIN_PASS) return false;
  const auth = req.headers.get('x-sa-token');
  if (!auth) return false;
  try {
    const decoded = atob(auth);
    return decoded === `${SUPERADMIN_EMAIL}:${SUPERADMIN_PASS}`;
  } catch {
    return false;
  }
}

function sanitize(str: string): string {
  return String(str).replace(/[<>]/g, '').trim();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSchoolDomain(slug: string): string {
  return `${slug}.${TENANT_BASE_DOMAIN}`;
}

function buildSchoolUrl(slug: string): string {
  return `https://${buildSchoolDomain(slug)}`;
}


// Auto-register subdomain on Netlify when establishment is created
async function registerNetlifyDomain(slug: string): Promise<void> {
  const token = Netlify.env.get('NETLIFY_TOKEN');
    const siteId = Netlify.env.get('NETLIFY_SITE_ID');
      if (!token || !siteId) {
          console.warn('[DNS] NETLIFY_TOKEN or NETLIFY_SITE_ID missing — skipping domain registration');
              return;
                }
                  const domain = buildSchoolDomain(slug);
                    try {
                        const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/domain_aliases`, {
                              method: 'POST',
                                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                                          body: JSON.stringify({ domain })
                                              });
                                                  if (res.ok) {
                                                        console.log(`[DNS] Netlify domain registered: ${domain}`);
                                                            } else {
                                                                  const err = await res.text();
                                                                        console.warn(`[DNS] Netlify domain registration failed for ${domain}:`, err);
                                                                            }
                                                                              } catch (e) {
                                                                                  console.warn(`[DNS] Netlify domain registration error for ${domain}:`, e);
                                                                                    }
                                                                                    }
const escapedTenantBaseDomain = escapeRegex(TENANT_BASE_DOMAIN);
const tenantOriginRegex = new RegExp(`^https:\\/\\/[a-z0-9-]+\\.${escapedTenantBaseDomain}$`);

const ALLOWED_ORIGINS = [
  'https://darling-muffin-21eb90.netlify.app',
  Netlify.env.get('SITE_URL') || '',
  Netlify.env.get('DEPLOY_PRIME_URL') || '',
  `https://${TENANT_BASE_DOMAIN}`,
].filter(Boolean);

function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (tenantOriginRegex.test(origin)) return origin;
  if (/^https:\/\/[a-z0-9-]+--darling-muffin-21eb90\.netlify\.app$/.test(origin)) return origin;
  return ALLOWED_ORIGINS[0] || 'https://darling-muffin-21eb90.netlify.app';
}

function cors(body: any, status = 200, req?: Request) {
  const allowedOrigin = req
    ? getAllowedOrigin(req)
    : ALLOWED_ORIGINS[0] || 'https://darling-muffin-21eb90.netlify.app';
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      Vary: 'Origin',
    },
  });
}

function genAdminCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SS';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

// Sync school to Supabase (non-blocking, best-effort)
async function syncToSupabase(school: any, store: any): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/schools`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({
        id: school.id,
        name: school.name,
        slug: school.slug,
        ville: school.city || null,
        email_contact: school.email || null,
        plan: school.plan,
        status: school.status,
        max_students: school.max_students,
        max_reports_month: school.max_reports,
        max_admins: school.max_admins,
        expires_at: school.expires_at,
      }),
    });
    if (res.ok) {
      try {
        const supaData = await res.json();
        if (Array.isArray(supaData) && supaData.length > 0 && supaData[0].id) {
          school.supabase_id = supaData[0].id;
          await store.setJSON(`school_${school.id}`, school);
        }
      } catch {
        /* ignore parse errors */
      }
    } else {
      console.warn('Supabase sync failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.warn('Supabase sync error:', e);
  }
}

export default async (req: Request, context: Context) => {
  try {
    if (req.method === 'OPTIONS') {
      return cors({ ok: true }, 200, req);
    }

    const url = new URL(req.url);
    const path = url.pathname.replace('/api/establishments', '');
    const store = getStore({ name: 'establishments', consistency: 'strong' });

    // Public endpoint: get establishment by slug (for app subdomain routing)
    if (req.method === 'GET' && path.startsWith('/by-slug/')) {
      const slug = path.replace('/by-slug/', '');
      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const entry = index.find((e: any) => e.slug === slug && e.is_active);
      if (!entry) return cors({ error: 'Etablissement non trouvé' }, 404, req);
      const data = await store.get(`school_${entry.id}`, { type: 'json' });
      if (!data) return cors({ error: 'Données non trouvées' }, 404, req);
      const isAdmin = authCheck(req);
      const publicInfo: any = {
        id: (data as any).id,
        name: (data as any).name,
        slug: (data as any).slug,
        city: (data as any).city,
        type: (data as any).type,
        plan: (data as any).plan,
        is_active: (data as any).is_active,
        domain: (data as any).domain || buildSchoolDomain((data as any).slug),
        url: (data as any).url || buildSchoolUrl((data as any).slug),
      };
      if (isAdmin) {
        publicInfo.admin_code = (data as any).admin_code;
        publicInfo.admin_email = (data as any).admin_email;
      }
      return cors(publicInfo, 200, req);
    }

    if (req.method === 'GET' && path === '/public') {
      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const active = index.filter((e: any) => e.is_active);
      const results = [];
      for (const e of active) {
        const data = (await store.get(`school_${e.id}`, { type: 'json' })) as any;
        results.push({
          id: e.id,
          name: e.name,
          slug: e.slug,
          city: e.city,
          type: e.type,
          plan: e.plan,
          supabase_id: data?.supabase_id || null,
          domain: data?.domain || buildSchoolDomain(e.slug),
          url: data?.url || buildSchoolUrl(e.slug),
        });
      }
      return cors(results, 200, req);
    }

    if (req.method === 'POST' && path.startsWith('/admin-login/')) {
      const clientIp = context.ip || req.headers.get('x-forwarded-for') || 'unknown';
      const rateCheck = await checkLoginRateLimit(clientIp);
      if (rateCheck.blocked) {
        return cors(
          { error: 'Trop de tentatives. Reessayez dans 15 minutes.', retry_after_seconds: LOGIN_RATE_WINDOW_MS / 1000 },
          429,
          req,
        );
      }

      const slug = path.replace('/admin-login/', '');
      if (!slug || slug.length > 100 || !/^[a-z0-9-]+$/.test(slug)) {
        return cors({ error: 'Slug invalide' }, 400, req);
      }

      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const entry = index.find((e: any) => e.slug === slug && e.is_active);
      if (!entry) return cors({ error: 'Etablissement non trouve' }, 404, req);
      const data = (await store.get(`school_${entry.id}`, { type: 'json' })) as any;
      if (!data) return cors({ error: 'Donnees non trouvees' }, 404, req);

      let body: any;
      try {
        body = await req.json();
      } catch {
        return cors({ error: 'Corps invalide' }, 400, req);
      }

      const email = (body.email || '').trim().toLowerCase();
      const password = (body.password || '').trim();

      if (!email || !isValidEmail(email)) return cors({ error: "Format d'email invalide" }, 400, req);
      if (!password || password.length === 0) return cors({ error: 'Mot de passe requis' }, 400, req);
      if (password.length > 200) return cors({ error: 'Mot de passe trop long' }, 400, req);

      const storedEmail = (data.admin_email || '').toLowerCase();
      const storedCode = data.admin_code || '';
      const storedPassword = data.admin_password || '';

      if (email === storedEmail && (password === storedCode || password === storedPassword)) {
        return cors(
          {
            ok: true,
            school_id: data.id,
            name: data.name,
            plan: data.plan,
            admin_email: data.admin_email,
            domain: data.domain || buildSchoolDomain(data.slug),
            url: data.url || buildSchoolUrl(data.slug),
          },
          200,
          req,
        );
      }

      await recordLoginAttempt(clientIp);
      return cors({ error: 'Identifiants incorrects', attempts_remaining: rateCheck.remaining - 1 }, 401, req);
    }

    if (req.method === 'POST' && path === '/ensure-uuid') {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return cors({ error: 'Corps invalide' }, 400, req);
      }

      const blobId = body.blob_id || body.id;
      const slug = body.slug;
      if (!blobId && !slug) return cors({ error: 'blob_id ou slug requis' }, 400, req);

      let schoolData: any = null;
      if (blobId) {
        schoolData = await store.get(`school_${blobId}`, { type: 'json' });
      }
      if (!schoolData && slug) {
        const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
        const entry = index.find((e: any) => e.slug === slug);
        if (entry) schoolData = await store.get(`school_${entry.id}`, { type: 'json' });
      }
      if (!schoolData) return cors({ error: 'École non trouvée' }, 404, req);

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (schoolData.supabase_id && uuidRegex.test(schoolData.supabase_id)) {
        if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
          try {
            const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/schools?id=eq.${schoolData.supabase_id}&select=id`, {
              headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
            });
            if (checkRes.ok) {
              const rows = await checkRes.json();
              if (!Array.isArray(rows) || rows.length === 0) {
                await syncToSupabase({ ...schoolData, id: schoolData.supabase_id }, store).catch(() => {});
              }
            }
          } catch {
            /* best effort */
          }
        }
        return cors({ uuid: schoolData.supabase_id, source: 'cached' }, 200, req);
      }

      if (uuidRegex.test(schoolData.id)) {
        if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
          await syncToSupabase(schoolData, store).catch(() => {});
        }
        return cors({ uuid: schoolData.id, source: 'blob_uuid' }, 200, req);
      }

      if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        try {
          const lookupRes = await fetch(
            `${SUPABASE_URL}/rest/v1/schools?slug=eq.${encodeURIComponent(schoolData.slug)}&select=id`,
            { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } },
          );
          if (lookupRes.ok) {
            const rows = await lookupRes.json();
            if (Array.isArray(rows) && rows.length > 0) {
              schoolData.supabase_id = rows[0].id;
              await store.setJSON(`school_${schoolData.id}`, schoolData);
              return cors({ uuid: rows[0].id, source: 'lookup' }, 200, req);
            }
          }
        } catch {
          /* ignore */
        }
      }

      const newUUID = crypto.randomUUID();
      if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        try {
          const res = await fetch(`${SUPABASE_URL}/rest/v1/schools`, {
            method: 'POST',
            headers: {
              apikey: SUPABASE_SERVICE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates,return=representation',
            },
            body: JSON.stringify({
              id: newUUID,
              name: schoolData.name,
              slug: schoolData.slug,
              ville: schoolData.city || null,
              email_contact: schoolData.email || null,
              plan: schoolData.plan || 'starter',
              status: schoolData.status || 'trial',
              max_students: schoolData.max_students || 200,
              max_reports_month: schoolData.max_reports || 50,
              max_admins: schoolData.max_admins || 1,
              expires_at: schoolData.expires_at,
            }),
          });
          if (res.ok) {
            const supaData = await res.json();
            const finalUUID = Array.isArray(supaData) && supaData.length > 0 ? supaData[0].id : newUUID;
            schoolData.supabase_id = finalUUID;
            await store.setJSON(`school_${schoolData.id}`, schoolData);
            await registerNetlifyDomain(schoolData.slug);
            return cors({ uuid: finalUUID, source: 'created' }, 200, req);
          }
          console.warn('Supabase insert failed:', res.status, await res.text().catch(() => ''));
        } catch (e) {
          console.warn('Supabase ensure-uuid error:', e);
        }
      }

      schoolData.supabase_id = newUUID;
      await store.setJSON(`school_${schoolData.id}`, schoolData);
      return cors({ uuid: newUUID, source: 'generated', warning: 'Supabase sync unavailable' }, 200, req);
    }

    if (!authCheck(req)) {
      return cors({ error: 'Non autorisé' }, 401, req);
    }

    if (req.method === 'GET' && (path === '' || path === '/')) {
      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const schools = [];
      for (const entry of index) {
        const data = await store.get(`school_${entry.id}`, { type: 'json' });
        if (data) schools.push(data);
      }
      return cors(schools, 200, req);
    }

    if (req.method === 'GET' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      const data = await store.get(`school_${id}`, { type: 'json' });
      if (!data) return cors({ error: 'Non trouvé' }, 404, req);
      return cors(data, 200, req);
    }

    if (req.method === 'POST' && (path === '' || path === '/')) {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return cors({ error: 'Corps de requête invalide' }, 400, req);
      }

      if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
        return cors({ error: 'Nom requis (minimum 2 caractères)' }, 400, req);
      }
      if (body.email && !isValidEmail(body.email)) {
        return cors({ error: "Format d'email invalide" }, 400, req);
      }
      if (body.admin_email && !isValidEmail(body.admin_email)) {
        return cors({ error: "Format d'email admin invalide" }, 400, req);
      }

      const name = sanitize(body.name.trim());
      const slug = sanitize(body.slug || genSlug(name)).toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
      if (!slug || slug.length < 2) {
        return cors({ error: 'Sous-domaine invalide' }, 400, req);
      }

      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      if (index.find((e: any) => e.slug === slug)) {
        return cors({ error: 'Sous-domaine déjà utilisé' }, 409, req);
      }

      const id = crypto.randomUUID();
      const adminCode = genAdminCode();
      const now = new Date().toISOString();
      const plan = body.plan || 'starter';
      const planDurations: Record<string, number> = { starter: 3, pro: 12, enterprise: 24 };
      const expDate = new Date();
      expDate.setMonth(expDate.getMonth() + (planDurations[plan] || 3));

      const schoolDomain = buildSchoolDomain(slug);
      const schoolUrl = buildSchoolUrl(slug);

      const school: any = {
        id,
        name,
        slug,
        domain: schoolDomain,
        url: schoolUrl,
        dns_target: NETLIFY_TARGET,
        tenant_base_domain: TENANT_BASE_DOMAIN,
        city: body.city || '',
        type: body.type || 'lycee',
        email: body.email || '',
        plan,
        status: plan === 'starter' ? 'trial' : 'active',
        is_active: true,
        admin_code: adminCode,
        admin_email: body.admin_email || body.email || '',
        admin_password: body.admin_password || adminCode,
        max_students: { starter: 200, pro: 9999, enterprise: 99999 }[plan] || 200,
        max_reports: { starter: 50, pro: 9999, enterprise: 99999 }[plan] || 50,
        max_admins: { starter: 1, pro: 2, enterprise: 99 }[plan] || 1,
        created_at: now,
        expires_at: expDate.toISOString(),
        report_count: 0,
        student_count: 0,
        staff_members: [],
        staff_codes: [],
      };

      await store.setJSON(`school_${id}`, school);
      index.push({
        id,
        name: school.name,
        slug: school.slug,
        city: school.city,
        type: school.type,
        plan: school.plan,
        is_active: true,
        status: school.status,
        created_at: now,
        domain: school.domain,
        url: school.url,
      });
      await store.setJSON('_index', index);

      syncToSupabase(school, store).catch(() => {});

      return cors(school, 201, req);
    }

    if (req.method === 'PUT' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      const existing = (await store.get(`school_${id}`, { type: 'json' })) as any;
      if (!existing) return cors({ error: 'Non trouvé' }, 404, req);

      const body = (await req.json()) as any;
      const updatedSlug = body.slug
        ? sanitize(body.slug).toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '')
        : existing.slug;
      const updated = {
        ...existing,
        ...body,
        slug: updatedSlug,
        domain: buildSchoolDomain(updatedSlug),
        url: buildSchoolUrl(updatedSlug),
        tenant_base_domain: TENANT_BASE_DOMAIN,
        dns_target: NETLIFY_TARGET,
        id,
        updated_at: new Date().toISOString(),
      };
      await store.setJSON(`school_${id}`, updated);

      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const idx = index.findIndex((e: any) => e.id === id);
      if (idx >= 0) {
        index[idx] = {
          ...index[idx],
          name: updated.name,
          slug: updated.slug,
          city: updated.city,
          type: updated.type,
          plan: updated.plan,
          is_active: updated.is_active,
          status: updated.status,
          domain: updated.domain,
          url: updated.url,
        };
        await store.setJSON('_index', index);
      }

      return cors(updated, 200, req);
    }

    if (req.method === 'DELETE' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      await store.delete(`school_${id}`);
      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const filtered = index.filter((e: any) => e.id !== id);
      await store.setJSON('_index', filtered);
      return cors({ deleted: true }, 200, req);
    }

    if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/staff-codes$/)) {
      const id = path.split('/')[1];
      const existing = (await store.get(`school_${id}`, { type: 'json' })) as any;
      if (!existing) return cors({ error: 'Non trouvé' }, 404, req);

      const body = (await req.json()) as any;
      const count = Math.min(body.count || 5, 50);
      const codes: any[] = existing.staff_codes || [];
      for (let i = 0; i < count; i++) {
        codes.push({
          code: 'STF-' + genAdminCode(),
          role: body.role || 'cpe',
          used: false,
          created_at: new Date().toISOString(),
        });
      }
      existing.staff_codes = codes;
      await store.setJSON(`school_${id}`, existing);
      return cors({ codes }, 200, req);
    }

    if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/regenerate-admin$/)) {
      const id = path.split('/')[1];
      const existing = (await store.get(`school_${id}`, { type: 'json' })) as any;
      if (!existing) return cors({ error: 'Non trouvé' }, 404, req);

      existing.admin_code = genAdminCode();
      existing.admin_password = existing.admin_code;
      await store.setJSON(`school_${id}`, existing);
      return cors({ admin_code: existing.admin_code, admin_password: existing.admin_password }, 200, req);
    }

    return cors({ error: 'Route non trouvée' }, 404, req);
  } catch (error: any) {
    console.error('api-establishments error:', error);
    return cors(
      {
        success: false,
        error: error?.message || 'Internal server error',
        step: 'api-establishments',
      },
      500,
      req,
    );
  }
};

export const config: Config = {
  path: ['/api/establishments', '/api/establishments/*'],
};
