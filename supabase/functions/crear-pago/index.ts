// ============================================================
// Edge Function: crear-pago  (Mercado Pago Checkout Pro)
// La llama el portal del propietario. Crea una preferencia de pago
// en Mercado Pago y devuelve el init_point (URL del checkout).
// Registra el intento en la tabla `pagos` (estado 'pendiente').
//
// Entrada (POST JSON): { propietario_id, monto, detalle_periodos?, periodo? }
// Salida: { pago_id, init_point }
// (Self-contained: sin imports, para desplegar pegando el código.)
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function uid(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

const SUPA = Deno.env.get("SUPABASE_URL")!;
const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function db(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<any> {
  const h: Record<string, string> = { apikey: SRV, Authorization: "Bearer " + SRV, "Content-Type": "application/json", ...(opts.headers || {}) };
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { method: opts.method || "GET", headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (!r.ok) throw new Error(`DB ${r.status}: ${await r.text()}`);
  const ct = r.headers.get("content-type");
  return (ct && ct.includes("json") && r.status !== 204) ? r.json() : null;
}

// URL pública de la app (a donde vuelve el propietario tras pagar).
const APP_URL = Deno.env.get("APP_URL") || "https://pragaconsorcios.github.io/pragaconsorcios/";
const MP = "https://api.mercadopago.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Metodo no permitido" }, 405);

  const TOKEN = Deno.env.get("MP_ACCESS_TOKEN");
  if (!TOKEN) return json({ error: "Falta el secreto MP_ACCESS_TOKEN" }, 500);

  try {
    const { propietario_id, monto, detalle_periodos, periodo } = await req.json();
    if (!propietario_id) return json({ error: "Falta propietario_id" }, 400);
    const montoNum = Number(monto);
    if (!(montoNum > 0) || montoNum > 100_000_000) return json({ error: "Monto invalido" }, 400);

    const props = await db(`propietarios?id=eq.${encodeURIComponent(propietario_id)}&select=id,nombre,email,consorcio_id`);
    const prop = props && props[0];
    if (!prop) return json({ error: "Propietario no encontrado" }, 404);

    const pagoId = uid();
    const backUrl = APP_URL + (APP_URL.includes("?") ? "&" : "?") + "pago=" + pagoId;

    // No se fija payer.email: deja que pague quien esté logueado en MP.
    // (Si se fija un email real, el sandbox tira "una de las partes es de prueba".)
    const prefBody: Record<string, unknown> = {
      items: [{ title: "Expensas — " + (prop.nombre || "propietario"), quantity: 1, currency_id: "ARS", unit_price: montoNum }],
      external_reference: pagoId,
      back_urls: { success: backUrl, failure: backUrl, pending: backUrl },
      auto_return: "approved",
    };

    const r = await fetch(MP + "/checkout/preferences", {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(prefBody),
    });
    const data = await r.json();
    if (!r.ok) return json({ error: "MP: " + JSON.stringify(data).slice(0, 300) }, 502);

    await db("pagos", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: {
        id: pagoId, propietario_id: prop.id, consorcio_id: prop.consorcio_id || null,
        monto: montoNum, periodo: periodo || null, detalle_periodos: detalle_periodos || null,
        estado: "pendiente", proveedor: "mercadopago", metodo: "mercadopago",
      },
    });

    return json({ pago_id: pagoId, init_point: data.init_point });
  } catch (e) {
    console.error("crear-pago error:", e);
    return json({ error: String(e?.message || e) }, 500);
  }
});
