// Same-origin proxy: browser -> Pages Function -> Worker B.
// Keeps API_SHARED_SECRET server-side; the browser never sees it.
interface Env {
  API_BASE_URL: string; // e.g. https://llmstats-api.<subdomain>.workers.dev
  API_SHARED_SECRET: string;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const upstreamPath = url.pathname.replace(/^\/api/, "/api");
  const upstreamUrl = `${ctx.env.API_BASE_URL}${upstreamPath}${url.search}`;

  const upstreamRes = await fetch(upstreamUrl, {
    method: ctx.request.method,
    headers: { "X-API-Key": ctx.env.API_SHARED_SECRET },
  });

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: { "Content-Type": upstreamRes.headers.get("Content-Type") ?? "application/json" },
  });
};
