import type { Context, Config } from '@netlify/edge-functions'

// V10 — Subdomain Router with improved validation and wildcard support
export default async (req: Request, context: Context) => {
  try {
    const url = new URL(req.url)
    const hostname = url.hostname

    // Extract subdomain from various domain patterns:
    // - xxx.safeschool.fr / .com / .net
    // - xxx--darling-muffin-21eb90.netlify.app (branch deploys)
    let subdomain: string | null = null

    // Match: lycee-name.safeschool.fr (or .com / .net)
    const safeschoolMatch = hostname.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.(safeschool\.(fr|com|net))$/i)
    if (safeschoolMatch) {
      subdomain = safeschoolMatch[1].toLowerCase()
    }

    // Match: lycee-name--darling-muffin-21eb90.netlify.app (Netlify branch subdomain)
    if (!subdomain) {
      const netlifyMatch = hostname.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)--darling-muffin-21eb90\.netlify\.app$/i)
      if (netlifyMatch) {
        subdomain = netlifyMatch[1].toLowerCase()
      }
    }

    // Skip if no subdomain detected
    if (!subdomain) return

    // Skip reserved subdomains
    const reserved = ['www', 'app', 'admin', 'api', 'staging', 'dev', 'test', 'mail', 'smtp', 'ftp', 'ns1', 'ns2']
    if (reserved.includes(subdomain)) return

    // For static assets, API calls, and known file extensions, pass through
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/') ||
        url.pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|json|webmanifest|xml|txt|map)$/)) {
      return
    }

    // For HTML pages, inject the subdomain as a global variable
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const response = await context.next()
      const html = await response.text()
      // Safely inject school slug - only alphanumeric and hyphens allowed by regex above
      const injection = `<script>window.__SAFESCHOOL_SLUG='${subdomain}';</script>`
      const modified = html.replace('<head>', '<head>' + injection)
      const headers = new Headers(response.headers)
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
      return new Response(modified, {
        status: 200,
        headers
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
