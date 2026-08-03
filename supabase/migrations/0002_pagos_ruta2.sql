-- ============================================================
-- Ruta 2 — Pago de expensas por transferencia/QR directo a AstroPay
-- (semi-automático: el propietario marca "Ya pagué" y el admin confirma).
--
-- ESTA es la migración a correr para la versión que anda HOY, sin Edge
-- Functions ni cuenta AstroPay Business. Pegar TODO en Supabase → SQL Editor.
--
-- Todo el frontend (propietario y admin) escribe con la clave PUBLISHABLE,
-- así que estas tablas llevan RLS con políticas ABIERTAS, igual que el resto
-- de la app. (Cuando abran AstroPay Business se pasa a la Ruta 1 con Edge
-- Functions + service_role y se puede cerrar la RLS — ver 0001_pagos.sql.)
-- ============================================================

-- ------------------------------------------------------------
-- 1) config_pagos — una sola fila (id=1) con el destino de cobro.
--    La ve el propietario en su celular; la edita el admin en Configuración.
-- ------------------------------------------------------------
create table if not exists public.config_pagos (
  id            smallint primary key default 1,
  alias         text,
  titular       text,
  cbu           text,
  qr_url        text,                 -- URL o data URI (imagen del QR)
  instrucciones text,
  activo        boolean not null default true,
  updated_at    timestamptz not null default now(),
  constraint config_pagos_single_row check (id = 1)
);

alter table public.config_pagos enable row level security;
drop policy if exists config_pagos_all on public.config_pagos;
create policy config_pagos_all on public.config_pagos
  for all using (true) with check (true);

-- ------------------------------------------------------------
-- 2) pagos — cada aviso de pago del propietario (ciclo de vida del cobro).
--    Es DISTINTA de `ingresos` (la verdad contable). Al confirmar un pago,
--    el admin crea la fila en `ingresos` y la enlaza acá con `ingreso_id`.
-- ------------------------------------------------------------
create table if not exists public.pagos (
  id               text primary key,
  propietario_id   text not null,
  consorcio_id     text,
  monto            numeric not null check (monto > 0),
  periodo          text,                                 -- '2026-05' | 'varios'
  detalle_periodos text,                                 -- 'Mayo 2026, Junio 2026'
  estado           text not null default 'pendiente',    -- pendiente | confirmado | rechazado
  metodo           text default 'transferencia',
  proveedor        text default 'astropay',
  ingreso_id       text,                                 -- fila de ingresos creada al confirmar
  nota             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Columnas nuevas por si la tabla ya existía de una corrida anterior (0001).
alter table public.pagos add column if not exists detalle_periodos text;
alter table public.pagos add column if not exists metodo           text default 'transferencia';
alter table public.pagos add column if not exists proveedor        text default 'astropay';
alter table public.pagos add column if not exists nota             text;

create index if not exists pagos_propietario_idx on public.pagos (propietario_id);
create index if not exists pagos_estado_idx      on public.pagos (estado);

-- updated_at automático
create or replace function public.pagos_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists pagos_touch on public.pagos;
create trigger pagos_touch before update on public.pagos
  for each row execute function public.pagos_touch_updated_at();

alter table public.pagos enable row level security;
drop policy if exists pagos_all on public.pagos;
create policy pagos_all on public.pagos
  for all using (true) with check (true);
