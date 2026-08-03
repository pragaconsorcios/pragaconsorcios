// ============================================================
// Edge Function: callback-astropay
// La llama AstroPay cuando un pago llega a estado final
// (COMPLETED / EXPIRED / REJECTED). Verifica la firma RSA, y si el
// pago esta COMPLETED inserta la fila en `ingresos` (la deuda baja sola).
//
// Es IDEMPOTENTE: se crea el ingreso una sola vez (pagos.ingreso_id).
// Esta es la URL que hay que configurar como "Callback URL" en AstroPay.
// ============================================================
import { db, json, uid } from "../_shared/util.ts";
import { mapEstado, verifyCallbackSignature } from "../_shared/astropay.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  try {
    // Leemos el body CRUDO (necesario para verificar la firma tal cual).
    const rawBody = await req.text();

    const firmaOk = await verifyCallbackSignature(req.headers, rawBody);
    if (!firmaOk) {
      console.warn("callback-astropay: firma invalida");
      return json({ error: "firma invalida" }, 401);
    }

    let body: any = {};
    try { body = JSON.parse(rawBody); } catch { /* body vacio */ }

    const ref = body.merchant_payment_id; // = nuestro pagos.id
    const externalId = body.payment_external_id;
    const estadoMP = String(body.payment_status || "").toUpperCase();
    const montoReal = body?.payment_info?.payment_amount?.value;

    if (!ref) return json({ ignored: "sin merchant_payment_id" });

    const rows = await db(`pagos?id=eq.${encodeURIComponent(ref)}&select=*`);
    const pago = rows && rows[0];
    if (!pago) return json({ ignored: "pago no encontrado", ref });

    // Idempotencia.
    if (pago.ingreso_id) return json({ ok: true, ya_procesado: true });

    if (estadoMP === "COMPLETED") {
      const monto = Number(montoReal ?? pago.monto);
      const ingresoId = uid();
      await db("ingresos", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: {
          id: ingresoId,
          propietario_id: pago.propietario_id,
          monto: monto,
          fecha: new Date().toISOString().slice(0, 10),
          concepto: "Expensa mensual",
          comprobante: externalId || ref, // id externo AstroPay como comprobante
          pagado_por: "Propietario — AstroPay",
        },
      });
      await db(`pagos?id=eq.${encodeURIComponent(ref)}`, {
        method: "PATCH",
        headers: { "Prefer": "return=minimal" },
        body: {
          estado: "aprobado",
          mp_payment_id: externalId || null,
          ingreso_id: ingresoId,
          detalle: body,
        },
      });
      return json({ ok: true, estado: "aprobado", ingreso_id: ingresoId });
    }

    // EXPIRED / REJECTED: registrar sin crear ingreso.
    await db(`pagos?id=eq.${encodeURIComponent(ref)}`, {
      method: "PATCH",
      headers: { "Prefer": "return=minimal" },
      body: { estado: mapEstado(estadoMP), mp_payment_id: externalId || null, detalle: body },
    });
    return json({ ok: true, estado: mapEstado(estadoMP) });
  } catch (e) {
    console.error("callback-astropay error:", e);
    // 200 igual: evita reintentos infinitos por un error puntual nuestro.
    return json({ ok: false, error: String(e?.message || e) });
  }
});
