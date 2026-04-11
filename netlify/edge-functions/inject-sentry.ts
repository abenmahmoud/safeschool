import type { Config, Context } from "@netlify/edge-functions";

export default async function handler(req: Request, context: Context): Promise<Response> {
  const res = await context.next();
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return res;

  const dsn = Deno.env.get("SENTRY_DSN") || "";
  if (!dsn) return res;

  const html = await res.text();
  const injected = html.replace(
    "</head>",
    `<script>window.SENTRY_DSN="${dsn}";</script></head>`
  );
  return new Response(injected, { status: res.status, headers: res.headers });
}

export const config: Config = { path: ["/*.html", "/"] };
