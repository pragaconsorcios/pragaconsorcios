-- ============================================================
-- Tabla `pagos` — ciclo de vida del checkout online (Mercado Pago)
-- Es DISTINTA de `ingresos` (la verdad contable). Una fila de `pagos`
-- representa un intento de pago; cuando MP confirma via webhook se crea
-- la fila en `ingresos` y se enlaza con `ingreso_id`.
-- ============================================================

create table if not exists public.pagos (
  id                text primary key,
  propietario_id    text not null,
  consorcio_id      text,
  monto             numeric not null check (monto > 0),
  periodo           text,                                   -- ej '2026-08'
  estado            text not null default 'pendiente',      -- pendiente | aprobado | rechazado | cancelado
  proveedor         text not null default 'astropay',
  mp_preference_id  text,
  mp_payment_id     text,
  ingreso_id        text,                                   -- fila de ingresos creada (idempotencia)
  detalle           jsonb,                                  -- payload crudo del proveedor (auditoria)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists pagos_propietario_idx on public.pagos (propietario_id);
create index if not exists pagos_estado_idx      on public.pagos (estado);
create index if not exists pagos_pref_idx        on public.pagos (mp_preference_id);

-- updated_at automatico
create or replace function public.pagos_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists pagos_touch on public.pagos;
create trigger pagos_touch before update on public.pagos
  for each row execute function public.pagos_touch_updated_at();

-- ------------------------------------------------------------
-- RLS: la tabla `pagos` la manejan SOLO las Edge Functions
-- (con service_role, que saltea RLS). El navegador NO escribe aca.
-- Dejamos habilitado RLS sin policies -> la clave publica no puede
-- insertar/leer/modificar pagos directamente.
-- ------------------------------------------------------------
alter table public.pagos enable row level security;

-- Lectura acotada para el portal (opcional): permite que el frontend
-- consulte el estado de UN pago por id al volver del checkout.
-- Si preferis cero acceso desde el cliente, borra esta policy y hace
-- el polling del estado tambien via Edge Function.
create policy pagos_select_publica on public.pagos
  for select
  using (true);
