import type { Context } from "@netlify/functions";
async function verifyJWT(token:string,sec:string):Promise<any|null>{
  try{
    const[h,p,s]=token.split('.');if(!h||!p||!s)return null;
    const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(sec),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    const sb=Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    const ok=await crypto.subtle.verify('HMAC',k,sb,new TextEncoder().encode(h+'.'+p));
    if(!ok)return null;
    const d=JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/')));
    if(d.exp<Math.floor(Date.now()/1000))return null;
    return d;
  }catch{return null;}
}
export default async(req:Request)=>{
  if(req.method!=='POST')return new Response('{}',{status:405});
  const SECRET=Netlify.env.get('ADMIN_JWT_SECRET')||'safeschool_jwt_change_me';
  let body:any={};try{body=await req.json();}catch{return new Response('{}',{status:400});}
  const payload=await verifyJWT(body.token,SECRET);
  if(!payload)return new Response(JSON.stringify({error:'Token invalide'}),{status:401,headers:{'Content-Type':'application/json'}});
  return new Response(JSON.stringify({ok:true,...payload}),{status:200,headers:{'Content-Type':'application/json'}});
};
export const config={path:'/api/admin/verify-token'};