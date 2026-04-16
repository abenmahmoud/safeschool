// SafeSchool Dashboard V2 Bridge - Sprint 4 Security
// Intercepte les fetch() vers Supabase REST et redirige vers /api/admin-v2/* (JWT secure)
// V2: aplatit /stats et adapte le format de retour pour compat dashboard

(function(){
  var _origFetch = window.fetch.bind(window);
  var SUPABASE_BASE = 'https://bsytkpgdxvlddzuwaabp.supabase.co';
  var V2_BASE = '/api/admin-v2';

  function getJWT(){
    try { return localStorage.getItem('ss_jwt') || ''; } catch(e) { return ''; }
  }

  function needsAuth(url){
    var u = typeof url === 'string' ? url : (url && url.url) || '';
    return u.indexOf(SUPABASE_BASE + '/rest/v1/') === 0 || u.indexOf(SUPABASE_BASE + '/storage/v1/') === 0;
  }

  function translateToV2(url, opts){
    var u = new URL(url);
    var path = u.pathname;
    var qs = u.searchParams;
    var method = (opts && opts.method) || 'GET';
    var restMatch = path.match(/^\/rest\/v1\/(\w+)$/);
    if(restMatch){
      var table = restMatch[1];
      if(table === 'reports'){
        if(method === 'PATCH'){
          var idEq = qs.get('id');
          if(idEq && idEq.indexOf('eq.') === 0){
            return { url: V2_BASE + '/reports/' + idEq.substring(3), method: 'PATCH', hasBody: true };
          }
        }
        if(method === 'GET'){
          var idEq2 = qs.get('id');
          if(idEq2 && idEq2.indexOf('eq.') === 0){
            return { url: V2_BASE + '/reports/' + idEq2.substring(3), method: 'GET', singleToArray: true };
          }
          return { url: V2_BASE + '/reports', method: 'GET' };
        }
      }
      if(table === 'report_files' && method === 'GET'){
        var ridEq = qs.get('report_id');
        if(ridEq && ridEq.indexOf('eq.') === 0){
          return { url: V2_BASE + '/files/' + ridEq.substring(3), method: 'GET' };
        }
      }
      if(table === 'sub_admins' && method === 'GET'){
        return { url: V2_BASE + '/subadmins', method: 'GET' };
      }
    }
    if(path.indexOf('/storage/v1/object/sign/') === 0){
      return null;
    }
    return null;
  }

  window.fetch = async function(url, opts){
    try {
      var urlStr = typeof url === 'string' ? url : (url && url.url) || '';
      if(needsAuth(urlStr)){
        var mapping = translateToV2(urlStr, opts);
        if(mapping){
          var jwt = getJWT();
          if(!jwt){
            console.warn('[V2 Bridge] No JWT, redirecting to login');
            var slug = new URL(window.location.href).searchParams.get('etab');
            window.location.href = '/admin/login.html' + (slug ? '?etab=' + slug : '');
            return new Response(JSON.stringify({error:'No JWT'}), {status:401});
          }
          var newOpts = {
            method: mapping.method,
            headers: { 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' }
          };
          if(mapping.hasBody && opts && opts.body){
            newOpts.body = opts.body;
          }
          console.log('[V2 Bridge]', mapping.method, urlStr.substring(0,60), '->', mapping.url);
          var resp = await _origFetch(mapping.url, newOpts);
          if(mapping.singleToArray && resp.ok){
            var data = await resp.json();
            var arr = Array.isArray(data) ? data : [data];
            return new Response(JSON.stringify(arr), {
              status: resp.status,
              headers: {'Content-Type':'application/json'}
            });
          }
          return resp;
        }
      }
    } catch(e){ console.error('[V2 Bridge] error:', e); }
    return _origFetch(url, opts);
  };

  // Enrich: add a helper window.adminStatsV2() that dashboard can use directly
  window.adminStatsV2 = async function(){
    var jwt = getJWT();
    if(!jwt) return null;
    try {
      var r = await _origFetch(V2_BASE + '/stats', { headers: { 'Authorization': 'Bearer ' + jwt } });
      if(!r.ok) return null;
      var d = await r.json();
      return d.stats || d;
    } catch(e){ return null; }
  };

  // Helper: load reports via V2
  window.adminReportsV2 = async function(){
    var jwt = getJWT();
    if(!jwt) return [];
    try {
      var r = await _origFetch(V2_BASE + '/reports', { headers: { 'Authorization': 'Bearer ' + jwt } });
      if(!r.ok) return [];
      return await r.json();
    } catch(e){ return []; }
  };

  console.log('[V2 Bridge] v2 installed - intercepts Supabase REST + helpers exposed');
})();