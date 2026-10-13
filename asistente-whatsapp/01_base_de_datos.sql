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

-- ------------------------------------------------------------
-- 6. Reservas por WhatsApp SIN SEÑAL
--
--    Las citas que reserva el asistente se guardan como reserva
--    online con pago "No requerido": quedan confirmadas al momento
--    y no caducan a los 15 minutos. Para que tu web de reservas las
--    respete igual que una cita pagada, se actualizan estas tres
--    funciones que ya tenías. El único cambio en cada una es que
--    "No requerido" cuenta igual que "Confirmado".
--
--    Además, en rpc_create_booking una cita puesta A MANO enlazada
--    a un hueco ya no se puede anular por error. Antes, si alguien
--    tenía la página de reservas abierta desde antes y reservaba ese
--    hueco, la cita manual se cancelaba como "expirada".
-- ------------------------------------------------------------

create or replace function hueco_ocupado(p_fecha date, p_hora time, p_excluir_appointment_id uuid default null)
returns boolean
language sql stable as $$
  select exists (
    select 1 from appointments a
    where a.fecha = p_fecha
      and a.estado <> 'Cancelada'
      and (p_excluir_appointment_id is null or a.id <> p_excluir_appointment_id)
      and (a.origen = 'manual' or a.pago_estado in ('Confirmado','No requerido')
           or (a.reservado_hasta is not null and a.reservado_hasta >= now_local()))
      and (p_fecha + p_hora) < ((a.fecha + a.hora) + make_interval(mins => coalesce(a.duracion_min, 60)))
      and (a.fecha + a.hora) < ((p_fecha + p_hora) + interval '15 minutes')
  );
$$;

