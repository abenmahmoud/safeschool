// SafeSchool Dashboard V2 Bridge v3 - Sprint 4
// Intercepte fetch() Supabase REST et les traduit vers /api/admin-v2/*
// v3: transformations auto pour que dashboard.html fonctionne sans modification

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
          // If it's a COUNT request (Prefer: count=exact), hit /stats
          var prefer = opts && opts.headers ? (opts.headers['Prefer'] || opts.headers['prefer'] || '') : '';
          if(prefer.indexOf('count') > -1){
            return { url: V2_BASE + '/reports', method: 'GET', countMode: true };
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
    if(path.indexOf('/storage/v1/object/sign/') === 0) return null;
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
            console.warn('[V2 Bridge] No JWT - redirect to login');
            var slug = new URL(window.location.href).searchParams.get('etab');
            window.location.href = '/admin/login.html' + (slug ? '?etab=' + slug : '');
            return new Response(JSON.stringify({error:'No JWT'}), {status:401});
          }
          var newOpts = {
            method: mapping.method,
            headers: { 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' }
          };
          if(mapping.hasBody && opts && opts.body) newOpts.body = opts.body;
          console.log('[V2]', mapping.method, mapping.url);
          var resp = await _origFetch(mapping.url, newOpts);
          if(mapping.singleToArray && resp.ok){
            var data = await resp.json();
            var arr = Array.isArray(data) ? data : [data];
            return new Response(JSON.stringify(arr), { status: resp.status, headers: {'Content-Type':'application/json'} });
          }
          if(mapping.countMode && resp.ok){
            var dataC = await resp.json();
            var arr2 = Array.isArray(dataC) ? dataC : [];
            var newHeaders = new Headers();
            newHeaders.set('Content-Type','application/json');
            newHeaders.set('Content-Range', '0-' + arr2.length + '/' + arr2.length);
            return new Response(JSON.stringify(arr2), { status: resp.status, headers: newHeaders });
          }
          return resp;
        }
      }
    } catch(e){ console.error('[V2 Bridge] error:', e); }
    return _origFetch(url, opts);
  };

  // Helpers publics
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
  window.adminReportsV2 = async function(){
    var jwt = getJWT();
    if(!jwt) return [];
    try {
      var r = await _origFetch(V2_BASE + '/reports', { headers: { 'Authorization': 'Bearer ' + jwt } });
      if(!r.ok) return [];
      return await r.json();
    } catch(e){ return []; }
  };

  // Force update stats cards + reports list au load et à chaque intervalle
  async function forceRender(){
    try {
      var reports = await window.adminReportsV2();
      if(!Array.isArray(reports)) return;

      // Stats compute (évite appel /stats supplémentaire)
      var stats = {
        total: reports.length,
        nouveau: reports.filter(function(r){return r.status==='nouveau';}).length,
        en_cours: reports.filter(function(r){return r.status==='en_cours';}).length,
        traites: reports.filter(function(r){return r.status==='traite'||r.status==='archive'||r.status==='closed';}).length,
        urgents: reports.filter(function(r){return r.urgency==='haute';}).length
      };

      // Update cards: trouver les compteurs numériques et les remplacer
      var cards = document.querySelectorAll('[class*="card"], [class*="Card"], .bg-white');
      cards.forEach(function(c){
        var text = (c.textContent||'').toLowerCase();
        var num = c.querySelector('h1, h2, h3, .text-2xl, .text-3xl, .text-4xl, [class*="text-3"], [class*="text-4"]');
        if(!num) return;
        if(text.indexOf('total')>-1 && text.indexOf('nouveaux')===-1) num.textContent = stats.total;
        else if(text.indexOf('nouveaux')>-1 || text.indexOf('nouveau')>-1) num.textContent = stats.nouveau;
        else if(text.indexOf('en cours')>-1 || text.indexOf('encours')>-1) num.textContent = stats.en_cours;
        else if(text.indexOf('resolus')>-1 || text.indexOf('résolus')>-1 || text.indexOf('traites')>-1) num.textContent = stats.traites;
        else if(text.indexOf('urgents')>-1 || text.indexOf('urgent')>-1) num.textContent = stats.urgents;
      });

      // Replace 'Chargement...' containers with actual reports list
      document.querySelectorAll('*').forEach(function(el){
        if(el.children.length === 0 && (el.textContent||'').trim() === 'Chargement...'){
          var parent = el.parentElement;
          if(parent && reports.length > 0){
            var html = '';
            reports.slice(0, 10).forEach(function(r){
              var statusColor = r.status==='nouveau'?'#3b82f6':(r.status==='en_cours'?'#f59e0b':(r.status==='traite'?'#10b981':'#6b7280'));
              var urgColor = r.urgency==='haute'?'#ef4444':(r.urgency==='moyenne'?'#f59e0b':'#10b981');
              html += '<div style="padding:14px 16px;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:10px;background:white;transition:all 0.15s;cursor:pointer;" onmouseover="this.style.boxShadow=\'0 4px 12px rgba(0,0,0,0.08)\';this.style.borderColor=\'#c7d2fe\';" onmouseout="this.style.boxShadow=\'none\';this.style.borderColor=\'#e5e7eb\';">';
              html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">';
              html += '<div style="flex:1;min-width:0">';
              html += '<div style="font-weight:600;color:#111827;margin-bottom:4px;display:flex;gap:8px;align-items:center;">';
              html += '<span style="background:' + statusColor + ';color:white;font-size:11px;padding:2px 8px;border-radius:12px;text-transform:uppercase;font-weight:500;letter-spacing:0.3px">' + (r.status||'nouveau') + '</span>';
              html += '<span style="background:' + urgColor + ';color:white;font-size:11px;padding:2px 8px;border-radius:12px;text-transform:uppercase;font-weight:500;letter-spacing:0.3px">' + (r.urgency||'-') + '</span>';
              html += '<span style="color:#6b7280;font-size:12px;font-weight:400">' + (r.type||'-') + '</span>';
              html += '</div>';
              html += '<div style="color:#374151;font-size:14px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + ((r.description||'').substring(0,180)) + '</div>';
              html += '<div style="color:#9ca3af;font-size:12px;margin-top:6px;display:flex;gap:12px">';
              html += '<span>📅 ' + new Date(r.created_at).toLocaleString('fr-FR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) + '</span>';
              html += '<span>🎫 ' + (r.tracking_code||'-') + '</span>';
              if(r.is_anonymous) html += '<span>🎭 Anonyme</span>';
              html += '</div>';
              html += '</div></div></div>';
            });
            parent.innerHTML = html;
          }
        }
      });
    } catch(e){ console.error('[V2 Bridge] forceRender error:', e); }
  }

  // Run forceRender after dashboard loads
  if(document.readyState === 'complete' || document.readyState === 'interactive'){
    setTimeout(forceRender, 800);
  } else {
    window.addEventListener('DOMContentLoaded', function(){ setTimeout(forceRender, 800); });
  }
  // Also refresh every 30s
  setInterval(forceRender, 30000);

  // Expose for manual trigger
  window.v2ForceRender = forceRender;

  console.log('[V2 Bridge v3] installed - auto-render dashboard with V2 data');
})();