// media-fix.js - Signed URL override for dashboard media thumbnails
if(typeof loadMedias==="function"){loadMedias=function(rid){
var t=document.getElementById("tab-media");
t.innerHTML="<div class='spin'>Chargement...</div>";
fetch(SU+"/rest/v1/report_files?report_id=eq."+rid+"&select=*",{headers:{apikey:SK,Authorization:"Bearer "+SK}})
.then(function(r){return r.json()}).then(function(f){
if(!Array.isArray(f)||!f.length){t.innerHTML="<div class='empty'>Aucun fichier</div>";return}
var p=f.map(function(x){return x.file_path});
fetch(SU+"/storage/v1/object/sign/report-files",{
method:"POST",
headers:{apikey:SK,Authorization:"Bearer "+SK,"Content-Type":"application/json"},
body:JSON.stringify({expiresIn:3600,paths:p})
}).then(function(r){return r.json()}).then(function(s){
var m={};if(Array.isArray(s)){for(var i=0;i<s.length;i++){if(s[i].signedURL)m[p[i]]=SU+"/storage/v1"+s[i].signedURL}}
var h="<div class='media-grid'>";
for(var i=0;i<f.length;i++){var x=f[i];var u=m[x.file_path]||"";
var iv=x.is_video||(x.mime_type&&x.mime_type.indexOf("video")>-1);
var ii=x.is_photo||(x.mime_type&&x.mime_type.indexOf("image")>-1);
h+="<div class='media-thumb' onclick='window.open(\""+u+"\")'>";
if(ii)h+="<img src='"+u+"' onerror='this.parentElement.innerHTML=String.fromCharCode(128247)' loading='lazy'>";
else if(iv)h+="<span style='font-size:2.5rem'>&#127909;</span>";
else h+="<span style='font-size:2.5rem'>&#128196;</span>";
h+="</div>"}
h+="</div><p style='font-size:.75rem;color:var(--muted);margin-top:.75rem'>"+f.length+" fichier(s)</p>";
t.innerHTML=h
}).catch(function(e){t.innerHTML="<div class='empty'>Erreur: "+e.message+"</div>"})
}).catch(function(e){t.innerHTML="<div class='empty'>Erreur: "+e.message+"</div>"})
}}
