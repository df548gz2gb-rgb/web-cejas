-- ============================================================
-- ASISTENTE DE WHATSAPP — añadido a la base de datos de GESTIÓN
-- (proyecto Supabase de webnoemi.netlify.app/gestion).
--
-- Cómo usarlo: Supabase → SQL Editor → New query → pega TODO
-- este archivo → Run. Se puede ejecutar más de una vez. No
-- modifica ni borra nada de lo que ya tienes: solo añade.
--
-- El asistente NO tiene agenda propia: usa tus "Reservas online"
-- (huecos de time_slots, servicios, señal, cancelaciones…) con
-- las mismas reglas que la página /reservas/.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Ajustes del asistente (editables en Table Editor → bot_ajustes)
-- ------------------------------------------------------------
create table if not exists bot_ajustes (
  clave text primary key,
  valor text not null,
  descripcion text
);
insert into bot_ajustes (clave, valor, descripcion) values
  ('web_reservas', 'https://webnoemi.netlify.app', 'Dirección de tu web (para los enlaces de pago, consentimiento y gestión de la cita)'),
  ('dias_vista', '45', 'Hasta cuántos días en adelante se ofrecen huecos'),
  ('dias_reactivar', '7', 'Días sin mensajes tras los que el asistente vuelve a atender un chat que tú habías atendido'),
  ('direccion', '', 'Dirección del estudio (se envía al confirmar la cita). Vacío = no se envía'),
  ('info_extra', '', 'Información extra para responder dudas (cuidados, formas de pago, etc.)')
on conflict (clave) do nothing;


-- ------------------------------------------------------------
-- 2. Conversaciones de WhatsApp
-- ------------------------------------------------------------
create table if not exists wa_conversaciones (
  telefono            text primary key,          -- como lo manda WhatsApp: 34XXXXXXXXX
  nombre_perfil       text,
  estado              text not null default 'inicio',
  datos               jsonb not null default '{}'::jsonb,
  historial           jsonb not null default '[]'::jsonb,
  atendida_por_noemi  boolean not null default false,  -- true = el asistente NO responde
  motivo_derivacion   text,
  derivada_at         timestamptz,
  ultimo_mensaje_at   timestamptz,
  usos_ia_dia         int not null default 0,
  usos_ia_fecha       date,
  updated_at          timestamptz not null default now()
);

create table if not exists wa_mensajes_procesados (
  id         text primary key,
  created_at timestamptz not null default now()
);

create table if not exists wa_estado (
  clave text primary key,
  valor text,
  updated_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- 3. Seguridad (mismo criterio que el resto de Gestión: solo tu
--    sesión puede verlas; el asistente entra con su clave de servicio)
-- ------------------------------------------------------------
alter table bot_ajustes            enable row level security;
alter table wa_conversaciones      enable row level security;
alter table wa_mensajes_procesados enable row level security;
alter table wa_estado              enable row level security;

drop policy if exists "auth_all_bot_ajustes" on bot_ajustes;
create policy "auth_all_bot_ajustes" on bot_ajustes for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
drop policy if exists "auth_all_wa_conversaciones" on wa_conversaciones;
create policy "auth_all_wa_conversaciones" on wa_conversaciones for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');


-- ------------------------------------------------------------
-- 4. Próximas citas de un teléfono (para "Cambiar o cancelar").
--    Solo la usa el asistente.
-- ------------------------------------------------------------
create or replace function bot_citas_futuras(p_telefono text)
returns table (
  id uuid, fecha date, hora time, servicio_nombre text, tipo_cita text,
  origen text, pago_estado text, management_token uuid, cliente_nombre text
)
language sql stable security definer set search_path = public as $$
  select a.id, a.fecha, a.hora, a.servicio_nombre, a.tipo_cita,
         a.origen, a.pago_estado, a.management_token, a.cliente_nombre
  from appointments a
  left join clients c on c.id = a.client_id
  where a.estado <> 'Cancelada'
    and (a.fecha + a.hora) > now_local()
    and (normalize_phone(a.cliente_telefono) = normalize_phone(p_telefono)
         or normalize_phone(c.telefono) = normalize_phone(p_telefono))
    -- reservas online sin pagar y ya caducadas no cuentan
    and not (a.origen = 'online' and a.pago_estado = 'Pendiente de verificar'
             and a.reservado_hasta is not null and a.reservado_hasta < now_local())
  order by a.fecha, a.hora
$$;
revoke execute on function bot_citas_futuras(text) from public, anon, authenticated;
grant execute on function bot_citas_futuras(text) to service_role;


-- ------------------------------------------------------------
-- 5. Botón "Devolver al asistente" / "Pausar" desde Gestión
-- ------------------------------------------------------------
create or replace function rpc_wa_set_atendida(p_telefono text, p_atendida boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'authenticated' then raise exception 'NO_AUTORIZADO'; end if;
  insert into wa_conversaciones (telefono, atendida_por_noemi, estado, datos, updated_at)
  values (regexp_replace(p_telefono, '\D', '', 'g'), p_atendida, 'inicio', '{}'::jsonb, now())
  on conflict (telefono) do update
    set atendida_por_noemi = excluded.atendida_por_noemi,
        estado = 'inicio', datos = '{}'::jsonb,
        motivo_derivacion = case when excluded.atendida_por_noemi then wa_conversaciones.motivo_derivacion end,
        updated_at = now();
end $$;
revoke execute on function rpc_wa_set_atendida(text, boolean) from public, anon;
grant execute on function rpc_wa_set_atendida(text, boolean) to authenticated;

-- Fin. Si ves "Success. No rows returned", todo ha ido bien.
