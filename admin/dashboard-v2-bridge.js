// SafeSchool Dashboard V2 Bridge v4 - Sprint 4
// Intercepte fetch() Supabase REST -> /api/admin-v2/* avec JWT
// v4: sélecteurs précis #c0-#c4 + sidebar fix + IDs pour le main content

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
          if(idEq && idEq.indexOf('eq.') === 0) return { url: V2_BASE + '/reports/' + idEq.substring(3), method: 'PATCH', hasBody: true };
        }
        if(method === 'GET'){
          var idEq2 = qs.get('id');
          if(idEq2 && idEq2.indexOf('eq.') === 0) return { url: V2_BASE + '/reports/' + idEq2.substring(3), method: 'GET', singleToArray: true };
          return { url: V2_BASE + '/reports', method: 'GET' };
        }
      }
      if(table === 'report_files' && method === 'GET'){
        var ridEq = qs.get('report_id');
        if(ridEq && ridEq.indexOf('eq.') === 0) return { url: V2_BASE + '/files/' + ridEq.substring(3), method: 'GET' };
      }
      if(table === 'sub_admins' && method === 'GET') return { url: V2_BASE + '/subadmins', method: 'GET' };
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
            var slug = new URL(window.location.href).searchParams.get('etab');
            window.location.href = '/admin/login.html' + (slug ? '?etab=' + slug : '');
            return new Response(JSON.stringify({error:'No JWT'}), {status:401});
          }
          var newOpts = {
            method: mapping.method,
            headers: { 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' }
          };
          if(mapping.hasBody && opts && opts.body) newOpts.body = opts.body;
          var resp = await _origFetch(mapping.url, newOpts);
          if(mapping.singleToArray && resp.ok){
            var data = await resp.json();
            var arr = Array.isArray(data) ? data : [data];
            return new Response(JSON.stringify(arr), { status: resp.status, headers: {'Content-Type':'application/json'} });
          }
          return resp;
        }
      }
    } catch(e){ console.error('[V2 Bridge] error:', e); }
    return _origFetch(url, opts);
  };

  window.adminStatsV2 = async function(){
    var jwt = getJWT(); if(!jwt) return null;
    try { var r = await _origFetch(V2_BASE + '/stats', { headers: { 'Authorization': 'Bearer ' + jwt } });
      if(!r.ok) return null; var d = await r.json(); return d.stats || d;
    } catch(e){ return null; }
  };
  window.adminReportsV2 = async function(){
    var jwt = getJWT(); if(!jwt) return [];
    try { var r = await _origFetch(V2_BASE + '/reports', { headers: { 'Authorization': 'Bearer ' + jwt } });
      if(!r.ok) return []; return await r.json();
    } catch(e){ return []; }
  };

  function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  function renderReportCard(r){
    var statusColor = r.status==='nouveau'?'#3b82f6':(r.status==='en_cours'?'#f59e0b':(r.status==='traite'?'#10b981':'#6b7280'));
    var urgColor = r.urgency==='haute'?'#ef4444':(r.urgency==='moyenne'?'#f59e0b':'#10b981');
    var html = '<div data-report-id="' + escapeHtml(r.id) + '" style="padding:14px 16px;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:10px;background:white;cursor:pointer;transition:all 0.15s;" onmouseover="this.style.boxShadow=\'0 4px 12px rgba(0,0,0,0.08)\';this.style.borderColor=\'#c7d2fe\';" onmouseout="this.style.boxShadow=\'none\';this.style.borderColor=\'#e5e7eb\';">';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">';
    html += '<div style="flex:1;min-width:0">';
    html += '<div style="font-weight:600;color:#111827;margin-bottom:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
    html += '<span style="background:' + statusColor + ';color:white;font-size:11px;padding:2px 8px;border-radius:12px;text-transform:uppercase;font-weight:500;letter-spacing:0.3px">' + escapeHtml(r.status||'nouveau') + '</span>';
    html += '<span style="background:' + urgColor + ';color:white;font-size:11px;padding:2px 8px;border-radius:12px;text-transform:uppercase;font-weight:500;letter-spacing:0.3px">' + escapeHtml(r.urgency||'-') + '</span>';
    html += '<span style="color:#6b7280;font-size:12px;font-weight:400">' + escapeHtml(r.type||'-') + '</span>';
    html += '</div>';
    html += '<div style="color:#374151;font-size:14px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + escapeHtml((r.description||'').substring(0,180)) + '</div>';
    html += '<div style="color:#9ca3af;font-size:12px;margin-top:6px;display:flex;gap:12px;flex-wrap:wrap">';
    html += '<span>📅 ' + new Date(r.created_at).toLocaleString('fr-FR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) + '</span>';
    html += '<span>🎫 ' + escapeHtml(r.tracking_code||'-') + '</span>';
    if(r.is_anonymous) html += '<span>🎭 Anonyme</span>';
    html += '</div>';
    html += '</div></div></div>';
    return html;
  }

  async function forceRender(){
    try {
      var reports = await window.adminReportsV2();
      if(!Array.isArray(reports)) return;

      var stats = {
        total: reports.length,
        nouveau: reports.filter(function(r){return r.status==='nouveau';}).length,
        en_cours: reports.filter(function(r){return r.status==='en_cours';}).length,
        traites: reports.filter(function(r){return r.status==='traite'||r.status==='archive'||r.status==='closed';}).length,
        urgents: reports.filter(function(r){return r.urgency==='haute';}).length
      };

      // Update counters via IDs précis #c0 #c1 #c2 #c3 #c4
      var c0 = document.getElementById('c0'); if(c0) c0.textContent = stats.total;
      var c1 = document.getElementById('c1'); if(c1) c1.textContent = stats.nouveau;
      var c2 = document.getElementById('c2'); if(c2) c2.textContent = stats.en_cours;
      var c3 = document.getElementById('c3'); if(c3) c3.textContent = stats.traites;
      var c4 = document.getElementById('c4'); if(c4) c4.textContent = stats.urgents;

      // Replace 'Chargement...' ONLY in main content area (not sidebar)
      var main = document.querySelector('main, [class*="main"], [class*="content"], body > div > div:last-child') || document.body;
      var loadingInMain = [];
      main.querySelectorAll('*').forEach(function(el){
        if(el.children.length === 0 && (el.textContent||'').trim() === 'Chargement...'){
          // Exclude sidebar elements (typically aside, nav, or narrow width)
          var parent = el.parentElement;
          var rect = parent ? parent.getBoundingClientRect() : {width:0, left:0};
          // Only replace if parent is wide enough (main content area)
          if(rect.width > 400 && rect.left > 150) loadingInMain.push(el);
        }
      });

      loadingInMain.forEach(function(el){
        var parent = el.parentElement;
        if(parent && reports.length > 0){
          parent.innerHTML = reports.slice(0, 10).map(renderReportCard).join('');
        } else if(parent) {
          parent.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:40px">Aucun signalement pour le moment</div>';
        }
      });

      console.log('[V2 Bridge] rendered', stats.total, 'reports, stats:', stats);
    } catch(e){ console.error('[V2 Bridge] forceRender error:', e); }
  }

  if(document.readyState === 'complete' || document.readyState === 'interactive'){
    setTimeout(forceRender, 800);
  } else {
    window.addEventListener('DOMContentLoaded', function(){ setTimeout(forceRender, 800); });
  }
  setInterval(forceRender, 30000);

  window.v2ForceRender = forceRender;
  console.log('[V2 Bridge v4] installed');
})();