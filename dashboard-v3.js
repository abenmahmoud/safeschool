// SafeSchool V4 - dashboard-v3.js - Dashboard CPE Kanban Complet
var SUPABASE_URL = window.ENV_SUPABASE_URL || "";
var SUPABASE_KEY = window.ENV_SUPABASE_KEY || "";
var STATUTS = {
  nouveau:  { label: "Nouveau",  color: "#3b82f6", bg: "#dbeafe", icon: "N" },
  en_cours: { label: "En cours", color: "#a16207", bg: "#fef9c3", icon: "E" },
  traite:   { label: "Traite",   color: "#166534", bg: "#dcfce7", icon: "T" },
  archive:  { label: "Archive",  color: "#475569", bg: "#f1f5f9", icon: "A" }
};
var TYPES = {
  verbal:    { label: "Verbal",         color: "#dc2626" },
  physique:  { label: "Physique",       color: "#ea580c" },
  cyber:     { label: "Cyber",          color: "#7c3aed" },
  exclusion: { label: "Mise a l'ecart", color: "#0891b2" },
  autre:     { label: "Autre",          color: "#64748b" }
};
var URGENCES = {
  haute:   { label: "Urgent", color: "#dc2626" },
  moyenne: { label: "Moyen",  color: "#f59e0b" },
  faible:  { label: "Faible", color: "#16a34a" }
};
var PHARE_STEPS = [
  "Recueil du signalement aupres de l'eleve victime",
  "Entretien avec les temoins",
  "Entretien avec l'eleve auteur(s)",
  "Information aux familles (victime)",
  "Information aux familles (auteur)",
  "Mise en place des mesures immediates",
  "Suivi a 15 jours post-intervention",
  "Cloture et bilan de l'action"
];
window.DB = {
  _ok: function() { return !!(SUPABASE_URL && SUPABASE_KEY); },
  _h: function() {
    var token = SUPABASE_KEY;
    try {
      var sessionStr = localStorage.getItem('sb-' + new URL(SUPABASE_URL).hostname.split('.')[0] + '-auth-token');
      if (sessionStr) { var s = JSON.parse(sessionStr); if (s && s.access_token) token = s.access_token; }
    } catch(e) {}
    return { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + token, "Content-Type": "application/json", "Prefer": "return=representation" };
  },
  generateCode: function() {
    var c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = "SS-";
    for (var i = 0; i < 6; i++) r += c[Math.floor(Math.random() * c.length)];
    return r;
  },
  getReports: async function(sid) {
    var allReports = [];
    if (this._ok()) {
      try {
        var r = await fetch(SUPABASE_URL + "/rest/v1/reports?school_id=eq." + sid + "&order=created_at.desc", { headers: this._h() });
        if (r.ok) allReports = await r.json();
      } catch(e) {}
    }
    var lsReports = JSON.parse(localStorage.getItem("ss_rpt_" + sid) || "[]");
    if (lsReports.length > 0) {
      var eIds = {}, eCodes = {};
      allReports.forEach(function(r) { if (r.id) eIds[r.id] = true; if (r.tracking_code) eCodes[r.tracking_code] = true; });
      lsReports.forEach(function(r) { if (r.id && !eIds[r.id] && (!r.tracking_code || !eCodes[r.tracking_code])) allReports.push(r); });
      allReports.sort(function(a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
    }
    return allReports;
  },
  saveReport: async function(rpt) {
    var sid = rpt.school_id || localStorage.getItem("ss_current_etab") || "demo";
    if (this._ok()) {
      try {
        var r = await fetch(SUPABASE_URL + "/rest/v1/reports", { method: "POST", headers: this._h(), body: JSON.stringify(Object.assign({}, rpt, { school_id: sid })) });
        if (r.ok) return (await r.json())[0];
      } catch(e) {}
    }
    var key = "ss_rpt_" + sid, list = JSON.parse(localStorage.getItem(key) || "[]");
    var nr = Object.assign({ id: "r" + Date.now(), tracking_code: this.generateCode(), created_at: new Date().toISOString(), status: "nouveau", school_id: sid }, rpt);
    list.unshift(nr); localStorage.setItem(key, JSON.stringify(list)); return nr;
  },
  updateStatus: async function(id, status, sid) {
    var s = status.replace("-", "_");
    if (this._ok()) {
      try {
        var r = await fetch(SUPABASE_URL + "/rest/v1/reports?id=eq." + id, { method: "PATCH", headers: this._h(), body: JSON.stringify({ status: s, updated_at: new Date().toISOString() }) });
        if (r.ok) return;
      } catch(e) {}
    }
    var key = "ss_rpt_" + sid, list = JSON.parse(localStorage.getItem(key) || "[]");
    var idx = list.findIndex(function(r) { return r.id === id; });
    if (idx > -1) { list[idx].status = s; list[idx].updated_at = new Date().toISOString(); }
    localStorage.setItem(key, JSON.stringify(list));
  },
  saveAdminNote: async function(id, note, sid) {
    if (this._ok()) {
      try {
        await fetch(SUPABASE_URL + "/rest/v1/reports?id=eq." + id, { method: "PATCH", headers: this._h(), body: JSON.stringify({ admin_note: note }) });
      } catch(e) {}
    }
    var key = "ss_rpt_" + sid, list = JSON.parse(localStorage.getItem(key) || "[]");
    var idx = list.findIndex(function(r) { return r.id === id; });
    if (idx > -1) { list[idx].admin_note = note; list[idx].updated_at = new Date().toISOString(); }
    localStorage.setItem(key, JSON.stringify(list));
  },
  saveStaffReply: async function(id, reply, sid) {
    if (this._ok()) {
      try {
        await fetch(SUPABASE_URL + "/rest/v1/reports?id=eq." + id, { method: "PATCH", headers: this._h(), body: JSON.stringify({ staff_reply: reply }) });
      } catch(e) {}
    }
    var key = "ss_rpt_" + sid, list = JSON.parse(localStorage.getItem(key) || "[]");
    var idx = list.findIndex(function(r) { return r.id === id; });
    if (idx > -1) { list[idx].staff_reply = reply; list[idx].updated_at = new Date().toISOString(); }
    localStorage.setItem(key, JSON.stringify(list));
  },
  savePhareSteps: async function(id, steps, sid) {
    var stepsJson = JSON.stringify(steps);
    if (this._ok()) {
      try { await fetch(SUPABASE_URL + "/rest/v1/reports?id=eq." + id, { method: "PATCH", headers: this._h(), body: JSON.stringify({ phare_steps: stepsJson }) }); } catch(e) {}
    }
    var key = "ss_rpt_" + sid, list = JSON.parse(localStorage.getItem(key) || "[]");
    var idx = list.findIndex(function(r) { return r.id === id; });
    if (idx > -1) { list[idx].phare_steps = stepsJson; list[idx].updated_at = new Date().toISOString(); }
    localStorage.setItem(key, JSON.stringify(list));
  },
  addJournalEntry: async function(id, entry, sid) {
    var key = "ss_rpt_" + sid, list = JSON.parse(localStorage.getItem(key) || "[]");
    var idx = list.findIndex(function(r) { return r.id === id; });
    var journal = [];
    if (idx > -1) {
      try { journal = JSON.parse(list[idx].journal || "[]"); } catch(e) {}
      journal.unshift({ date: new Date().toISOString(), text: entry, author: "CPE" });
      list[idx].journal = JSON.stringify(journal); list[idx].updated_at = new Date().toISOString();
      localStorage.setItem(key, JSON.stringify(list));
    }
    if (this._ok()) {
      try { await fetch(SUPABASE_URL + "/rest/v1/reports?id=eq." + id, { method: "PATCH", headers: this._h(), body: JSON.stringify({ journal: JSON.stringify(journal) }) }); } catch(e) {}
    }
    return journal;
  },
  getStats: async function(sid) {
    var all = await this.getReports(sid);
    var now = new Date();
    var thisM = all.filter(function(r) { var d = new Date(r.created_at); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
    var byType = {}, byStatus = { nouveau: 0, en_cours: 0, traite: 0, archive: 0 };
    all.forEach(function(r) {
      var t = r.type || "autre"; byType[t] = (byType[t] || 0) + 1;
      var s = r.status || "nouveau"; if (byStatus[s] !== undefined) byStatus[s]++;
    });
    var trend = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(now); d.setDate(d.getDate() - (6 - i));
      var ds = d.toISOString().slice(0, 10), dn = d.toLocaleDateString("fr-FR", { weekday: "short" }).slice(0, 3);
      trend.push({ date: ds, day: dn, count: all.filter(function(r) { return r.created_at && r.created_at.startsWith(ds); }).length });
    }
    return { total: all.length, thisMonth: thisM.length, byType, byStatus, trend, recent: all.slice(0, 50) };
  }
};
function bdgS(s) { var v = STATUTS[s]||STATUTS.nouveau; return '<span style="background:'+v.bg+';color:'+v.color+';padding:3px 8px;border-radius:20px;font-size:.7rem;font-weight:700">'+v.label+'</span>'; }
function bdgT(t) { var v = TYPES[t]||TYPES.autre; return '<span style="background:'+v.color+'22;color:'+v.color+';padding:3px 8px;border-radius:20px;font-size:.7rem;font-weight:700">'+v.label+'</span>'; }
function bdgU(u) { var v = URGENCES[u]||URGENCES.faible; return '<span style="color:'+v.color+';font-size:.75rem;font-weight:700">'+v.label+'</span>'; }
window.switchTab = function(tab) {
  ['desc','msg','phare','journal'].forEach(function(t) { var el = document.getElementById('tab-'+t); if (el) el.style.display = t===tab?'block':'none'; });
  document.querySelectorAll('.mtab').forEach(function(b) { var active = b.dataset.tab===tab; b.style.borderBottomColor = active?'#4f46e5':'transparent'; b.style.color = active?'#4f46e5':'#64748b'; b.style.fontWeight = active?'700':'600'; });
};
window.openRpt = function(id) {
  var all = window._allReports || [], r = all.find(function(x) { return x.id === id; });
  if (!r) return;
  var sid = localStorage.getItem("ss_current_etab") || "demo";
  var ex = document.getElementById("rpt-modal"); if (ex) ex.remove();
  var phareSteps = []; try { phareSteps = JSON.parse(r.phare_steps || "[]"); } catch(e) {}
  var journal = []; try { journal = JSON.parse(r.journal || "[]"); } catch(e) {}
  var pHAREhtml = PHARE_STEPS.map(function(step, i) {
    var done = phareSteps.indexOf(i) > -1;
    return '<label style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;background:'+(done?'#f0fdf4':'#f8fafc')+';border-radius:8px;margin-bottom:6px;cursor:pointer;border:1px solid '+(done?'#86efac':'#e2e8f0')+'">' +
      '<input type="checkbox" id="phare_'+i+'" '+(done?'checked':'')+' style="margin-top:2px;accent-color:#16a34a">' +
      '<span style="font-size:.82rem;color:'+(done?'#166534':'#374151')+';'+(done?'text-decoration:line-through;':'')+'">' + step + '</span></label>';
  }).join('');
  var journalHtml = journal.length ? journal.map(function(e) {
    return '<div style="border-left:3px solid #818cf8;padding:8px 12px;margin-bottom:8px;background:#fafafa;border-radius:0 8px 8px 0">' +
      '<div style="font-size:.7rem;color:#94a3b8">'+new Date(e.date).toLocaleDateString("fr-FR",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})+' - '+(e.author||"CPE")+'</div>' +
      '<div style="font-size:.83rem;color:#374151;margin-top:3px">'+e.text+'</div></div>';
  }).join('') : '<div style="text-align:center;color:#94a3b8;font-size:.82rem;padding:12px">Aucune entree dans le journal</div>';
  var m = document.createElement("div"); m.className = "rpt-modal-bg"; m.id = "rpt-modal";
  m.innerHTML = '<div class="rpt-modal" style="max-width:540px;max-height:92vh;overflow-y:auto">' +
    '<div class="rpt-modal-h" style="position:sticky;top:0;background:#fff;z-index:10;border-bottom:1px solid #f1f5f9;padding-bottom:12px">' +
      '<div><div style="font-size:1.05rem;font-weight:800;color:#1e293b">'+((TYPES[r.type]||{}).label||r.type||"Signalement")+'</div>' +
      '<div style="font-size:.75rem;color:#94a3b8">'+(r.created_at?new Date(r.created_at).toLocaleDateString("fr-FR",{day:"numeric",month:"long",year:"numeric"}):'')+' - '+(r.classe||"NC")+(r.anonymous?' - Anonyme':'')+(r.tracking_code?' | <b style="color:#6366f1">'+r.tracking_code+'</b>':'')+' </div>' +
      '<div style="margin-top:6px;display:flex;gap:6px;align-items:center">'+bdgU(r.urgence)+bdgS(r.status)+bdgT(r.type)+'</div></div>' +
      '<button class="rpt-modal-close" onclick="document.getElementById('rpt-modal').remove()">x</button></div>' +
    '<div id="modal-tabs" style="display:flex;border-bottom:1.5px solid #e8eaed;margin-bottom:14px">' +
      '<button class="mtab active" onclick="switchTab('desc')" data-tab="desc" style="flex:1;padding:10px 4px;background:none;border:none;border-bottom:2.5px solid #4f46e5;font-size:.75rem;font-weight:700;color:#4f46e5;cursor:pointer">Dossier</button>' +
      '<button class="mtab" onclick="switchTab('msg')" data-tab="msg" style="flex:1;padding:10px 4px;background:none;border:none;border-bottom:2.5px solid transparent;font-size:.75rem;font-weight:600;color:#64748b;cursor:pointer">Messagerie</button>' +
      '<button class="mtab" onclick="switchTab('phare')" data-tab="phare" style="flex:1;padding:10px 4px;background:none;border:none;border-bottom:2.5px solid transparent;font-size:.75rem;font-weight:600;color:#64748b;cursor:pointer">pHARe</button>' +
      '<button class="mtab" onclick="switchTab('journal')" data-tab="journal" style="flex:1;padding:10px 4px;background:none;border:none;border-bottom:2.5px solid transparent;font-size:.75rem;font-weight:600;color:#64748b;cursor:pointer">Journal</button>' +
    '</div>' +
    '<div id="tab-desc">' +
      '<div style="font-size:.72rem;font-weight:700;color:#94a3b8;margin-bottom:5px;text-transform:uppercase">Description</div>' +
      '<div class="rpt-modal-desc" style="margin-bottom:14px">'+(r.description||"Aucun detail")+'</div>' +
      '<div id="rpt-photos-'+r.id+'" style="margin-bottom:14px"></div>' +
      '<div style="margin-bottom:14px"><div style="font-size:.72rem;font-weight:700;color:#166534;margin-bottom:6px;text-transform:uppercase">Note interne CPE (non visible par l'eleve)</div>' +
      '<textarea id="ani" style="width:100%;padding:10px;background:#f0fdf4;border:1.5px solid #86efac;border-radius:8px;font-size:.85rem;resize:vertical;min-height:70px" placeholder="Note confidentielle visible uniquement par l'equipe...">'+(r.admin_note||"")+'</textarea></div>' +
      '<div style="font-size:.72rem;font-weight:700;color:#94a3b8;margin-bottom:8px;text-transform:uppercase">Changer le statut</div>' +
      '<div class="st-btns" style="margin-bottom:14px">' +
        '<button class="st-btn" style="background:#dbeafe;color:#1d4ed8" onclick="chgSt(''+r.id+'','nouveau',''+sid+'')">Nouveau</button>' +
        '<button class="st-btn" style="background:#fef9c3;color:#a16207" onclick="chgSt(''+r.id+'','en_cours',''+sid+'')">En cours</button>' +
        '<button class="st-btn" style="background:#dcfce7;color:#166534" onclick="chgSt(''+r.id+'','traite',''+sid+'')">Traite</button>' +
        '<button class="st-btn" style="background:#f1f5f9;color:#475569" onclick="chgSt(''+r.id+'','archive',''+sid+'')">Archiver</button>' +
      '</div>' +
      '<button onclick="saveNoteAndReply(''+r.id+'',''+sid+'')" style="width:100%;padding:12px;background:#4f46e5;color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer">Sauvegarder note</button>' +
    '</div>' +
    '<div id="tab-msg" style="display:none">' +
      (r.staff_reply?'<div style="background:#eef2ff;border:1.5px solid #818cf8;border-radius:10px;padding:12px;margin-bottom:12px"><div style="font-size:.7rem;color:#4f46e5;font-weight:700;margin-bottom:4px">REPONSE ACTUELLE VISIBLE PAR LE DECLARANT</div><div style="font-size:.85rem;color:#312e81">'+r.staff_reply+'</div></div>':'<div style="background:#fef9c3;border:1px solid #fbbf24;border-radius:8px;padding:10px;margin-bottom:12px;font-size:.82rem;color:#92400e">Aucune reponse envoyee au declarant.</div>') +
      '<div style="font-size:.72rem;font-weight:700;color:#4f46e5;margin-bottom:6px;text-transform:uppercase">Reponse au declarant (visible via code de suivi)</div>' +
      '<textarea id="sri" style="width:100%;padding:10px;background:#f8fafc;border:1.5px solid #818cf8;border-radius:8px;font-size:.85rem;resize:vertical;min-height:100px" placeholder="Reponse visible par l'eleve via son code de suivi...">'+(r.staff_reply||"")+'</textarea>' +
      '<button onclick="saveReplyOnly(''+r.id+'',''+sid+'')" style="width:100%;padding:12px;background:#4f46e5;color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;margin-top:10px">Envoyer la reponse</button>' +
    '</div>' +
    '<div id="tab-phare" style="display:none">' +
      '<div style="background:linear-gradient(135deg,#1e1b4b,#312e81);border-radius:10px;padding:12px 14px;margin-bottom:14px;color:#fff">' +
        '<div style="font-size:.85rem;font-weight:800">Protocole pHARe</div>' +
        '<div style="font-size:.75rem;opacity:.8;margin-top:2px">Cochez chaque etape au fur et a mesure</div></div>' +
      pHAREhtml +
      '<button onclick="savePhare(''+r.id+'',''+sid+'')" style="width:100%;padding:12px;background:#166534;color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;margin-top:10px">Sauvegarder le protocole</button>' +
    '</div>' +
    '<div id="tab-journal" style="display:none">' +
      '<div style="margin-bottom:12px">' +
        '<textarea id="journal-entry" style="width:100%;padding:10px;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:8px;font-size:.85rem;resize:vertical;min-height:70px" placeholder="Entretien, action menee, observation..."></textarea>' +
        '<button onclick="addJournalEntry(''+r.id+'',''+sid+'')" style="width:100%;padding:10px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;margin-top:8px">Ajouter au journal</button>' +
      '</div>' +
      '<div id="journal-list">'+journalHtml+'</div>' +
    '</div>' +
  '</div>';
  m.addEventListener("click", function(e) { if (e.target === m) m.remove(); });
  document.body.appendChild(m);
  (async function() {
    try {
      var pc = document.getElementById("rpt-photos-"+r.id); if (!pc) return;
      var res = await fetch("/api/photos/list/"+r.id); if (!res.ok) return;
      var data = await res.json(); if (!data.photos||!data.photos.length) return;
      var html = '<div style="display:flex;gap:8px;flex-wrap:wrap">';
      data.photos.forEach(function(p) { var url = "/api/photos/get/"+encodeURIComponent(p.key); html += '<a href="'+url+'" target="_blank" style="display:block;width:80px;height:80px;border-radius:8px;overflow:hidden;border:2px solid #e2e8f0"><img src="'+url+'" style="width:100%;height:100%;object-fit:cover"></a>'; });
      pc.innerHTML = html + '</div>';
    } catch(e) {}
  })();
};
window.saveReplyOnly = async function(id, sid) {
  var reply = document.getElementById("sri").value.trim();
  await DB.saveStaffReply(id, reply, sid);
  if (window._allReports) { var r = window._allReports.find(function(x){return x.id===id;}); if (r) r.staff_reply = reply; }
  document.getElementById("rpt-modal").remove();
  if (typeof toast === "function") toast("Reponse envoyee");
};
window.saveNoteAndReply = async function(id, sid) {
  var note = (document.getElementById("ani")||{}).value||"";
  var reply = (document.getElementById("sri")||{}).value||"";
  await DB.saveAdminNote(id, note.trim(), sid);
  if (reply.trim()) await DB.saveStaffReply(id, reply.trim(), sid);
  if (window._allReports) { var r = window._allReports.find(function(x){return x.id===id;}); if (r) { r.admin_note = note; if (reply) r.staff_reply = reply; } }
  document.getElementById("rpt-modal").remove();
  if (typeof toast === "function") toast("Sauvegarde");
};
window.savePhare = async function(id, sid) {
  var steps = [];
  PHARE_STEPS.forEach(function(_, i) { var cb = document.getElementById("phare_"+i); if (cb&&cb.checked) steps.push(i); });
  await DB.savePhareSteps(id, steps, sid);
  if (window._allReports) { var r = window._allReports.find(function(x){return x.id===id;}); if (r) r.phare_steps = JSON.stringify(steps); }
  document.getElementById("rpt-modal").remove();
  if (typeof toast === "function") toast("pHARe sauvegarde");
};
window.addJournalEntry = async function(id, sid) {
  var ta = document.getElementById("journal-entry"), entry = ta ? ta.value.trim() : ""; if (!entry) return;
  var journal = await DB.addJournalEntry(id, entry, sid);
  if (window._allReports) { var r = window._allReports.find(function(x){return x.id===id;}); if (r) r.journal = JSON.stringify(journal); }
  ta.value = "";
  var jl = document.getElementById("journal-list");
  if (jl) jl.innerHTML = journal.map(function(e) { return '<div style="border-left:3px solid #818cf8;padding:8px 12px;margin-bottom:8px;background:#fafafa;border-radius:0 8px 8px 0"><div style="font-size:.7rem;color:#94a3b8">'+new Date(e.date).toLocaleDateString("fr-FR",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})+' - '+(e.author||"CPE")+'</div><div style="font-size:.83rem;color:#374151;margin-top:3px">'+e.text+'</div></div>'; }).join('');
  if (typeof toast === "function") toast("Entree ajoutee");
};
window.chgSt = async function(id, status, sid) {
  await DB.updateStatus(id, status, sid);
  if (window._allReports) { var r = window._allReports.find(function(x){return x.id===id;}); if (r) r.status = status; }
  document.getElementById("rpt-modal").remove();
  if (typeof toast === "function") toast("Statut mis a jour");
  var el = document.querySelector("[data-dash-content]");
  if (el) window.renderDashboardV3External(el);
};
window.renderRptList = function(list) {
  if (!list||!list.length) return '<div style="text-align:center;padding:32px;color:#64748b;font-size:.85rem">Aucun signalement</div>';
  return list.map(function(r) {
    var dt = r.created_at ? new Date(r.created_at).toLocaleDateString("fr-FR",{day:"numeric",month:"short"}) : "";
    var phareSteps = []; try { phareSteps = JSON.parse(r.phare_steps||"[]"); } catch(e) {}
    return '<div class="rpt-item" onclick="openRpt(''+r.id+'')">' +
      '<div class="rpt-row1">'+bdgT(r.type)+bdgS(r.status)+'</div>' +
      '<div class="rpt-desc">'+(r.description||"Aucun detail")+'</div>' +
      '<div class="rpt-row3"><span style="font-size:.72rem;background:#f1f5f9;color:#64748b;padding:2px 7px;border-radius:10px;font-weight:600">'+(r.classe||"NC")+'</span>'+bdgU(r.urgence)+'<span class="rpt-date">'+dt+'</span>'+(r.tracking_code?'<span style="font-size:.65rem;color:#94a3b8;font-family:monospace">'+r.tracking_code+'</span>':'')+(phareSteps.length>0?'<span style="font-size:.65rem;color:#16a34a;font-weight:700">'+phareSteps.length+'/8 pHARe</span>':'')+(r.staff_reply?'<span style="font-size:.65rem;color:#4f46e5">repondu</span>':'')+'</div></div>';
  }).join('');
};
window.renderKanban = function(all) {
  var cols = ['nouveau','en_cours','traite','archive'];
  return '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">' +
    cols.map(function(s) {
      var v = STATUTS[s], items = all.filter(function(r){return (r.status||"nouveau")===s;});
      return '<div style="background:#fff;border-radius:14px;border:1.5px solid '+v.color+'33;overflow:hidden">' +
        '<div style="background:'+v.bg+';padding:10px 14px;display:flex;align-items:center;justify-content:space-between">' +
          '<span style="font-size:.82rem;font-weight:800;color:'+v.color+'">'+v.label+'</span>' +
          '<span style="background:'+v.color+';color:#fff;border-radius:20px;font-size:.7rem;font-weight:700;padding:2px 8px">'+items.length+'</span></div>' +
        '<div style="padding:8px;max-height:280px;overflow-y:auto">' +
          (items.length ? items.slice(0,10).map(function(r) {
            return '<div onclick="openRpt(''+r.id+'')" style="background:#f8fafc;border-radius:8px;padding:8px 10px;margin-bottom:6px;cursor:pointer;border:1px solid #e8eaed">' +
              '<div style="font-size:.72rem;font-weight:700;color:'+(TYPES[r.type]||TYPES.autre).color+'">'+(TYPES[r.type]||TYPES.autre).label+'</div>' +
              '<div style="font-size:.78rem;color:#374151;margin:2px 0;line-height:1.3">'+(r.description||"").substring(0,55)+(r.description&&r.description.length>55?'...':"")+'</div>' +
              '<div style="font-size:.65rem;color:#94a3b8">'+(r.classe||"NC")+' - '+(r.created_at?new Date(r.created_at).toLocaleDateString("fr-FR",{day:"numeric",month:"short"}):"")+'</div></div>';
          }).join('') : '<div style="text-align:center;color:#94a3b8;font-size:.78rem;padding:16px">Aucun</div>') +
        '</div></div>';
    }).join('') + '</div>';
};
window.fltRpt = async function(filter, btn) {
  document.querySelectorAll(".flt-btn").forEach(function(b){b.classList.remove("on");});
  if (btn) btn.classList.add("on");
  var sid = localStorage.getItem("ss_current_etab")||"demo";
  var all = window._allReports || await DB.getReports(sid);
  var f = filter==="all" ? all : all.filter(function(r){return STATUTS[filter]?r.status===filter:TYPES[filter]?r.type===filter:URGENCES[filter]?r.urgence===filter:true;});
  var el = document.getElementById("rpt-list"); if (el) el.innerHTML = window.renderRptList(f.slice(0,50));
};
window.renderDashboardV3External = async function(el) {
  if (!el) { el = document.querySelector("[data-dash-content]")||document.querySelector(".admin-content-area")||document.querySelector("#dash-content"); if (!el) return; }
  var sid = localStorage.getItem("ss_current_etab")||"demo";
  var etabs = JSON.parse(localStorage.getItem("ss_etabs")||"[]");
  var etab = etabs.find(function(e){return e.id===sid;})||{name:"Demo"};
  var S = await DB.getStats(sid); window._allReports = await DB.getReports(sid);
  var maxBar = Math.max(1, Math.max.apply(null, S.trend.map(function(d){return d.count;})));
  var bars = S.trend.map(function(d,i){var h=Math.max(3,Math.round(d.count/maxBar*44)),today=i===6;return '<div class="mini-bar-col"><div class="mini-cnt'+(today?" today":"")+'">'+( d.count||"")+'</div><div class="mini-bar'+(today?" today":"")+'" style="height:'+h+'px"></div><div class="mini-day" style="color:'+(today?"#4f46e5":"#94a3b8")+'">'+d.day+'</div></div>';}).join("");
  var nc=S.byStatus.nouveau||0,ec=S.byStatus.en_cours||0,tc=S.byStatus.traite||0,ac=S.byStatus.archive||0;
  var rr=S.total>0?Math.round(tc/S.total*100):0;
  var types=Object.entries(S.byType).sort(function(a,b){return b[1]-a[1];}).slice(0,5);
  var tot=S.total||1,rv=32,circ=2*Math.PI*rv,off=0;
  var segs=types.map(function(e){var t=e[0],n=e[1],col=(TYPES[t]||TYPES.autre).color,da=n/tot*circ;var s='<circle cx="42" cy="42" r="'+rv+'" fill="none" stroke="'+col+'" stroke-width="9" stroke-dasharray="'+da.toFixed(2)+' '+(circ-da).toFixed(2)+'" stroke-dashoffset="'+(-off).toFixed(2)+'"/>';off+=da;return s;}).join("");
  var leg=types.slice(0,4).map(function(e){var t=e[0],n=e[1],col=(TYPES[t]||TYPES.autre).color,lbl=(TYPES[t]||TYPES.autre).label;return '<div class="leg-row"><div class="leg-dot" style="background:'+col+'"></div><div class="leg-lbl">'+lbl+'</div><div class="leg-val">'+n+'</div></div>';}).join("");
  el.setAttribute("data-dash-content","1");
  el.innerHTML='<div style="background:#f8fafc;min-height:100%;padding-bottom:40px">' +
    '<div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:20px 16px 32px;position:relative;overflow:hidden">' +
      '<div style="position:absolute;right:-30px;top:-30px;width:120px;height:120px;background:rgba(255,255,255,.08);border-radius:50%"></div>' +
      '<div style="font-size:.75rem;color:#c7d2fe;font-weight:600;margin-bottom:3px">'+etab.name+'</div>' +
      '<div style="font-size:1.25rem;font-weight:800;color:#fff">Tableau de bord CPE</div>' +
      '<div style="font-size:.8rem;color:#a5b4fc;margin-top:2px">'+new Date().toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long"})+'</div></div>' +
    '<div style="margin-top:-18px;padding:0 14px"><div class="dash-kpi-grid">' +
      '<div class="kpi-card" style="--kpi-color:#4f46e5"><div class="kpi-icon">All</div><div class="kpi-label">Total</div><div class="kpi-num">'+S.total+'</div><div class="kpi-trend neu">signalements</div></div>' +
      '<div class="kpi-card" style="--kpi-color:#dc2626"><div class="kpi-icon">New</div><div class="kpi-label">Nouveaux</div><div class="kpi-num">'+nc+'</div><div class="kpi-trend '+(nc>0?"dn":"up")+'">'+(nc>0?"A traiter":"A jour")+'</div></div>' +
      '<div class="kpi-card" style="--kpi-color:#f59e0b"><div class="kpi-icon">Enc</div><div class="kpi-label">En cours</div><div class="kpi-num">'+ec+'</div><div class="kpi-trend neu">actifs</div></div>' +
      '<div class="kpi-card" style="--kpi-color:#16a34a"><div class="kpi-icon">OK</div><div class="kpi-label">Traites</div><div class="kpi-num">'+tc+'</div><div class="kpi-trend up">'+rr+'% resol.</div></div>' +
    '</div></div>' +
    '<div class="dsec"><div class="dsec-t">Vue Kanban</div>'+window.renderKanban(window._allReports)+'</div>' +
    '<div class="dsec"><div class="dsec-t">Tendance 7 jours</div><div style="background:#fff;border-radius:14px;padding:14px;border:1.5px solid #e8eaed"><div class="mini-chart">'+bars+'</div></div></div>' +
    (S.total>0?'<div class="dsec"><div class="dsec-t">Repartition par type</div><div style="background:#fff;border-radius:14px;padding:14px;border:1.5px solid #e8eaed"><div class="donut-row"><div class="donut-wrap"><svg viewBox="0 0 84 84" style="transform:rotate(-90deg)">'+segs+'</svg><div class="donut-mid"><div class="donut-n">'+S.total+'</div><div class="donut-l">cas</div></div></div><div class="leg">'+leg+'</div></div></div></div>':'') +
    '<div class="flt-bar"><button class="flt-btn on" onclick="fltRpt('all',this)">Tous ('+S.total+')</button><button class="flt-btn" onclick="fltRpt('nouveau',this)">Nouveaux ('+nc+')</button><button class="flt-btn" onclick="fltRpt('en_cours',this)">En cours ('+ec+')</button><button class="flt-btn" onclick="fltRpt('traite',this)">Traites ('+tc+')</button><button class="flt-btn" onclick="fltRpt('archive',this)">Archives ('+ac+')</button></div>' +
    '<div class="flt-bar" style="margin-top:-8px"><button class="flt-btn" onclick="fltRpt('verbal',this)" style="font-size:.72rem">Verbal</button><button class="flt-btn" onclick="fltRpt('physique',this)" style="font-size:.72rem">Physique</button><button class="flt-btn" onclick="fltRpt('cyber',this)" style="font-size:.72rem">Cyber</button><button class="flt-btn" onclick="fltRpt('exclusion',this)" style="font-size:.72rem">Exclusion</button><button class="flt-btn" onclick="fltRpt('haute',this)" style="font-size:.72rem;color:#dc2626">Urgent</button></div>' +
    '<div class="dsec"><div class="dsec-t">Tous les signalements</div><div class="rpt-list" id="rpt-list">'+window.renderRptList(S.recent)+'</div></div>' +
  '</div>';
};
(function seedDemo(){var sid=localStorage.getItem("ss_current_etab")||"demo",key="ss_rpt_"+sid;if(localStorage.getItem(key))return;var types=["verbal","physique","cyber","exclusion","autre"],classes=["6e A","6e B","5e A","4e A","4e B","3e A","3e B"],descs=["Moqueries repetees en classe","Messages blessants sur les reseaux","Mise a l'ecart systematique","Bousculades dans les couloirs","Screenshots sans accord","Insultes en recreation","Commentaires degradants en ligne","Exclusion des conversations"],statuts=["nouveau","nouveau","en_cours","traite","traite","archive"],urgences=["haute","moyenne","faible","faible","moyenne"],now=new Date(),list=[];for(var i=0;i<16;i++){var d=new Date(now);d.setDate(d.getDate()-Math.floor(Math.random()*30));list.push({id:"demo_"+i,tracking_code:"SS-DM"+String(i).padStart(2,"0"),type:types[i%5],classe:classes[i%7],urgence:urgences[i%5],status:statuts[i%6],anonymous:true,description:descs[i%8],school_id:sid,created_at:d.toISOString()});}localStorage.setItem(key,JSON.stringify(list));})();
console.log("[SafeSchool V4] dashboard-v3.js charge OK - Kanban CPE + pHARe + Messagerie + Journal");

