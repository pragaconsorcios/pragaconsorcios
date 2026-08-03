// ============================================================
// Edge Function: crear-pago
// La llama el portal del propietario. Crea un pago en AstroPay
// (Offsite Checkout) y devuelve el redirect_url del checkout.
//
// Entrada (POST JSON): { propietario_id: string, monto: number }
// Salida: { pago_id, init_point }
// ============================================================
import { corsHeaders, db, json, uid } from "../_shared/util.ts";
import { createPayment } from "../_shared/astropay.ts";

const APP_URL = Deno.env.get("APP_URL") || ""; // URL publica de la app (redirect)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Metodo no permitido" }, 405);

  try {
    const { propietario_id, monto } = await req.json();

    if (!propietario_id) return json({ error: "Falta propietario_id" }, 400);
    const montoNum = Number(monto);
    if (!(montoNum > 0) || montoNum > 100_000_000) {
      return json({ error: "Monto invalido" }, 400);
    }

    // Validar que el propietario exista (server-side, no confiamos en el cliente).
    const props = await db(
      `propietarios?id=eq.${encodeURIComponent(propietario_id)}&select=id,nombre,email,consorcio_id`,
    );
    const prop = props && props[0];
    if (!prop) return json({ error: "Propietario no encontrado" }, 404);

    const pagoId = uid();
    const success = APP_URL
      ? `${APP_URL}${APP_URL.includes("?") ? "&" : "?"}pago=${pagoId}`
      : "";
    const error = APP_URL
      ? `${APP_URL}${APP_URL.includes("?") ? "&" : "?"}pago=${pagoId}&err=1`
      : "";

    const { redirectUrl, paymentExternalId, status } = await createPayment({
      externalReference: pagoId,
      monto: montoNum,
      successUrl: success,
      errorUrl: error,
      emailComprador: prop.email || undefined,
      merchantUserId: prop.id,
      soloTarjeta: false, // full checkout (wallet + tarjeta). Poner true para solo tarjeta.
    });

    // Registrar el intento de pago (estado pendiente).
    await db("pagos", {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: {
        id: pagoId,
        propietario_id: prop.id,
        consorcio_id: prop.consorcio_id || null,
        monto: montoNum,
        periodo: new Date().toISOString().slice(0, 7),
        estado: "pendiente",
        proveedor: "astropay",
        mp_preference_id: paymentExternalId || null, // reutilizamos la col p/ el id externo
      },
    });

    return json({ pago_id: pagoId, init_point: redirectUrl, status });
  } catch (e) {
    console.error("crear-pago error:", e);
    return json({ error: String(e?.message || e) }, 500);
  }
});
