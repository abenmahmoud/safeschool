// SafeSchool V3 - dashboard-v3.js
// Corrections: statuts snake_case, filtres complets, reponse admin, DB layer propre

var SUPABASE_URL = window.ENV_SUPABASE_URL || "";
var SUPABASE_KEY = window.ENV_SUPABASE_KEY || "";

var STATUTS = {
  nouveau:  { label: "Nouveau",  color: "#3b82f6", bg: "#dbeafe" },
  en_cours: { label: "En cours", color: "#a16207", bg: "#fef9c3" },
  traite:   { label: "Traite",   color: "#166534", bg: "#dcfce7" },
  archive:  { label: "Archive",  color: "#475569", bg: "#f1f5f9" }
};
var TYPES = {
  verbal:    { label: "Verbal",    color: "#dc2626" },
  physique:  { label: "Physique",  color: "#ea580c" },
  cyber:     { label: "Cyber",     color: "#7c3aed" },
  exclusion: { label: "Mise à l'écart", color: "#0891b2" },
  autre:     { label: "Autre",     color: "#64748b" }
};
var URGENCES = {
  haute:   { label: "Urgent", color: "#dc2626" },
  moyenne: { label: "Moyen",  color: "#f59e0b" },
  faible:  { label: "Faible", color: "#16a34a" }
};

window.DB = {
  _ok: function() { return !!(SUPABASE_URL && SUPABASE_KEY); },
  _h: function() {
    return {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    };
  },
  generateCode: function() {
    var c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var r = "SS-";
    for (var i = 0; i < 6; i++) r += c[Math.floor(Math.random() * c.length)];
    return r;
  },
  getReports: async function(sid) {
    if (this._ok()) {
      try {
        var r = await fetch(SUPABASE_URL + "/rest/v1/reports?school_id=eq." + sid + "&order=created_at.desc", { headers: this._h() });
        if (r.ok) return await r.json();
      } catch(e) { console.warn("Supabase fallback:", e); }
    }
    return JSON.parse(localStorage.getItem("ss_rpt_" + sid) || "[]");
  },
  saveReport: async function(rpt) {
    var sid = rpt.school_id || localStorage.getItem("ss_current_etab") || "demo";
    if (this._ok()) {
      try {
        var r = await fetch(SUPABASE_URL + "/rest/v1/reports", { method: "POST", headers: this._h(), body: JSON.stringify(Object.assign({}, rpt, { school_id: sid })) });
        if (r.ok) return (await r.json())[0];
      } catch(e) {}
    }
    var key = "ss_rpt_" + sid;
    var list = JSON.parse(localStorage.getItem(key) || "[]");
    var nr = Object.assign({ id: "r" + Date.now(), tracking_code: this.generateCode(), created_at: new Date().toISOString(), status: "nouveau", school_id: sid }, rpt);
    list.unshift(nr);
    localStorage.setItem(key, JSON.stringify(list));
    return nr;
  },
  updateStatus: async function(id, status, sid) {
    var s = status.replace("-", "_");
    if (this._ok()) {
      try {
        var r = await fetch(SUPABASE_URL + "/rest/v1/reports?id=eq." + id, { method: "PATCH", headers: this._h(), body: JSON.stringify({ status: s }) });
        if (r.ok) return;
      } catch(e) {}
    }
    var key = "ss_rpt_" + sid;
    var list = JSON.parse(localStorage.getItem(key) || "[]");
    var idx = list.findIndex(function(r) { return r.id === id; });
    if (idx > -1) { list[idx].status = s; list[idx].updated_at = new Date().toISOString(); }
    localStorage.setItem(key, JSON.stringify(list));
  },
  saveAdminNote: async function(id, note, sid) {
    if (this._ok()) {
      try {
        var r = await fetch(SUPABASE_URL + "/rest/v1/reports?id=eq." + id, { method: "PATCH", headers: this._h(), body: JSON.stringify({ admin_note: note }) });
        if (r.ok) return;
      } catch(e) {}
    }
    var key = "ss_rpt_" + sid;
    var list = JSON.parse(localStorage.getItem(key) || "[]");
    var idx = list.findIndex(function(r) { return r.id === id; });
    if (idx > -1) { list[idx].admin_note = note; list[idx].updated_at = new Date().toISOString(); }
    localStorage.setItem(key, JSON.stringify(list));
  },
  saveStaffReply: async function(id, reply, sid) {
    if (this._ok()) {
      try {
        var r = await fetch(SUPABASE_URL + "/rest/v1/reports?id=eq." + id, { method: "PATCH", headers: this._h(), body: JSON.stringify({ staff_reply: reply }) });
        if (r.ok) return;
      } catch(e) {}
    }
    var key = "ss_rpt_" + sid;
    var list = JSON.parse(localStorage.getItem(key) || "[]");
    var idx = list.findIndex(function(r) { return r.id === id; });
    if (idx > -1) { list[idx].staff_reply = reply; list[idx].updated_at = new Date().toISOString(); }
    localStorage.setItem(key, JSON.stringify(list));
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
      var ds = d.toISOString().slice(0, 10);
      var dn = d.toLocaleDateString("fr-FR", { weekday: "short" }).slice(0, 3);
      var cnt = all.filter(function(r) { return r.created_at && r.created_at.startsWith(ds); }).length;
      trend.push({ date: ds, day: dn, count: cnt });
    }
    return { total: all.length, thisMonth: thisM.length, byType: byType, byStatus: byStatus, trend: trend, recent: all.slice(0, 30) };
  }
};

