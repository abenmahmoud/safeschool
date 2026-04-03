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

  const DEFAULT_SCHOOLS = [
    { id: "demo", name: "Établissement de démonstration", city: "Paris", slug: "demo" },
    { id: "blaise-cendrars", name: "Lycée Blaise Cendrars", city: "Sevran", slug: "blaise-cendrars" }
  ];

  function loadJSON(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  }
  function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  function hasSupabase() { return !!(ENV.supabaseUrl && ENV.supabaseAnonKey); }

  function ensureSeed() {
    if (!Array.isArray(loadJSON(LS.schools, null))) saveJSON(LS.schools, DEFAULT_SCHOOLS);
    if (!Array.isArray(loadJSON(LS.reports, null))) {
      saveJSON(LS.reports, [{
        id: "demo-1",
        school_id: "demo",
        tracking_code: "SS-AB12CD",
        role: "victime",
        type: "verbal",
        location: "Cour",
        urgence: "moyenne",
        classe: "4e A",
        description: "Moqueries répétées pendant la récréation.",
        anonymous: true,
        contact: "",
        status: "nouveau",
        admin_note: "Nous avons bien reçu ton signalement.",
        created_at: new Date().toISOString()
      }]);
    }
  }

  function getSchools() { return loadJSON(LS.schools, DEFAULT_SCHOOLS); }
  function getCurrentSchoolId() { return localStorage.getItem(LS.currentSchool) || "demo"; }
  function setCurrentSchoolId(id) { localStorage.setItem(LS.currentSchool, id); }
  function getCurrentSchool() { return getSchools().find(s => s.id === getCurrentSchoolId()) || getSchools()[0]; }
  function randomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "SS-";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  async function createReport(payload) {
    if (hasSupabase()) {
      const res = await fetch(`${ENV.supabaseUrl}/rest/v1/reports`, {
        method: "POST",
        headers: {
          apikey: ENV.supabaseAnonKey,
          Authorization: `Bearer ${ENV.supabaseAnonKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error("Erreur Supabase");
      const rows = await res.json();
      return rows[0];
    }
    const list = loadJSON(LS.reports, []);
    const entry = { id: `r-${Date.now()}`, created_at: new Date().toISOString(), ...payload };
    list.unshift(entry);
    saveJSON(LS.reports, list);
    return entry;
  }

  async function getReportByCode(code, schoolId) {
    if (hasSupabase()) {
      const rpc = await fetch(`${ENV.supabaseUrl}/rest/v1/rpc/get_report_by_code_secure`, {
        method: "POST",
        headers: {
          apikey: ENV.supabaseAnonKey,
          Authorization: `Bearer ${ENV.supabaseAnonKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ p_code: code, p_school_slug: getCurrentSchool().slug })
      });
      if (rpc.ok) {
        const rows = await rpc.json();
        return Array.isArray(rows) ? rows[0] || null : rows || null;
      }
    }
    return loadJSON(LS.reports, []).find(r => r.school_id === schoolId && r.tracking_code === code) || null;
  }

  function switchTab(tab) {
    document.querySelectorAll("[id^='tab-']").forEach(el => el.classList.add("hidden"));
    document.getElementById(`tab-${tab}`)?.classList.remove("hidden");
  }

  function updateSchoolIndicators() {
    const school = getCurrentSchool();
    document.getElementById("currentSchoolPill").textContent = `Établissement : ${school.name}`;
    document.getElementById("tenantLine").textContent = `${school.name} · ${school.city} · espace sécurisé`;
  }

  function initSchoolSelector() {
    const select = document.getElementById("schoolSelect");
    const schools = getSchools();
    select.innerHTML = schools.map(s => `<option value="${s.id}">${s.name} · ${s.city}</option>`).join("");
    select.value = getCurrentSchoolId();
    updateSchoolIndicators();
  }

  function bind() {
    document.querySelectorAll("[data-tab]").forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
    document.getElementById("saveSchoolBtn").addEventListener("click", () => {
      setCurrentSchoolId(document.getElementById("schoolSelect").value);
      updateSchoolIndicators();
      alert(hasSupabase() ? "Établissement sélectionné." : "Établissement sélectionné. Mode démo local actif.");
    });

    document.getElementById("reportForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const school = getCurrentSchool();
      const anonymous = document.getElementById("anonymous").value === "true";
      const contact = document.getElementById("contact").value.trim();
      const description = document.getElementById("description").value.trim();
      if (description.length < 20) return alert("Décris la situation en au moins 20 caractères.");
      if (!anonymous && !contact) return alert("Ajoute un contact ou repasse en mode anonyme.");

      const payload = {
        school_id: school.id,
        tracking_code: randomCode(),
        role: document.getElementById("role").value,
        type: document.getElementById("type").value,
        location: document.getElementById("location").value.trim(),
        urgence: document.getElementById("urgency").value,
        classe: document.getElementById("className").value.trim(),
        description,
        anonymous,
        contact,
        status: "nouveau",
        admin_note: "Merci. L'équipe a bien reçu ton signalement."
      };

      try {
        const report = await createReport(payload);
        const box = document.getElementById("reportResult");
        box.classList.remove("hidden");
        box.innerHTML = `<div class="success"><strong>Signalement envoyé.</strong><p>Ton code de suivi est <code>${report.tracking_code}</code>.</p></div>`;
        e.target.reset();
        switchTab("track");
        document.getElementById("trackCode").value = report.tracking_code;
      } catch (err) {
        alert("Erreur lors de l'envoi.");
      }
    });

    document.getElementById("trackBtn").addEventListener("click", async () => {
      const code = document.getElementById("trackCode").value.trim().toUpperCase();
      const target = document.getElementById("trackResult");
      if (code.length < 6) return target.innerHTML = `<div class="empty">Code invalide.</div>`;
      const report = await getReportByCode(code, getCurrentSchoolId());
      if (!report) return target.innerHTML = `<div class="empty">Aucun dossier trouvé pour ce code.</div>`;
      target.innerHTML = `
        <div class="report">
          <div class="report-head">
            <strong>Dossier ${report.tracking_code || code}</strong>
            <span class="badge ${report.status === "nouveau" ? "status-new" : report.status === "en_cours" ? "status-open" : "status-done"}">${report.status}</span>
          </div>
          <p><strong>Type :</strong> ${report.type}</p>
          <p><strong>Description :</strong> ${report.description}</p>
          <p><strong>Réponse de l'équipe :</strong> ${report.admin_note || "Aucune réponse pour le moment."}</p>
        </div>`;
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    ensureSeed();
    initSchoolSelector();
    bind();
    switchTab("home");
  });
})();
