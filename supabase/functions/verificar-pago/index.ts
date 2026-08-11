// ============================================================
// Edge Function: verificar-pago  (Mercado Pago)
// La llama el portal al volver del checkout. Busca el pago en MP por
// external_reference (= pagos.id). Si está aprobado, crea la fila en
// `ingresos` (la deuda baja sola) y marca el pago. Es IDEMPOTENTE.
//
// Entrada (POST JSON): { pago_id }
// Salida: { estado: 'aprobado'|'pendiente'|'rechazado', propietario_id, ingreso_id? }
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

const MP = "https://api.mercadopago.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Metodo no permitido" }, 405);

  const TOKEN = Deno.env.get("MP_ACCESS_TOKEN");
  if (!TOKEN) return json({ error: "Falta el secreto MP_ACCESS_TOKEN" }, 500);

  try {
    const { pago_id } = await req.json();
    if (!pago_id) return json({ error: "Falta pago_id" }, 400);

    const rows = await db(`pagos?id=eq.${encodeURIComponent(pago_id)}&select=*`);
    const pago = rows && rows[0];
    if (!pago) return json({ error: "pago no encontrado", estado: "pendiente" }, 404);

    // Idempotencia: si ya creamos el ingreso, listo.
    if (pago.ingreso_id) return json({ estado: "aprobado", propietario_id: pago.propietario_id, ingreso_id: pago.ingreso_id });

    // Buscar el pago REAL en MP por external_reference (= pagos.id). Nunca confiamos en el navegador.
    const r = await fetch(`${MP}/v1/payments/search?external_reference=${encodeURIComponent(pago_id)}&sort=date_created&criteria=desc`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    const data = await r.json();
    if (!r.ok) return json({ error: "MP: " + JSON.stringify(data).slice(0, 200), estado: "pendiente" }, 502);

    const results = Array.isArray(data?.results) ? data.results : [];
    const approved = results.find((p: any) => p.status === "approved");

    if (approved) {
      const det = (pago.detalle_periodos && pago.detalle_periodos !== "Deuda general") ? (" " + pago.detalle_periodos) : "";
      const ingId = uid();
      await db("ingresos", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: {
          id: ingId, propietario_id: pago.propietario_id,
          monto: Number(approved.transaction_amount || pago.monto),
          fecha: new Date().toISOString().slice(0, 10),
          concepto: "Pago expensa" + det, comprobante: "Mercado Pago",
          pagado_por: "Propietario — Mercado Pago",
        },
      });
      await db(`pagos?id=eq.${encodeURIComponent(pago_id)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: { estado: "aprobado", ingreso_id: ingId },
      });
      return json({ estado: "aprobado", propietario_id: pago.propietario_id, ingreso_id: ingId });
    }

    const rejected = results.find((p: any) => p.status === "rejected" || p.status === "cancelled");
    if (rejected) return json({ estado: "rechazado", propietario_id: pago.propietario_id });

    return json({ estado: "pendiente", propietario_id: pago.propietario_id });
  } catch (e) {
    console.error("verificar-pago error:", e);
    return json({ error: String(e?.message || e), estado: "pendiente" }, 500);
  }
});
