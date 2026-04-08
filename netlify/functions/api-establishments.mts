import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

// ── V11 — Robust error handling, JSON-only responses, env validation ──
const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || '';
const SUPERADMIN_PASS = Netlify.env.get('SUPERADMIN_PASS') || '';
const SUPABASE_URL = Netlify.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || Netlify.env.get('SUPABASE_ANON_KEY') || '';
const SITE_URL = Netlify.env.get('SITE_URL') || '';
const BASE_DOMAIN = Netlify.env.get('VITE_BASE_DOMAIN') || 'safeschool.fr';

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
    entry = await store.get(key, { type: 'json' }) as any;
  } catch { entry = null; }
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
    entry = await store.get(key, { type: 'json' }) as any;
  } catch { entry = null; }
  const recent = entry?.attempts?.filter((ts: number) => now - ts < LOGIN_RATE_WINDOW_MS) || [];
  recent.push(now);
  await store.setJSON(key, { attempts: recent });
}

function authCheck(req: Request): boolean {
  if (!SUPERADMIN_EMAIL || !SUPERADMIN_PASS) {
    console.error('[api-establishments] SUPERADMIN_EMAIL or SUPERADMIN_PASS not set');
    return false;
  }
  const auth = req.headers.get('x-sa-token');
  if (!auth) return false;
  try {
    const decoded = atob(auth);
    return decoded === `${SUPERADMIN_EMAIL}:${SUPERADMIN_PASS}`;
  } catch { return false; }
}

function sanitize(str: string): string {
  return String(str).replace(/[<>]/g, '').trim();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const ALLOWED_ORIGINS: string[] = [
  SITE_URL,
  Netlify.env.get('DEPLOY_PRIME_URL') || '',
  'https://darling-muffin-21eb90.netlify.app',
].filter(Boolean);

function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Allow any subdomain of the configured base domain
  const escapedDomain = BASE_DOMAIN.replace(/\./g, '\\.');
  const domainRegex = new RegExp(`^https:\\/\\/[a-z0-9-]+\\.${escapedDomain}$`);
  if (domainRegex.test(origin)) return origin;
  // Allow the base domain itself
  if (origin === `https://${BASE_DOMAIN}` || origin === `https://www.${BASE_DOMAIN}`) return origin;
  // Allow Netlify deploy previews
  if (/^https:\/\/[a-z0-9-]+--darling-muffin-21eb90\.netlify\.app$/.test(origin)) return origin;
  return ALLOWED_ORIGINS[0] || '*';
}

function cors(body: any, status = 200, req?: Request) {
  const allowedOrigin = req ? getAllowedOrigin(req) : ALLOWED_ORIGINS[0] || '*';
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Vary': 'Origin'
    }
  });
}

function genAdminCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SS';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genSlug(name: string): string {
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function genSecureToken(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

// Sync school to Supabase (non-blocking, best-effort)
async function syncToSupabase(school: any, store: any): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[syncToSupabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — skipping sync');
    return;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/schools`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
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
        expires_at: school.expires_at
      })
    });
    if (res.ok) {
      try {
        const supaData = await res.json();
        if (Array.isArray(supaData) && supaData.length > 0 && supaData[0].id) {
          school.supabase_id = supaData[0].id;
          await store.setJSON(`school_${school.id}`, school);
        }
      } catch { /* ignore parse errors */ }
    } else {
      const errText = await res.text().catch(() => '');
      console.error('[syncToSupabase] Failed:', res.status, errText);
    }
  } catch (e) {
    console.error('[syncToSupabase] Error:', e);
  }
}

// Create Supabase admin user via auth + admin_profiles (invitation flow)
async function createSupabaseAdmin(school: any): Promise<{ success: boolean; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[createSupabaseAdmin] Missing Supabase env vars — admin not created in Supabase');
    return { success: false, error: 'Supabase not configured' };
  }

  const adminEmail = school.admin_email;
  if (!adminEmail || !isValidEmail(adminEmail)) {
    return { success: false, error: 'Invalid admin email' };
  }

  try {
    // Create user via Supabase Admin API (generates invite automatically)
    const inviteRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'invite',
        email: adminEmail,
        data: {
          school_id: school.supabase_id || school.id,
          school_name: school.name,
          role: 'school_admin'
        }
      })
    });

    if (!inviteRes.ok) {
      const errText = await inviteRes.text().catch(() => '');
      console.error('[createSupabaseAdmin] Invite failed:', inviteRes.status, errText);

      // If user already exists, try to link them
      if (inviteRes.status === 422 || errText.includes('already registered')) {
        console.log('[createSupabaseAdmin] User already exists, attempting profile link');
        // Look up existing user
        const lookupRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?filter=email%3Deq.${encodeURIComponent(adminEmail)}`, {
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
          }
        });
        if (lookupRes.ok) {
          const lookupData = await lookupRes.json();
          const users = lookupData.users || lookupData;
          if (Array.isArray(users) && users.length > 0) {
            const userId = users[0].id;
            // Upsert admin_profiles
            await upsertAdminProfile(userId, school);
            return { success: true };
          }
        }
        return { success: false, error: 'User exists but could not link profile' };
      }
      return { success: false, error: `Invite failed: ${inviteRes.status}` };
    }

    const inviteData = await inviteRes.json();
    const userId = inviteData.id || inviteData.user_id;

    if (userId) {
      await upsertAdminProfile(userId, school);
    }

    console.log('[createSupabaseAdmin] Admin invite created for:', adminEmail);
    return { success: true };
  } catch (e) {
    console.error('[createSupabaseAdmin] Error:', e);
    return { success: false, error: String(e) };
  }
}

