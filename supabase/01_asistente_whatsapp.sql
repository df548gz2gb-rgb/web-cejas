-- ============================================================
-- ASISTENTE DE WHATSAPP — PREPARACIÓN DE LA BASE DE DATOS
-- Cómo usarlo: Supabase → SQL Editor → New query → pega TODO
-- este archivo → Run. Se puede ejecutar más de una vez sin
-- romper nada (no borra ni modifica tus datos actuales).
-- ============================================================


-- ------------------------------------------------------------
-- 1. Utilidades
-- ------------------------------------------------------------

-- Deja un teléfono siempre igual: solo dígitos, con prefijo 34.
-- "612 34 56 78", "+34612345678" y "0034612345678" → "34612345678"
create or replace function public.wa_norm_phone(p text)
returns text language sql immutable as $$
  select case
    when d = '' then null
    when length(d) = 9 then '34' || d
    when d like '00%' then substr(d, 3)
    else d
  end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

-- Fecha y hora actuales en Valencia.
create or replace function public.ahora_madrid()
returns timestamp language sql stable as $$
  select (now() at time zone 'Europe/Madrid')
$$;


-- ------------------------------------------------------------
-- 2. Ficha de clienta: dos campos nuevos
-- ------------------------------------------------------------
alter table public.clients add column if not exists micro_conmigo boolean;       -- null = sin verificar
alter table public.clients add column if not exists fecha_ultima_micro date;


-- ------------------------------------------------------------
-- 3. Agenda: franjas fijas y días bloqueados
-- ------------------------------------------------------------
-- tipo 'micro' = micropigmentación · tipo 'corto' = retoque o removedor
create table if not exists public.agenda_franjas (
  id          bigint generated always as identity primary key,
  dia_semana  int  not null check (dia_semana between 1 and 7),  -- 1 = lunes … 7 = domingo
  hora_inicio time not null,
  hora_fin    time not null,
  tipo        text not null check (tipo in ('micro','corto')),
  activa      boolean not null default true,
  unique (dia_semana, hora_inicio, tipo)
);

insert into public.agenda_franjas (dia_semana, hora_inicio, hora_fin, tipo) values
  -- Lunes
  (1, '18:45', '19:15', 'corto'),
  (1, '19:15', '20:45', 'micro'),
  -- Miércoles
  (3, '18:45', '19:15', 'corto'),
  (3, '19:15', '20:45', 'micro'),
  -- Sábado
  (6, '09:30', '11:00', 'micro'),
  (6, '11:00', '12:30', 'micro'),
  (6, '12:30', '13:15', 'corto'),
  (6, '13:15', '14:00', 'corto'),
  (6, '16:00', '17:30', 'micro'),
  (6, '17:30', '19:00', 'micro'),
  (6, '19:00', '20:30', 'micro')
on conflict (dia_semana, hora_inicio, tipo) do nothing;

-- Días (o tramos) en los que no trabajas: vacaciones, festivos…
-- Sin hora = el día entero.
create table if not exists public.agenda_bloqueos (
  id          bigint generated always as identity primary key,
  fecha       date not null,
  hora_inicio time,
  hora_fin    time,
  nota        text,
  created_at  timestamptz not null default now()
);

-- Ajustes que puedes cambiar desde Supabase → Table Editor → bot_ajustes
create table if not exists public.bot_ajustes (
  clave text primary key,
  valor text not null,
  descripcion text
);
insert into public.bot_ajustes (clave, valor, descripcion) values
  ('antelacion_horas', '12', 'Horas mínimas de antelación para reservar o cambiar una cita por WhatsApp'),
  ('dias_vista', '45', 'Hasta cuántos días en adelante se ofrecen huecos'),
  ('dias_reactivar', '7', 'Días sin mensajes tras los que el asistente vuelve a atender un chat que tú habías atendido'),
  ('direccion', '', 'Dirección del estudio (se envía al confirmar la cita). Déjalo vacío para no enviarla'),
  ('info_extra', '', 'Información extra que el asistente puede usar al responder dudas (cuidados, formas de pago, etc.)')
on conflict (clave) do nothing;


