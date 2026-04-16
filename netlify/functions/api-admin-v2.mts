import type { Context } from '@netlify/functions';

// SafeSchool Admin API V2 - DEBUG VERSION

function b64urlDecode(s: string): string {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while(b64.length % 4) b64 += '=';
  return atob(b64);
}

// Match the EXACT same logic as api-establishments signJWT
async function signJWT(payload: any, secret: string): Promise<string> {
  const h = { alg: 'HS256', typ: 'JWT' };
  const toB64url = (obj: any) => btoa(JSON.stringify(obj)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const h64 = toB64url(h);
  const p64 = toB64url(payload);
  const msg = h64 + '.' + p64;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return msg + '.' + sigB64;
}

async function verifyJWT(token: string, secret: string): Promise<{ok: boolean, payload?: any, error?: string}> {
  try {
    const parts = token.split('.');
    if(parts.length !== 3) return {ok:false, error:'parts ne 3'};
    const [h, p, s] = parts;

    // Re-sign with our secret and compare signatures
    const msg = h + '.' + p;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
    const mySigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
    const mySig = btoa(String.fromCharCode(...new Uint8Array(mySigBuf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

    if(mySig !== s) return {ok:false, error:'sig mismatch', expected: mySig.substring(0,20), got: s.substring(0,20)};

    const payload = JSON.parse(b64urlDecode(p));
    if(payload.exp && payload.exp < Math.floor(Date.now()/1000)) return {ok:false, error:'expired'};
    return {ok:true, payload: payload};
  } catch(e: any) {
    return {ok:false, error: e.message || 'verify error'};
  }
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

  const urlCheck = new URL(req.url);
  const pathCheck = urlCheck.pathname;

  if(pathCheck.endsWith('/_debug')){
    const auth = req.headers.get('Authorization') || '';
    const tok = auth.replace(/^Bearer\s+/i,'').trim();
    const result = tok ? await verifyJWT(tok, JWT_SECRET) : {ok:false, error:'no token'};
    return cors({
      env: { has_SU: !!SU, has_SK: !!SK, has_JWT: !!JWT_SECRET, jwt_len: JWT_SECRET.length },
      token_info: tok ? { len: tok.length, parts: tok.split('.').length } : null,
      verify_result: result
    });
  }

  const auth = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if(!token) return cors({error:'Token requis'}, 401);

  const verifyResult = await verifyJWT(token, JWT_SECRET);
  if(!verifyResult.ok || !verifyResult.payload) return cors({error:'Token invalide', debug: verifyResult}, 401);
  const payload = verifyResult.payload;

  if(!payload.school_id || !payload.slug) return cors({error:'Payload incomplet', payload_keys: Object.keys(payload)}, 401);

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/admin-v2/, '').replace(/\/$/,'') || '/';

  if(req.method === 'GET' && path === '/reports'){
    const r = await fetch(SU + '/rest/v1/reports?school_id=eq.' + payload.school_id + '&select=*&order=created_at.desc', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    return cors(await r.json());
  }

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

  if(req.method === 'PATCH' && reportIdMatch){
    const id = reportIdMatch[1];
    let body: any = {};
    try { body = await req.json(); } catch { return cors({error:'Invalid body'}, 400); }
    const allowed = ['status','admin_reply','admin_note','staff_reply','assigned_to','assigned_staff_id','assigned_to_name','reply_sent_at','internal_notes','urgency'];
    const update: any = {};
    for(const k of allowed) if(k in body) update[k] = body[k];
    if(Object.keys(update).length === 0) return cors({error:'Nothing to update'}, 400);

    const verifyR = await fetch(SU + '/rest/v1/reports?id=eq.' + id + '&school_id=eq.' + payload.school_id + '&select=id', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    if(!(await verifyR.json()).length) return cors({error:'Not found or cross-tenant'}, 404);

    const r = await fetch(SU + '/rest/v1/reports?id=eq.' + id + '&school_id=eq.' + payload.school_id, {
      method: 'PATCH',
      headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type':'application/json', Prefer:'return=representation' },
      body: JSON.stringify(update)
    });
    return cors(await r.json());
  }

  const filesMatch = path.match(/^\/files\/([a-f0-9\-]+)$/);
  if(req.method === 'GET' && filesMatch){
    const reportId = filesMatch[1];
    const verifyR = await fetch(SU + '/rest/v1/reports?id=eq.' + reportId + '&school_id=eq.' + payload.school_id + '&select=id', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    if(!(await verifyR.json()).length) return cors({error:'Not found'}, 404);

    const filesR = await fetch(SU + '/rest/v1/report_files?report_id=eq.' + reportId + '&school_id=eq.' + payload.school_id + '&select=*', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    const files: any[] = await filesR.json();
    if(!Array.isArray(files) || !files.length) return cors([]);

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

  if(req.method === 'GET' && path === '/stats'){
    const r = await fetch(SU + '/rest/v1/reports?school_id=eq.' + payload.school_id + '&select=status,urgency,type', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    const data: any[] = await r.json();
    return cors({
      school_id: payload.school_id,
      school_name: payload.school_name,
      stats: {
        total: data.length,
        nouveau: data.filter(d => d.status === 'nouveau').length,
        en_cours: data.filter(d => d.status === 'en_cours').length,
        traites: data.filter(d => ['traite','archive','closed'].includes(d.status)).length,
        urgents: data.filter(d => d.urgency === 'haute').length
      }
    });
  }

  if(req.method === 'GET' && path === '/subadmins'){
    const r = await fetch(SU + '/rest/v1/sub_admins?school_id=eq.' + payload.school_id + '&select=id,name,role,email,is_active,created_at&order=created_at.desc', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    return cors(await r.json());
  }

  if(req.method === 'GET' && path === '/me'){
    return cors({school_id: payload.school_id, school_name: payload.school_name, slug: payload.slug, role: payload.role, exp: payload.exp});
  }

  return cors({error: 'Route not found', method: req.method, path: path}, 404);
}

export const config = { path: '/api/admin-v2/*' };