(function seedDemo() {
  var sid = localStorage.getItem("ss_current_etab") || "demo";
  var key = "ss_rpt_" + sid;
  if (localStorage.getItem(key)) return;
  var types = ["verbal","physique","cyber","exclusion","autre"];
  var classes = ["6e A","6e B","5e A","4e A","4e B","3e A","3e B"];
  var descs = ["Moqueries repetees en classe","Messages blessants sur les reseaux","Mise a lecart systematique","Bousculades dans les couloirs","Screenshots sans accord","Insultes en recreation","Commentaires degradants en ligne","Exclusion des conversations"];
  var statuts = ["nouveau","nouveau","en_cours","traite","traite","archive"];
  var urgences = ["haute","moyenne","faible","faible","moyenne"];
  var now = new Date(), list = [];
  for (var i = 0; i < 16; i++) {
    var d = new Date(now); d.setDate(d.getDate() - Math.floor(Math.random() * 30));
    list.push({ id: "demo_" + i, tracking_code: "SS-DM" + String(i).padStart(2,"0"), type: types[i%5], classe: classes[i%7], urgence: urgences[i%5], status: statuts[i%6], anonymous: true, description: descs[i%8], school_id: sid, created_at: d.toISOString() });
  }
  localStorage.setItem(key, JSON.stringify(list));
})();

function bdgS(s) { var v = STATUTS[s] || STATUTS.nouveau; return "<span style=\"background:" + v.bg + ";color:" + v.color + ";padding:3px 8px;border-radius:20px;font-size:.7rem;font-weight:700\">" + v.label + "</span>"; }
function bdgT(t) { var v = TYPES[t] || TYPES.autre; return "<span style=\"background:" + v.color + "22;color:" + v.color + ";padding:3px 8px;border-radius:20px;font-size:.7rem;font-weight:700\">" + v.label + "</span>"; }
function bdgU(u) { var v = URGENCES[u] || URGENCES.faible; return "<span style=\"color:" + v.color + ";font-size:.75rem;font-weight:700\">" + v.label + "</span>"; }

