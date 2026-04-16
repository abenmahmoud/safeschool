// secure-client.js - Sprint 4: Replace service_role with anon_key + JWT admin API
// Must load BEFORE any other admin script that uses SK

// Safe anon key (RLS enforces data protection)
var ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJzeXRrcGdkeHZsZGR6dXdhYWJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMDY1NTIsImV4cCI6MjA5MDc4MjU1Mn0.owZw9RrqYVns97eajtPMbfhhfzHbPprBSPJ3k8jYdkI";

// Replace exposed service_role_key with safe anon_key
window.SK = ANON_KEY;
try { SK = ANON_KEY; } catch(e) {}

// JWT token management
window._adminJWT = null;

window.adminLogin = async function(slug, adminCode){
  var r = await fetch("/api/establishments/admin-jwt/" + slug, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({admin_code: adminCode})
  });
  if(!r.ok) return null;
  var d = await r.json();
  if(d.token){
    window._adminJWT = d.token;
    try { localStorage.setItem("ss_jwt", d.token); } catch(e){}
    return d;
  }
  return null;
};

window.adminLogout = function(){
  window._adminJWT = null;
  try { localStorage.removeItem("ss_jwt"); } catch(e){}
};

// Restore JWT on page load
(function(){
  try { window._adminJWT = localStorage.getItem("ss_jwt"); } catch(e){}
  if(!window._adminJWT) return;
  try {
    var parts = window._adminJWT.split(".");
    if(parts.length !== 3){ window._adminJWT = null; return; }
    var p64 = parts[1].replace(/-/g,"+").replace(/_/g,"/");
    while(p64.length % 4) p64 += "=";
    var pld = JSON.parse(atob(p64));
    if(pld.exp && pld.exp < Math.floor(Date.now()/1000)){
      window._adminJWT = null;
      try { localStorage.removeItem("ss_jwt"); } catch(e){}
    } else {
      window._jwtPayload = pld;
    }
  } catch(e){ window._adminJWT = null; }
})();

// Wrapper for admin V2 API calls
window.adminFetch = function(path, options){
  options = options || {};
  options.headers = options.headers || {};
  if(window._adminJWT) options.headers["Authorization"] = "Bearer " + window._adminJWT;
  var url = path.indexOf("/") === 0 ? ("/api/admin-v2" + path) : ("/api/admin-v2/" + path);
  return fetch(url, options);
};

window.secureLoadReports = async function(){
  var r = await window.adminFetch("/reports");
  return r.ok ? await r.json() : [];
};

window.secureUpdateReport = async function(id, patch){
  var r = await window.adminFetch("/reports/" + id, {
    method: "PATCH",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(patch)
  });
  return r.ok ? await r.json() : null;
};

window.secureLoadFiles = async function(reportId){
  var r = await window.adminFetch("/files/" + reportId);
  return r.ok ? await r.json() : [];
};

window.secureStats = async function(){
  var r = await window.adminFetch("/stats");
  return r.ok ? await r.json() : null;
};

window.secureSubAdmins = async function(){
  var r = await window.adminFetch("/subadmins");
  return r.ok ? await r.json() : [];
};

// Override loadMedias to use secure V2 endpoint with pre-signed URLs
setTimeout(function(){
  if(!window._adminJWT) return;
  window.loadMedias = async function(reportId){
    var t = document.getElementById("tab-media");
    if(!t) return;
    t.innerHTML = "<div class=\"spin\">Chargement medias...</div>";
    try {
      var files = await window.secureLoadFiles(reportId);
      if(!Array.isArray(files) || !files.length){
        t.innerHTML = "<div class=\"empty\">Aucun fichier joint</div>";
        return;
      }
      var h = "<div class=\"media-grid\">";
      for(var i=0; i<files.length; i++){
        var f = files[i];
        var url = f.signed_url || "";
        var isVid = f.is_video || (f.mime_type && f.mime_type.indexOf("video")>-1);
        var isImg = f.is_photo || (f.mime_type && f.mime_type.indexOf("image")>-1);
        h += "<div class=\"media-thumb\" onclick=\"window.open(\\\"" + url + "\\\")\">";
        if(isImg){
          h += "<img src=\"" + url + "\" loading=\"lazy\">";
        } else if(isVid){
          h += "<span style=\"font-size:2.5rem\">&#127909;</span>";
          h += "<div class=\"play-icon\">VIDEO</div>";
        } else {
          h += "<span style=\"font-size:2.5rem\">&#128196;</span>";
        }
        h += "</div>";
      }
      h += "</div><p style=\"font-size:.75rem;color:var(--muted);margin-top:.75rem\">" + files.length + " fichier(s)</p>";
      t.innerHTML = h;
    } catch(e){
      t.innerHTML = "<div class=\"empty\">Erreur: " + e.message + "</div>";
    }
  };
}, 300);