// =======================================================
// SAFESCHOOL PRO - Extensions dashboard
// Session persistante + Reports Supabase + Sous-admin
// =======================================================

// --- SESSION PERSISTANTE ---
// Vérifier au chargement si une session admin existe
(function checkPersistedSession() {
  var adminToken = localStorage.getItem('ss_admin_token');
  var adminData = localStorage.getItem('ss_admin_data');
  if (!adminToken || !adminData) return;
  try {
    var data = JSON.parse(adminData);
    var tokenData = JSON.parse(atob(adminToken.split('.')[1] || 'e30='));
    var now = Date.now() / 1000;
    if (tokenData.exp && tokenData.exp < now) {
      localStorage.removeItem('ss_admin_token');
      localStorage.removeItem('ss_admin_data');
      return;
    }
    // Session valide - restaurer
    window.__adminToken = adminToken;
    window.__adminData = data;
    window.__adminSlug = data.slug || localStorage.getItem('ss_current_etab_slug');
  } catch(e) {
    localStorage.removeItem('ss_admin_token');
  }
})();

// --- LECTURE REPORTS DEPUIS SUPABASE ---
window.loadReportsFromSupabase = async function(slug, adminCode) {
  var code = adminCode || window.__adminToken || '';
  var r = await fetch('/api/reports/list/' + slug, {
    headers: { 'x-admin-code': code, 'Content-Type': 'application/json' }
  });
  if (!r.ok) {
    if (r.status === 401) {
      localStorage.removeItem('ss_admin_token');
      localStorage.removeItem('ss_admin_data');
      window.location.reload();
      return [];
    }
    return [];
  }
  var d = await r.json();
  return d.reports || [];
};

