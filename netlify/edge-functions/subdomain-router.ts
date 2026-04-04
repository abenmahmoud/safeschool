import type { Context, Config } from '@netlify/edge-functions'

export default async (req: Request, context: Context) => {
  const url = new URL(req.url)
  const hostname = url.hostname

  // Extract subdomain: xxx.safeschool.fr or xxx.safeschool.com
  const safeschoolMatch = hostname.match(/^([a-z0-9][a-z0-9-]+)\.(safeschool\.(fr|com|net)|darling-muffin-21eb90\.netlify\.app)$/i)

  // Skip if no subdomain, or if it's www/app/admin
  if (!safeschoolMatch || ['www', 'app', 'admin', 'api'].includes(safeschoolMatch[1])) {
    return
  }

  const subdomain = safeschoolMatch[1]

  // For static assets and API calls, let them pass through
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/') ||
      url.pathname.match(/\.(js|css|png|jpg|svg|ico|woff2?)$/)) {
    return
  }

  // For HTML pages, inject the subdomain as a query parameter
  // The app will pick this up and auto-select the establishment
  if (url.pathname === '/' || url.pathname === '/index.html') {
    url.searchParams.set('school', subdomain)
    const response = await context.next()
    // Inject a script to set the school slug before the app loads
    const html = await response.text()
    const injection = `<script>window.__SAFESCHOOL_SLUG='${subdomain}';</script>`
    const modified = html.replace('<head>', '<head>' + injection)
    return new Response(modified, {
      status: 200,
      headers: response.headers
    })
  }

  // For superadmin pages accessed via subdomain, redirect to main domain
  if (url.pathname === '/superadmin.html') {
    return
  }

  return
}

export const config: Config = {
  path: '/*',
  excludedPath: ['/api/*', '/.netlify/*']
}
