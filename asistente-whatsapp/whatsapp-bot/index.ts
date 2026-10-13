// ============================================================
// ASISTENTE DE WHATSAPP — Noemi Cuesta Micropigmentación
// Supabase Edge Function "whatsapp-bot" del proyecto de GESTIÓN.
//
// Recibe los mensajes de WhatsApp, sigue el flujo con botones y
// reserva, cambia o cancela usando tus "Reservas online" (mismos
// huecos, servicios y reglas que la página /reservas/, pero sin señal).
// Los casos que debe ver Noemi se le pasan con un aviso a su
// WhatsApp personal y aparecen en Gestión → WhatsApp.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   WA_TOKEN, WA_PHONE_NUMBER_ID, WEBHOOK_KEY, ANTHROPIC_API_KEY,
//   NOEMI_WHATSAPP (34644737315)
// Opcionales: WA_VERIFY_TOKEN, MODO_PRUEBA, WA_API_URL,
//   WA_AUTH_HEADER, META_APP_SECRET, AVISO_PLANTILLA, AVISO_IDIOMA
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const WA_TOKEN = env("WA_TOKEN");
const WA_PHONE_NUMBER_ID = env("WA_PHONE_NUMBER_ID");
const WA_API_URL = env("WA_API_URL", `https://graph.facebook.com/v25.0/${WA_PHONE_NUMBER_ID}/messages`);
const WA_AUTH_HEADER = env("WA_AUTH_HEADER");
const WEBHOOK_KEY = env("WEBHOOK_KEY");
const WA_VERIFY_TOKEN = env("WA_VERIFY_TOKEN");
const META_APP_SECRET = env("META_APP_SECRET");
const NOEMI = soloDigitos(env("NOEMI_WHATSAPP", "34644737315"));
const AVISO_PLANTILLA = env("AVISO_PLANTILLA", "aviso_chat_pendiente");
const AVISO_IDIOMA = env("AVISO_IDIOMA", "es");
const MODO_PRUEBA = env("MODO_PRUEBA").split(",").map(soloDigitos).filter(Boolean);
const MODELO_IA = "claude-haiku-5-5";
const MAX_IA_DIA = 25;     // tope de consultas a la IA por clienta y día
const HORAS_SESION = 12;   // tras estas horas sin escribir, se empieza de cero

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const ia = env("ANTHROPIC_API_KEY") ? new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) : null;

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------
function soloDigitos(s: string) { return (s || "").replace(/\D/g, ""); }
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DIAS_C = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MESES_C = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function parseFecha(f: string) { const [y, m, d] = f.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function sumarDias(f: string, n: number) { const d = parseFecha(f); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fechaLarga(f: string) { const d = parseFecha(f); return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`; }
function fechaCorta(f: string) { const d = parseFecha(f); return `${DIAS_C[d.getUTCDay()]} ${d.getUTCDate()} ${MESES_C[d.getUTCMonth()]}`; }
function hhmm(t: string) { return (t || "").slice(0, 5); }
function euros(n: number | string | null | undefined) {
  const v = Number(n ?? 0);
  return (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(".", ",")) + " €";
}
function hoyMadrid() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function horasHasta(fecha: string, hora: string) {
  const ahora = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid", dateStyle: "short", timeStyle: "short" }).format(new Date());
  const a = new Date(ahora.replace(" ", "T") + ":00Z").getTime();
  const b = new Date(`${fecha}T${hhmm(hora)}:00Z`).getTime();
  return (b - a) / 3600000;
}
function limpiarParam(s: string) { return (s || "—").replace(/[\n\t]+/g, " ").replace(/ {4,}/g, " ").slice(0, 200); }
function primerNombre(n?: string | null) { return n ? String(n).trim().split(/\s+/)[0] : ""; }

// ------------------------------------------------------------
// Envío de mensajes de WhatsApp
// ------------------------------------------------------------
type Boton = { id: string; title: string };
type Fila = { id: string; title: string; description?: string };

async function enviarRaw(payload: Record<string, unknown>) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (WA_AUTH_HEADER) headers[WA_AUTH_HEADER] = WA_TOKEN;
  else headers["Authorization"] = `Bearer ${WA_TOKEN}`;
  const res = await fetch(WA_API_URL, {
    method: "POST", headers,
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { console.error("Error enviando WhatsApp", res.status, JSON.stringify(json)); return null; }
  const id = json?.messages?.[0]?.id as string | undefined;
  if (id) await db.from("wa_mensajes_procesados").insert({ id: "out:" + id }).then(() => {}, () => {});
  return id ?? "ok";
}
function texto(to: string, body: string) {
  return enviarRaw({ to, type: "text", text: { body, preview_url: true } });
}
function botones(to: string, body: string, bs: Boton[]) {
  return enviarRaw({
    to, type: "interactive",
    interactive: { type: "button", body: { text: body.slice(0, 1024) },
      action: { buttons: bs.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) } },
  });
}
function lista(to: string, body: string, boton: string, seccion: string, filas: Fila[]) {
  return enviarRaw({
    to, type: "interactive",
    interactive: { type: "list", body: { text: body.slice(0, 1024) },
      action: { button: boton.slice(0, 20), sections: [{ title: seccion.slice(0, 24),
        rows: filas.slice(0, 10).map((f) => ({ id: f.id, title: f.title.slice(0, 24), ...(f.description ? { description: f.description.slice(0, 72) } : {}) })) }] } },
  });
}

// ------------------------------------------------------------
// Conversación (estado guardado en la base de datos)
// ------------------------------------------------------------
type Conv = {
  telefono: string; nombre_perfil: string | null; estado: string;
  datos: Record<string, any>; historial: { r: string; t: string }[];
  atendida_por_noemi: boolean; motivo_derivacion: string | null;
  ultimo_mensaje_at: string | null; usos_ia_dia: number; usos_ia_fecha: string | null;
};

async function cargarConv(tel: string, perfil: string | null): Promise<Conv> {
  const { data } = await db.from("wa_conversaciones").select("*").eq("telefono", tel).maybeSingle();
  if (data) return { ...data, nombre_perfil: perfil || data.nombre_perfil } as Conv;
  return { telefono: tel, nombre_perfil: perfil, estado: "inicio", datos: {}, historial: [],
    atendida_por_noemi: false, motivo_derivacion: null, ultimo_mensaje_at: null, usos_ia_dia: 0, usos_ia_fecha: null };
}
async function guardarConv(c: Conv) {
  const { error } = await db.from("wa_conversaciones").upsert({
    telefono: c.telefono, nombre_perfil: c.nombre_perfil, estado: c.estado, datos: c.datos,
    historial: c.historial.slice(-12), atendida_por_noemi: c.atendida_por_noemi,
    motivo_derivacion: c.motivo_derivacion, ultimo_mensaje_at: c.ultimo_mensaje_at,
    usos_ia_dia: c.usos_ia_dia, usos_ia_fecha: c.usos_ia_fecha, updated_at: new Date().toISOString(),
  });
  if (error) console.error("guardarConv", error);
}
function anotar(c: Conv, r: "c" | "a", t: string) { c.historial.push({ r, t: t.slice(0, 500) }); }

// ------------------------------------------------------------
// Datos de Gestión (mismas funciones que usa la página /reservas/)
// ------------------------------------------------------------
async function ajustes(): Promise<Record<string, string>> {
  const { data } = await db.from("bot_ajustes").select("clave, valor");
  return Object.fromEntries((data ?? []).map((r: any) => [r.clave, r.valor]));
}
type InfoReservas = { agenda_online_abierta: boolean; antelacion_minima_min: number; cancelacion_limite_horas: number;
  deposito_importe: number; bizum_telefono: string; bizum_instrucciones: string };
async function infoReservas(): Promise<InfoReservas> {
  const { data, error } = await db.rpc("rpc_public_booking_info");
  if (error) console.error("rpc_public_booking_info", error);
  return (Array.isArray(data) ? data[0] : data) ?? { agenda_online_abierta: false, antelacion_minima_min: 90, cancelacion_limite_horas: 5,
    deposito_importe: 5, bizum_telefono: "", bizum_instrucciones: "" };
}
type Ficha = { existe: boolean; puede_retoque: boolean; nombre: string | null; tiene_cita_activa: boolean };
async function ficha(tel: string): Promise<Ficha> {
  const { data, error } = await db.rpc("rpc_check_client", { p_telefono: "+" + tel });
  if (error) console.error("rpc_check_client", error);
  const f = Array.isArray(data) ? data[0] : data;
  return { existe: !!f?.existe, puede_retoque: !!f?.puede_retoque, nombre: f?.nombre ?? null, tiene_cita_activa: !!f?.tiene_cita_activa };
}
type Servicio = { id: string; nombre: string; precio: number; duracion_min: number | null; descripcion: string };
async function serviciosOnline(tipo: "primera" | "retoque"): Promise<Servicio[]> {
  const { data, error } = await db.rpc("rpc_public_services", { p_tipo: tipo });
  if (error) console.error("rpc_public_services", error);
  return (data ?? []) as Servicio[];
}
async function textoPrecios(): Promise<string> {
  const { data } = await db.from("services").select("nombre, precio, duracion_min, descripcion").eq("activo", true).order("nombre");
  return (data ?? []).map((s: any) => `• ${s.nombre}: ${euros(s.precio)}${s.duracion_min ? ` (${s.duracion_min} min)` : ""}${s.descripcion ? ` — ${s.descripcion}` : ""}`).join("\n");
}

// ------------------------------------------------------------
// Avisos a Noemi
// ------------------------------------------------------------
async function avisarNoemi(c: Conv, motivo: string) {
  if (!NOEMI) return;
  const nombre = c.datos.nombre || c.nombre_perfil || "Sin nombre";
  const { data } = await db.from("wa_estado").select("valor").eq("clave", "ventana_noemi").maybeSingle();
  const ventanaAbierta = data?.valor && Date.now() - new Date(data.valor).getTime() < 23 * 3600 * 1000;
  if (ventanaAbierta) {
    await texto(NOEMI, `🔔 *Chat pendiente en WhatsApp Business*\n👤 ${nombre}\n📱 +${c.telefono}\n📝 ${motivo}`);
  } else {
    await enviarRaw({
      to: NOEMI, type: "template",
      template: { name: AVISO_PLANTILLA, language: { code: AVISO_IDIOMA },
        components: [{ type: "body", parameters: [nombre, "+" + c.telefono, motivo].map((t) => ({ type: "text", text: limpiarParam(t) })) }] },
    });
  }
}

async function derivar(c: Conv, mensajeClienta: string | null, motivo: string) {
  if (mensajeClienta) { await texto(c.telefono, mensajeClienta); anotar(c, "a", mensajeClienta); }
  c.atendida_por_noemi = true;
  c.motivo_derivacion = motivo;
  c.estado = "derivada";
  await guardarConv(c);
  await db.from("wa_conversaciones").update({ derivada_at: new Date().toISOString() }).eq("telefono", c.telefono);
  await avisarNoemi(c, motivo);
}

const MSG_FOTOS = "Para poder valorarlo bien, envíame por aquí *fotos de tus cejas* 📸\n\n• Mejor con la *cámara trasera*\n• Con *buena luz* (luz natural si puede ser)\n• De frente y sin maquillaje en las cejas\n\nNoemi las revisará y te escribirá personalmente 😊";

// ------------------------------------------------------------
// Pasos del flujo
// ------------------------------------------------------------
async function menuPrincipal(c: Conv, saludo = true) {
  c.estado = "menu"; c.datos = { nombre: c.datos.nombre };
  const body = saludo ? "¡Hola! 😊 Bienvenida. ¿En qué puedo ayudarte?" : "¿En qué más puedo ayudarte? 😊";
  await botones(c.telefono, body, [
    { id: "menu:reservar", title: "Reservar una cita" },
    { id: "menu:cambiar", title: "Cambiar o cancelar" },
    { id: "menu:info", title: "Info y precios" },
  ]);
  anotar(c, "a", body + " [Reservar una cita] [Cambiar o cancelar] [Info y precios]");
}

async function preguntarServicio(c: Conv, prefijo = "") {
  c.estado = "servicio";
  const body = `${prefijo}¿Qué servicio te interesa?`;
  await botones(c.telefono, body, [
    { id: "srv:micro", title: "Micropigmentación" },
    { id: "srv:retoque", title: "Retoque" },
    { id: "srv:removedor", title: "Removedor" },
  ]);
  anotar(c, "a", body + " [Micropigmentación] [Retoque] [Removedor]");
}

// Antes de reservar: ¿ya tiene una cita online activa? (regla de tu web: una a la vez)
async function yaTieneCita(c: Conv, f: Ficha) {
  if (!f.tiene_cita_activa) return false;
  c.estado = "cita_activa";
  const body = "Veo que ya tienes una cita reservada con nosotras 😊 Solo se puede tener una reserva online a la vez. ¿Quieres cambiarla o cancelarla?";
  await botones(c.telefono, body, [
    { id: "menu:cambiar", title: "Cambiar o cancelar" },
    { id: "hablar", title: "Hablar con Noemi" },
  ]);
  anotar(c, "a", body);
  return true;
}

async function elegirServicio(c: Conv, tipo: "primera" | "retoque", intro: string) {
  const info = await infoReservas();
  const servicios = await serviciosOnline(tipo);
  const etiquetaTipo = tipo === "retoque" ? "un retoque" : "una primera micropigmentación";
  if (!info.agenda_online_abierta || servicios.length === 0) {
    return derivar(c, "¡Genial! 😊 Ahora mismo Noemi está organizando la agenda personalmente, así que te escribirá por aquí para darte cita.",
      `Quiere ${etiquetaTipo} (la agenda online está cerrada o no hay servicios reservables)`);
  }
  c.datos = { ...c.datos, tipo, servicios: Object.fromEntries(servicios.map((s) => [s.id, { nombre: s.nombre, precio: s.precio }])) };
  c.estado = "eligiendo_servicio";
  await lista(c.telefono, intro, "Ver servicios", "Servicios", servicios.slice(0, 10).map((s) => ({
    id: "svc:" + s.id, title: s.nombre,
    description: [euros(s.precio), s.duracion_min ? `${s.duracion_min} min` : "", s.descripcion].filter(Boolean).join(" · "),
  })));
  anotar(c, "a", intro + " [lista de servicios]");
}

async function mostrarHuecos(c: Conv, desde?: string, intro?: string) {
  const aj = await ajustes();
  const hoy = hoyMadrid();
  const inicio = desde && desde > hoy ? desde : hoy;
  const hasta = sumarDias(hoy, Number(aj.dias_vista || 45));
  const { data, error } = await db.rpc("rpc_available_slots", { p_fecha_desde: inicio, p_fecha_hasta: hasta, p_tipo: c.datos.tipo });
  if (error) console.error("rpc_available_slots", error);
  const huecos = (data ?? []) as { id: string; fecha: string; hora: string }[];
  if (huecos.length === 0) {
    if (desde) {
      await botones(c.telefono, "No me quedan más huecos libres en las próximas semanas 🙈", [
        { id: "mas:" + hoy, title: "Ver desde el inicio" },
        { id: "hablar", title: "Hablar con Noemi" },
      ]);
      return;
    }
    return derivar(c, "Ahora mismo no me quedan huecos libres en las próximas semanas 🙈 Noemi te escribirá personalmente para buscarte uno 😊",
      `Quiere cita de ${c.datos.servicio_nombre || "micropigmentación"} y no hay huecos libres`);
  }
  c.estado = "eligiendo_hueco";
  const muestra = huecos.slice(0, 9);
  c.datos.huecos = Object.fromEntries(muestra.map((h) => [h.id, `${h.fecha}T${hhmm(h.hora)}`]));
  const filas: Fila[] = muestra.map((h) => ({ id: "slot:" + h.id, title: `${fechaCorta(h.fecha)} · ${hhmm(h.hora)}` }));
  if (huecos.length > 9) filas.push({ id: "mas:" + sumarDias(muestra[muestra.length - 1].fecha, 1), title: "Ver más fechas ➡️" });
  const body = (intro ? intro + "\n\n" : "") + `Estos son los próximos huecos libres para *${c.datos.servicio_nombre}*. Elige el que mejor te venga 👇`;
  await lista(c.telefono, body, "Ver horarios", "Huecos libres", filas);
  anotar(c, "a", body + " [lista de horarios]");
}

async function elegirHueco(c: Conv, slotId: string) {
  const fh = c.datos.huecos?.[slotId];
  if (!fh) return mostrarHuecos(c);
  c.datos.slot_id = slotId; c.datos.slot = fh;
  if (!c.datos.nombre) {
    c.estado = "pidiendo_nombre";
    const body = "¡Perfecto! ¿A nombre de quién hago la reserva? (nombre y apellido)";
    await texto(c.telefono, body); anotar(c, "a", body);
    return;
  }
  await pedirConfirmacion(c);
}

async function pedirConfirmacion(c: Conv) {
  const [f, h] = String(c.datos.slot).split("T");
  c.estado = "confirmando";
  let body: string;
  if (c.datos.mover_token) {
    body = `Te confirmo el cambio:\n\n✨ ${c.datos.servicio_nombre}\n📅 ${fechaLarga(f)}\n🕐 ${h} h\n\n¿Cambio tu cita a este día y hora?`;
  } else {
    body = `Te confirmo los datos:\n\n✨ ${c.datos.servicio_nombre}\n📅 ${fechaLarga(f)}\n🕐 ${h} h\n💶 ${euros(c.datos.precio)}\n👤 ${c.datos.nombre}\n\n¿Reservo la cita?`;
  }
  await botones(c.telefono, body, [
    { id: "ok:reservar", title: c.datos.mover_token ? "Sí, cambiarla" : "Sí, reservar" },
    { id: "otra:hora", title: "Elegir otra hora" },
    { id: "hablar", title: "Hablar con Noemi" },
  ]);
  anotar(c, "a", body);
}

async function confirmarReserva(c: Conv) {
  if (!c.datos.slot_id) return menuPrincipal(c);
  const [f, h] = String(c.datos.slot).split("T");
  const aj = await ajustes();
  const web = (aj.web_reservas || "https://webnoemi.netlify.app").replace(/\/$/, "");

  if (c.datos.mover_token) {
    const { error } = await db.rpc("rpc_reschedule_booking", { p_token: c.datos.mover_token, p_new_slot_id: c.datos.slot_id });
    if (error) return errorReserva(c, error, f, h);
    const body = `¡Listo! Tu cita ha quedado cambiada ✨\n\n📅 ${fechaLarga(f)} a las ${h} h\n✨ ${c.datos.servicio_nombre}` +
      (aj.direccion ? `\n📍 ${aj.direccion}` : "") + "\n\nSi necesitas algo más, escríbeme por aquí 😊";
    await texto(c.telefono, body); anotar(c, "a", body);
    await avisarNoemi(c, `Ha cambiado su cita (${c.datos.servicio_nombre}) al ${fechaLarga(f)} a las ${h}`);
    c.estado = "fin"; c.datos = { nombre: c.datos.nombre };
    return;
  }

  // Reserva sin señal: queda confirmada al momento.
  const { data, error } = await db.rpc("bot_reservar", {
    p_telefono: "+" + c.telefono, p_nombre: c.datos.nombre,
    p_service_id: c.datos.servicio_id, p_tipo_cita: c.datos.tipo, p_slot_id: c.datos.slot_id,
  });
  if (error) return errorReserva(c, error, f, h);
  const r = Array.isArray(data) ? data[0] : data;

  // Mismo SMS/email de confirmación que cuando Noemi crea una cita en Gestión
  db.functions.invoke("notify-appointment", { body: { appointment_id: r.appointment_id } })
    .then(({ error: e }) => { if (e) console.error("notify-appointment", e); }, (e) => console.error("notify-appointment", e));

  // Enlace al consentimiento informado (el mismo que genera la web de reservas)
  let consentimiento = "";
  const cons = await db.rpc("rpc_get_or_create_consent_for_booking", { p_token: r.management_token });
  if (!cons.error && cons.data) consentimiento = `${web}/consentimiento/?id=${cons.data}`;

  const body = `¡Cita reservada! ✨\n\n📅 ${fechaLarga(f)} a las ${h} h\n✨ ${c.datos.servicio_nombre}` +
    (aj.direccion ? `\n📍 ${aj.direccion}` : "") +
    (consentimiento ? `\n\n📝 Antes de la cita, rellena el consentimiento aquí:\n${consentimiento}` : "") +
    "\n\nSi necesitas cambiarla o cancelarla, escríbeme por aquí. ¡Hasta pronto! 😊";
  await texto(c.telefono, body); anotar(c, "a", "[cita reservada]");
  c.estado = "fin"; c.datos = { nombre: c.datos.nombre };
}

async function errorReserva(c: Conv, error: { message?: string }, f: string, h: string) {
  const msg = String(error?.message || "");
  console.error("reserva", msg);
  if (msg.includes("no está disponible")) return mostrarHuecos(c, undefined, "¡Vaya! Ese hueco se acaba de ocupar 😅");
  if (msg.includes("YA_TIENES_CITA_ACTIVA")) return yaTieneCita(c, { existe: true, puede_retoque: false, nombre: null, tiene_cita_activa: true });
  if (msg.includes("RETOQUE_NO_VERIFICADO")) {
    return derivar(c, "Noemi tiene que revisar tu ficha antes de darte el retoque 😊 Te escribirá personalmente por aquí.", "Retoque: no se ha podido verificar que sea clienta");
  }
  return derivar(c, "Ha habido un problema al guardar la cita 🙈 Noemi te escribirá enseguida para dártela.",
    `Error al reservar ${c.datos.servicio_nombre || ""} el ${fechaLarga(f)} a las ${h}: ${msg.slice(0, 80)}`);
}

// --- Cambiar / cancelar ---
type Cita = { id: string; fecha: string; hora: string; servicio_nombre: string; tipo_cita: string | null;
  origen: string; pago_estado: string; management_token: string; cliente_nombre: string };
async function citasFuturas(tel: string): Promise<Cita[]> {
  const { data, error } = await db.rpc("bot_citas_futuras", { p_telefono: "+" + tel });
  if (error) console.error("bot_citas_futuras", error);
  return (data ?? []) as Cita[];
}
function describirCita(ci: Cita) { return `${ci.servicio_nombre} · ${fechaLarga(ci.fecha)} a las ${hhmm(ci.hora)} h`; }

async function cambiarOCancelar(c: Conv) {
  const citas = await citasFuturas(c.telefono);
  if (citas.length === 0) {
    return derivar(c, "No encuentro ninguna cita próxima con este número 🤔 Puede que se reservara con otro teléfono. Noemi lo revisará y te escribirá personalmente 😊",
      "Quiere cambiar o cancelar una cita, pero no aparece ninguna con su número");
  }
  if (citas.length === 1) return opcionesCita(c, citas[0]);
  c.estado = "eligiendo_cita";
  const body = "Tienes estas citas próximas. ¿Cuál quieres cambiar o cancelar?";
  await lista(c.telefono, body, "Ver mis citas", "Tus citas", citas.slice(0, 10).map((ci) => ({
    id: "csel:" + ci.id, title: `${fechaCorta(ci.fecha)} · ${hhmm(ci.hora)}`, description: ci.servicio_nombre,
  })));
  anotar(c, "a", body);
}

async function opcionesCita(c: Conv, ci: Cita) {
  // Las citas que pusiste tú a mano (no online) las gestionas tú.
  if (ci.origen !== "online") {
    return derivar(c, `Tu cita: *${describirCita(ci)}*.\n\nNoemi te escribirá personalmente para cambiarla o cancelarla 😊`,
      `Quiere cambiar o cancelar su cita (puesta a mano): ${describirCita(ci)}`);
  }
  c.estado = "opciones_cita";
  const body = `Tu cita: *${describirCita(ci)}*.\n\n¿Qué quieres hacer?`;
  await botones(c.telefono, body, [
    { id: "cmov:" + ci.id, title: "Cambiar fecha/hora" },
    { id: "ccan:" + ci.id, title: "Cancelar la cita" },
    { id: "menu:inicio", title: "Nada, volver" },
  ]);
  anotar(c, "a", body);
}

async function buscarCita(c: Conv, id: string) {
  return (await citasFuturas(c.telefono)).find((x) => x.id === id) ?? null;
}

// ------------------------------------------------------------
// IA: entender mensajes escritos y responder dudas
// ------------------------------------------------------------
type Interpretacion = { intencion: "reservar" | "cambiar_cancelar" | "pregunta" | "hablar_noemi" | "saludo" | "otro"; sabe_responder: boolean; respuesta: string };

async function interpretar(c: Conv, mensaje: string): Promise<Interpretacion | null> {
  if (!ia) return null;
  const hoy = hoyMadrid();
  if (c.usos_ia_fecha !== hoy) { c.usos_ia_fecha = hoy; c.usos_ia_dia = 0; }
  if (c.usos_ia_dia >= MAX_IA_DIA) return null;
  c.usos_ia_dia++;
  const [aj, info, precios] = await Promise.all([ajustes(), infoReservas(), textoPrecios()]);
  const sistema = `Eres el asistente de WhatsApp de Noemi Cuesta, especialista en micropigmentación de cejas en Valencia. Hablas en español de España, con un tono cercano, cálido y profesional, tratando a la clienta de tú. Mensajes breves (máximo 3-4 frases), con algún emoji suave.

Tu tarea: leer el último mensaje de la clienta y clasificar su intención:
- "reservar": quiere pedir cita (micropigmentación, retoque, removedor...).
- "cambiar_cancelar": quiere cambiar, mover o anular una cita que ya tiene.
- "pregunta": pregunta sobre servicios, precios, técnicas, duración, cuidados, señal, cancelaciones o el estudio.
- "hablar_noemi": pide hablar con Noemi o con una persona, se queja, o el tema es delicado o personal.
- "saludo": solo saluda o da las gracias.
- "otro": cualquier otra cosa.

Si es "pregunta", responde en "respuesta" usando EXCLUSIVAMENTE la información de abajo. Si la respuesta no está ahí, o requiere valorar su caso (pigmento antiguo, trabajos de otro centro, salud, embarazo, alergias, medicación, cicatrices...), pon sabe_responder=false y deja "respuesta" vacía. Nunca inventes precios, fechas, horas libres ni datos. No ofrezcas horas concretas: para eso hay botones. No des precio de retoque a quien se hizo la micro en otro centro. En cualquier otro caso deja "respuesta" vacía.

INFORMACIÓN DEL NEGOCIO
Noemi Cuesta: micropigmentación y estética en Valencia. Formada con una profesional ganadora del WULOP. Especialista en cejas. Estudia la piel y los rasgos de cada clienta antes del diseño.
Servicios y precios actuales:
${precios}

Reservas por WhatsApp: no hace falta pagar señal. Se puede cancelar o cambiar hasta ${info.cancelacion_limite_horas} horas antes; con menos antelación lo gestiona Noemi personalmente.
Los retoques solo se reservan directamente si la micropigmentación la hizo Noemi. Micropigmentaciones antiguas, de otro centro, removedor y neutralización: Noemi los valora personalmente con fotos.
${aj.direccion ? "Dirección: " + aj.direccion : "Dirección: Valencia (Noemi la facilita al confirmar la cita)."}
${aj.info_extra ? "Más información: " + aj.info_extra : ""}`;

  const contexto = c.historial.slice(-8).map((h) => `${h.r === "c" ? "Clienta" : "Asistente"}: ${h.t}`).join("\n");
  try {
    const r = await ia.messages.create({
      model: MODELO_IA,
      max_tokens: 2000,
      system: sistema,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              intencion: { type: "string", enum: ["reservar", "cambiar_cancelar", "pregunta", "hablar_noemi", "saludo", "otro"] },
              sabe_responder: { type: "boolean" },
              respuesta: { type: "string" },
            },
            required: ["intencion", "sabe_responder", "respuesta"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: `Conversación reciente:\n${contexto || "(ninguna)"}\n\nÚltimo mensaje de la clienta:\n${mensaje}` }],
    });
    if (r.stop_reason === "refusal") return { intencion: "hablar_noemi", sabe_responder: false, respuesta: "" };
    const bloque = r.content.find((b) => b.type === "text");
    if (!bloque || bloque.type !== "text") return null;
    return JSON.parse(bloque.text) as Interpretacion;
  } catch (e) {
    console.error("IA", e);
    return null;
  }
}

// Palabras clave: funcionan aunque la IA no esté disponible.
function interpretarSinIA(msg: string): Interpretacion | null {
  const t = msg.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const r = (intencion: Interpretacion["intencion"]): Interpretacion => ({ intencion, sabe_responder: false, respuesta: "" });
  if (/\b(noemi|persona|humano|humana)\b/.test(t)) return r("hablar_noemi");
  if (/(cancel|anular|cambiar|mover|modificar)/.test(t)) return r("cambiar_cancelar");
  if (/(cita|reserv|hueco)/.test(t)) return r("reservar");
  return null;
}

// ------------------------------------------------------------
// Router principal
// ------------------------------------------------------------
type Entrada = { tipo: "boton"; id: string; titulo: string } | { tipo: "texto"; texto: string } | { tipo: "media"; clase: string };

async function procesarBoton(c: Conv, id: string) {
  const [accion, ...resto] = id.split(":");
  const valor = resto.join(":");
  // Botón de un mensaje antiguo cuya reserva ya no está en curso → empezar de nuevo
  if (["svc", "mas", "slot", "ok", "otra"].includes(accion) && !c.datos.tipo) return preguntarServicio(c);

  switch (accion) {
    case "menu":
      if (valor === "reservar") return preguntarServicio(c);
      if (valor === "cambiar") return cambiarOCancelar(c);
      if (valor === "info") {
        c.estado = "info";
        await texto(c.telefono, `*Servicios y precios*\n${await textoPrecios()}`);
        const body = "¿Tienes alguna duda? Escríbemela y te respondo 😊";
        await botones(c.telefono, body, [
          { id: "menu:reservar", title: "Reservar una cita" },
          { id: "hablar", title: "Hablar con Noemi" },
        ]);
        anotar(c, "a", "[lista de precios] " + body);
        return;
      }
      return menuPrincipal(c, false);

    case "srv": {
      if (valor === "removedor") {
        return derivar(c, "¡Perfecto! 😊 Noemi te atenderá personalmente por aquí en cuanto pueda. Si quieres, puedes ir enviándole fotos de tus cejas con buena luz 📸", "Removedor");
      }
      const f = await ficha(c.telefono);
      if (f.nombre && !c.datos.nombre) c.datos.nombre = f.nombre;
      if (await yaTieneCita(c, f)) return;
      if (valor === "micro") {
        c.estado = "pigmento";
        const body = "¿Tienes actualmente micropigmentación o restos de pigmento en las cejas?";
        await botones(c.telefono, body, [
          { id: "pig:no", title: "No, es mi 1ª vez" },
          { id: "pig:si", title: "Sí, tengo" },
        ]);
        anotar(c, "a", body);
        return;
      }
      if (valor === "retoque") {
        if (!f.puede_retoque) {
          c.estado = "retoque_origen";
          const body = "¿La micropigmentación te la hizo Noemi o fue en otro centro?";
          await botones(c.telefono, body, [
            { id: "ret:noemi", title: "Me la hizo Noemi" },
            { id: "ret:otro", title: "En otro centro" },
          ]);
          anotar(c, "a", body);
          return;
        }
        const saludo = c.datos.nombre ? `¡Hola, ${primerNombre(c.datos.nombre)}! 😊 ` : "";
        return elegirServicio(c, "retoque", `${saludo}¿Qué retoque necesitas?`);
      }
      return preguntarServicio(c);
    }
    case "pig":
      if (valor === "si") return derivar(c, MSG_FOTOS, "Micropigmentación con pigmento anterior (le he pedido fotos)");
      return elegirServicio(c, "primera", "¡Qué ilusión! 🥰 ¿Qué técnica te gustaría?");
    case "ret":
      if (valor === "otro") return derivar(c, MSG_FOTOS, "Retoque de trabajo de otro centro (le he pedido fotos)");
      return derivar(c, "¡Genial! 😊 Noemi revisará tu ficha y te escribirá personalmente para darte cita.", "Retoque: dice que la micro se la hizo Noemi, pero no consta como clienta");
    case "svc": {
      const s = c.datos.servicios?.[valor];
      if (!s) return elegirServicio(c, c.datos.tipo, "¿Qué servicio quieres?");
      c.datos = { ...c.datos, servicio_id: valor, servicio_nombre: s.nombre, precio: s.precio, mover_token: undefined };
      return mostrarHuecos(c);
    }
    case "mas": return mostrarHuecos(c, valor);
    case "slot": return elegirHueco(c, valor);
    case "ok": return confirmarReserva(c);
    case "otra": return mostrarHuecos(c);
    case "hablar": return derivar(c, "¡Claro! 😊 Noemi te escribirá personalmente por aquí en cuanto pueda.", "Ha pedido hablar contigo");

    case "csel": {
      const ci = await buscarCita(c, valor);
      return ci ? opcionesCita(c, ci) : cambiarOCancelar(c);
    }
    case "cmov": {
      const ci = await buscarCita(c, valor);
      if (!ci) return cambiarOCancelar(c);
      const info = await infoReservas();
      if (!ci.tipo_cita || !info.agenda_online_abierta || horasHasta(ci.fecha, ci.hora) < info.cancelacion_limite_horas) {
        return derivar(c, "Para cambiar esta cita, Noemi te escribirá personalmente en cuanto pueda 😊", `Quiere cambiar su cita: ${describirCita(ci)}`);
      }
      c.datos = { ...c.datos, nombre: c.datos.nombre || ci.cliente_nombre, tipo: ci.tipo_cita, servicio_nombre: ci.servicio_nombre,
        mover_token: ci.management_token };
      return mostrarHuecos(c);
    }
    case "ccan": {
      const ci = await buscarCita(c, valor);
      if (!ci) return cambiarOCancelar(c);
      const info = await infoReservas();
      if (horasHasta(ci.fecha, ci.hora) < info.cancelacion_limite_horas) {
        return derivar(c, "Como queda muy poco para tu cita, Noemi te escribirá personalmente 😊", `Quiere cancelar con poca antelación: ${describirCita(ci)}`);
      }
      c.estado = "confirmar_cancelacion";
      const body = `¿Seguro que quieres cancelar tu cita de *${describirCita(ci)}*?`;
      await botones(c.telefono, body, [
        { id: "ccanok:" + ci.id, title: "Sí, cancelarla" },
        { id: "menu:inicio", title: "No, mantenerla" },
      ]);
      anotar(c, "a", body);
      return;
    }
    case "ccanok": {
      const ci = await buscarCita(c, valor);
      if (!ci) return cambiarOCancelar(c);
      // Igual que la web (/reservas/gestionar): la función cancel-booking cancela
      // y envía el SMS/email de cancelación. Si falla, se cancela directamente.
      let error: { message?: string } | null = null;
      const fn = await db.functions.invoke("cancel-booking", { body: { management_token: ci.management_token } });
      if (fn.error || fn.data?.error) {
        console.error("cancel-booking", fn.error || fn.data?.error);
        ({ error } = await db.rpc("rpc_cancel_booking", { p_token: ci.management_token }));
        if (error && String(error.message).includes("ya estaba cancelada")) error = null;
      }
      if (error) {
        console.error("cancelar", error);
        return derivar(c, "Ha habido un problema al cancelar 🙈 Noemi te escribirá enseguida.", `Error al cancelar: ${describirCita(ci)}`);
      }
      const body = "Tu cita ha quedado cancelada. ¡Gracias por avisar! 😊 Cuando quieras volver a reservar, escríbeme.";
      await texto(c.telefono, body); anotar(c, "a", body);
      await avisarNoemi(c, `Ha cancelado su cita: ${describirCita(ci)}. El hueco ha quedado libre`);
      c.estado = "fin"; c.datos = { nombre: c.datos.nombre };
      return;
    }
    default:
      return menuPrincipal(c, false);
  }
}

async function procesarTexto(c: Conv, msg: string, sesionNueva: boolean) {
  if (c.estado === "pidiendo_nombre") {
    const nombre = msg.replace(/\s+/g, " ").trim().slice(0, 60);
    if (nombre.length >= 2) { c.datos.nombre = nombre; return pedirConfirmacion(c); }
  }
  const clave = interpretarSinIA(msg);
  const r = clave?.intencion === "hablar_noemi" ? clave : (await interpretar(c, msg)) ?? clave;
  const prefijo = sesionNueva ? "¡Hola! 😊 Bienvenida. " : "";
  switch (r?.intencion) {
    case "reservar": return preguntarServicio(c, prefijo);
    case "cambiar_cancelar": return cambiarOCancelar(c);
    case "hablar_noemi": return derivar(c, "¡Claro! 😊 Noemi te escribirá personalmente por aquí en cuanto pueda.", `Ha escrito: "${msg.slice(0, 150)}"`);
    case "pregunta":
      if (r.sabe_responder && r.respuesta) {
        await texto(c.telefono, prefijo + r.respuesta); anotar(c, "a", r.respuesta);
        c.estado = "info";
        await botones(c.telefono, "¿Te puedo ayudar en algo más?", [
          { id: "menu:reservar", title: "Reservar una cita" },
          { id: "hablar", title: "Hablar con Noemi" },
        ]);
        return;
      }
      return derivar(c, "Esa pregunta prefiero que te la responda Noemi personalmente 😊 Te escribirá por aquí en cuanto pueda.", `Pregunta: "${msg.slice(0, 150)}"`);
    default:
      if (!sesionNueva && ["servicio", "pigmento", "eligiendo_servicio", "eligiendo_hueco", "confirmando", "retoque_origen", "opciones_cita", "eligiendo_cita", "confirmar_cancelacion", "cita_activa"].includes(c.estado)) {
        await texto(c.telefono, "Para seguir, toca una de las opciones de mi mensaje anterior 👆 O si lo prefieres, escribe «hablar con Noemi».");
        return;
      }
      return menuPrincipal(c, sesionNueva || c.estado === "inicio" || c.estado === "fin");
  }
}

async function procesarMensaje(m: any, perfil: string | null) {
  const tel = soloDigitos(m.from);
  if (!tel || !m.id) return;

  // Evitar procesar dos veces el mismo mensaje
  const { error: dup } = await db.from("wa_mensajes_procesados").insert({ id: m.id });
  if (dup) return;

  // Mensajes desde tu WhatsApp personal: abren la "ventana" de avisos gratis
  // (salvo que esté en MODO_PRUEBA: así puedes probar el asistente desde tu número).
  if (tel === NOEMI) {
    await db.from("wa_estado").upsert({ clave: "ventana_noemi", valor: new Date().toISOString(), updated_at: new Date().toISOString() });
    if (!MODO_PRUEBA.includes(NOEMI)) return;
  }
  if (MODO_PRUEBA.length && !MODO_PRUEBA.includes(tel)) return;

  const c = await cargarConv(tel, perfil);
  const aj = await ajustes();
  const ahora = Date.now();
  const ultimo = c.ultimo_mensaje_at ? new Date(c.ultimo_mensaje_at).getTime() : 0;

  let entrada: Entrada;
  if (m.type === "text") entrada = { tipo: "texto", texto: String(m.text?.body ?? "").trim() };
  else if (m.type === "interactive") {
    const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
    entrada = { tipo: "boton", id: String(r?.id ?? ""), titulo: String(r?.title ?? "") };
  } else if (m.type === "button") entrada = { tipo: "texto", texto: String(m.button?.text ?? "") };
  else entrada = { tipo: "media", clase: String(m.type) };

  anotar(c, "c", entrada.tipo === "texto" ? entrada.texto : entrada.tipo === "boton" ? `[${entrada.titulo}]` : `[${entrada.clase}]`);
  c.ultimo_mensaje_at = new Date(ahora).toISOString();

  // Chat atendido por Noemi: el asistente no contesta (salvo que lleve días parado)
  if (c.atendida_por_noemi) {
    const diasReactivar = Number(aj.dias_reactivar || 7);
    if (ultimo && ahora - ultimo > diasReactivar * 86400000) {
      c.atendida_por_noemi = false; c.motivo_derivacion = null; c.estado = "inicio"; c.datos = {};
    } else {
      await guardarConv(c);
      return;
    }
  }

  // Sesión caducada: empezar de cero
  const sesionNueva = !ultimo || ahora - ultimo > HORAS_SESION * 3600000 || c.estado === "inicio";
  if (sesionNueva && c.estado !== "inicio") { c.estado = "inicio"; c.datos = {}; }

  try {
    if (entrada.tipo === "boton") await procesarBoton(c, entrada.id);
    else if (entrada.tipo === "texto") {
      if (entrada.texto) await procesarTexto(c, entrada.texto, sesionNueva);
    } else if (["image", "video", "document"].includes(entrada.clase)) {
      await derivar(c, "¡Gracias! 😊 Se lo paso a Noemi para que lo vea y te responda personalmente.",
        `Ha enviado ${entrada.clase === "image" ? "una foto" : entrada.clase === "video" ? "un vídeo" : "un documento"}`);
    } else if (entrada.clase === "audio") {
      await texto(c.telefono, "¡Hola! 😊 Ahora mismo no puedo escuchar audios 🙈 ¿Me lo escribes, por favor? Si lo prefieres, escribe «hablar con Noemi».");
    }
    // stickers, reacciones, ubicaciones...: no se responde
  } catch (e) {
    console.error("Error procesando mensaje", e);
  }
  await guardarConv(c);
}

// Noemi ha escrito a una clienta desde la app del móvil → el asistente se aparta
async function procesarEco(e: any) {
  const tel = soloDigitos(e.to);
  if (!tel || tel === NOEMI) return;
  if (e.id) {
    const { data } = await db.from("wa_mensajes_procesados").select("id").eq("id", "out:" + e.id).maybeSingle();
    if (data) return; // lo envió el propio asistente
  }
  const c = await cargarConv(tel, null);
  if (c.atendida_por_noemi) return;
  c.atendida_por_noemi = true;
  c.estado = "derivada";
  c.motivo_derivacion = c.motivo_derivacion || "Has respondido tú desde el móvil";
  c.ultimo_mensaje_at = new Date().toISOString();
  await guardarConv(c);
}

// ------------------------------------------------------------
// Seguridad del webhook
// ------------------------------------------------------------
async function firmaValida(req: Request, cuerpo: string) {
  const url = new URL(req.url);
  if (WEBHOOK_KEY && url.searchParams.get("key") === WEBHOOK_KEY) return true;
  if (META_APP_SECRET) {
    const firma = req.headers.get("x-hub-signature-256") ?? "";
    const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(META_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(cuerpo)));
    const hex = Array.from(mac).map((b) => b.toString(16).padStart(2, "0")).join("");
    return firma === "sha256=" + hex;
  }
  return false;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Verificación inicial del webhook (Meta / proveedor)
  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" &&
        ((WA_VERIFY_TOKEN && url.searchParams.get("hub.verify_token") === WA_VERIFY_TOKEN) ||
         (WEBHOOK_KEY && url.searchParams.get("key") === WEBHOOK_KEY))) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("ok", { status: 200 });
  }
  if (req.method !== "POST") return new Response("Método no permitido", { status: 405 });

  const cuerpo = await req.text();
  if (!(await firmaValida(req, cuerpo))) return new Response("No autorizado", { status: 401 });

  let payload: any;
  try { payload = JSON.parse(cuerpo); } catch { return new Response("JSON no válido", { status: 400 }); }

  try {
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const v = change?.value ?? {};
        if (change.field === "messages") {
          const perfiles: Record<string, string> = {};
          for (const ct of v.contacts ?? []) perfiles[soloDigitos(ct.wa_id)] = ct?.profile?.name;
          for (const m of v.messages ?? []) await procesarMensaje(m, perfiles[soloDigitos(m.from)] ?? null);
        } else if (change.field === "smb_message_echoes") {
          for (const e of v.message_echoes ?? []) await procesarEco(e);
        }
      }
    }
  } catch (e) {
    console.error("Error general", e);
  }
  // Siempre 200 para que WhatsApp no reintente en bucle
  return new Response("ok", { status: 200 });
});
