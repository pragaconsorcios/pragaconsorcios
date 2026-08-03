# Pagos de expensas — AstroPay

Hay **dos rutas**. La que está funcionando hoy es la **Ruta 2** (abajo). La
**Ruta 1** (pasarela con auto-registro) queda documentada más abajo para cuando
se consiga una cuenta **AstroPay Business/Partners**.

---

## ✅ RUTA 2 — En uso: transferencia/QR directo a AstroPay + confirmación del admin

Pensada para una **billetera AstroPay personal** (sin API): el propietario paga
por **transferencia/QR directo al alias/CVU de la administración** (directo, sin
comisión, sin Mercado Pago) y el admin **confirma con 1 clic**. No usa Edge
Functions: es solo frontend + Supabase (todo con la clave *publishable*).

### Flujo
1. **Propietario** (portal → "Pagar expensas online"): ve su deuda, **elige qué
   cuotas pagar** (si tiene varias vencidas), ve el **alias/CVU/QR** de AstroPay y
   el monto, transfiere desde cualquier billetera y toca **"Ya pagué"**. No sube
   comprobante. Queda un `pago` en estado `pendiente`.
2. **Admin** (menú → "Pagos por confirmar"): verifica en su app de AstroPay que
   llegó el dinero y toca **"Confirmar"** → se crea la fila en `ingresos` (la deuda
   baja sola) y el `pago` pasa a `confirmado`. También puede **"Registrar pago
   recibido"** a mano para quien transfirió sin tocar "Ya pagué".

### Puesta en marcha (2 pasos)
1. **Base de datos:** Supabase → SQL Editor → pegar y ejecutar
   `migrations/0002_pagos_ruta2.sql` (crea `config_pagos` y `pagos` con RLS abierta).
2. **Cargar el destino de cobro:** entrar como admin → **Configuración → Pagos
   online (AstroPay)** → completar **alias**, **titular**, **CBU/CVU** (opcional),
   **instrucciones** y subir el **QR** (opcional, imagen de "Cobrar/Recibir" de la
   app AstroPay). Guardar. Eso es lo que ve el propietario.

Listo. No hacen falta credenciales ni Edge Functions.

### Nota de seguridad (Ruta 2)
El `pago` que marca el propietario es solo un **aviso**; el `ingreso` contable lo
crea el **admin** al confirmar contra lo que ve en AstroPay. Nadie acredita deuda
sin la confirmación humana. La RLS de estas tablas está abierta (como el resto de
la app, que usa la clave publishable); si en el futuro se endurece la seguridad,
mover la escritura de `pagos`/`ingresos` a Edge Functions con service_role.

---

## RUTA 1 — Futuro: AstroPay Business (Offsite Checkout, auto-registro)

Integración para que el propietario pague sus expensas desde el portal y el
ingreso se cargue **automáticamente** (vía callback verificado del lado servidor).
La plata cae directo en la cuenta AstroPay de la administración. **Requiere cuenta
AstroPay Business/Partners** (no la billetera personal). El código ya está escrito
(`_shared/astropay.ts`, `crear-pago`, `callback-astropay`, migración `0001_pagos.sql`).

## Arquitectura

- **Frontend** (`index.html`): botón "Pagar expensas online" en el portal del
  propietario → llama a la Edge Function `crear-pago` → redirige al checkout de AstroPay.
- **`crear-pago`** (Edge Function): crea el pago en AstroPay (`POST /v1/payments`,
  modo Offsite) y registra el intento en la tabla `pagos` (estado `pendiente`).
  Devuelve el `redirect_url` del checkout hosteado.
- **`callback-astropay`** (Edge Function): la llama AstroPay cuando el pago llega a
  estado final. Verifica la **firma RSA**, y si está `COMPLETED` inserta la fila en
  `ingresos` (la deuda baja sola). Es idempotente.
- **Tabla `pagos`**: ciclo de vida del checkout. La escriben SOLO las funciones
  (service_role). `ingresos` no cambió de forma.

