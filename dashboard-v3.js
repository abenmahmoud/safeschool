// SafeSchool v3 - Dashboard Admin + DB Layer
// ASCII only - no special characters in code
var SUPABASE_URL = '';
var SUPABASE_KEY = '';

function detectTenant() {
  var h = location.hostname;
  var m = h.match(/^([a-z0-9-]+)\.safeschool\.fr$/);
  return m ? m[1] : null;
}
window.SS_TENANT = detectTenant();

window.DB = {
  _sb: function() { return !!(SUPABASE_URL && SUPABASE_KEY); },

  getReports: async function(sid) {
    if (this._sb()) {
      try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/reports?school_id=eq.' + sid + '&order=created_at.desc', {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
        });
        return r.ok ? await r.json() : [];
      } catch(e) { return []; }
    }
    return JSON.parse(localStorage.getItem('ss_rpt_' + sid) || '[]');
  },

  saveReport: async function(rpt) {
    var sid = rpt.school_id || localStorage.getItem('ss_current_etab') || 'demo';
    if (this._sb()) {
      try {
        await fetch(SUPABASE_URL + '/rest/v1/reports', {
          method: 'POST',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify(Object.assign({}, rpt, { school_id: sid }))
        });
        return;
      } catch(e) {}
    }
    var key = 'ss_rpt_' + sid;
    var list = JSON.parse(localStorage.getItem(key) || '[]');
    var nr = Object.assign({ id: 'r' + Date.now(), created_at: new Date().toISOString(), status: 'nouveau', school_id: sid }, rpt);
    list.unshift(nr);
    localStorage.setItem(key, JSON.stringify(list));
    return nr;
  },

  updateStatus: async function(id, status, sid) {
    if (this._sb()) {
      try {
        await fetch(SUPABASE_URL + '/rest/v1/reports?id=eq.' + id, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: status })
        });
        return;
      } catch(e) {}
    }
    var key = 'ss_rpt_' + sid;
    var list = JSON.parse(localStorage.getItem(key) || '[]');
    var idx = list.findIndex(function(r) { return r.id === id; });
    if (idx > -1) { list[idx].status = status; list[idx].updated_at = new Date().toISOString(); }
    localStorage.setItem(key, JSON.stringify(list));
  },

  getStats: async function(sid) {
    var all = await this.getReports(sid);
    var now = new Date();
    var thisM = all.filter(function(r) {
      var d = new Date(r.created_at);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    var byType = {}, byStatus = { nouveau: 0, 'en-cours': 0, traite: 0, archive: 0 };
    all.forEach(function(r) {
      var t = r.type || 'autre'; byType[t] = (byType[t] || 0) + 1;
      var s = r.status || 'nouveau';
      if (byStatus[s] !== undefined) byStatus[s]++; else byStatus[s] = 1;
    });
    var trend = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(now); d.setDate(d.getDate() - (6 - i));
      var ds = d.toISOString().slice(0, 10);
      var dn = d.toLocaleDateString('fr-FR', { weekday: 'short' }).slice(0, 3);
      var cnt = all.filter(function(r) { return r.created_at && r.created_at.startsWith(ds); }).length;
      trend.push({ date: ds, day: dn, count: cnt });
    }
    return { total: all.length, thisMonth: thisM.length, byType: byType, byStatus: byStatus, trend: trend, recent: all.slice(0, 20) };
  }
};

(function seedDemo() {
  var sid = localStorage.getItem('ss_current_etab') || 'demo';
  var key = 'ss_rpt_' + sid;
  if (localStorage.getItem(key)) return;
  var types = ['verbal', 'physique', 'cyber', 'exclusion', 'autre'];
  var classes = ['6e A', '6e B', '5e A', '4e A', '4e B', '3e A', '3e B'];
  var descs = [
    'Moqueries repetees en classe',
    'Messages blessants sur les reseaux',
    'Mise a l ecart systematique',
    'Bousculades dans les couloirs',
    'Screenshots partages sans accord',
    'Insultes pendant la recreation',
    'Commentaires degradants en ligne',
    'Exclusion des conversations'
  ];
  var statuses = ['nouveau', 'nouveau', 'en-cours', 'traite', 'traite', 'archive'];
  var urgences = ['haute', 'moyenne', 'faible', 'faible', 'moyenne'];
  var now = new Date(), list = [];
  for (var i = 0; i < 16; i++) {
    var d = new Date(now);
    d.setDate(d.getDate() - Math.floor(Math.random() * 30));
    list.push({ id: 'demo_' + i, type: types[i % 5], classe: classes[i % 7], urgence: urgences[i % 5], status: statuses[i % 6], anonymous: true, description: descs[i % 8], school_id: sid, created_at: d.toISOString() });
  }
  localStorage.setItem(key, JSON.stringify(list));
})();

