import type { Config, Context } from "@netlify/edge-functions";

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  
  // La page /admin/login est publique
  if (url.pathname === '/admin/login' || url.pathname === '/admin/login.html') {
    return context.next();
  }
  
  // Vérifier le cookie JWT
  const cookie = request.headers.get('cookie') || '';
  const tokenMatch = cookie.match(/ss_admin_token=([^;]+)/);
  
  if (!tokenMatch) {
    return Response.redirect(new URL('/admin/login', request.url), 302);
  }
  
  const token = tokenMatch[1];
  
  try {
    // Vérifier JWT via notre API
    const verify = await fetch(`${url.origin}/api/admin/verify-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    
    if (!verify.ok) {
      return Response.redirect(new URL('/admin/login', request.url), 302);
    }
    
    return context.next();
  } catch {
    return Response.redirect(new URL('/admin/login', request.url), 302);
  }
};

export const config: Config = {
  path: "/admin/*",
  excludedPath: ["/admin/login", "/admin/login.html", "/admin/login/*"]
};