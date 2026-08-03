// ============================================================
// Adaptador Mercado Pago — TODA la logica especifica del proveedor
// vive aca. Para migrar a otro proveedor (ej AstroPay) se reescribe
// este archivo respetando la misma interfaz publica:
//   createPreference(), getPayment(), verifyWebhookSignature()
// ============================================================

const MP_BASE = "https://api.mercadopago.com";

function accessToken(): string {
  const t = Deno.env.get("MP_ACCESS_TOKEN");
  if (!t) throw new Error("Falta el secreto MP_ACCESS_TOKEN");
  return t;
}

export interface PreferenceInput {
  externalReference: string; // nuestro pagos.id
  titulo: string;
  monto: number;
  backUrl: string; // URL de la app a la que vuelve el propietario
  notificationUrl: string; // URL de la Edge Function webhook-mp
  emailComprador?: string;
}

// Crea una preferencia de Checkout Pro y devuelve el punto de inicio.
export async function createPreference(
  input: PreferenceInput,
): Promise<{ preferenceId: string; initPoint: string }> {
  const body: Record<string, unknown> = {
    items: [
      {
        id: input.externalReference,
        title: input.titulo,
        quantity: 1,
        currency_id: "ARS",
        unit_price: Number(input.monto),
      },
    ],
    external_reference: input.externalReference,
    notification_url: input.notificationUrl,
    ...(input.emailComprador ? { payer: { email: input.emailComprador } } : {}),
  };

  // MP rechaza auto_return si no hay back_urls validas -> solo las incluimos
  // cuando tenemos la URL publica de la app (APP_URL configurada).
  if (input.backUrl) {
    body.back_urls = {
      success: input.backUrl,
      failure: input.backUrl,
      pending: input.backUrl,
    };
    body.auto_return = "approved";
  }

  const r = await fetch(`${MP_BASE}/checkout/preferences`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json();
  if (!r.ok) {
    throw new Error("MP preferencia: " + JSON.stringify(data));
  }
  return { preferenceId: data.id, initPoint: data.init_point };
}

export interface PaymentInfo {
  id: string;
  status: string; // approved | rejected | pending | in_process | cancelled | refunded ...
  amount: number;
  externalReference: string | null;
  raw: unknown;
}

// Consulta el pago REAL a MP. Nunca confiamos en lo que dice el navegador.
export async function getPayment(paymentId: string): Promise<PaymentInfo> {
  const r = await fetch(`${MP_BASE}/v1/payments/${paymentId}`, {
    headers: { "Authorization": `Bearer ${accessToken()}` },
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error("MP pago: " + JSON.stringify(data));
  }
  return {
    id: String(data.id),
    status: data.status,
    amount: Number(data.transaction_amount),
    externalReference: data.external_reference ?? null,
    raw: data,
  };
}

// Valida la firma x-signature del webhook (HMAC-SHA256).
// Formato del header: "ts=1699...,v1=<hmac_hex>"
// Manifest que MP firma: `id:<dataId>;request-id:<xRequestId>;ts:<ts>;`
export async function verifyWebhookSignature(
  xSignature: string | null,
  xRequestId: string | null,
  dataId: string | null,
): Promise<boolean> {
  const secret = Deno.env.get("MP_WEBHOOK_SECRET");
  // Si no hay secreto configurado, no bloqueamos (util en pruebas iniciales),
  // pero se recomienda SIEMPRE configurarlo en produccion.
  if (!secret) return true;
  if (!xSignature) return false;

  const parts: Record<string, string> = {};
  for (const seg of xSignature.split(",")) {
    const i = seg.indexOf("=");
    if (i > -1) parts[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
  }
  const ts = parts["ts"];
  const v1 = parts["v1"];
  if (!ts || !v1) return false;

  // El id en el manifest va en minusculas segun la doc de MP.
  const id = (dataId ?? "").toLowerCase();
  const manifest = `id:${id};request-id:${xRequestId ?? ""};ts:${ts};`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(manifest),
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Comparacion en tiempo constante
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