create or replace function rpc_check_client(p_telefono text)
returns table(existe boolean, puede_retoque boolean, nombre text, tiene_cita_activa boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_client_id uuid;
  v_nombre text;
  v_retoque boolean;
  v_activa boolean;
  v_norm text := normalize_phone(p_telefono);
begin
  if v_norm = '' then
    return query select false, false, null::text, false;
    return;
  end if;

  select c.id, c.nombre into v_client_id, v_nombre
  from clients c
  where normalize_phone(c.telefono) = v_norm
  order by c.created_at asc
  limit 1;

  if v_client_id is null then
    return query select false, false, null::text, false;
    return;
  end if;

  select exists(
    select 1 from appointments a
    where a.client_id = v_client_id
      and a.estado = 'Cobrada'
      and a.es_micropigmentacion = true
  ) into v_retoque;

  -- Una misma persona no puede tener más de una cita online activa
  -- a la vez (evita que acapare huecos "para amigas" con su propio
  -- teléfono: cada persona debe reservar con el suyo).
  select exists(
    select 1 from appointments a
    where a.client_id = v_client_id
      and a.origen = 'online'
      and a.estado <> 'Cancelada'
      and (a.fecha + a.hora) > now_local()
      and (a.pago_estado in ('Confirmado','No requerido') or a.reservado_hasta >= now_local())
  ) into v_activa;

  return query select true, coalesce(v_retoque, false), v_nombre, coalesce(v_activa, false);
end;
$$;

create or replace function rpc_create_booking(
  p_telefono text,
  p_nombre text,
  p_email text,
  p_service_id uuid,
  p_tipo_cita text,
  p_slot_id uuid,
  p_notas text
)
returns table(appointment_id uuid, management_token uuid, deposito_importe numeric, bizum_telefono text, bizum_instrucciones text)
language plpgsql security definer set search_path = public as $$
declare
  v_settings booking_settings%rowtype;
  v_slot time_slots%rowtype;
  v_old_appt appointments%rowtype;
  v_service services%rowtype;
  v_client_id uuid;
  v_nombre_actual text;
  v_puede_retoque boolean;
  v_norm text := normalize_phone(p_telefono);
  v_new_id uuid;
begin
  if v_norm = '' or length(v_norm) < 9 then
    raise exception 'Indica un teléfono válido.';
  end if;
  if p_tipo_cita not in ('primera','retoque') then
    raise exception 'Tipo de cita no válido.';
  end if;

  select * into v_settings from booking_settings where id = true;
  if not found or not v_settings.agenda_online_abierta then
    raise exception 'La agenda online está cerrada en este momento.';
  end if;

  select * into v_slot from time_slots where id = p_slot_id for update;
  if not found or v_slot.estado <> 'abierto' or v_slot.tipo not in (p_tipo_cita, 'ambos') then
    raise exception 'Este hueco ya no está disponible.';
  end if;
  if (v_slot.fecha + v_slot.hora) <= (now_local() + make_interval(mins => v_settings.antelacion_minima_min)) then
    raise exception 'No se puede reservar con tan poca antelación.';
  end if;

  if v_slot.appointment_id is not null then
    select * into v_old_appt from appointments where id = v_slot.appointment_id;
    if v_old_appt.estado <> 'Cancelada' and (v_old_appt.origen = 'manual' or v_old_appt.pago_estado in ('Confirmado','No requerido') or v_old_appt.reservado_hasta >= now_local()) then
      raise exception 'Este hueco ya no está disponible.';
    end if;
    if v_old_appt.estado <> 'Cancelada' then
      update appointments set estado = 'Cancelada',
             notas = coalesce(notas,'') || E'\n[Expirada automáticamente: no se confirmó el pago a tiempo]'
        where id = v_old_appt.id;
      insert into appointment_history(appointment_id, tipo, detalle)
        values (v_old_appt.id, 'expirada_sin_pago', jsonb_build_object('en', now()));
    end if;
  end if;

  -- Comprobación de verdad: ¿hay alguna cita real (manual u online,
  -- enlazada a este hueco o no) que ocupe ya esta franja?
  if hueco_ocupado(v_slot.fecha, v_slot.hora) then
    raise exception 'Este hueco ya no está disponible.';
  end if;

  select * into v_service from services where id = p_service_id and activo = true;
  if not found then
    raise exception 'Este servicio no está disponible actualmente.';
  end if;

  select c.id, c.nombre into v_client_id, v_nombre_actual
    from clients c where normalize_phone(c.telefono) = v_norm
    order by c.created_at asc limit 1;

  if v_client_id is not null and exists (
    select 1 from appointments a
    where a.client_id = v_client_id
      and a.origen = 'online'
      and a.estado <> 'Cancelada'
      and (a.fecha + a.hora) > now_local()
      and (a.pago_estado in ('Confirmado','No requerido') or a.reservado_hasta >= now_local())
  ) then
    raise exception 'YA_TIENES_CITA_ACTIVA';
  end if;

  if v_client_id is not null then
    select exists(
      select 1 from appointments a
      where a.client_id = v_client_id and a.estado = 'Cobrada' and a.es_micropigmentacion = true
    ) into v_puede_retoque;
  else
    v_puede_retoque := false;
  end if;

  if p_tipo_cita = 'retoque' and not coalesce(v_puede_retoque, false) then
    raise exception 'RETOQUE_NO_VERIFICADO';
  end if;

  if v_client_id is null then
    insert into clients (nombre, telefono, email) values (p_nombre, p_telefono, coalesce(p_email,''))
      returning id into v_client_id;
  elsif p_nombre is not null and trim(p_nombre) <> '' and trim(p_nombre) <> trim(v_nombre_actual) then
    update clients set nombre = trim(p_nombre), updated_at = now() where id = v_client_id;
  end if;

  insert into appointments (
    fecha, hora, client_id, cliente_nombre, cliente_telefono,
    service_id, servicio_nombre, precio, duracion_min, es_micropigmentacion,
    metodo_pago, estado, origen, tipo_cita, pago_estado,
    deposito_importe, deposito_metodo, reservado_hasta, notas
  ) values (
    v_slot.fecha, v_slot.hora, v_client_id, trim(p_nombre), p_telefono,
    v_service.id, v_service.nombre, v_service.precio, v_service.duracion_min, v_service.es_micropigmentacion,
    'Efectivo', 'Pendiente', 'online', p_tipo_cita, 'Pendiente de verificar',
    v_settings.deposito_importe, 'Bizum', now_local() + interval '15 minutes', coalesce(p_notas,'')
  ) returning id into v_new_id;

  update time_slots set appointment_id = v_new_id where id = v_slot.id;

  insert into appointment_history(appointment_id, tipo, detalle)
    values (v_new_id, 'creada_online', jsonb_build_object('tipo_cita', p_tipo_cita, 'servicio', v_service.nombre));

  return query
    select a.id, a.management_token, v_settings.deposito_importe, v_settings.bizum_telefono, v_settings.bizum_instrucciones
    from appointments a where a.id = v_new_id;
end;
$$;

-- Reserva desde WhatsApp: mismas comprobaciones que la web
-- (agenda abierta, hueco libre, antelación, retoque verificado,
-- una reserva activa por persona), pero sin señal.
create or replace function bot_reservar(
  p_telefono text, p_nombre text, p_service_id uuid, p_tipo_cita text, p_slot_id uuid
)
returns table(appointment_id uuid, management_token uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_settings booking_settings%rowtype;
  v_slot time_slots%rowtype;
  v_service services%rowtype;
  v_client_id uuid;
  v_nombre_actual text;
  v_norm text := normalize_phone(p_telefono);
  v_new_id uuid;
begin
  if v_norm = '' or length(v_norm) < 9 then raise exception 'Indica un teléfono válido.'; end if;
  if p_tipo_cita not in ('primera','retoque') then raise exception 'Tipo de cita no válido.'; end if;

  select * into v_settings from booking_settings where id = true;
  if not found or not v_settings.agenda_online_abierta then
    raise exception 'La agenda online está cerrada en este momento.';
  end if;

  select * into v_slot from time_slots where id = p_slot_id for update;
  if not found or v_slot.estado <> 'abierto' or v_slot.tipo not in (p_tipo_cita, 'ambos') then
    raise exception 'Este hueco ya no está disponible.';
  end if;
  if (v_slot.fecha + v_slot.hora) <= (now_local() + make_interval(mins => v_settings.antelacion_minima_min)) then
    raise exception 'No se puede reservar con tan poca antelación.';
  end if;
  if hueco_ocupado(v_slot.fecha, v_slot.hora) then
    raise exception 'Este hueco ya no está disponible.';
  end if;

  select * into v_service from services where id = p_service_id and activo = true;
  if not found then raise exception 'Este servicio no está disponible actualmente.'; end if;

  select c.id, c.nombre into v_client_id, v_nombre_actual
    from clients c where normalize_phone(c.telefono) = v_norm
    order by c.created_at asc limit 1;

  if v_client_id is not null and exists (
    select 1 from appointments a
    where a.client_id = v_client_id and a.origen = 'online' and a.estado <> 'Cancelada'
      and (a.fecha + a.hora) > now_local()
      and (a.pago_estado in ('Confirmado','No requerido') or a.reservado_hasta >= now_local())
  ) then
    raise exception 'YA_TIENES_CITA_ACTIVA';
  end if;

  if p_tipo_cita = 'retoque' and not exists (
    select 1 from appointments a
    where a.client_id = v_client_id and a.estado = 'Cobrada' and a.es_micropigmentacion = true
  ) then
    raise exception 'RETOQUE_NO_VERIFICADO';
  end if;

  if v_client_id is null then
    insert into clients (nombre, telefono) values (trim(p_nombre), p_telefono) returning id into v_client_id;
  end if;

  insert into appointments (
    fecha, hora, client_id, cliente_nombre, cliente_telefono,
    service_id, servicio_nombre, precio, duracion_min, es_micropigmentacion,
    metodo_pago, estado, origen, tipo_cita, pago_estado, notas
  ) values (
    v_slot.fecha, v_slot.hora, v_client_id, trim(p_nombre), p_telefono,
    v_service.id, v_service.nombre, v_service.precio, v_service.duracion_min, v_service.es_micropigmentacion,
    'Efectivo', 'Pendiente', 'online', p_tipo_cita, 'No requerido', 'Reservada por WhatsApp (sin señal)'
  ) returning id into v_new_id;

  update time_slots set appointment_id = v_new_id where id = v_slot.id;

  insert into appointment_history(appointment_id, tipo, detalle)
    values (v_new_id, 'creada_whatsapp', jsonb_build_object('tipo_cita', p_tipo_cita, 'servicio', v_service.nombre));

  return query select a.id, a.management_token from appointments a where a.id = v_new_id;
end;
$$;
revoke execute on function bot_reservar(text, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function bot_reservar(text, text, uuid, text, uuid) to service_role;

-- Fin. Si ves "Success. No rows returned", todo ha ido bien.