async function upsertAdminProfile(userId: string, school: any): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    const schoolId = school.supabase_id || school.id;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/admin_profiles`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        user_id: userId,
        school_id: schoolId,
        role: 'school_admin',
        full_name: `Admin ${school.name}`
      })
    });
    if (!res.ok) {
      console.error('[upsertAdminProfile] Failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.error('[upsertAdminProfile] Error:', e);
  }
}

export default async (req: Request, context: Context) => {
  // ── Global try/catch — ALWAYS return JSON ──
  try {
    if (req.method === 'OPTIONS') {
      return cors({ ok: true }, 200, req);
    }

    const url = new URL(req.url);
    const path = url.pathname.replace('/api/establishments', '');
    const store = getStore({ name: 'establishments', consistency: 'strong' });

    // ── Env var check (logged once per cold start effectively) ──
    if (!SUPERADMIN_EMAIL || !SUPERADMIN_PASS) {
      console.error('[api-establishments] CRITICAL: SUPERADMIN_EMAIL or SUPERADMIN_PASS environment variable is missing');
    }
    if (!SUPABASE_URL) {
      console.warn('[api-establishments] WARNING: SUPABASE_URL not set — Supabase sync disabled');
    }

    // Public endpoint: get establishment by slug (for app subdomain routing)
    if (req.method === 'GET' && path.startsWith('/by-slug/')) {
      const slug = path.replace('/by-slug/', '');
      const index = await store.get('_index', { type: 'json' }) as any[] || [];
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
        is_active: (data as any).is_active
      };
      if (isAdmin) {
        publicInfo.admin_code = (data as any).admin_code;
        publicInfo.admin_email = (data as any).admin_email;
      }
      return cors(publicInfo, 200, req);
    }

    // Public endpoint: list active establishments (for app)
    if (req.method === 'GET' && path === '/public') {
      const index = await store.get('_index', { type: 'json' }) as any[] || [];
      const active = index.filter((e: any) => e.is_active);
      const results = [];
      for (const e of active) {
        const data = await store.get(`school_${e.id}`, { type: 'json' }) as any;
        results.push({
          id: e.id, name: e.name, slug: e.slug, city: e.city, type: e.type, plan: e.plan,
          supabase_id: data?.supabase_id || null
        });
      }
      return cors(results, 200, req);
    }

    // Public endpoint: admin login for a school (verifies credentials without exposing them)
    if (req.method === 'POST' && path.startsWith('/admin-login/')) {
      const clientIp = context.ip || req.headers.get('x-forwarded-for') || 'unknown';
      const rateCheck = await checkLoginRateLimit(clientIp);
      if (rateCheck.blocked) {
        return cors({ error: 'Trop de tentatives. Reessayez dans 15 minutes.', retry_after_seconds: LOGIN_RATE_WINDOW_MS / 1000 }, 429, req);
      }

      const slug = path.replace('/admin-login/', '');
      if (!slug || slug.length > 100 || !/^[a-z0-9-]+$/.test(slug)) {
        return cors({ error: 'Slug invalide' }, 400, req);
      }

      const index = await store.get('_index', { type: 'json' }) as any[] || [];
      const entry = index.find((e: any) => e.slug === slug && e.is_active);
      if (!entry) return cors({ error: 'Etablissement non trouve' }, 404, req);
      const data = await store.get(`school_${entry.id}`, { type: 'json' }) as any;
      if (!data) return cors({ error: 'Donnees non trouvees' }, 404, req);

      let body: any;
      try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }

      const email = (body.email || '').trim().toLowerCase();
      const password = (body.password || '').trim();

      if (!email || !isValidEmail(email)) return cors({ error: 'Format d\'email invalide' }, 400, req);
      if (!password || password.length === 0) return cors({ error: 'Mot de passe requis' }, 400, req);
      if (password.length > 200) return cors({ error: 'Mot de passe trop long' }, 400, req);

      const storedEmail = (data.admin_email || '').toLowerCase();
      const storedCode = data.admin_code || '';
      const storedToken = data.admin_invite_token || '';

      if (email === storedEmail && (password === storedCode || (storedToken && password === storedToken))) {
        return cors({
          ok: true,
          school_id: data.id,
          name: data.name,
          plan: data.plan,
          admin_email: data.admin_email
        }, 200, req);
      }

      await recordLoginAttempt(clientIp);
      return cors({ error: 'Identifiants incorrects', attempts_remaining: rateCheck.remaining - 1 }, 401, req);
    }

    // POST /api/establishments/ensure-uuid
    if (req.method === 'POST' && path === '/ensure-uuid') {
      let body: any;
      try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }

      const blobId = body.blob_id || body.id;
      const slug = body.slug;
      if (!blobId && !slug) return cors({ error: 'blob_id ou slug requis' }, 400, req);

      let schoolData: any = null;
      if (blobId) {
        schoolData = await store.get(`school_${blobId}`, { type: 'json' });
      }
      if (!schoolData && slug) {
        const index = await store.get('_index', { type: 'json' }) as any[] || [];
        const entry = index.find((e: any) => e.slug === slug);
        if (entry) {
          schoolData = await store.get(`school_${entry.id}`, { type: 'json' });
        }
      }
      if (!schoolData) return cors({ error: 'École non trouvée' }, 404, req);

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (schoolData.supabase_id && uuidRegex.test(schoolData.supabase_id)) {
        if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
          try {
            const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/schools?id=eq.${schoolData.supabase_id}&select=id`, {
              headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
            });
            if (checkRes.ok) {
              const rows = await checkRes.json();
              if (!Array.isArray(rows) || rows.length === 0) {
                await syncToSupabase({ ...schoolData, id: schoolData.supabase_id }, store).catch(() => {});
              }
            }
          } catch { /* best effort */ }
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
          const lookupRes = await fetch(`${SUPABASE_URL}/rest/v1/schools?slug=eq.${encodeURIComponent(schoolData.slug)}&select=id`, {
            headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
          });
          if (lookupRes.ok) {
            const rows = await lookupRes.json();
            if (Array.isArray(rows) && rows.length > 0) {
              schoolData.supabase_id = rows[0].id;
              await store.setJSON(`school_${schoolData.id}`, schoolData);
              return cors({ uuid: rows[0].id, source: 'lookup' }, 200, req);
            }
          }
        } catch { /* ignore */ }
      }

      const newUUID = crypto.randomUUID();
      if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        try {
          const res = await fetch(`${SUPABASE_URL}/rest/v1/schools`, {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates,return=representation'
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
              expires_at: schoolData.expires_at
            })
          });
          if (res.ok) {
            const supaData = await res.json();
            const finalUUID = (Array.isArray(supaData) && supaData.length > 0) ? supaData[0].id : newUUID;
            schoolData.supabase_id = finalUUID;
            await store.setJSON(`school_${schoolData.id}`, schoolData);
            return cors({ uuid: finalUUID, source: 'created' }, 200, req);
          } else {
            console.warn('[ensure-uuid] Supabase insert failed:', res.status, await res.text().catch(() => ''));
          }
        } catch (e) {
          console.error('[ensure-uuid] Supabase error:', e);
        }
      }

      schoolData.supabase_id = newUUID;
      await store.setJSON(`school_${schoolData.id}`, schoolData);
      return cors({ uuid: newUUID, source: 'generated', warning: 'Supabase sync unavailable' }, 200, req);
    }

    // All other endpoints require superadmin auth
    if (!authCheck(req)) {
      return cors({ error: 'Non autorisé' }, 401, req);
    }

    // GET /api/establishments - List all (superadmin)
    if (req.method === 'GET' && (path === '' || path === '/')) {
      const index = await store.get('_index', { type: 'json' }) as any[] || [];
      const schools = [];
      for (const entry of index) {
        const data = await store.get(`school_${entry.id}`, { type: 'json' });
        if (data) schools.push(data);
      }
      return cors(schools, 200, req);
    }

    // GET /api/establishments/:id - Get single (superadmin)
    if (req.method === 'GET' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      const data = await store.get(`school_${id}`, { type: 'json' });
      if (!data) return cors({ error: 'Non trouvé' }, 404, req);
      return cors(data, 200, req);
    }

    // POST /api/establishments - Create
    if (req.method === 'POST' && (path === '' || path === '/')) {
      let body: any;
      try {
        body = await req.json();
      } catch (e) {
        console.error('[create] Failed to parse request body:', e);
        return cors({ error: 'Corps de requête invalide' }, 400, req);
      }

      if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
        return cors({ error: 'Nom requis (minimum 2 caractères)' }, 400, req);
      }
      if (body.email && !isValidEmail(body.email)) {
        return cors({ error: 'Format d\'email invalide' }, 400, req);
      }
      if (body.admin_email && !isValidEmail(body.admin_email)) {
        return cors({ error: 'Format d\'email admin invalide' }, 400, req);
      }

      const name = sanitize(body.name.trim());
      const slug = body.slug || genSlug(name);

      console.log('[create] Creating establishment:', name, 'slug:', slug);

      const index = await store.get('_index', { type: 'json' }) as any[] || [];
      if (index.find((e: any) => e.slug === slug)) {
        return cors({ error: 'Sous-domaine déjà utilisé' }, 409, req);
      }

      const id = crypto.randomUUID();
      const adminCode = genAdminCode();
      const inviteToken = genSecureToken();
      const now = new Date().toISOString();
      const plan = body.plan || 'starter';
      const planDurations: Record<string, number> = { starter: 3, pro: 12, enterprise: 24 };
      const expDate = new Date();
      expDate.setMonth(expDate.getMonth() + (planDurations[plan] || 3));

      const school: any = {
        id,
        name,
        slug,
        city: body.city || '',
        type: body.type || 'lycee',
        email: body.email || '',
        plan,
        status: plan === 'starter' ? 'trial' : 'active',
        is_active: true,
        admin_code: adminCode,
        admin_email: body.admin_email || body.email || '',
        admin_invite_token: inviteToken,
        admin_invited: false,
        max_students: { starter: 200, pro: 9999, enterprise: 99999 }[plan] || 200,
        max_reports: { starter: 50, pro: 9999, enterprise: 99999 }[plan] || 50,
        max_admins: { starter: 1, pro: 2, enterprise: 99 }[plan] || 1,
        created_at: now,
        expires_at: expDate.toISOString(),
        report_count: 0,
        student_count: 0,
        staff_members: [],
        staff_codes: []
      };

      console.log('[create] Saving to Netlify Blobs...');
      await store.setJSON(`school_${id}`, school);
      index.push({
        id, name: school.name, slug: school.slug, city: school.city,
        type: school.type, plan: school.plan, is_active: true,
        status: school.status, created_at: now
      });
      await store.setJSON('_index', index);
      console.log('[create] Blob saved successfully');

      // Sync to Supabase (non-blocking)
      syncToSupabase(school, store).catch((e) => {
        console.error('[create] Supabase sync failed:', e);
      });

      // Create Supabase admin user (non-blocking)
      createSupabaseAdmin(school).then(result => {
        if (result.success) {
          console.log('[create] Supabase admin invite sent to:', school.admin_email);
          // Update blob with invitation status
          school.admin_invited = true;
          store.setJSON(`school_${id}`, school).catch(() => {});
        } else {
          console.warn('[create] Supabase admin creation failed:', result.error);
        }
      }).catch((e) => {
        console.error('[create] Supabase admin creation error:', e);
      });

      // Return response without sensitive fields
      const response = { ...school };
      delete response.admin_invite_token;
      console.log('[create] Establishment created successfully:', id);
      return cors(response, 201, req);
    }

    // PUT /api/establishments/:id - Update
    if (req.method === 'PUT' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      const existing = await store.get(`school_${id}`, { type: 'json' }) as any;
      if (!existing) return cors({ error: 'Non trouvé' }, 404, req);

      let body: any;
      try {
        body = await req.json();
      } catch (e) {
        console.error('[update] Failed to parse body:', e);
        return cors({ error: 'Corps de requête invalide' }, 400, req);
      }

      const updated = { ...existing, ...body, id, updated_at: new Date().toISOString() };
      await store.setJSON(`school_${id}`, updated);

      const index = await store.get('_index', { type: 'json' }) as any[] || [];
      const idx = index.findIndex((e: any) => e.id === id);
      if (idx >= 0) {
        index[idx] = {
          ...index[idx],
          name: updated.name, slug: updated.slug, city: updated.city,
          type: updated.type, plan: updated.plan, is_active: updated.is_active,
          status: updated.status
        };
        await store.setJSON('_index', index);
      }

      return cors(updated, 200, req);
    }

    // DELETE /api/establishments/:id
    if (req.method === 'DELETE' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      await store.delete(`school_${id}`);
      const index = await store.get('_index', { type: 'json' }) as any[] || [];
      const filtered = index.filter((e: any) => e.id !== id);
      await store.setJSON('_index', filtered);
      return cors({ deleted: true }, 200, req);
    }

    // POST /api/establishments/:id/staff-codes
    if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/staff-codes$/)) {
      const id = path.split('/')[1];
      const existing = await store.get(`school_${id}`, { type: 'json' }) as any;
      if (!existing) return cors({ error: 'Non trouvé' }, 404, req);

      let body: any;
      try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
      const count = Math.min(body.count || 5, 50);
      const codes: any[] = existing.staff_codes || [];
      for (let i = 0; i < count; i++) {
        codes.push({
          code: 'STF-' + genAdminCode(),
          role: body.role || 'cpe',
          used: false,
          created_at: new Date().toISOString()
        });
      }
      existing.staff_codes = codes;
      await store.setJSON(`school_${id}`, existing);
      return cors({ codes }, 200, req);
    }

    // POST /api/establishments/:id/regenerate-admin
    if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/regenerate-admin$/)) {
      const id = path.split('/')[1];
      const existing = await store.get(`school_${id}`, { type: 'json' }) as any;
      if (!existing) return cors({ error: 'Non trouvé' }, 404, req);

      existing.admin_code = genAdminCode();
      existing.admin_invite_token = genSecureToken();
      await store.setJSON(`school_${id}`, existing);
      return cors({ admin_code: existing.admin_code, admin_email: existing.admin_email }, 200, req);
    }

    // POST /api/establishments/:id/resend-invite — resend admin invitation
    if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/resend-invite$/)) {
      const id = path.split('/')[1];
      const existing = await store.get(`school_${id}`, { type: 'json' }) as any;
      if (!existing) return cors({ error: 'Non trouvé' }, 404, req);

      const result = await createSupabaseAdmin(existing);
      if (result.success) {
        existing.admin_invited = true;
        await store.setJSON(`school_${id}`, existing);
        return cors({ ok: true, message: 'Invitation renvoyée à ' + existing.admin_email }, 200, req);
      }
      return cors({ error: result.error || 'Impossible d\'envoyer l\'invitation' }, 500, req);
    }

    return cors({ error: 'Route non trouvée' }, 404, req);

  } catch (error: any) {
    // ── Global error handler — NEVER return non-JSON ──
    console.error('[api-establishments] UNHANDLED ERROR:', error);
    console.error('[api-establishments] Stack:', error?.stack || 'no stack');
    console.error('[api-establishments] Method:', req.method, 'URL:', req.url);

    return new Response(JSON.stringify({
      error: 'Erreur interne du serveur',
      message: 'Une erreur inattendue est survenue. Veuillez réessayer.',
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, x-sa-token, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
      }
    });
  }
};

export const config: Config = {
  path: ['/api/establishments', '/api/establishments/*']
};
