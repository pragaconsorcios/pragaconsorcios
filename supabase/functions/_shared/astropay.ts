// ============================================================
// Adaptador AstroPay (Offsite Checkout) — TODA la logica del proveedor.
// Interfaz publica: createPayment(), verifyCallbackSignature().
// Docs: https://developers.astropay.com/docs/accept-astropay/checkout
// ============================================================
import forge from "npm:node-forge@1.3.1";

function env(): "sandbox" | "production" {
  return (Deno.env.get("ASTROPAY_ENV") || "sandbox") as "sandbox" | "production";
}
function baseUrl(): string {
  return env() === "production"
    ? "https://partners-api.astropay.com"
    : "https://partners-api-sandbox.astropay.com";
}
function appId(): string {
  const v = Deno.env.get("ASTROPAY_APP_ID");
  if (!v) throw new Error("Falta el secreto ASTROPAY_APP_ID");
  return v;
}
function secretKey(): string {
  const v = Deno.env.get("ASTROPAY_SECRET_KEY");
  if (!v) throw new Error("Falta el secreto ASTROPAY_SECRET_KEY");
  return v;
}
// Basic auth: base64(app_id:secret_key). Todos los endpoints de Checkout
// aceptan Basic o Bearer; usamos Basic por simplicidad.
function authHeader(): string {
  return "Basic " + btoa(`${appId()}:${secretKey()}`);
}

export interface PaymentInput {
  externalReference: string; // nuestro pagos.id -> merchant_payment_id
  monto: number;
  successUrl: string;
  errorUrl: string;
  emailComprador?: string;
  merchantUserId?: string; // propietario_id (recomendado por AstroPay)
  soloTarjeta?: boolean; // true => requested_payment_method: CARD
}

// Crea un pago Offsite y devuelve el redirect_url del checkout hosteado.
export async function createPayment(
  input: PaymentInput,
): Promise<{ redirectUrl: string; paymentExternalId?: string; status: string }> {
  const body: Record<string, unknown> = {
    amount: Number(input.monto),
    currency: "ARS",
    country: "AR",
    merchant_payment_id: input.externalReference,
    redirect_success_url: input.successUrl,
    redirect_error_url: input.errorUrl,
    requested_payment_method: input.soloTarjeta ? "CARD" : null,
  };
  const user: Record<string, unknown> = {};
  if (input.emailComprador) user.email = input.emailComprador;
  if (input.merchantUserId) user.merchant_user_id = input.merchantUserId;
  if (Object.keys(user).length) body.user = user;

  const r = await fetch(`${baseUrl()}/v1/payments`, {
    method: "POST",
    headers: {
      "Authorization": authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error("AstroPay pago: " + JSON.stringify(data));
  return {
    redirectUrl: data.redirect_url,
    paymentExternalId: data.payment_external_id,
    status: data.status,
  };
}

// Baja los certificados activos para validar la firma del callback.
async function getCertificate(serial: string): Promise<string | null> {
  const r = await fetch(`${baseUrl()}/v1/certificates`, {
    headers: { "Authorization": authHeader() },
  });
  if (!r.ok) return null;
  const data = await r.json();
  const list = (data && data.certificates) || [];
  const match = list.find((c: any) => String(c.serial_number) === String(serial));
  // Si no matchea el serial exacto, probamos el primero (rotacion de certs).
  return (match && match.certificate) || (list[0] && list[0].certificate) || null;
}

// Verifica la firma RSA del callback.
// String firmado: `requestId:timestamp:body` (body = JSON crudo recibido).
// Headers: Partner-Signature (base64), Partner-Request-ID, Partner-Request-Time,
// Partner-Certificate-Serial-Number.
export async function verifyCallbackSignature(
  headers: Headers,
  rawBody: string,
): Promise<boolean> {
  // En pruebas iniciales de sandbox se puede desactivar; en produccion SIEMPRE on.
  if (Deno.env.get("ASTROPAY_VERIFY_SIGNATURE") === "0") return true;

  const signatureB64 = headers.get("Partner-Signature");
  const requestId = headers.get("Partner-Request-ID");
  const timestamp = headers.get("Partner-Request-Time");
  const serial = headers.get("Partner-Certificate-Serial-Number");
  if (!signatureB64 || !requestId || !timestamp || !serial) return false;

  const certPem = await getCertificate(serial);
  if (!certPem) return false;

  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const pub = cert.publicKey as any;
    const signed = `${requestId}:${timestamp}:${rawBody}`;
    const md = forge.md.sha256.create();
    md.update(signed, "utf8");
    const sigBytes = forge.util.decode64(signatureB64);
    return pub.verify(md.digest().bytes(), sigBytes);
  } catch (_e) {
    return false;
  }
}

// Normaliza el estado de AstroPay a nuestro vocabulario interno.
export function mapEstado(paymentStatus: string): string {
  switch (String(paymentStatus).toUpperCase()) {
    case "COMPLETED": return "aprobado";
    case "REJECTED": return "rechazado";
    case "EXPIRED": return "cancelado";
    default: return "pendiente";
  }
}
