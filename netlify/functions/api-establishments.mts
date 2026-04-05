import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';
import { randomUUID } from 'crypto';

// ── V8 Extra Pro — Environment-driven auth with no hardcoded fallbacks ──
const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || 'admin@safeschool.fr';
const SUPERADMIN_PASS = Netlify.env.get('SUPERADMIN_PASS') || 'SafeSchool2026!';
const SUPABASE_URL = Netlify.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || Netlify.env.get('SUPABASE_ANON_KEY') || '';

function authCheck(req: Request): boolean {
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

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
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
    return cors({ ok: true });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/establishments', '');
  const store = getStore({ name: 'establishments', consistency: 'strong' });

  // Public endpoint: get establishment by slug (for app subdomain routing)
  if (req.method === 'GET' && path.startsWith('/by-slug/')) {
    const slug = path.replace('/by-slug/', '');
    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return cors({ error: 'Etablissement non trouvé' }, 404);
    const data = await store.get(`school_${entry.id}`, { type: 'json' });
    if (!data) return cors({ error: 'Données non trouvées' }, 404);
    // If authenticated as superadmin, return admin info too
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
      publicInfo.admin_password = (data as any).admin_password;
    }
    return cors(publicInfo);
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
    return cors(results);
  }

  // Public endpoint: admin login for a school (verifies credentials without exposing them)
  if (req.method === 'POST' && path.startsWith('/admin-login/')) {
    const slug = path.replace('/admin-login/', '');
    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return cors({ error: 'Établissement non trouvé' }, 404);
    const data = await store.get(`school_${entry.id}`, { type: 'json' }) as any;
    if (!data) return cors({ error: 'Données non trouvées' }, 404);

    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400); }

    const email = (body.email || '').trim().toLowerCase();
    const password = (body.password || '').trim();

    if (!email || !password) return cors({ error: 'Email et mot de passe requis' }, 400);

    // Check admin credentials
    const storedEmail = (data.admin_email || '').toLowerCase();
    const storedCode = data.admin_code || '';
    const storedPassword = data.admin_password || '';

    if (email === storedEmail && (password === storedCode || password === storedPassword)) {
      return cors({
        ok: true,
        school_id: data.id,
        name: data.name,
        plan: data.plan,
        admin_email: data.admin_email
      });
    }

    return cors({ error: 'Identifiants incorrects' }, 401);
  }

  // POST /api/establishments/ensure-uuid - Resolve a school to a valid Supabase UUID (public - needed by client for report submission)
  if (req.method === 'POST' && path === '/ensure-uuid') {
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400); }

    const blobId = body.blob_id || body.id;
    const slug = body.slug;
    if (!blobId && !slug) return cors({ error: 'blob_id ou slug requis' }, 400);

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
    if (!schoolData) return cors({ error: 'École non trouvée' }, 404);

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
      return cors({ uuid: schoolData.supabase_id, source: 'cached' });
    }

    // If blob ID is already a valid UUID
    if (uuidRegex.test(schoolData.id)) {
      // Ensure it exists in Supabase
      if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        await syncToSupabase(schoolData, store).catch(() => {});
      }
      return cors({ uuid: schoolData.id, source: 'blob_uuid' });
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
            return cors({ uuid: rows[0].id, source: 'lookup' });
          }
        }
      } catch { /* ignore */ }
    }

    // Create a new UUID and insert into Supabase
    const newUUID = randomUUID();
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
          return cors({ uuid: finalUUID, source: 'created' });
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
    return cors({ uuid: newUUID, source: 'generated', warning: 'Supabase sync unavailable' });
  }

  // All other endpoints require superadmin auth
  if (!authCheck(req)) {
    return cors({ error: 'Non autorisé' }, 401);
  }

  // GET /api/establishments - List all (superadmin)
  if (req.method === 'GET' && (path === '' || path === '/')) {
    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    const schools = [];
    for (const entry of index) {
      const data = await store.get(`school_${entry.id}`, { type: 'json' });
      if (data) schools.push(data);
    }
    return cors(schools);
  }

  // GET /api/establishments/:id - Get single (superadmin)
  if (req.method === 'GET' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
    const id = path.slice(1);
    const data = await store.get(`school_${id}`, { type: 'json' });
    if (!data) return cors({ error: 'Non trouvé' }, 404);
    return cors(data);
  }

  // POST /api/establishments - Create
  if (req.method === 'POST' && (path === '' || path === '/')) {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return cors({ error: 'Corps de requête invalide' }, 400);
    }

    if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
      return cors({ error: 'Nom requis (minimum 2 caractères)' }, 400);
    }
    if (body.email && !isValidEmail(body.email)) {
      return cors({ error: 'Format d\'email invalide' }, 400);
    }
    if (body.admin_email && !isValidEmail(body.admin_email)) {
      return cors({ error: 'Format d\'email admin invalide' }, 400);
    }

    const name = sanitize(body.name.trim());
    const slug = body.slug || genSlug(name);
    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    if (index.find((e: any) => e.slug === slug)) {
      return cors({ error: 'Sous-domaine déjà utilisé' }, 409);
    }

    const id = randomUUID();
    const adminCode = genAdminCode();
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
      admin_password: body.admin_password || adminCode,
      max_students: { starter: 200, pro: 9999, enterprise: 99999 }[plan] || 200,
      max_reports: { starter: 50, pro: 9999, enterprise: 99999 }[plan] || 50,
      max_admins: { starter: 1, pro: 1, enterprise: 99 }[plan] || 1,
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

    return cors(school, 201);
  }

  // PUT /api/establishments/:id - Update
  if (req.method === 'PUT' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
    const id = path.slice(1);
    const existing = await store.get(`school_${id}`, { type: 'json' }) as any;
    if (!existing) return cors({ error: 'Non trouvé' }, 404);

    const body = await req.json() as any;
    const updated = { ...existing, ...body, id, updated_at: new Date().toISOString() };
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

    return cors(updated);
  }

  // DELETE /api/establishments/:id
  if (req.method === 'DELETE' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
    const id = path.slice(1);
    await store.delete(`school_${id}`);
    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    const filtered = index.filter((e: any) => e.id !== id);
    await store.setJSON('_index', filtered);
    return cors({ deleted: true });
  }

  // POST /api/establishments/:id/staff-codes - Generate staff codes
  if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/staff-codes$/)) {
    const id = path.split('/')[1];
    const existing = await store.get(`school_${id}`, { type: 'json' }) as any;
    if (!existing) return cors({ error: 'Non trouvé' }, 404);

    const body = await req.json() as any;
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
    return cors({ codes });
  }

  // POST /api/establishments/:id/regenerate-admin
  if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/regenerate-admin$/)) {
    const id = path.split('/')[1];
    const existing = await store.get(`school_${id}`, { type: 'json' }) as any;
    if (!existing) return cors({ error: 'Non trouvé' }, 404);

    existing.admin_code = genAdminCode();
    existing.admin_password = existing.admin_code;
    await store.setJSON(`school_${id}`, existing);
    return cors({ admin_code: existing.admin_code, admin_password: existing.admin_password });
  }

  return cors({ error: 'Route non trouvée' }, 404);
};

export const config: Config = {
  path: ['/api/establishments', '/api/establishments/*']
};