-- ------------------------------------------------------------
-- 4. Conversaciones de WhatsApp
-- ------------------------------------------------------------
create table if not exists public.wa_conversaciones (
  telefono            text primary key,          -- normalizado: 34XXXXXXXXX
  nombre_perfil       text,                      -- nombre que tiene en WhatsApp
  estado              text not null default 'inicio',
  datos               jsonb not null default '{}'::jsonb,
  historial           jsonb not null default '[]'::jsonb,  -- últimos mensajes (contexto para la IA)
  atendida_por_noemi  boolean not null default false,       -- true = el asistente NO responde
  motivo_derivacion   text,
  derivada_at         timestamptz,
  ultimo_mensaje_at   timestamptz,
  usos_ia_dia         int not null default 0,
  usos_ia_fecha       date,
  updated_at          timestamptz not null default now()
);

-- Para no procesar dos veces el mismo mensaje si WhatsApp lo reenvía
create table if not exists public.wa_mensajes_procesados (
  id         text primary key,
  created_at timestamptz not null default now()
);

-- Para saber si hay "ventana abierta" con tu WhatsApp personal (avisos gratis)
create table if not exists public.wa_estado (
  clave text primary key,
  valor text,
  updated_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- 5. Seguridad: nadie de fuera puede leer ni tocar estas tablas.
--    Solo tú (con sesión iniciada en el panel) y el asistente.
-- ------------------------------------------------------------
alter table public.agenda_franjas         enable row level security;
alter table public.agenda_bloqueos        enable row level security;
alter table public.bot_ajustes            enable row level security;
alter table public.wa_conversaciones      enable row level security;
alter table public.wa_mensajes_procesados enable row level security;
alter table public.wa_estado              enable row level security;

drop policy if exists "panel lee franjas" on public.agenda_franjas;
create policy "panel lee franjas" on public.agenda_franjas for select to authenticated using (true);
drop policy if exists "panel lee bloqueos" on public.agenda_bloqueos;
create policy "panel lee bloqueos" on public.agenda_bloqueos for select to authenticated using (true);
drop policy if exists "panel lee conversaciones" on public.wa_conversaciones;
create policy "panel lee conversaciones" on public.wa_conversaciones for select to authenticated using (true);
drop policy if exists "panel lee ajustes" on public.bot_ajustes;
create policy "panel lee ajustes" on public.bot_ajustes for select to authenticated using (true);


-- ------------------------------------------------------------
-- 6. Lógica de la agenda (la usa el asistente)
-- ------------------------------------------------------------

-- Minutos que ocupa una cita puesta a mano a una hora que no coincide
-- con ninguna franja (mismos valores que el panel).
create or replace function public.duracion_categoria(p_cat text)
returns int language sql immutable as $$
  select case coalesce(p_cat, 'otro')
    when 'polvo' then 90 when 'hibrida' then 120 when 'pelo_a_pelo' then 120
    when 'neutralizacion' then 120 when 'combo' then 90 when 'retoque' then 45
    when 'removedor' then 30 when 'diseno' then 35 else 60 end
$$;

-- ¿Está ocupada esta franja? Una cita que empieza justo al inicio de una
-- franja ocupa exactamente esa franja. Una cita puesta a otra hora ocupa
-- todo lo que pise según su duración. Los bloqueos también cuentan.
create or replace function public.franja_ocupada(p_fecha date, p_ini time, p_fin time, p_excluir_cita text default null)
returns boolean language sql stable security definer set search_path = public as $$
  select
    exists (
      select 1 from agenda_bloqueos b
      where b.fecha = p_fecha
        and (b.hora_inicio is null
             or (b.hora_inicio < p_fin and coalesce(b.hora_fin, '23:59:59'::time) > p_ini))
    )
    or exists (
      select 1
      from appointments a
      left join lateral (
        select g.hora_inicio from agenda_franjas g
        where g.activa
          and g.dia_semana = extract(isodow from p_fecha)
          and g.hora_inicio = a.time::time
        limit 1
      ) dentro on true
      where a.date::date = p_fecha
        and (p_excluir_cita is null or a.id::text <> p_excluir_cita)
        and case
              when dentro.hora_inicio is not null then dentro.hora_inicio = p_ini
              else a.time::time < p_fin
                   and (p_fecha + a.time::time + make_interval(mins => duracion_categoria(a.category))) > (p_fecha + p_ini)
            end
    )
$$;

-- Huecos libres de un tipo ('micro' o 'corto') entre dos fechas.
create or replace function public.bot_huecos_libres(p_tipo text, p_desde date, p_hasta date, p_excluir_cita text default null)
returns table (fecha date, hora_inicio time, hora_fin time)
language sql stable security definer set search_path = public as $$
  select d::date, f.hora_inicio, f.hora_fin
  from generate_series(p_desde, p_hasta, interval '1 day') d
  join agenda_franjas f
    on f.activa and f.tipo = p_tipo and f.dia_semana = extract(isodow from d)
  where (d::date + f.hora_inicio) >
        ahora_madrid() + make_interval(hours => coalesce((select valor::int from bot_ajustes where clave = 'antelacion_horas'), 12))
    and not franja_ocupada(d::date, f.hora_inicio, f.hora_fin, p_excluir_cita)
  order by 1, 2
$$;

-- Lo que sabe la base de datos de un teléfono.
-- verificada = tiene una micropigmentación ya realizada en tu calendario,
--              o tú has marcado en su ficha "micro conmigo = sí".
drop function if exists public.bot_ficha(text);
create or replace function public.bot_ficha(p_telefono text)
returns table (nombre text, verificada boolean, ultima_micro date, tiene_ficha boolean)
language sql stable security definer set search_path = public as $$
  with tel as (select wa_norm_phone(p_telefono) t),
  c as (
    select cl.name, cl.micro_conmigo, cl.fecha_ultima_micro
    from clients cl, tel
    where wa_norm_phone(cl.phone) = tel.t
    order by (cl.micro_conmigo is true) desc, cl.created_at desc
    limit 1
  ),
  m as (
    select max(a.date::date) as d
    from appointments a, tel
    where wa_norm_phone(a.phone) = tel.t
      and a.category in ('polvo','hibrida','pelo_a_pelo','neutralizacion','combo')
      and a.date::date < ahora_madrid()::date
  ),
  ult as (
    select a.client_name from appointments a, tel
    where wa_norm_phone(a.phone) = tel.t
    order by a.date::date desc limit 1
  )
  select
    coalesce((select name from c), (select client_name from ult)),
    ((select d from m) is not null or coalesce((select micro_conmigo from c), false)),
    case when coalesce((select micro_conmigo from c), false) or (select d from m) is not null
         then greatest((select d from m), (select fecha_ultima_micro from c)) end,
    exists (select 1 from c)
$$;

-- Próximas citas de un teléfono.
create or replace function public.bot_citas_futuras(p_telefono text)
returns table (id text, fecha date, hora time, categoria text, nombre text)
language sql stable security definer set search_path = public as $$
  select a.id::text, a.date::date, a.time::time, coalesce(a.category, 'otro'), a.client_name
  from appointments a
  where wa_norm_phone(a.phone) = wa_norm_phone(p_telefono)
    and (a.date::date + a.time::time) > ahora_madrid()
  order by 2, 3
$$;

-- Reservar (con bloqueo para que dos reservas simultáneas no cojan el mismo hueco).
create or replace function public.bot_reservar(
  p_tipo text, p_fecha date, p_hora time, p_nombre text, p_telefono text, p_categoria text, p_nota text)
returns text language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  perform pg_advisory_xact_lock(hashtext('agenda'));
  if not exists (select 1 from bot_huecos_libres(p_tipo, p_fecha, p_fecha) h where h.hora_inicio = p_hora) then
    raise exception 'HUECO_OCUPADO';
  end if;
  insert into appointments (date, time, client_name, phone, note, category)
  values (p_fecha, p_hora, p_nombre, '+' || wa_norm_phone(p_telefono), p_nota, p_categoria)
  returning id::text into v_id;
  return v_id;
end $$;

-- Cambiar de día/hora una cita existente (la misma cita, sin duplicar).
create or replace function public.bot_mover_cita(
  p_id text, p_telefono text, p_tipo text, p_fecha date, p_hora time)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('agenda'));
  if not exists (select 1 from appointments a where a.id::text = p_id
                 and wa_norm_phone(a.phone) = wa_norm_phone(p_telefono)) then
    raise exception 'CITA_NO_ENCONTRADA';
  end if;
  if not exists (select 1 from bot_huecos_libres(p_tipo, p_fecha, p_fecha, p_id) h where h.hora_inicio = p_hora) then
    raise exception 'HUECO_OCUPADO';
  end if;
  update appointments set date = p_fecha, time = p_hora,
         note = trim(coalesce(note, '') || ' · cambiada por WhatsApp')
  where id::text = p_id;