// Patch de refreshReports pour utiliser Supabase
var _origRefreshReports = window.refreshReports;
window.refreshReports = async function() {
  var slug = window.__adminSlug || localStorage.getItem('ss_current_etab_slug');
  var adminData = window.__adminData || JSON.parse(localStorage.getItem('ss_admin_data') || '{}');
  var code = adminData.admin_code || adminData.admin_password || window.__adminToken || '';
  
  if (!slug || !code) {
    if (_origRefreshReports) return _origRefreshReports.apply(this, arguments);
    return;
  }
  
  try {
    var reports = await window.loadReportsFromSupabase(slug, code);
    window.__cachedReports = reports;
    // Déclencher le re-render si le dashboard est visible
    if (typeof renderReportsList === 'function') renderReportsList(reports);
    else if (typeof renderDashboardV3 === 'function') renderDashboardV3(adminData);
    return reports;
  } catch(e) {
    if (_origRefreshReports) return _origRefreshReports.apply(this, arguments);
  }
};

// --- SOUS-ADMIN MODAL ---
window.openSubAdminModal = function() {
  var old = document.getElementById('ss-sa-ov');
  if (old) old.remove();
  var slug = window.__adminSlug || localStorage.getItem('ss_current_etab_slug') || '';
  var adminData = window.__adminData || JSON.parse(localStorage.getItem('ss_admin_data') || '{}');
  var currentSubAdmins = parseInt(adminData.sub_admins_count || '0');
  var maxSubAdmins = adminData.plan === 'enterprise' ? 5 : adminData.plan === 'pro' ? 3 : 0;
  
  if (maxSubAdmins === 0) {
    alert('Votre contrat ne permet pas de créer des sous-admins. Contactez SafeSchool pour upgrader.');
    return;
  }
  if (currentSubAdmins >= maxSubAdmins) {
    alert('Limite atteinte : ' + maxSubAdmins + ' sous-admin(s) maximum pour votre contrat.');
    return;
  }
  
  var ov = document.createElement('div');
  ov.id = 'ss-sa-ov';
  ov.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,20,40,.96);z-index:9999;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
  var h = '<div style="background:#fff;border-radius:20px;padding:28px 24px;width:90%;max-width:400px;box-shadow:0 20px 60px rgba(0,0,0,.4);">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">';
  h += '<h2 style="margin:0;font-size:18px;font-weight:700;color:#0f1428;">Ajouter un sous-admin</h2>';
  h += '<span style="background:#7c3aed;color:#fff;border-radius:20px;padding:3px 10px;font-size:12px;">' + currentSubAdmins + '/' + maxSubAdmins + '</span></div>';
  h += '<p style="margin:0 0 18px;color:#6b7280;font-size:13px;">Accès restreint — voit uniquement les incidents assignés</p>';
  h += '<div id="ssa-err" style="display:none;background:#fef2f2;color:#dc2626;border-radius:8px;padding:10px;margin-bottom:14px;font-size:13px;"></div>';
  h += '<label style="display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:5px;">Prénom et Nom *</label>';
  h += '<input id="ssa-name" type="text" placeholder="Mme Martin Sophie" style="width:100%;box-sizing:border-box;padding:11px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;margin-bottom:13px;outline:none;">';
  h += '<label style="display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:5px;">Rôle *</label>';
  h += '<select id="ssa-role" style="width:100%;box-sizing:border-box;padding:11px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;margin-bottom:13px;background:#fff;outline:none;">';
  h += '<option value="CPE">CPE - Conseiller Principal</option>';
  h += '<option value="PSY">Psychologue scolaire</option>';
  h += '<option value="PROF">Prof référent</option>';
  h += '<option value="INF">Infirmier(e)</option>';
  h += '<option value="DIR">Direction</option>';
  h += '</select>';
  h += '<label style="display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:5px;">Email</label>';
  h += '<input id="ssa-email" type="email" placeholder="prenom.nom@lycee.fr" style="width:100%;box-sizing:border-box;padding:11px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;margin-bottom:20px;outline:none;">';
  h += '<div style="display:flex;gap:10px;">';
  h += '<button onclick="document.getElementById('ss-sa-ov').remove()" style="flex:1;padding:12px;background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;border-radius:10px;font-size:14px;cursor:pointer;">Annuler</button>';
  h += '<button id="ssa-btn" onclick="window.saveSubAdmin()" style="flex:2;padding:12px;background:#7c3aed;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;">Créer le compte</button>';
  h += '</div></div>';
  ov.innerHTML = h;
  document.body.appendChild(ov);
  setTimeout(function(){ var n=document.getElementById('ssa-name'); if(n) n.focus(); }, 100);
};

