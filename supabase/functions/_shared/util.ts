// Helpers compartidos: CORS + acceso a Supabase con service_role.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Supabase inyecta estas variables automaticamente en las Edge Functions.
function supaUrl(): string {
  const u = Deno.env.get("SUPABASE_URL");
  if (!u) throw new Error("Falta SUPABASE_URL");
  return u;
}
function serviceKey(): string {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!k) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
  return k;
}

// Cliente REST minimo (PostgREST) usando service_role -> saltea RLS.
export async function db(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<any> {
  const h: Record<string, string> = {
    "apikey": serviceKey(),
    "Authorization": `Bearer ${serviceKey()}`,
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  const r = await fetch(`${supaUrl()}/rest/v1/${path}`, {
    method: opts.method || "GET",
    headers: h,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`DB ${r.status}: ${t}`);
  }
  const ct = r.headers.get("content-type");
  if (ct && ct.includes("json") && r.status !== 204) return r.json();
  return null;
}

// id corto con el mismo formato que uid() del frontend.
export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