window.renderRptList = function(list) {
  if (!list || !list.length) return "<div style=\"text-align:center;padding:32px;color:#64748b;font-size:.85rem\">Aucun signalement</div>";
  return list.map(function(r) {
    var dt = r.created_at ? new Date(r.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : "";
    return "<div class=\"rpt-item\" onclick=\"openRpt(\"" + r.id + "\")\">" + "<div class=\"rpt-row1\">" + bdgT(r.type) + bdgS(r.status) + "</div>" + "<div class=\"rpt-desc\">" + (r.description || "Aucun detail") + "</div>" + "<div class=\"rpt-row3\">" + "<span style=\"font-size:.72rem;background:#f1f5f9;color:#64748b;padding:2px 7px;border-radius:10px;font-weight:600\">" + (r.classe || "NC") + "</span>" + bdgU(r.urgence) + "<span class=\"rpt-date\">" + dt + "</span>" + (r.tracking_code ? "<span style=\"font-size:.65rem;color:#94a3b8;font-family:monospace\">" + r.tracking_code + "</span>" : "") + "</div></div>";
  }).join("");
};

window.fltRpt = async function(filter, btn) {
  document.querySelectorAll(".flt-btn").forEach(function(b) { b.classList.remove("on"); });
  if (btn) btn.classList.add("on");
  var sid = localStorage.getItem("ss_current_etab") || "demo";
  var all = window._allReports || await DB.getReports(sid);
  var f = filter === "all" ? all : all.filter(function(r) { return (STATUTS[filter] ? r.status === filter : TYPES[filter] ? r.type === filter : URGENCES[filter] ? r.urgence === filter : true); });
  var el = document.getElementById("rpt-list");
  if (el) el.innerHTML = window.renderRptList(f.slice(0, 30));
};

window.openRpt = function(id) {
  var all = window._allReports || [];
  var r = all.find(function(x) { return x.id === id; });
  if (!r) return;
  var sid = localStorage.getItem("ss_current_etab") || "demo";
  var ex = document.getElementById("rpt-modal");
  if (ex) ex.remove();
  var m = document.createElement("div");
  m.className = "rpt-modal-bg"; m.id = "rpt-modal";
  m.innerHTML = "<div class=\"rpt-modal\">"
    + "<div class=\"rpt-modal-h\"><div>"
    + "<div style=\"font-size:1.05rem;font-weight:800;color:#1e293b\">" + ((TYPES[r.type] || {}).label || r.type || "Signalement") + "</div>"
    + "<div style=\"font-size:.75rem;color:#94a3b8\">" + (r.created_at ? new Date(r.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : "") + " - " + (r.classe || "NC") + (r.anonymous ? " - Anonyme" : "") + (r.tracking_code ? " | <b style=\"color:#6366f1\">" + r.tracking_code + "</b>" : "") + "</div>"
    + "</div><button class=\"rpt-modal-close\" onclick=\"document.getElementById('rpt-modal').remove()\">x</button></div>"
    + "<div style=\"font-size:.72rem;font-weight:700;color:#94a3b8;margin-bottom:5px;text-transform:uppercase\">Description</div>"
    + "<div class=\"rpt-modal-desc\">" + (r.description || "Aucun detail") + "</div>"
    + "<div style=\"display:flex;gap:12px;margin-bottom:14px\">" + bdgU(r.urgence) + bdgS(r.status) + "</div>"
    + (r.staff_reply ? "<div style=\"background:#eef2ff;border:1px solid #818cf8;border-radius:8px;padding:10px;margin-bottom:12px\"><div style=\"font-size:.72rem;color:#4f46e5;font-weight:700;margin-bottom:4px\">REPONSE VISIBLE AU DECLARANT</div><div style=\"font-size:.85rem;color:#312e81\">" + r.staff_reply + "</div></div>" : "")
    + (r.admin_note ? "<div style=\"background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:10px;margin-bottom:12px\"><div style=\"font-size:.72rem;color:#166534;font-weight:700;margin-bottom:4px\">NOTE INTERNE CPE</div><div style=\"font-size:.85rem;color:#15803d\">" + r.admin_note + "</div></div>" : "")
    + "<div style=\"margin-bottom:14px\"><div style=\"font-size:.72rem;font-weight:700;color:#4f46e5;margin-bottom:6px;text-transform:uppercase\">Reponse au declarant (visible via code de suivi)</div>"
    + "<textarea id=\"sri\" style=\"width:100%;padding:10px;background:#f8fafc;border:1px solid #818cf8;border-radius:8px;font-size:.85rem;resize:vertical;min-height:70px\" placeholder=\"Cette reponse sera visible par l'eleve via son code de suivi...\">" + (r.staff_reply || "") + "</textarea></div>"
    + "<div style=\"margin-bottom:14px\"><div style=\"font-size:.72rem;font-weight:700;color:#94a3b8;margin-bottom:6px;text-transform:uppercase\">Note interne CPE (non visible par l'eleve)</div>"
    + "<textarea id=\"ani\" style=\"width:100%;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:.85rem;resize:vertical;min-height:70px\" placeholder=\"Note visible uniquement par les admins...\">" + (r.admin_note || "") + "</textarea></div>"
    + "<div style=\"font-size:.72rem;font-weight:700;color:#94a3b8;margin-bottom:8px;text-transform:uppercase\">Changer le statut</div>"
    + "<div class=\"st-btns\">"
    + "<button class=\"st-btn\" style=\"background:#dbeafe;color:#1d4ed8\" onclick=\"chgSt('" + r.id + "','nouveau','" + sid + "')\">Nouveau</button>"
    + "<button class=\"st-btn\" style=\"background:#fef9c3;color:#a16207\" onclick=\"chgSt('" + r.id + "','en_cours','" + sid + "')\">En cours</button>"
    + "<button class=\"st-btn\" style=\"background:#dcfce7;color:#166534\" onclick=\"chgSt('" + r.id + "','traite','" + sid + "')\">Traite</button>"
    + "<button class=\"st-btn\" style=\"background:#f1f5f9;color:#475569\" onclick=\"chgSt('" + r.id + "','archive','" + sid + "')\">Archiver</button>"
    + "</div>"
    + "<div style=\"display:flex;gap:10px;margin-top:16px\">"
    + "<button onclick=\"saveNoteAndReply('" + r.id + "','" + sid + "')\" style=\"flex:1;padding:12px;background:#6366f1;color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer\">Sauvegarder tout</button>"
    + "<button onclick=\"document.getElementById('rpt-modal').remove()\" style=\"padding:12px 20px;background:#f1f5f9;color:#64748b;border:none;border-radius:10px;font-weight:600;cursor:pointer\">Fermer</button>"
    + "</div></div>";
  m.addEventListener("click", function(e) { if (e.target === m) m.remove(); });
  document.body.appendChild(m);
};

window.saveNote = async function(id, sid) {
  var note = document.getElementById("ani").value.trim();
  await DB.saveAdminNote(id, note, sid);
  if (window._allReports) { var r = window._allReports.find(function(x) { return x.id === id; }); if (r) r.admin_note = note; }
  document.getElementById("rpt-modal").remove();
  if (typeof toast === "function") toast("Note sauvegardee");
};

window.saveNoteAndReply = async function(id, sid) {
  var note = document.getElementById("ani").value.trim();
  var reply = document.getElementById("sri").value.trim();
  await DB.saveAdminNote(id, note, sid);
  await DB.saveStaffReply(id, reply, sid);
  if (window._allReports) {
    var r = window._allReports.find(function(x) { return x.id === id; });
    if (r) { r.admin_note = note; r.staff_reply = reply; }
  }
  document.getElementById("rpt-modal").remove();
  if (typeof toast === "function") toast("Reponse et note sauvegardees");
};

window.chgSt = async function(id, status, sid) {
  await DB.updateStatus(id, status, sid);
  if (window._allReports) { var r = window._allReports.find(function(x) { return x.id === id; }); if (r) r.status = status; }
  document.getElementById("rpt-modal").remove();
  if (typeof toast === "function") toast("Statut mis a jour");
  var el = document.querySelector("[data-dash-content]");
  if (el) window.renderDashboardV3(el);
};

window.renderDashboardV3 = async function(el) {
  if (!el) { el = document.querySelector("[data-dash-content]") || document.querySelector(".admin-content-area") || document.querySelector("#dash-content"); if (!el) return; }
  var sid = localStorage.getItem("ss_current_etab") || "demo";
  var etabs = JSON.parse(localStorage.getItem("ss_etabs") || "[]");
  var etab = etabs.find(function(e) { return e.id === sid; }) || { name: "Demo" };
  var S = await DB.getStats(sid);
  window._allReports = await DB.getReports(sid);
  var maxBar = Math.max(1, Math.max.apply(null, S.trend.map(function(d) { return d.count; })));
  var bars = S.trend.map(function(d, i) {
    var h = Math.max(3, Math.round(d.count / maxBar * 44)), today = i === 6;
    return "<div class=\"mini-bar-col\"><div class=\"mini-cnt" + (today ? " today" : "") + "\">" + (d.count || "") + "</div><div class=\"mini-bar" + (today ? " today" : "") + "\" style=\"height:" + h + "px\"></div><div class=\"mini-day\" style=\"color:" + (today ? "#4f46e5" : "#94a3b8") + "\">" + d.day + "</div></div>";
  }).join("");
  var types = Object.entries(S.byType).sort(function(a,b){return b[1]-a[1];}).slice(0,5);
  var tot = S.total||1, rv=32, circ=2*Math.PI*rv, off=0;
  var segs = types.map(function(e) { var t=e[0],n=e[1],col=(TYPES[t]||TYPES.autre).color,da=n/tot*circ; var s="<circle cx=\"42\" cy=\"42\" r=\""+rv+"\" fill=\"none\" stroke=\""+col+"\" stroke-width=\"9\" stroke-dasharray=\""+da.toFixed(2)+" "+(circ-da).toFixed(2)+"\" stroke-dashoffset=\""+(-off).toFixed(2)+"\"/>"; off+=da; return s; }).join("");
  var leg = types.slice(0,4).map(function(e){var t=e[0],n=e[1],col=(TYPES[t]||TYPES.autre).color,lbl=(TYPES[t]||TYPES.autre).label; return "<div class=\"leg-row\"><div class=\"leg-dot\" style=\"background:"+col+"\"></div><div class=\"leg-lbl\">"+lbl+"</div><div class=\"leg-val\">"+n+"</div></div>"; }).join("");
  var nc=S.byStatus.nouveau||0, ec=S.byStatus.en_cours||0, tc=S.byStatus.traite||0, rr=S.total>0?Math.round(tc/S.total*100):0;
  el.setAttribute("data-dash-content","1");
  el.innerHTML = "<div style=\"background:#f8fafc;min-height:100%;padding-bottom:32px\">"
    + "<div style=\"background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:20px 16px 32px;position:relative;overflow:hidden\">"
    + "<div style=\"position:absolute;right:-30px;top:-30px;width:120px;height:120px;background:rgba(255,255,255,.08);border-radius:50%\"></div>"
    + "<div style=\"font-size:.75rem;color:#c7d2fe;font-weight:600;margin-bottom:3px\">" + etab.name + "</div>"
    + "<div style=\"font-size:1.25rem;font-weight:800;color:#fff\">Tableau de bord admin</div>"
    + "<div style=\"font-size:.8rem;color:#a5b4fc;margin-top:2px\">" + new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }) + "</div></div>"
    + "<div style=\"margin-top:-18px;padding:0 14px\"><div class=\"dash-kpi-grid\">"
    + "<div class=\"kpi-card\" style=\"--kpi-color:#4f46e5\"><div class=\"kpi-icon\">All</div><div class=\"kpi-label\">Total</div><div class=\"kpi-num\">" + S.total + "</div><div class=\"kpi-trend neu\">signalements</div></div>"
    + "<div class=\"kpi-card\" style=\"--kpi-color:#dc2626\"><div class=\"kpi-icon\">New</div><div class=\"kpi-label\">Nouveaux</div><div class=\"kpi-num\">" + nc + "</div><div class=\"kpi-trend " + (nc>0?"dn":"up") + "\">" + (nc>0?"A traiter":"A jour") + "</div></div>"
    + "<div class=\"kpi-card\" style=\"--kpi-color:#f59e0b\"><div class=\"kpi-icon\">Cal</div><div class=\"kpi-label\">Ce mois</div><div class=\"kpi-num\">" + S.thisMonth + "</div><div class=\"kpi-trend neu\">30 jours</div></div>"
    + "<div class=\"kpi-card\" style=\"--kpi-color:#16a34a\"><div class=\"kpi-icon\">OK</div><div class=\"kpi-label\">Traites</div><div class=\"kpi-num\">" + tc + "</div><div class=\"kpi-trend up\">" + rr + "% resol.</div></div>"
    + "</div></div>"
    + "<div class=\"dsec\"><div class=\"dsec-t\">Tendance 7 jours</div><div style=\"background:#fff;border-radius:14px;padding:14px;border:1.5px solid #e8eaed\"><div class=\"mini-chart\">" + bars + "</div></div></div>"
    + (S.total>0 ? "<div class=\"dsec\"><div class=\"dsec-t\">Repartition par type</div><div style=\"background:#fff;border-radius:14px;padding:14px;border:1.5px solid #e8eaed\"><div class=\"donut-row\"><div class=\"donut-wrap\"><svg viewBox=\"0 0 84 84\" style=\"transform:rotate(-90deg)\">" + segs + "</svg><div class=\"donut-mid\"><div class=\"donut-n\">" + S.total + "</div><div class=\"donut-l\">cas</div></div></div><div class=\"leg\">" + leg + "</div></div></div></div>" : "")
    + "<div class=\"flt-bar\"><button class=\"flt-btn on\" onclick=\"fltRpt('all',this)\">Tous (" + S.total + ")</button><button class=\"flt-btn\" onclick=\"fltRpt('nouveau',this)\">Nouveaux (" + nc + ")</button><button class=\"flt-btn\" onclick=\"fltRpt('en_cours',this)\">En cours (" + ec + ")</button><button class=\"flt-btn\" onclick=\"fltRpt('traite',this)\">Traites (" + tc + ")</button></div>"
    + "<div class=\"flt-bar\" style=\"margin-top:-8px\"><button class=\"flt-btn\" onclick=\"fltRpt('verbal',this)\" style=\"font-size:.72rem\">Verbal</button><button class=\"flt-btn\" onclick=\"fltRpt('physique',this)\" style=\"font-size:.72rem\">Physique</button><button class=\"flt-btn\" onclick=\"fltRpt('cyber',this)\" style=\"font-size:.72rem\">Cyber</button><button class=\"flt-btn\" onclick=\"fltRpt('exclusion',this)\" style=\"font-size:.72rem\">Exclusion</button><button class=\"flt-btn\" onclick=\"fltRpt('haute',this)\" style=\"font-size:.72rem;color:#dc2626\">Urgent</button></div>"
    + "<div class=\"dsec\"><div class=\"dsec-t\">Signalements recents</div><div class=\"rpt-list\" id=\"rpt-list\">" + window.renderRptList(S.recent) + "</div>"
    + (S.total===0?"<div style=\"text-align:center;padding:32px;color:#64748b\">Aucun signalement</div>":"")
    + "</div></div>";
};

console.log("[SafeSchool V3] dashboard-v3.js charge OK");
