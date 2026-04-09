import type { Context, Config } from '@netlify/edge-functions'

const TENANT_BASE_DOMAIN = Netlify.env.get('TENANT_BASE_DOMAIN') || 'app.safeschool.fr'
const NETLIFY_TARGET = Netlify.env.get('NETLIFY_TARGET') || 'safeschoolproject.netlify.app'
const ROOT_DOMAINS = (Netlify.env.get('ROOT_DOMAINS') || 'safeschool.fr,safeschool.com,safeschool.net')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean)

function extractSlugFromHost(hostname: string): string | null {
  const normalizedHost = hostname.toLowerCase()
  const rootCandidates = [...ROOT_DOMAINS, TENANT_BASE_DOMAIN.toLowerCase(), NETLIFY_TARGET.toLowerCase()]

  for (const root of rootCandidates) {
    if (!root) continue
    if (!normalizedHost.endsWith(`.${root}`)) continue
    const suffix = `.${root}`
    const subdomainPart = normalizedHost.slice(0, normalizedHost.length - suffix.length)
    if (!subdomainPart || subdomainPart.includes('.')) continue
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(subdomainPart)) continue
    return subdomainPart
  }

  return null
}

// V9 Pro — Dynamic subdomain router (env-driven, multi-domain)
export default async (req: Request, context: Context) => {
  try {
    const url = new URL(req.url)
    const hostname = url.hostname

    // Skip if no subdomain, or if it's a reserved subdomain
    const reserved = ['www', 'app', 'admin', 'api', 'staging', 'dev', 'test', 'mail', 'smtp', 'ftp']
    const subdomain = extractSlugFromHost(hostname)
    if (!subdomain || reserved.includes(subdomain)) {
      return
    }

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
