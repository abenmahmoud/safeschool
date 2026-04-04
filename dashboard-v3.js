// SafeSchool Dashboard Admin V3 (Team + Assignment)
// VERSION STABLE

console.log("[SafeSchool] Dashboard V3 loaded");

const SUPABASE_URL = window.ENV_SUPABASE_URL;
const SUPABASE_KEY = window.ENV_SUPABASE_KEY;

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
let currentSchoolId = localStorage.getItem("ss_current_etab");

// KPI
async function loadKPI() {
  const { data } = await supabase.from("reports").select("*").eq("school_id", currentSchoolId);
  document.getElementById("kpi").innerHTML = "Total: " + data.length;
}

// Reports
async function loadReports() {
  const { data } = await supabase.from("reports").select("*").eq("school_id", currentSchoolId);
  renderReports(data);
}

function renderReports(reports) {
  document.getElementById("reports").innerHTML = reports.map(r => `
    <div>
      <b>${r.case_number || ""}</b><br/>
      ${r.description}<br/>
    </div>
  `).join("");
}

// Init
async function initDashboard() {
  await loadKPI();
  await loadReports();
}

window.initDashboard = initDashboard;
