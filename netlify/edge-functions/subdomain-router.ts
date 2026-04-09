import type { Context, Config } from '@netlify/edge-functions'

// V8 Pro — Subdomain Router FIXED
export default async (req: Request, context: Context) => {
  try {
    const url = new URL(req.url)
    const hostname = url.hostname

    const safeschoolMatch = hostname.match(
      /^([a-z0-9][a-z0-9-]*[a-z0-9])\.(safeschool\.(fr|com|net)|darling-muffin-21eb90\.netlify\.app)$/i
    )

    const reserved = ['www', 'app', 'admin', 'api', 'staging', 'dev', 'test', 'mail', 'smtp', 'ftp']
    if (!safeschoolMatch || reserved.includes(safeschoolMatch[1].toLowerCase())) {
      return
    }

    const subdomain = safeschoolMatch[1].toLowerCase()

    // Passer les assets statiques sans modification
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/.netlify/') ||
      url.pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|json|webmanifest|xml|txt|map|ts)$/)
    ) {
      return
    }

    // Superadmin accessible uniquement depuis app.safeschool.fr
    if (url.pathname.startsWith('/superadmin')) {
      return
    }

    // ✅ FIX PRINCIPAL : Injecter le slug sur TOUTES les pages HTML
    const response = await context.next()
    const contentType = response.headers.get('content-type') || ''

    if (!contentType.includes('text/html')) {
      return response
    }

    const html = await response.text()
    const injection = `<script>window.__SAFESCHOOL_SLUG='${subdomain}';window.__SAFESCHOOL_DOMAIN='${hostname}';</script>`
    const modified = html.replace('<head>', '<head>' + injection)

    const newHeaders = new Headers(response.headers)
    newHeaders.delete('content-length')

    return new Response(modified, {
      status: response.status,
      headers: newHeaders
    })

  } catch (error) {
    console.error('[Edge] Subdomain router error:', error)
    return
  }
}

export const config: Config = {
  path: '/*',
  excludedPath: ['/api/*', '/.netlify/*']
}
