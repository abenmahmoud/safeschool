// SafeSchool Dashboard Admin V1 (clean)
const SUPABASE_URL = window.ENV_SUPABASE_URL;
const SUPABASE_KEY = window.ENV_SUPABASE_KEY;

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentSchoolId = localStorage.getItem("ss_current_etab");

// ===== LOAD KPIs =====
async function loadKPI() {
  const { data } = await supabase
    .from("reports")
    .select("status", { count: "exact" })
    .eq("school_id", currentSchoolId);

  const total = data.length;
  const urgent = data.filter(r => r.urgency === "haute").length;
  const enCours = data.filter(r => r.status === "en_cours").length;

  document.getElementById("kpi").innerHTML = `
    <div>Total: ${total}</div>
    <div>Urgent: ${urgent}</div>
    <div>En cours: ${enCours}</div>
  `;
}

// ===== LOAD REPORTS =====
async function loadReports() {
  const { data } = await supabase
    .from("reports")
    .select("*")
    .eq("school_id", currentSchoolId)
    .order("created_at", { ascending: false });

  renderReports(data);
}

// ===== RENDER =====
function renderReports(reports) {
  const container = document.getElementById("reports");

  container.innerHTML = reports.map(r => `
    <div style="border:1px solid #ccc;padding:10px;margin:10px">
      <b>${r.case_number || ""}</b><br/>
      ${r.description}<br/>
      Status: ${r.status}<br/>
      <button onclick="updateStatus('${r.id}','traite')">Traiter</button>
      <button onclick="archive('${r.id}')">Archiver</button>
    </div>
  `).join("");
}

// ===== UPDATE STATUS =====
async function updateStatus(id, status) {
  await supabase.from("reports").update({ status }).eq("id", id);
  loadReports();
}

// ===== ARCHIVE =====
async function archive(id) {
  await supabase.from("reports").update({ status: "archive" }).eq("id", id);
  loadReports();
}

// ===== SEARCH =====
async function searchReports(term) {
  if (term.length < 3) return;

  const { data } = await supabase
    .from("reports")
    .select("*")
    .ilike("description", `%${term}%`)
    .eq("school_id", currentSchoolId);

  renderReports(data);
}

// ===== INIT =====
async function initDashboard() {
  await loadKPI();
  await loadReports();
}

window.updateStatus = updateStatus;
window.archive = archive;
window.searchReports = searchReports;
window.initDashboard = initDashboard;