end $$;

-- Cancelar una cita (solo si el teléfono coincide).
create or replace function public.bot_cancelar_cita(p_id text, p_telefono text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from appointments a
  where a.id::text = p_id and wa_norm_phone(a.phone) = wa_norm_phone(p_telefono);
  if not found then raise exception 'CITA_NO_ENCONTRADA'; end if;
end $$;

-- Las funciones del asistente solo las puede usar el asistente.
revoke execute on function public.franja_ocupada(date, time, time, text) from public, anon, authenticated;
revoke execute on function public.bot_huecos_libres(text, date, date, text) from public, anon, authenticated;
revoke execute on function public.bot_ficha(text) from public, anon, authenticated;
revoke execute on function public.bot_citas_futuras(text) from public, anon, authenticated;
revoke execute on function public.bot_reservar(text, date, time, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.bot_mover_cita(text, text, text, date, time) from public, anon, authenticated;
revoke execute on function public.bot_cancelar_cita(text, text) from public, anon, authenticated;
grant execute on function public.franja_ocupada(date, time, time, text) to service_role;
grant execute on function public.bot_huecos_libres(text, date, date, text) to service_role;
grant execute on function public.bot_ficha(text) to service_role;
grant execute on function public.bot_citas_futuras(text) to service_role;
grant execute on function public.bot_reservar(text, date, time, text, text, text, text) to service_role;
grant execute on function public.bot_mover_cita(text, text, text, date, time) to service_role;
grant execute on function public.bot_cancelar_cita(text, text) to service_role;


-- ------------------------------------------------------------
-- 7. Funciones del panel (solo con tu sesión iniciada)
-- ------------------------------------------------------------
create or replace function public.rpc_update_client_micro(p_id text, p_micro boolean, p_fecha date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NO_AUTORIZADO'; end if;
  update clients set micro_conmigo = p_micro, fecha_ultima_micro = p_fecha where id::text = p_id;
end $$;

create or replace function public.rpc_wa_set_atendida(p_telefono text, p_atendida boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NO_AUTORIZADO'; end if;
  insert into wa_conversaciones (telefono, atendida_por_noemi, estado, datos, updated_at)
  values (wa_norm_phone(p_telefono), p_atendida, 'inicio', '{}'::jsonb, now())
  on conflict (telefono) do update
    set atendida_por_noemi = excluded.atendida_por_noemi,
        estado = 'inicio', datos = '{}'::jsonb,
        motivo_derivacion = case when excluded.atendida_por_noemi then wa_conversaciones.motivo_derivacion end,
        updated_at = now();
end $$;

create or replace function public.rpc_add_bloqueo(p_fecha date, p_hora_inicio time, p_hora_fin time, p_nota text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NO_AUTORIZADO'; end if;
  insert into agenda_bloqueos (fecha, hora_inicio, hora_fin, nota) values (p_fecha, p_hora_inicio, p_hora_fin, p_nota);
end $$;

create or replace function public.rpc_remove_bloqueo(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NO_AUTORIZADO'; end if;
  delete from agenda_bloqueos where id = p_id;
end $$;

revoke execute on function public.rpc_update_client_micro(text, boolean, date) from public, anon;
revoke execute on function public.rpc_wa_set_atendida(text, boolean) from public, anon;
revoke execute on function public.rpc_add_bloqueo(date, time, time, text) from public, anon;
revoke execute on function public.rpc_remove_bloqueo(bigint) from public, anon;
grant execute on function public.rpc_update_client_micro(text, boolean, date) to authenticated;
grant execute on function public.rpc_wa_set_atendida(text, boolean) to authenticated;
grant execute on function public.rpc_add_bloqueo(date, time, time, text) to authenticated;
grant execute on function public.rpc_remove_bloqueo(bigint) to authenticated;

-- Fin. Si ves "Success. No rows returned", todo ha ido bien.