window.saveSubAdmin = async function() {
  var nameEl=document.getElementById('ssa-name'), roleEl=document.getElementById('ssa-role'), emailEl=document.getElementById('ssa-email');
  var errEl=document.getElementById('ssa-err'), btn=document.getElementById('ssa-btn');
  var name=(nameEl?nameEl.value:'').trim(), role=roleEl?roleEl.value:'CPE', email=(emailEl?emailEl.value:'').trim();
  if (!name) { if(errEl){errEl.textContent='Nom requis';errEl.style.display='block';} return; }
  if(btn){btn.disabled=true;btn.textContent='Création...';}
  var chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789', code=role.substring(0,2)+'-';
  for(var i=0;i<6;i++) code+=chars[Math.floor(Math.random()*chars.length)];
  var adminData=window.__adminData||JSON.parse(localStorage.getItem('ss_admin_data')||'{}');
  var slug=window.__adminSlug||localStorage.getItem('ss_current_etab_slug')||'';
  var adminCode=adminData.admin_code||adminData.admin_password||'';
  try {
    var res=await fetch('/api/establishments/add-subadmin/'+slug,{method:'POST',headers:{'Content-Type':'application/json','x-admin-code':adminCode},body:JSON.stringify({name:name,role:role,email:email,code:code})});
    var d=await res.json();
    if(d.ok){
      var ov=document.getElementById('ss-sa-ov'); if(ov) ov.remove();
      alert('Sous-admin créé !

Nom : '+name+'
Code d'accès : '+code+'

Donnez ce code à '+name+' pour se connecter.');
      if(typeof renderStaffTab==='function') renderStaffTab();
    } else {
      if(errEl){errEl.textContent=d.error||'Erreur';errEl.style.display='block';}
      if(btn){btn.disabled=false;btn.textContent='Créer le compte';}
    }
  } catch(e){
    if(errEl){errEl.textContent='Erreur réseau';errEl.style.display='block';}
    if(btn){btn.disabled=false;btn.textContent='Créer le compte';}
  }
};

// Injecter le bouton sous-admin dans l'onglet Equipe
document.addEventListener('DOMContentLoaded', function() {
  var _origRenderStaff = window.renderStaffTab;
  if (typeof _origRenderStaff !== 'function') return;
  window.renderStaffTab = function() {
    _origRenderStaff.apply(this, arguments);
    setTimeout(function() {
      if (document.getElementById('ss-subadmin-btn')) return;
      var addBtn = Array.from(document.querySelectorAll('button')).find(function(b) {
        return b.textContent && b.textContent.trim().indexOf('Ajouter un membre') !== -1;
      });
      if (addBtn && addBtn.parentNode) {
        var nb = document.createElement('button');
        nb.id = 'ss-subadmin-btn';
        nb.style.cssText = 'display:flex;align-items:center;gap:8px;background:#7c3aed;color:#fff;border:none;border-radius:12px;padding:12px 18px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:8px;width:100%;';
        nb.innerHTML = '<span style="font-size:16px;">+</span> Ajouter un sous-admin';
        nb.onclick = window.openSubAdminModal;
        addBtn.parentNode.insertBefore(nb, addBtn.nextSibling);
      }
    }, 300);
  };
});
