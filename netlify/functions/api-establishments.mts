import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';
import {
  extractClientIp,
  hashPassword,
  isSuperadminRequest,
  jsonCors,
  safeJson,
  sanitizeText
} from './_lib/security.mts';

// ── V10 EU — Environment-driven auth — NO hardcoded fallbacks ──
const SUPABASE_URL = Netlify.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || Netlify.env.get('SUPABASE_ANON_KEY') || '';

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

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

// Sync school to Supabase (non-blocking, best-effort)
async function syncToSupabase(school: any, store: any): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
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
      // Store Supabase UUID back into the blob for cross-reference
      try {
        const supaData = await res.json();
        if (Array.isArray(supaData) && supaData.length > 0 && supaData[0].id) {
          school.supabase_id = supaData[0].id;
          await store.setJSON(`school_${school.id}`, school);
        }
      } catch { /* ignore parse errors */ }
    } else {
      console.warn('Supabase sync failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.warn('Supabase sync error:', e);
  }
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') {
    return jsonCors({ ok: true }, 200, req);
  }

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/establishments', '');
  const store = getStore({ name: 'establishments', consistency: 'strong' });

  // Public endpoint: get establishment by slug (for app subdomain routing)
  if (req.method === 'GET' && path.startsWith('/by-slug/')) {
    const slug = path.replace('/by-slug/', '');
    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return jsonCors({ error: 'Etablissement non trouvé' }, 404, req);
    const data = await store.get(`school_${entry.id}`, { type: 'json' });
    if (!data) return jsonCors({ error: 'Données non trouvées' }, 404, req);
    // If authenticated as superadmin, return admin info too
    const isAdmin = await isSuperadminRequest(req);
    const publicInfo: any = {
      id: (data as any).id,
      name: (data as any).name,
      slug: (data as any).slug,
      city: (data as any).city,
      type: (data as any).type,
      plan: (data as any).plan,
      is_active: (data as any).is_active
    };
    if (isAdmin) publicInfo.admin_email = (data as any).admin_email;
    return jsonCors(publicInfo, 200, req);
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
    return jsonCors(results, 200, req);
  }

  // Public endpoint: admin login for a school (verifies credentials without exposing them)
  if (req.method === 'POST' && path.startsWith('/admin-login/')) {
    // Rate limit login attempts
    const clientIp = extractClientIp(req, context);
    const rateCheck = await checkLoginRateLimit(clientIp);
    if (rateCheck.blocked) {
      return jsonCors({ error: 'Trop de tentatives. Reessayez dans 15 minutes.', retry_after_seconds: LOGIN_RATE_WINDOW_MS / 1000 }, 429, req);
    }

    const slug = path.replace('/admin-login/', '');
    if (!slug || slug.length > 100 || !/^[a-z0-9-]+$/.test(slug)) {
      return jsonCors({ error: 'Slug invalide' }, 400, req);
    }

    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return jsonCors({ error: 'Etablissement non trouve' }, 404, req);
    const data = await store.get(`school_${entry.id}`, { type: 'json' }) as any;
    if (!data) return jsonCors({ error: 'Donnees non trouvees' }, 404, req);

    let body: any;
    try { body = await safeJson(req); } catch { return jsonCors({ error: 'Corps invalide' }, 400, req); }

    const email = sanitizeText(body.email || '', 140).toLowerCase();
    const password = String(body.password || '').trim();

    if (!email || !isValidEmail(email)) return jsonCors({ error: 'Format d\'email invalide' }, 400, req);
    if (!password || password.length === 0) return jsonCors({ error: 'Mot de passe requis' }, 400, req);
    if (password.length > 200) return jsonCors({ error: 'Mot de passe trop long' }, 400, req);

    // Check admin credentials
    const storedEmail = (data.admin_email || '').toLowerCase();
    const storedCode = data.admin_code || '';
    const storedPasswordHash = data.admin_password_hash || '';
    const passwordHash = await hashPassword(password);
    const legacyPassword = data.admin_password || '';
    const matches = email === storedEmail && (password === storedCode || passwordHash === storedPasswordHash || password === legacyPassword);

    if (matches) {
      if (!storedPasswordHash || legacyPassword) {
        data.admin_password_hash = passwordHash;
        delete data.admin_password;
        await store.setJSON(`school_${entry.id}`, data);
      }
      return jsonCors({
        ok: true,
        school_id: data.id,
        name: data.name,
        plan: data.plan,
        admin_email: data.admin_email,
        role: 'establishment_admin'
      }, 200, req);
    }

    await recordLoginAttempt(clientIp);
    return jsonCors({ error: 'Identifiants incorrects', attempts_remaining: Math.max(rateCheck.remaining - 1, 0) }, 401, req);
  }

  // POST /api/establishments/ensure-uuid - Resolve a school to a valid Supabase UUID (public - needed by client for report submission)
  if (req.method === 'POST' && path === '/ensure-uuid') {
    let body: any;
    try { body = await safeJson(req); } catch { return jsonCors({ error: 'Corps invalide' }, 400, req); }

    const blobId = body.blob_id || body.id;
    const slug = body.slug;
    if (!blobId && !slug) return jsonCors({ error: 'blob_id ou slug requis' }, 400, req);

    // Find the school in blobs
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
    if (!schoolData) return jsonCors({ error: 'École non trouvée' }, 404, req);

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // If school already has a valid supabase_id cached, return it
    if (schoolData.supabase_id && uuidRegex.test(schoolData.supabase_id)) {
      // Also ensure it exists in Supabase schools table
      if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        try {
          const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/schools?id=eq.${schoolData.supabase_id}&select=id`, {
            headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
          });
          if (checkRes.ok) {
            const rows = await checkRes.json();
            if (!Array.isArray(rows) || rows.length === 0) {
              // UUID cached but school not in Supabase - re-sync
              await syncToSupabase({ ...schoolData, id: schoolData.supabase_id }, store).catch(() => {});
            }
          }
        } catch { /* best effort */ }
      }
      return jsonCors({ uuid: schoolData.supabase_id, source: 'cached' }, 200, req);
    }

    // If blob ID is already a valid UUID
    if (uuidRegex.test(schoolData.id)) {
      // Ensure it exists in Supabase
      if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        await syncToSupabase(schoolData, store).catch(() => {});
      }
      return jsonCors({ uuid: schoolData.id, source: 'blob_uuid' }, 200, req);
    }

    // Old-format ID: need to create a proper UUID
    // First try to look up by slug in Supabase (maybe it was synced before)
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
            return jsonCors({ uuid: rows[0].id, source: 'lookup' }, 200, req);
          }
        }
      } catch { /* ignore */ }
    }

    // Create a new UUID and insert into Supabase
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
          return jsonCors({ uuid: finalUUID, source: 'created' }, 200, req);
        } else {
          console.warn('Supabase insert failed:', res.status, await res.text().catch(() => ''));
        }
      } catch (e) {
        console.warn('Supabase ensure-uuid error:', e);
      }
    }

    // Last resort: generate UUID locally (Supabase unavailable)
    schoolData.supabase_id = newUUID;
    await store.setJSON(`school_${schoolData.id}`, schoolData);
    return jsonCors({ uuid: newUUID, source: 'generated', warning: 'Supabase sync unavailable' }, 200, req);
  }

  // All other endpoints require superadmin auth
  if (!(await isSuperadminRequest(req))) {
    return jsonCors({ error: 'Non autorisé' }, 401, req);
  }

  // GET /api/establishments - List all (superadmin)
  if (req.method === 'GET' && (path === '' || path === '/')) {
    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    const schools = [];
    for (const entry of index) {
      const data = await store.get(`school_${entry.id}`, { type: 'json' });
      if (data) schools.push(data);
    }
    const sanitizedSchools = schools.map((s: any) => {
      const copy = { ...s };
      delete copy.admin_password;
      return copy;
    });
    return jsonCors(sanitizedSchools, 200, req);
  }

  // GET /api/establishments/:id - Get single (superadmin)
  if (req.method === 'GET' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
    const id = path.slice(1);
    const data = await store.get(`school_${id}`, { type: 'json' });
    if (!data) return jsonCors({ error: 'Non trouvé' }, 404, req);
    const sanitized = { ...(data as any) };
    delete sanitized.admin_password;
    return jsonCors(sanitized, 200, req);
  }

  // POST /api/establishments - Create
  if (req.method === 'POST' && (path === '' || path === '/')) {
    let body: any;
    try {
      body = await safeJson(req);
    } catch {
      return jsonCors({ error: 'Corps de requête invalide' }, 400, req);
    }

    if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
      return jsonCors({ error: 'Nom requis (minimum 2 caractères)' }, 400, req);
    }
    if (body.email && !isValidEmail(body.email)) {
      return jsonCors({ error: 'Format d\'email invalide' }, 400, req);
    }
    if (body.admin_email && !isValidEmail(body.admin_email)) {
      return jsonCors({ error: 'Format d\'email admin invalide' }, 400, req);
    }

    const name = sanitizeText(body.name, 140);
    const slug = sanitizeText(body.slug || genSlug(name), 80);
    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    if (index.find((e: any) => e.slug === slug)) {
      return jsonCors({ error: 'Sous-domaine déjà utilisé' }, 409, req);
    }

    const id = crypto.randomUUID();
    const adminCode = genAdminCode();
    const now = new Date().toISOString();
    const plan = body.plan || 'starter';
    const planDurations: Record<string, number> = { starter: 3, pro: 12, enterprise: 24 };
    const expDate = new Date();
    expDate.setMonth(expDate.getMonth() + (planDurations[plan] || 3));

    const generatedPassword = sanitizeText(body.admin_password || adminCode, 200);
    const adminPasswordHash = await hashPassword(generatedPassword);
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
      admin_email: sanitizeText(body.admin_email || body.email || '', 140).toLowerCase(),
      admin_password_hash: adminPasswordHash,
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

    await store.setJSON(`school_${id}`, school);
    index.push({
      id, name: school.name, slug: school.slug, city: school.city,
      type: school.type, plan: school.plan, is_active: true,
      status: school.status, created_at: now
    });
    await store.setJSON('_index', index);

    // Sync to Supabase (non-blocking)
    syncToSupabase(school, store).catch(() => {});

    const responseSchool = { ...school, admin_temp_password: generatedPassword };
    return jsonCors(responseSchool, 201, req);
  }

  // PUT /api/establishments/:id - Update
  if (req.method === 'PUT' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
    const id = path.slice(1);
    const existing = await store.get(`school_${id}`, { type: 'json' }) as any;
    if (!existing) return jsonCors({ error: 'Non trouvé' }, 404, req);

    const body = await safeJson(req) as any;
    const updated = { ...existing, ...body, id, updated_at: new Date().toISOString() };
    if (body.admin_password) {
      updated.admin_password_hash = await hashPassword(String(body.admin_password));
      delete updated.admin_password;
    }
    await store.setJSON(`school_${id}`, updated);

    // Update index
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

    const sanitized = { ...updated };
    delete sanitized.admin_password;
    return jsonCors(sanitized, 200, req);
  }

  // DELETE /api/establishments/:id
  if (req.method === 'DELETE' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
    const id = path.slice(1);
    await store.delete(`school_${id}`);
    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    const filtered = index.filter((e: any) => e.id !== id);
    await store.setJSON('_index', filtered);
    return jsonCors({ deleted: true }, 200, req);
  }

  // POST /api/establishments/:id/staff-codes - Generate staff codes
  if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/staff-codes$/)) {
    const id = path.split('/')[1];
    const existing = await store.get(`school_${id}`, { type: 'json' }) as any;
    if (!existing) return jsonCors({ error: 'Non trouvé' }, 404, req);

    const body = await safeJson(req) as any;
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
    return jsonCors({ codes }, 200, req);
  }

  // POST /api/establishments/:id/regenerate-admin
  if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/regenerate-admin$/)) {
    const id = path.split('/')[1];
    const existing = await store.get(`school_${id}`, { type: 'json' }) as any;
    if (!existing) return jsonCors({ error: 'Non trouvé' }, 404, req);

    existing.admin_code = genAdminCode();
    existing.admin_password_hash = await hashPassword(existing.admin_code);
    delete existing.admin_password;
    await store.setJSON(`school_${id}`, existing);
    return jsonCors({ admin_code: existing.admin_code, admin_temp_password: existing.admin_code }, 200, req);
  }

  return jsonCors({ error: 'Route non trouvée' }, 404, req);
};

export const config: Config = {
  path: ['/api/establishments', '/api/establishments/*']
};
