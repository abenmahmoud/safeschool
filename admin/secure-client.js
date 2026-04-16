// SafeSchool Secure Client - Transparent fetch proxy for admin dashboard
// Sprint 4: routes all Supabase REST calls through /api/admin-v2/* with JWT auth
// This allows the dashboard to work securely without modifying index.html/dashboard.html
(function(){
  var SB_URL = 'https://bsytkpgdxvlddzuwaabp.supabase.co';
  var JWT_KEY = 'ss_jwt_v2';
  var LEGACY_TOKEN_KEY = 'ss_admin_token';

  // ---------- JWT helpers ----------
  function getJWT(){ return localStorage.getItem(JWT_KEY); }
  function setJWT(t){ if(t) localStorage.setItem(JWT_KEY, t); else localStorage.removeItem(JWT_KEY); }

  function jwtPayload(t){
    try { var p = t.split('.')[1]; p = p.replace(/-/g,'+').replace(/_/g,'/'); while(p.length%4) p+='='; return JSON.parse(atob(p)); } catch(e){ return null; }
  }
  function jwtValid(t){
    if(!t) return false;
    var p = jwtPayload(t);
    if(!p || !p.exp) return false;
    return p.exp > Math.floor(Date.now()/1000) + 60;
  }

  // ---------- Admin login: exchange admin_code for JWT ----------
  async function adminLoginJWT(slug, adminCode){
    var r = await fetch('/api/establishments/admin-jwt/' + slug, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({admin_code: adminCode})
    });
    if(!r.ok) return null;
    var d = await r.json();
    if(d.token){ setJWT(d.token); return d.token; }
    return null;
  }
  window.adminLoginJWT = adminLoginJWT;

  // Auto-acquire JWT: if admin_code available in localStorage or URL, call login
  async function ensureJWT(){
    var j = getJWT();
    if(jwtValid(j)) return j;
    // Try auto-login: need slug + admin_code
    var slug = null, code = null;
    try { slug = new URLSearchParams(location.search).get('etab') || location.hostname.split('.')[0]; } catch(e){}
    // Check if login page already saved admin_code
    code = localStorage.getItem('ss_admin_code') || sessionStorage.getItem('ss_admin_code');
    if(slug && code){
      var t = await adminLoginJWT(slug, code);
      if(t) return t;
    }
    return null;
  }
  window.ensureJWT = ensureJWT;

  // ---------- Query parser: extract school_id filter, id, etc. ----------
  function parseSupabaseQuery(url){
    // Parse /rest/v1/<table>?<params>
    var u;
    try { u = new URL(url); } catch(e){ return null; }
    if(!u.pathname.startsWith('/rest/v1/')) return null;
    var table = u.pathname.replace('/rest/v1/', '').split('?')[0];
    var params = u.searchParams;
    return { table: table, params: params, full: url };
  }

  // ---------- Main proxy: translate Supabase REST to admin-v2 ----------
  var origFetch = window.fetch.bind(window);

  async function proxyFetch(input, init){
    init = init || {};
    var urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    var method = (init.method || (input && input.method) || 'GET').toUpperCase();

    // Only intercept Supabase REST calls
    if(!urlStr || urlStr.indexOf(SB_URL + '/rest/v1/') === -1){
      return origFetch(input, init);
    }

    // Allow storage/sign to go through (handled by V2 /files endpoint separately)
    // For now only intercept /rest/v1/* 

    var q = parseSupabaseQuery(urlStr);
    if(!q){ return origFetch(input, init); }

    // Ensure we have a JWT
    var jwt = await ensureJWT();
    if(!jwt){
      console.warn('[secure-client] No JWT available, passing through (will likely fail with RLS)');
      return origFetch(input, init);
    }

    var authHeaders = { 'Authorization': 'Bearer ' + jwt, 'Content-Type':'application/json' };

    // ---- Route: reports table ----
    if(q.table === 'reports'){
      var idFilter = q.params.get('id');
      // PATCH /reports?id=eq.X (update)
      if(method === 'PATCH' && idFilter && idFilter.startsWith('eq.')){
        var reportId = idFilter.substring(3);
        var body = init.body;
        return origFetch('/api/admin-v2/reports/' + reportId, { method:'PATCH', headers: authHeaders, body: body });
      }
      // GET /reports?id=eq.X (single)
      if(method === 'GET' && idFilter && idFilter.startsWith('eq.')){
        var rId = idFilter.substring(3);
        var r2 = await origFetch('/api/admin-v2/reports/' + rId, { headers: authHeaders });
        if(!r2.ok) return r2;
        var oneData = await r2.json();
        // Supabase returns array for eq filter
        return new Response(JSON.stringify([oneData]), { status:200, headers:{'Content-Type':'application/json'} });
      }
      // GET /reports (list)
      if(method === 'GET'){
        return origFetch('/api/admin-v2/reports', { headers: authHeaders });
      }
    }

    // ---- Route: report_files ----
    if(q.table === 'report_files' && method === 'GET'){
      var repIdFilter = q.params.get('report_id');
      if(repIdFilter && repIdFilter.startsWith('eq.')){
        var rpId = repIdFilter.substring(3);
        return origFetch('/api/admin-v2/files/' + rpId, { headers: authHeaders });
      }
    }

    // ---- Route: sub_admins ----
    if(q.table === 'sub_admins' && method === 'GET'){
      return origFetch('/api/admin-v2/subadmins', { headers: authHeaders });
    }

    // ---- Route: schools (school info - for now fall through to public endpoint) ----
    if(q.table === 'schools' && method === 'GET'){
      // Use /me endpoint which returns school info
      var rMe = await origFetch('/api/admin-v2/me', { headers: authHeaders });
      if(rMe.ok){
        var me = await rMe.json();
        return new Response(JSON.stringify([{
          id: me.school_id,
          name: me.school_name,
          slug: me.slug
        }]), { status:200, headers:{'Content-Type':'application/json'} });
      }
      return rMe;
    }

    // Default: pass through (will fail with RLS if sensitive)
    console.warn('[secure-client] Unrouted Supabase call:', q.table, method, urlStr);
    return origFetch(input, init);
  }

  window.fetch = proxyFetch;

  // ---------- Auto-init on load ----------
  document.addEventListener('DOMContentLoaded', function(){
    ensureJWT().then(j => {
      if(j){
        console.log('[secure-client] JWT ready, routing through /api/admin-v2/*');
      } else {
        console.warn('[secure-client] No JWT - admin must log in first');
      }
    });
  });

  // Hook: when login page sets admin_code, save it for auto-login
  window.saveAdminCode = function(code){ if(code) localStorage.setItem('ss_admin_code', code); };

  console.log('[secure-client] Loaded. Fetch proxy active for ' + SB_URL + '/rest/v1/*');
})();