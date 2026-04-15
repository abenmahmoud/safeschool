export default async (req) => {
  const hdrs = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') return new Response('{}', { status: 200, headers: hdrs });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: hdrs });
  
  const SU = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
  const SK = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const SECRET = Netlify.env.get('ADMIN_JWT_SECRET') || 'safeschool_jwt_secret_change_me';

  let body = {}; try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Corps invalide' }), { status: 400, headers: hdrs }); }
  const slug = String(body.slug || '').toLowerCase().trim();
  const admin_code = String(body.admin_code || '').trim();
  if (!slug || !admin_code) return new Response(JSON.stringify({ error: 'Slug et code requis' }), { status: 400, headers: hdrs });

  const resp = await fetch(SU + '/rest/v1/schools?slug=eq.' + encodeURIComponent(slug) + '&select=id,name,slug,is_active,admin_code,plan_code', {
    headers: { 'apikey': SK, 'Authorization': 'Bearer ' + SK }
  });
  const schools = await resp.json();
  if (!schools || !schools.length || !schools[0].is_active) return new Response(JSON.stringify({ error: 'Etablissement non trouve' }), { status: 404, headers: hdrs });
  const school = schools[0];
  if (!school.admin_code || admin_code !== school.admin_code) return new Response(JSON.stringify({ error: 'Code incorrect' }), { status: 401, headers: hdrs });

  // JWT HS256 avec base64url via Uint8Array (safe pour tous les bytes)
  const b64u = (buf) => {
    const bytes = buf instanceof Uint8Array ? buf : new TextEncoder().encode(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  };
  const jh = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const jp = b64u(JSON.stringify({ slug, school_id: school.id, school_name: school.name, plan: school.plan_code || 'standard', role: 'admin', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 }));
  const jm = jh + '.' + jp;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(jm)));
  const token = jm + '.' + b64u(sigBuf);

  return new Response(JSON.stringify({ ok: true, token, school_name: school.name, role: 'admin' }), {
    status: 200,
    headers: { ...hdrs, 'Set-Cookie': 'ss_admin_token=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400' }
  });
};
export const config = { path: '/api/admin/login' };