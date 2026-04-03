const SUPABASE_URL = window.ENV_SUPABASE_URL;
const SUPABASE_KEY = window.ENV_SUPABASE_KEY;

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Charger les signalements
async function loadReports() {
  const schoolId = localStorage.getItem("ss_current_etab");

  const { data, error } = await supabase
    .from("reports")
    .select("*")
    .eq("school_id", schoolId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    return;
  }

  renderReports(data);
}

// Affichage simple
function renderReports(reports) {
  const container = document.getElementById("reports");

  if (!container) return;

  container.innerHTML = reports
    .map(
      (r) => `
      <div style="border:1px solid #ccc;padding:10px;margin:10px">
        <b>${r.case_number || ""}</b><br/>
        ${r.description}<br/>
        Status: ${r.status}
      </div>
    `
    )
    .join("");
}

// changer statut
async function updateStatus(id, status) {
  await supabase
    .from("reports")
    .update({ status })
    .eq("id", id);

  loadReports();
}

window.loadReports = loadReports;
window.updateStatus = updateStatus;