// SafeSchool Dashboard V2 Bridge - Sprint 4 Security
// Intercepte tous les fetch() vers Supabase REST (utilisant SK/anon_key)
// et les redirige vers /api/admin-v2/* qui utilise JWT admin secure
// 
// Chargement: placer <script src='/admin/dashboard-v2-bridge.js'></script>
// APRES dashboard.html declare SU/SK, AVANT les autres scripts qui font fetch

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
    // Extract tableName and query from /rest/v1/<table>?<query>
    var u = new URL(url);
    var path = u.pathname;
    var qs = u.searchParams;
    var method = (opts && opts.method) || 'GET';

    // Table extraction
    var restMatch = path.match(/^\/rest\/v1\/(\w+)$/);
    if(restMatch){
      var table = restMatch[1];
      
      // reports
      if(table === 'reports'){
        // PATCH reports?id=eq.UUID
        if(method === 'PATCH'){
          var idEq = qs.get('id');
          if(idEq && idEq.indexOf('eq.') === 0){
            var reportId = idEq.substring(3);
            return { url: V2_BASE + '/reports/' + reportId, method: 'PATCH', hasBody: true };
          }
        }
        // GET reports?id=eq.UUID
        if(method === 'GET'){
          var idEq2 = qs.get('id');
          if(idEq2 && idEq2.indexOf('eq.') === 0){
            var rid = idEq2.substring(3);
            return { url: V2_BASE + '/reports/' + rid, method: 'GET', singleToArray: true };
          }
          // GET reports?school_id=eq.X&order=...
          return { url: V2_BASE + '/reports', method: 'GET' };
        }
      }
      
      // report_files?report_id=eq.UUID
      if(table === 'report_files' && method === 'GET'){
        var ridEq = qs.get('report_id');
        if(ridEq && ridEq.indexOf('eq.') === 0){
          return { url: V2_BASE + '/files/' + ridEq.substring(3), method: 'GET' };
        }
      }
      
      // sub_admins?school_id=eq.X
      if(table === 'sub_admins' && method === 'GET'){
        return { url: V2_BASE + '/subadmins', method: 'GET' };
      }
    }

    // Storage signed URLs - keep direct (V2 /files already handles signing)
    if(path.indexOf('/storage/v1/object/sign/') === 0){
      return null; // Let original passthrough (will fail with anon, but V2 /files handles this)
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
            // Redirect to login page
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
          console.log('[V2 Bridge]', opts?opts.method||'GET':'GET', urlStr.substring(0,80), '=>', mapping.url);
          var resp = await _origFetch(mapping.url, newOpts);
          // If singleToArray (dashboard expects array from /rest/v1), wrap it
          if(mapping.singleToArray && resp.ok){
            var data = await resp.json();
            var arr = Array.isArray(data) ? data : [data];
            return new Response(JSON.stringify(arr), {
              status: resp.status,
              headers: resp.headers
            });
          }
          return resp;
        }
      }
    } catch(e){
      console.error('[V2 Bridge] error:', e);
    }
    return _origFetch(url, opts);
  };

  console.log('[V2 Bridge] installed - fetches to Supabase REST redirected to /api/admin-v2');
})();