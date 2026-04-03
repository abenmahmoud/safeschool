(() => {
  const ENV = {
    supabaseUrl: window.SUPABASE_URL || "",
    supabaseAnonKey: window.SUPABASE_ANON_KEY || ""
  };

  const LS = {
    schools: "ss_schools_v3",
    currentSchool: "ss_current_school_v3",
    reports: "ss_reports_v3"
  };

  const TYPE_LABELS = { verbal:"Verbal", physique:"Physique", cyber:"Cyber", exclusion:"Exclusion", autre:"Autre" };
  const STATUS_LABELS = { nouveau:"Nouveau", en_cours:"En cours", traite:"Traité", archive:"Archivé" };

  function hasSupabase(){ return !!(ENV.supabaseUrl && ENV.supabaseAnonKey); }
  function loadJSON(key, fallback){ try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
  function saveJSON(key, value){ localStorage.setItem(key, JSON.stringify(value)); }
  function currentSchoolId(){ return localStorage.getItem(LS.currentSchool) || "demo"; }
  function getSchools(){ return loadJSON(LS.schools, []); }
  function currentSchool(){ return getSchools().find(s => s.id === currentSchoolId()) || { id:"demo", name:"Démo", city:"Paris" }; }
  function urgencyClass(v){ return v === "haute" ? "urg-high" : v === "moyenne" ? "urg-med" : "urg-low"; }
  function statusClass(v){ return v === "nouveau" ? "status-new" : v === "en_cours" ? "status-open" : "status-done"; }

  async function fetchReports(page = 1, pageSize = 20, filters = {}) {
    const sid = currentSchoolId();
    if (hasSupabase()) {
      const params = new URLSearchParams();
      params.set("school_id", `eq.${sid}`);
      params.set("order", "created_at.desc");
      if (filters.status && filters.status !== "all") params.set("status", `eq.${filters.status}`);
      if (filters.type && filters.type !== "all") params.set("type", `eq.${filters.type}`);
      if (filters.urgence && filters.urgence !== "all") params.set("urgence", `eq.${filters.urgence}`);
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const res = await fetch(`${ENV.supabaseUrl}/rest/v1/reports?${params.toString()}`, {
        headers: {
          apikey: ENV.supabaseAnonKey,
          Authorization: `Bearer ${ENV.supabaseAnonKey}`,
          Range: `${from}-${to}`
        }
      });
      if (res.ok) return await res.json();
    }
    let rows = loadJSON(LS.reports, []).filter(r => r.school_id === sid);
    if (filters.status && filters.status !== "all") rows = rows.filter(r => r.status === filters.status);
    if (filters.type && filters.type !== "all") rows = rows.filter(r => r.type === filters.type);
    if (filters.urgence && filters.urgence !== "all") rows = rows.filter(r => r.urgence === filters.urgence);
    return rows.slice((page - 1) * pageSize, page * pageSize);
  }

  async function updateReport(id, patch) {
    const sid = currentSchoolId();
    if (hasSupabase()) {
      const res = await fetch(`${ENV.supabaseUrl}/rest/v1/reports?id=eq.${encodeURIComponent(id)}&school_id=eq.${encodeURIComponent(sid)}`, {
        method: "PATCH",
        headers: {
          apikey: ENV.supabaseAnonKey,
          Authorization: `Bearer ${ENV.supabaseAnonKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
      });
      if (res.ok) return true;
    }
    const rows = loadJSON(LS.reports, []);
    const idx = rows.findIndex(r => r.id === id && r.school_id === sid);
    if (idx > -1) {
      rows[idx] = { ...rows[idx], ...patch, updated_at: new Date().toISOString() };
      saveJSON(LS.reports, rows);
      return true;
    }
    return false;
  }

  async function computeStats() {
    const sid = currentSchoolId();
    let rows = loadJSON(LS.reports, []).filter(r => r.school_id === sid);
    return {
      total: rows.length,
      urgent: rows.filter(r => r.urgence === "haute").length,
      nouveau: rows.filter(r => r.status === "nouveau").length,
      en_cours: rows.filter(r => r.status === "en_cours").length,
      traite: rows.filter(r => r.status === "traite").length
    };
  }

  function reportCard(r) {
    return `
      <div class="report">
        <div class="report-head">
          <div>
            <strong>${TYPE_LABELS[r.type] || r.type}</strong>
            <div class="muted">${new Date(r.created_at).toLocaleString("fr-FR")}</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <span class="badge ${urgencyClass(r.urgence)}">${r.urgence || "faible"}</span>
            <span class="badge ${statusClass(r.status)}">${STATUS_LABELS[r.status] || r.status}</span>
          </div>
        </div>
        <p>${r.description || ""}</p>
        <p class="muted">Classe : ${r.classe || "NC"} · Lieu : ${r.location || "NC"} · Code : ${r.tracking_code || "-"}</p>
        <div class="row">
          <div>
            <label>Réponse admin</label>
            <textarea id="note-${r.id}" style="min-height:80px">${r.admin_note || ""}</textarea>
          </div>
          <div>
            <label>Statut</label>
            <select id="status-${r.id}">
              <option value="nouveau" ${r.status==="nouveau"?"selected":""}>Nouveau</option>
              <option value="en_cours" ${r.status==="en_cours"?"selected":""}>En cours</option>
              <option value="traite" ${r.status==="traite"?"selected":""}>Traité</option>
              <option value="archive" ${r.status==="archive"?"selected":""}>Archivé</option>
            </select>
            <div class="section">
              <button class="btn brand" onclick="window.SafeSchoolAdmin.save('${r.id}')">Sauvegarder</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  async function render(root, page = 1, filters = { status:"all", type:"all", urgence:"all" }) {
    const school = currentSchool();
    const rows = await fetchReports(page, 20, filters);
    const stats = await computeStats();

    root.innerHTML = `
      <div class="container">
        <div class="hero">
          <div class="topbar">
            <div class="brand">
              <div class="brand-badge">S</div>
              <div>
                <div>Dashboard admin</div>
                <div class="muted">${school.name} · ${school.city || ""}</div>
              </div>
            </div>
            <div class="pill">${hasSupabase() ? "Mode Supabase" : "Mode démo local"}</div>
          </div>

          <div class="section kpis">
            <div class="kpi"><div class="muted">Total</div><strong>${stats.total}</strong></div>
            <div class="kpi"><div class="muted">Urgents</div><strong>${stats.urgent}</strong></div>
            <div class="kpi"><div class="muted">Nouveaux</div><strong>${stats.nouveau}</strong></div>
            <div class="kpi"><div class="muted">En cours</div><strong>${stats.en_cours}</strong></div>
            <div class="kpi"><div class="muted">Traités</div><strong>${stats.traite}</strong></div>
          </div>

          <div class="card section" style="padding:20px">
            <div class="row-3">
              <div>
                <label>Statut</label>
                <select id="flt-status">
                  <option value="all">Tous</option>
                  <option value="nouveau">Nouveau</option>
                  <option value="en_cours">En cours</option>
                  <option value="traite">Traité</option>
                  <option value="archive">Archivé</option>
                </select>
              </div>
              <div>
                <label>Type</label>
                <select id="flt-type">
                  <option value="all">Tous</option>
                  <option value="verbal">Verbal</option>
                  <option value="physique">Physique</option>
                  <option value="cyber">Cyber</option>
                  <option value="exclusion">Exclusion</option>
                  <option value="autre">Autre</option>
                </select>
              </div>
              <div>
                <label>Urgence</label>
                <select id="flt-urgence">
                  <option value="all">Toutes</option>
                  <option value="faible">Faible</option>
                  <option value="moyenne">Moyenne</option>
                  <option value="haute">Haute</option>
                </select>
              </div>
            </div>
            <div class="section"><button class="btn secondary" onclick="window.SafeSchoolAdmin.refresh()">Appliquer les filtres</button></div>
          </div>

          <div class="card section" style="padding:20px">
            <h2>Signalements</h2>
            <div class="list section" id="admin-list">${rows.length ? rows.map(reportCard).join("") : `<div class="empty">Aucun signalement.</div>`}</div>
          </div>
        </div>
      </div>
    `;
  }

  const api = {
    page: 1,
    root: null,
    filters: { status:"all", type:"all", urgence:"all" },
    async mount(root){
      this.root = root || document.getElementById("admin-root");
      if (this.root) await render(this.root, this.page, this.filters);
    },
    async refresh(){
      if (!this.root) return;
      this.filters = {
        status: document.getElementById("flt-status")?.value || "all",
        type: document.getElementById("flt-type")?.value || "all",
        urgence: document.getElementById("flt-urgence")?.value || "all"
      };
      await render(this.root, this.page, this.filters);
    },
    async save(id){
      const ok = await updateReport(id, {
        status: document.getElementById(`status-${id}`).value,
        admin_note: document.getElementById(`note-${id}`).value.trim()
      });
      if (ok) await this.refresh();
    }
  };

  window.SafeSchoolAdmin = api;
  document.addEventListener("DOMContentLoaded", () => {
    const root = document.getElementById("admin-root");
    if (root) api.mount(root);
  });
})();
