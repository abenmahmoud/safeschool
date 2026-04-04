import type { Context, Config } from '@netlify/edge-functions'

// V8 Pro — Subdomain Router with improved validation and error handling
export default async (req: Request, context: Context) => {
  try {
    const url = new URL(req.url)
    const hostname = url.hostname

    // Extract subdomain: xxx.safeschool.fr or xxx.safeschool.com
    const safeschoolMatch = hostname.match(/^([a-z0-9][a-z0-9-]*[a-z0-9])\.(safeschool\.(fr|com|net)|darling-muffin-21eb90\.netlify\.app)$/i)

    // Skip if no subdomain, or if it's a reserved subdomain
    const reserved = ['www', 'app', 'admin', 'api', 'staging', 'dev', 'test', 'mail', 'smtp', 'ftp']
    if (!safeschoolMatch || reserved.includes(safeschoolMatch[1].toLowerCase())) {
      return
    }

    const subdomain = safeschoolMatch[1].toLowerCase()

    // For static assets, API calls, and known file extensions, pass through
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/') ||
        url.pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|json|webmanifest|xml|txt|map)$/)) {
      return
    }

    // For HTML pages, inject the subdomain as a query parameter
    if (url.pathname === '/' || url.pathname === '/index.html') {
      url.searchParams.set('school', subdomain)
      const response = await context.next()
      const html = await response.text()
      // Safely inject school slug - only alphanumeric and hyphens allowed by regex
      const injection = `<script>window.__SAFESCHOOL_SLUG='${subdomain}';</script>`
      const modified = html.replace('<head>', '<head>' + injection)
      return new Response(modified, {
        status: 200,
        headers: response.headers
      })
    }

    // For superadmin pages accessed via subdomain, redirect to main domain
    if (url.pathname.startsWith('/superadmin')) {
      return
    }

    return
  } catch (error) {
    console.error('[Edge] Subdomain router error:', error)
    return
  }
}

export const config: Config = {
  path: '/*',
  excludedPath: ['/api/*', '/.netlify/*']
}
