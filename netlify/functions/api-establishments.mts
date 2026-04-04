import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || 'am.ad.bm@gmail.com';
const SUPERADMIN_PASS = Netlify.env.get('SUPERADMIN_PASS') || 'SafeSchool2026!';

function authCheck(req: Request): boolean {
  const auth = req.headers.get('x-sa-token');
  if (!auth) return false;
  try {
    const decoded = atob(auth);
    return decoded === `${SUPERADMIN_EMAIL}:${SUPERADMIN_PASS}`;
  } catch { return false; }
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
    // Return only public info
    return cors({
      id: (data as any).id,
      name: (data as any).name,
      slug: (data as any).slug,
      city: (data as any).city,
      type: (data as any).type,
      plan: (data as any).plan,
      is_active: (data as any).is_active
    });
  }

  // Public endpoint: list active establishments (for app)
  if (req.method === 'GET' && path === '/public') {
    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    const active = index.filter((e: any) => e.is_active);
    return cors(active.map((e: any) => ({
      id: e.id, name: e.name, slug: e.slug, city: e.city, type: e.type, plan: e.plan
    })));
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
    const body = await req.json() as any;
    if (!body.name) return cors({ error: 'Nom requis' }, 400);

    const slug = body.slug || genSlug(body.name);
    const index = await store.get('_index', { type: 'json' }) as any[] || [];
    if (index.find((e: any) => e.slug === slug)) {
      return cors({ error: 'Sous-domaine déjà utilisé' }, 409);
    }

    const id = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const adminCode = genAdminCode();
    const now = new Date().toISOString();
    const plan = body.plan || 'starter';
    const planDurations: Record<string, number> = { starter: 3, pro: 12, enterprise: 24 };
    const expDate = new Date();
    expDate.setMonth(expDate.getMonth() + (planDurations[plan] || 3));

    const school: any = {
      id,
      name: body.name,
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
      max_admins: { starter: 1, pro: 3, enterprise: 99 }[plan] || 1,
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
  path: '/api/establishments/*'
};
