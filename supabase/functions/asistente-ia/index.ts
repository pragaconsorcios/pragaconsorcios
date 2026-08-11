// ============================================================
// Edge Function: asistente-ia
// Asistente de consultas para el ADMIN. La llama el portal con el
// contexto (datos del consorcio) + la conversación, y responde con Claude.
//
// La API KEY de Anthropic vive SOLO acá (secreto ANTHROPIC_API_KEY);
// nunca en el frontend (que es público).
//
// Entrada (POST JSON): { contexto: string(JSON), mensajes: [{rol, texto}] }
// Salida: { respuesta: string }
// (Self-contained: sin imports, para poder desplegar pegando el código.)
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Modelo por defecto: Haiku 4.5 (rápido y barato). Cambiable con el
// secreto ANTHROPIC_MODEL (ej: claude-sonnet-5 para más razonamiento).
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5";

const SYSTEM = `Sos el asistente de "Praga Consorcios", una plataforma de administración de consorcios (edificios de departamentos) en Argentina. Te habla el ADMINISTRADOR.

Reglas:
- Respondé en español rioplatense, claro y CONCISO. Andá al grano.
- Usá EXCLUSIVAMENTE los datos que te paso en el bloque DATOS (JSON). No inventes números, nombres ni deudas.
- Si la respuesta no está en los datos, decilo ("No tengo ese dato") en vez de suponer.
- Los montos van en pesos con formato $X (ej: $60.000). No hagas cálculos que no se desprendan de los datos; usá los valores ya calculados (deuda por unidad, caja, etc.).
- "deuda" es el total que debe cada unidad. "saldo de caja" es ingresos menos gastos del consorcio.
- Si te piden redactar un aviso o mensaje para un moroso, escribí un texto breve, cordial y claro (para mandar por WhatsApp), usando su nombre y el monto que debe. No inventes fechas ni datos de pago que no estén en los datos.
- Cuando muestres varias unidades, usá una lista ordenada por deuda (de mayor a menor).`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Metodo no permitido" }, 405);

  const KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!KEY) return json({ error: "Falta el secreto ANTHROPIC_API_KEY" }, 500);

  try {
    const body = await req.json();
    const contexto = String(body?.contexto || "").slice(0, 120000); // techo de seguridad
    const mensajes = Array.isArray(body?.mensajes) ? body.mensajes.slice(-12) : [];

    if (!mensajes.length) return json({ error: "Sin mensajes" }, 400);

    const apiMessages = mensajes.map((m: any) => ({
      role: m.rol === "assistant" ? "assistant" : "user",
      content: String(m.texto || "").slice(0, 4000),
    }));

    const system = SYSTEM + "\n\nDATOS (JSON actual del sistema):\n" + contexto;

    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: apiMessages,
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("anthropic error:", JSON.stringify(data));
      const msg = data?.error?.message || ("HTTP " + r.status);
      return json({ error: "IA: " + msg }, 502);
    }

    const texto = Array.isArray(data?.content)
      ? data.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim()
      : "";

    return json({ respuesta: texto || "(sin respuesta)" });
  } catch (e) {
    console.error("asistente-ia error:", e);
    return json({ error: String(e?.message || e) }, 500);
  }
});
