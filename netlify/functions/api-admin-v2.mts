import type { Context } from '@netlify/functions';

// SafeSchool Admin API V2 - JWT-based multi-tenant isolation
// Sprint 4 hardening: replaces direct Supabase calls from dashboard

async function verifyJWT(token: string, secret: string): Promise<any|null> {
  try {
    const [h, p, s] = token.split('.');
    if(!h || !p || !s) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
    const sig = Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(h+'.'+p));
    if(!ok) return null;
    const payload = JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/')));
    if(payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

function cors(body:any, status:number=200){
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: status,
    headers: {
      'Content-Type':'application/json',
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type,Authorization'
    }
  });
}

export default async function handler(req: Request, ctx: Context) {
  if(req.method === 'OPTIONS') return cors({});

  const SU = process.env.aSUPABASE_URL || process.env.SUPABASE_URL || '';
  const SK = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'safeschool_change_me';

  // Extract JWT from Authorization header
  const auth = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if(!token) return cors({error:'Token requis'}, 401);

  const payload = await verifyJWT(token, JWT_SECRET);
  if(!payload || !payload.school_id || !payload.slug) return cors({error:'Token invalide'}, 401);

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/admin-v2/, '').replace(/\/$/,'') || '/';

  // Route: GET /reports - list reports for MY school
  if(req.method === 'GET' && path === '/reports'){
    const r = await fetch(SU + '/rest/v1/reports?school_id=eq.' + payload.school_id + '&select=*&order=created_at.desc', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    const data = await r.json();
    return cors(data);
  }

  // Route: GET /reports/:id - get single report (must belong to my school)
  const reportIdMatch = path.match(/^\/reports\/([a-f0-9\-]+)$/);
  if(req.method === 'GET' && reportIdMatch){
    const id = reportIdMatch[1];
    const r = await fetch(SU + '/rest/v1/reports?id=eq.' + id + '&school_id=eq.' + payload.school_id + '&select=*', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    const data = await r.json();
    if(!Array.isArray(data) || !data.length) return cors({error:'Not found'}, 404);
    return cors(data[0]);
  }

  // Route: PATCH /reports/:id - update report (must belong to my school)
  if(req.method === 'PATCH' && reportIdMatch){
    const id = reportIdMatch[1];
    let body: any = {};
    try { body = await req.json(); } catch { return cors({error:'Invalid body'}, 400); }
    // Whitelist allowed fields (no privilege escalation)
    const allowed = ['status','admin_reply','admin_note','staff_reply','assigned_to','assigned_staff_id','assigned_to_name','reply_sent_at','internal_notes','urgency'];
    const update: any = {};
    for(const k of allowed) if(k in body) update[k] = body[k];
    if(Object.keys(update).length === 0) return cors({error:'Nothing to update'}, 400);

    // Verify report belongs to my school first
    const verifyR = await fetch(SU + '/rest/v1/reports?id=eq.' + id + '&school_id=eq.' + payload.school_id + '&select=id', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    const verifyData = await verifyR.json();
    if(!Array.isArray(verifyData) || !verifyData.length) return cors({error:'Not found or cross-tenant blocked'}, 404);

    const r = await fetch(SU + '/rest/v1/reports?id=eq.' + id + '&school_id=eq.' + payload.school_id, {
      method: 'PATCH',
      headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type':'application/json', Prefer:'return=representation' },
      body: JSON.stringify(update)
    });
    const data = await r.json();
    return cors(data);
  }

  // Route: GET /files/:reportId - get signed URLs for report files
  const filesMatch = path.match(/^\/files\/([a-f0-9\-]+)$/);
  if(req.method === 'GET' && filesMatch){
    const reportId = filesMatch[1];
    // Verify report belongs to my school
    const verifyR = await fetch(SU + '/rest/v1/reports?id=eq.' + reportId + '&school_id=eq.' + payload.school_id + '&select=id', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    if(!(await verifyR.json()).length) return cors({error:'Not found'}, 404);

    const filesR = await fetch(SU + '/rest/v1/report_files?report_id=eq.' + reportId + '&school_id=eq.' + payload.school_id + '&select=*', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    const files: any[] = await filesR.json();
    if(!Array.isArray(files) || !files.length) return cors([]);

    // Sign URLs
    const paths = files.map(f => f.file_path);
    const signR = await fetch(SU + '/storage/v1/object/sign/report-files', {
      method: 'POST',
      headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type':'application/json' },
      body: JSON.stringify({ expiresIn: 3600, paths: paths })
    });
    const signed: any[] = await signR.json();
    const enriched = files.map((f, i) => ({
      ...f,
      signed_url: Array.isArray(signed) && signed[i] && signed[i].signedURL ? SU + '/storage/v1' + signed[i].signedURL : null
    }));
    return cors(enriched);
  }

  // Route: GET /stats - dashboard stats for my school
  if(req.method === 'GET' && path === '/stats'){
    const r = await fetch(SU + '/rest/v1/reports?school_id=eq.' + payload.school_id + '&select=status,urgency,type', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    const data: any[] = await r.json();
    const stats = {
      total: data.length,
      nouveau: data.filter(d => d.status === 'nouveau').length,
      en_cours: data.filter(d => d.status === 'en_cours').length,
      traites: data.filter(d => ['traite','archive','closed'].includes(d.status)).length,
      urgents: data.filter(d => d.urgency === 'haute').length
    };
    return cors({school_id: payload.school_id, school_name: payload.school_name, stats: stats});
  }

  // Route: GET /subadmins - list sub-admins
  if(req.method === 'GET' && path === '/subadmins'){
    const r = await fetch(SU + '/rest/v1/sub_admins?school_id=eq.' + payload.school_id + '&select=id,name,role,email,is_active,created_at&order=created_at.desc', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    return cors(await r.json());
  }

  // Route: GET /me - return JWT payload info
  if(req.method === 'GET' && path === '/me'){
    return cors({school_id: payload.school_id, school_name: payload.school_name, slug: payload.slug, role: payload.role});
  }

  return cors({error: 'Route not found', method: req.method, path: path}, 404);
}

export const config = { path: '/api/admin-v2/*' };