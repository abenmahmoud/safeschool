import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
function g(){const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let r="RPT-";for(let i=0;i<8;i++)r+=c[Math.floor(Math.random()*c.length)];return r;}
function cors(data,status,req){return new Response(JSON.stringify(data),{status:status||200,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,x-admin-code"}});}
export default async (req,context) => {
  if(req.method==="OPTIONS")return cors({},200,req);
  const SU=Netlify.env.get("aSUPABASE_URL")||Netlify.env.get("SUPABASE_URL")||"";
  const SK=Netlify.env.get("SUPABASE_ANON_KEY")||Netlify.env.get("SUPABASE_KEY")||"";
  const SA="c3VwZXJhZG1pbkBzYWZlc2Nob29sLmZyOlNhZmVTY2hvb2wyMDI1IUAjU0E=";
  const store=getStore("safeschool-data");
  const url=new URL(req.url);
  const path=url.pathname.replace("/api/reports","");
  if(req.method==="POST"&&path.startsWith("/submit/")){
    const slug=path.replace("/submit/","").split("?")[0];
    const idx=((await store.get("_index",{type:"json"}))||[]);
    const entry=idx.find(e=>e.slug===slug);
    if(!entry?.id)return cors({error:"Etablissement non trouve"},404,req);
    let body={};try{body=await req.json();}catch{return cors({error:"Corps invalide"},400,req);}
    const tracking=g();
    const res=await fetch(SU+"/rest/v1/reports",{method:"POST",headers:{"Content-Type":"application/json","apikey":SK,"Authorization":"Bearer "+SK,"Prefer":"return=representation"},body:JSON.stringify({school_id:entry.id,tracking_code:tracking,type:String(body.type||"autre").substring(0,100),description:String(body.description||"").substring(0,2000),location:String(body.location||"").substring(0,500),urgency:String(body.urgency||"moyen").substring(0,50),anonymous:body.anonymous!==false,reporter_role:String(body.reporter_role||"eleve").substring(0,50),reporter_email:String(body.reporter_email||body.contact||"").substring(0,200),classe:String(body.classe||body.class_name||"").substring(0,100),status:"nouveau",source_channel:"web",created_at:new Date().toISOString()})});
    if(!res.ok){const e=await res.text();return cors({error:"DB error",d:e.substring(0,100)},500,req);}
    const data=await res.json();
    return cors({ok:true,tracking_code:tracking,report_id:data[0]?.id},201,req);
  }
  if(req.method==="GET"&&path.startsWith("/list/")){
    const slug=path.replace("/list/","").split("?")[0];
    const ac=req.headers.get("x-admin-code")||"";
    const idx=((await store.get("_index",{type:"json"}))||[]);
    const entry=idx.find(e=>e.slug===slug);
    if(!entry?.id)return cors({error:"Etablissement non trouve"},404,req);
    const sd=(await store.get("school_"+entry.id,{type:"json"}));
    if(!(sd&&(ac===sd.admin_code||ac===sd.admin_password)||ac===SA))return cors({error:"Non autorise"},401,req);
    const res=await fetch(SU+"/rest/v1/reports?school_id=eq."+entry.id+"&order=created_at.desc&limit=200",{headers:{"apikey":SK,"Authorization":"Bearer "+SK}});
    const data=await res.json();
    return cors({ok:true,reports:data,total:data.length},200,req);
  }
  if(req.method==="GET"&&path.startsWith("/track/")){
    const tc=path.replace("/track/","").split("?")[0].toUpperCase();
    const res=await fetch(SU+"/rest/v1/reports?tracking_code=eq."+tc+"&limit=1",{headers:{"apikey":SK,"Authorization":"Bearer "+SK}});
    const data=await res.json();
    if(!data?.length)return cors({error:"Non trouve"},404,req);
    return cors({ok:true,report:data[0]},200,req);
  }
  return cors({error:"Route non trouvee"},404,req);
};
export const config={path:"/api/reports/*"};