var TLBL = { verbal: 'Verbal', physique: 'Physique', cyber: 'Cyber', exclusion: 'Exclusion', autre: 'Autre' };
var TCOL = { verbal: '#dc2626', physique: '#ea580c', cyber: '#7c3aed', exclusion: '#0891b2', autre: '#64748b' };
var SLBL = { nouveau: 'Nouveau', 'en-cours': 'En cours', traite: 'Traite', archive: 'Archive' };

window.renderRptList = function(list) {
  if (!list || !list.length) return '<p style="text-align:center;color:#94a3b8;padding:24px">Aucun signalement</p>';
  return list.map(function(r) {
    var uc = r.urgence === 'haute' ? 'urg-haute' : r.urgence === 'moyenne' ? 'urg-moyenne' : 'urg-faible';
    var ut = r.urgence === 'haute' ? 'Urgent' : r.urgence === 'moyenne' ? 'Moyen' : 'Faible';
    var dt = r.created_at ? new Date(r.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
    return '<div class="rpt-item" onclick="openRpt(\'' + r.id + '\')">' +
      '<div class="rpt-row1"><span class="tag tag-' + (r.type || 'autre') + '">' + (TLBL[r.type || 'autre'] || r.type) + '</span>' +
      '<span class="tag tag-' + (r.status || 'nouveau') + '">' + (SLBL[r.status || 'nouveau'] || r.status) + '</span></div>' +
      '<div class="rpt-desc">' + (r.description || 'Aucun detail') + '</div>' +
      '<div class="rpt-row3"><span style="font-size:.72rem;background:#f1f5f9;color:#64748b;padding:2px 7px;border-radius:10px;font-weight:600">' + (r.classe || 'NC') + '</span>' +
      '<span class="' + uc + '">' + ut + '</span><span class="rpt-date">' + dt + '</span></div></div>';
  }).join('');
};

window.fltRpt = async function(status, btn) {
  document.querySelectorAll('.flt-btn').forEach(function(b) { b.classList.remove('on'); });
  btn.classList.add('on');
  var sid = localStorage.getItem('ss_current_etab') || 'demo';
  var all = window._allRptsAll || await DB.getReports(sid);
  var f = status === 'all' ? all : all.filter(function(r) { return (r.status || 'nouveau') === status; });
  var el = document.getElementById('rpt-list');
  if (el) el.innerHTML = window.renderRptList(f.slice(0, 20));
};

window.openRpt = function(id) {
  var all = window._allRptsAll || [];
  var r = null;
  for (var i = 0; i < all.length; i++) { if (all[i].id === id) { r = all[i]; break; } }
  if (!r) return;
  var sid = localStorage.getItem('ss_current_etab') || 'demo';
  var uc = 'urg-' + (r.urgence || 'faible');
  var ut = r.urgence === 'haute' ? 'Urgence haute - Intervention immediate' : r.urgence === 'moyenne' ? 'Urgence moyenne - Traiter rapidement' : 'Urgence faible - Surveiller';
  var dt = r.created_at ? new Date(r.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  var ex = document.getElementById('rpt-modal');
  if (ex) ex.remove();
  var m = document.createElement('div');
  m.className = 'rpt-modal-bg'; m.id = 'rpt-modal';
  m.innerHTML = '<div class="rpt-modal">' +
    '<div class="rpt-modal-h"><div>' +
    '<div style="font-size:1.05rem;font-weight:800;color:#1e293b">' + (TLBL[r.type] || r.type || 'Signalement') + '</div>' +
    '<div style="font-size:.78rem;color:#94a3b8;margin-top:2px">' + dt + ' - ' + (r.classe || 'NC') + (r.anonymous ? ' - Anonyme' : '') + '</div></div>' +
    '<button class="rpt-modal-close" onclick="document.getElementById(\'rpt-modal\').remove()">x</button></div>' +
    '<div style="font-size:.75rem;font-weight:700;color:#94a3b8;margin-bottom:5px">DESCRIPTION</div>' +
    '<div class="rpt-modal-desc">' + (r.description || 'Aucun detail') + '</div>' +
    '<div style="font-size:.75rem;font-weight:700;color:#94a3b8;margin-bottom:8px">URGENCE</div>' +
    '<div style="margin-bottom:18px"><span class="' + uc + '" style="font-size:.9rem">' + ut + '</span></div>' +
    '<div style="font-size:.75rem;font-weight:700;color:#94a3b8;margin-bottom:10px">CHANGER STATUT</div>' +
    '<div class="st-btns">' +
    '<button class="st-btn" style="background:#dbeafe;color:#1d4ed8" onclick="chgSt(\'' + r.id + '\',\'nouveau\',\'' + sid + '\')">Nouveau</button>' +
    '<button class="st-btn" style="background:#fef9c3;color:#a16207" onclick="chgSt(\'' + r.id + '\',\'en-cours\',\'' + sid + '\')">En cours</button>' +
    '<button class="st-btn" style="background:#dcfce7;color:#166534" onclick="chgSt(\'' + r.id + '\',\'traite\',\'' + sid + '\')">Traite</button>' +
    '<button class="st-btn" style="background:#f1f5f9;color:#475569" onclick="chgSt(\'' + r.id + '\',\'archive\',\'' + sid + '\')">Archiver</button></div>' +
    '<button onclick="document.getElementById(\'rpt-modal\').remove()" style="margin-top:20px;width:100%;padding:14px;background:#4f46e5;color:#fff;border:none;border-radius:12px;font-weight:700;cursor:pointer">Fermer</button></div>';
  m.addEventListener('click', function(e) { if (e.target === m) m.remove(); });
  document.body.appendChild(m);
};

window.chgSt = async function(id, status, sid) {
  await DB.updateStatus(id, status, sid);
  if (window._allRptsAll) { var r = window._allRptsAll.find(function(x) { return x.id === id; }); if (r) r.status = status; }
  document.getElementById('rpt-modal')?.remove();
  if (typeof toast === 'function') toast('Statut mis a jour');
  var el = document.querySelector('[data-dash-content]');
  if (el) window.renderDashboardV3(el);
};

window.renderDashboardV3 = async function(el) {
  if (!el) {
    el = document.querySelector('[data-dash-content]') || document.querySelector('.admin-content-area') || document.querySelector('#dash-content');
    if (!el) return;
  }
  var sid = localStorage.getItem('ss_current_etab') || 'demo';
  var etabs = JSON.parse(localStorage.getItem('ss_etabs') || '[]');
  var etab = etabs.find(function(e) { return e.id === sid; }) || { name: 'Demo' };
  var S = await DB.getStats(sid);
  window._allRptsAll = await DB.getReports(sid);
  var maxBar = 1;
  S.trend.forEach(function(d) { if (d.count > maxBar) maxBar = d.count; });
  var bars = '';
  S.trend.forEach(function(d, i) {
    var h = Math.max(3, Math.round(d.count / maxBar * 44)), today = i === 6;
    bars += '<div class="mini-bar-col"><div class="mini-cnt' + (today ? ' today' : '') + '">' + (d.count || '') + '</div><div class="mini-bar' + (today ? ' today' : '') + '" style="height:' + h + 'px"></div><div class="mini-day" style="color:' + (today ? '#4f46e5' : '#94a3b8') + '">' + d.day + '</div></div>';
  });
  var types = Object.entries(S.byType).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);
  var tot = S.total || 1, rv = 32, circ = 2 * Math.PI * rv, offset = 0, segs = '', leg = '';
  types.forEach(function(e) {
    var t = e[0], n = e[1], da = n / tot * circ;
    segs += '<circle cx="42" cy="42" r="' + rv + '" fill="none" stroke="' + (TCOL[t] || '#94a3b8') + '" stroke-width="9" stroke-dasharray="' + da.toFixed(2) + ' ' + (circ - da).toFixed(2) + '" stroke-dashoffset="' + (-offset).toFixed(2) + '"/>';
    offset += da;
  });
  types.slice(0, 4).forEach(function(e) {
    var t = e[0], n = e[1];
    leg += '<div class="leg-row"><div class="leg-dot" style="background:' + (TCOL[t] || '#94a3b8') + '"></div><div class="leg-lbl">' + (TLBL[t] || t) + '</div><div class="leg-val">' + n + '</div></div>';
  });
  var nc = S.byStatus.nouveau || 0, tc = S.byStatus.traite || 0, rr = S.total > 0 ? Math.round(tc / S.total * 100) : 0;
  var donut = S.total > 0 ? '<div class="dsec"><div class="dsec-t">Repartition par type</div><div style="background:#fff;border-radius:14px;padding:14px;border:1.5px solid #e8eaed"><div class="donut-row"><div class="donut-wrap"><svg viewBox="0 0 84 84" style="transform:rotate(-90deg)">' + segs + '</svg><div class="donut-mid"><div class="donut-n">' + S.total + '</div><div class="donut-l">cas</div></div></div><div class="leg">' + leg + '</div></div></div></div>' : '';
  var empty = S.total === 0 ? '<div style="text-align:center;padding:40px 20px"><div style="font-size:2rem">OK</div><div style="font-weight:700;color:#64748b;margin-top:8px">Aucun signalement</div></div>' : '';
  el.setAttribute('data-dash-content', '1');
  el.innerHTML = '<div style="background:#f8fafc;min-height:100%;padding-bottom:32px">' +
    '<div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:20px 16px 32px;position:relative;overflow:hidden">' +
    '<div style="position:absolute;right:-30px;top:-30px;width:120px;height:120px;background:rgba(255,255,255,.08);border-radius:50%"></div>' +
    '<div style="font-size:.75rem;color:#c7d2fe;font-weight:600;margin-bottom:3px">' + etab.name + '</div>' +
    '<div style="font-size:1.25rem;font-weight:800;color:#fff">Tableau de bord</div>' +
    '<div style="font-size:.8rem;color:#a5b4fc;margin-top:2px">' + new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + '</div></div>' +
    '<div style="margin-top:-18px;padding:0 14px"><div class="dash-kpi-grid">' +
    '<div class="kpi-card" style="--kpi-color:#4f46e5"><div class="kpi-icon">All</div><div class="kpi-label">Total</div><div class="kpi-num">' + S.total + '</div><div class="kpi-trend neu">signalements</div></div>' +
    '<div class="kpi-card" style="--kpi-color:#dc2626"><div class="kpi-icon">New</div><div class="kpi-label">Nouveaux</div><div class="kpi-num">' + nc + '</div><div class="kpi-trend ' + (nc > 0 ? 'dn' : 'up') + '">' + (nc > 0 ? 'A traiter' : 'A jour') + '</div></div>' +
    '<div class="kpi-card" style="--kpi-color:#f59e0b"><div class="kpi-icon">Cal</div><div class="kpi-label">Ce mois</div><div class="kpi-num">' + S.thisMonth + '</div><div class="kpi-trend neu">30 jours</div></div>' +
    '<div class="kpi-card" style="--kpi-color:#16a34a"><div class="kpi-icon">OK</div><div class="kpi-label">Traites</div><div class="kpi-num">' + tc + '</div><div class="kpi-trend up">' + rr + '% resol.</div></div>' +
    '</div></div>' +
    '<div class="dsec"><div class="dsec-t">Tendance 7 jours</div>' +
    '<div style="background:#fff;border-radius:14px;padding:14px;border:1.5px solid #e8eaed"><div class="mini-chart">' + bars + '</div></div></div>' +
    donut +
    '<div class="flt-bar">' +
    '<button class="flt-btn on" onclick="fltRpt(\'all\',this)">Tous (' + S.total + ')</button>' +
    '<button class="flt-btn" onclick="fltRpt(\'nouveau\',this)">Nouveaux (' + nc + ')</button>' +
    '<button class="flt-btn" onclick="fltRpt(\'en-cours\',this)">En cours (' + (S.byStatus['en-cours'] || 0) + ')</button>' +
    '<button class="flt-btn" onclick="fltRpt(\'traite\',this)">Traites (' + tc + ')</button></div>' +
    '<div class="dsec"><div class="dsec-t">Signalements recents</div>' +
    '<div class="rpt-list" id="rpt-list">' + window.renderRptList(S.recent) + '</div>' + empty + '</div></div>';
};

console.log('[SafeSchool v3] dashboard-v3.js loaded OK');