El proveedor está aislado en `functions/_shared/astropay.ts` (adaptador). Queda
`_shared/mp.ts` como alternativa por si algún día se cobra con Mercado Pago.

## Datos técnicos de AstroPay (para referencia)

- **Entornos:** sandbox `https://partners-api-sandbox.astropay.com` ·
  producción `https://partners-api.astropay.com`.
- **Auth:** Basic `base64(App ID:Secret Key)`.
- **Crear pago:** `POST /v1/payments` → `{ redirect_url, payment_external_id, status }`.
  Campos: `amount`, `currency:"ARS"`, `country:"AR"`, `merchant_payment_id` (= nuestro
  `pagos.id`), `redirect_success_url`, `redirect_error_url`, `user`,
  `requested_payment_method` (`CARD` = solo tarjeta, `null` = tarjeta + wallet).
- **Callback:** POST a la Callback URL con `merchant_payment_id`, `payment_status`
  (`COMPLETED`/`EXPIRED`/`REJECTED`) y `payment_info.payment_amount.value`.
- **Firma:** RSA sobre `requestId:timestamp:body`; headers `Partner-Signature`,
  `Partner-Request-ID`, `Partner-Request-Time`, `Partner-Certificate-Serial-Number`;
  certificados en `GET /v1/certificates`.

## Pasos de puesta en marcha

### 1. Crear la tabla `pagos`
En Supabase → SQL Editor, pegar y ejecutar `migrations/0001_pagos.sql`.

### 2. Credenciales de AstroPay (cuenta Business/Partners)
Necesitás una cuenta **AstroPay Business/Partners** (no la billetera personal).
Pedile a tu ejecutivo de cuenta / en el Partners dashboard:
- **App ID** y **Secret Key** (empezar con las de **sandbox**).
- Que **whitelisteen el dominio** de la app (sandbox y producción).
- Que configuren la **Callback URL** (ver paso 6).

### 3. Instalar y linkear la CLI de Supabase
```bash
npm i -g supabase
supabase login
supabase link --project-ref ylsakdugmhsddapodlfs
```

### 4. Cargar los secretos
```bash
supabase secrets set \
  ASTROPAY_APP_ID="tu_app_id" \
  ASTROPAY_SECRET_KEY="tu_secret_key" \
  ASTROPAY_ENV="sandbox" \
  APP_URL="https://TU-URL-PUBLICA-DE-LA-APP"
```
`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase solo.
En pruebas iniciales podés agregar `ASTROPAY_VERIFY_SIGNATURE="0"` para saltear la
verificación de firma; **en producción NO** (dejalo activado, que es el default).

### 5. Desplegar las funciones
```bash
supabase functions deploy crear-pago --no-verify-jwt
supabase functions deploy callback-astropay --no-verify-jwt
```

### 6. Configurar la Callback URL en AstroPay
Pedile a AstroPay que registre como Callback URL:
```
https://ylsakdugmhsddapodlfs.functions.supabase.co/callback-astropay
```

### 7. Probar (sandbox)
- Loguearse como propietario con deuda → "Pagar expensas online".
- Completar el pago en el checkout de sandbox de AstroPay.
- Verificar: en Supabase aparece la fila en `ingresos`, `pagos.estado='aprobado'`,
  y al volver al portal la deuda bajó.

Cuando funcione en sandbox, cambiar `ASTROPAY_ENV="production"` (y App ID/Secret Key
de producción) y volver a desplegar.

## Notas de seguridad
- El `ingreso` se crea SOLO en el callback, con el monto REAL informado por AstroPay.
  El navegador nunca inserta pagos → no se pueden falsificar.
- La firma del callback se valida con el certificado RSA de AstroPay
  (`GET /v1/certificates`). Confirmar en sandbox que el algoritmo es RSA-SHA256; si
  AstroPay usara otro hash, ajustar `verifyCallbackSignature` en `_shared/astropay.ts`.
- La tabla `pagos` tiene RLS: el cliente solo puede LEER estado por id; no escribe.
