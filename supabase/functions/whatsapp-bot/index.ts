// ============================================================
// ASISTENTE DE WHATSAPP — Noemi Cuesta Micropigmentación
// Supabase Edge Function "whatsapp-bot".
//
// Recibe los mensajes de WhatsApp (webhook), sigue el flujo con
// botones, reserva/cambia/cancela en la agenda de la web y deriva
// a Noemi los casos que debe atender ella personalmente.
//
// Claves que hay que configurar en Supabase → Edge Functions → Secrets:
//   WA_TOKEN            token de la API de WhatsApp
//   WA_PHONE_NUMBER_ID  identificador del número de WhatsApp Business
//   WEBHOOK_KEY         contraseña inventada que va en la URL del webhook
//   WA_VERIFY_TOKEN     (si el proveedor la pide) palabra para verificar el webhook
//   ANTHROPIC_API_KEY   clave de Claude (IA)
//   NOEMI_WHATSAPP      tu WhatsApp personal, p. ej. 34644737315
// Opcionales:
//   MODO_PRUEBA         números separados por comas: si está puesto, el
//                       asistente SOLO responde a esos números
//   WA_API_URL          URL de envío si el proveedor no es Meta directo
//   WA_AUTH_HEADER      nombre de la cabecera de la clave (p. ej. D360-API-KEY)
//   META_APP_SECRET     para comprobar la firma de Meta en lugar de WEBHOOK_KEY
//   AVISO_PLANTILLA     nombre de la plantilla de aviso (por defecto aviso_chat_pendiente)
//   AVISO_IDIOMA        idioma de la plantilla (por defecto es)
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
const MAX_IA_DIA = 25;           // tope de consultas a la IA por clienta y día
const HORAS_SESION = 12;         // tras estas horas sin escribir, se empieza de cero

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const ia = env("ANTHROPIC_API_KEY") ? new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) : null;

// ------------------------------------------------------------
// Servicios
// ------------------------------------------------------------
const MICRO_CATS = ["polvo", "hibrida", "pelo_a_pelo", "neutralizacion", "combo"];
const ETIQUETAS: Record<string, string> = {
  polvo: "Efecto polvo", hibrida: "Híbrida", pelo_a_pelo: "Pelo a pelo",
  neutralizacion: "Micropigmentación + neutralización", combo: "Combo amigas",
  retoque: "Retoque", removedor: "Removedor", diseno: "Diseño de cejas", otro: "Cita",
};
const TECNICAS: Record<string, { categoria: string; etiqueta: string; precio: string }> = {
  polvo: { categoria: "polvo", etiqueta: "Efecto polvo", precio: "90 €" },
  hibrida: { categoria: "hibrida", etiqueta: "Híbrida", precio: "95 €" },
  pelo_a_pelo: { categoria: "pelo_a_pelo", etiqueta: "Pelo a pelo", precio: "100 €" },
  nose: { categoria: "polvo", etiqueta: "Micropigmentación (técnica a elegir con Noemi)", precio: "desde 90 €" },
};

const PRECIOS = `*Micropigmentación de cejas*
• Efecto polvo: 90 € (1:30 h)
• Híbrida: 95 € (2 h)
• Pelo a pelo: 100 € (2 h)
• Micropigmentación + neutralización: 110 € (2 h)
• Combo amigas (2): 80 € cada una

*Retoques* (de trabajos realizados por Noemi)
• 1-2 meses: 20 €
• 3-12 meses: 45 €
• 12-24 meses: precio a valorar

*Removedor*
• Sesión: 30 € · Pack 3: 80 € · Pack 5: 120 € · Pack 8: 180 €

*Diseño de cejas*
• Diseño + henna: 15 € · Con depilación: 18 €`;

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------
function soloDigitos(s: string) { return (s || "").replace(/\D/g, ""); }

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DIAS_C = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MESES_C = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function parseFecha(f: string) { const [y, m, d] = f.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function isoFecha(d: Date) { return d.toISOString().slice(0, 10); }
function sumarDias(f: string, n: number) { const d = parseFecha(f); d.setUTCDate(d.getUTCDate() + n); return isoFecha(d); }
function sumarMeses(f: string, n: number) { const d = parseFecha(f); d.setUTCMonth(d.getUTCMonth() + n); return isoFecha(d); }
function fechaLarga(f: string) { const d = parseFecha(f); return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`; }
function fechaCorta(f: string) { const d = parseFecha(f); return `${DIAS_C[d.getUTCDay()]} ${d.getUTCDate()} ${MESES_C[d.getUTCMonth()]}`; }
function hhmm(t: string) { return (t || "").slice(0, 5); }
function hoyMadrid() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function tipoDeCategoria(cat: string): "micro" | "corto" | null {
  if (MICRO_CATS.includes(cat)) return "micro";
  if (cat === "retoque" || cat === "removedor") return "corto";
  return null; // diseño, otro… → lo gestiona Noemi
}
function horasHasta(fecha: string, hora: string) {
  // Diferencia aproximada en horas entre ahora (Madrid) y fecha+hora (Madrid).
  const ahora = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid", dateStyle: "short", timeStyle: "short" }).format(new Date());
  const a = new Date(ahora.replace(" ", "T") + ":00Z").getTime();
  const b = new Date(`${fecha}T${hhmm(hora)}:00Z`).getTime();
  return (b - a) / 3600000;
}
function limpiarParam(s: string) { return (s || "—").replace(/[\n\t]+/g, " ").replace(/ {4,}/g, " ").slice(0, 200); }

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
  return enviarRaw({ to, type: "text", text: { body, preview_url: false } });
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

async function ajustes(): Promise<Record<string, string>> {
  const { data } = await db.from("bot_ajustes").select("clave, valor");
  return Object.fromEntries((data ?? []).map((r: any) => [r.clave, r.valor]));
}
async function ficha(tel: string): Promise<{ nombre: string | null; verificada: boolean; ultima_micro: string | null; tiene_ficha: boolean }> {
  const { data, error } = await db.rpc("bot_ficha", { p_telefono: tel });
  if (error) console.error("bot_ficha", error);
  const f = Array.isArray(data) ? data[0] : data;
  return { nombre: f?.nombre ?? null, verificada: !!f?.verificada, ultima_micro: f?.ultima_micro ?? null, tiene_ficha: !!f?.tiene_ficha };
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
  const { error } = await db.from("requests").insert({
    name: c.datos.nombre || c.nombre_perfil || "WhatsApp", phone: "+" + c.telefono,
    tipo: "WhatsApp", motivo, status: "pendiente",
  });
  if (error) console.error("No se pudo crear la solicitud", error);
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

async function mostrarHuecos(c: Conv, desde?: string, intro?: string) {
  const aj = await ajustes();
  const hoy = hoyMadrid();
  const inicio = desde && desde > hoy ? desde : (c.datos.desde && c.datos.desde > hoy ? c.datos.desde : hoy);
  const hasta = sumarDias(hoy, Number(aj.dias_vista || 45));
  const { data, error } = await db.rpc("bot_huecos_libres", {
    p_tipo: c.datos.tipo, p_desde: inicio, p_hasta: hasta, p_excluir_cita: c.datos.mover_id ?? null,
  });
  if (error) console.error("bot_huecos_libres", error);
  const huecos = (data ?? []) as { fecha: string; hora_inicio: string; hora_fin: string }[];
  if (huecos.length === 0) {
    if (desde) {
      await botones(c.telefono, "No me quedan más huecos libres en las próximas semanas 🙈", [
        { id: "mas:" + (c.datos.desde || hoy), title: "Ver desde el inicio" },
        { id: "hablar", title: "Hablar con Noemi" },
      ]);
      return;
    }
    await derivar(c, "Ahora mismo no me quedan huecos libres en las próximas semanas 🙈 Noemi te escribirá personalmente para buscarte un hueco 😊",
      `Quiere cita de ${c.datos.etiqueta} y no hay huecos libres`);
    return;
  }
  c.estado = "eligiendo_hueco";
  const muestra = huecos.slice(0, 9);
  const filas: Fila[] = muestra.map((h) => ({
    id: `slot:${h.fecha}T${hhmm(h.hora_inicio)}`,
    title: `${fechaCorta(h.fecha)} · ${hhmm(h.hora_inicio)}`,
  }));
  if (huecos.length > 9) filas.push({ id: "mas:" + sumarDias(muestra[muestra.length - 1].fecha, 1), title: "Ver más fechas ➡️" });
  const body = (intro ? intro + "\n\n" : "") + `Estos son los próximos huecos libres para *${c.datos.etiqueta}*. Elige el que mejor te venga 👇`;
  await lista(c.telefono, body, "Ver horarios", "Huecos libres", filas);
  anotar(c, "a", body + " [lista de horarios]");
}

async function pedirConfirmacion(c: Conv) {
  const s = c.datos.slot as string;
  const [f, h] = s.split("T");
  c.estado = "confirmando";
  const accion = c.datos.mover_id ? "¿Cambio tu cita a este día y hora?" : "¿Reservo la cita?";
  const body = `Te confirmo los datos:\n\n✨ ${c.datos.etiqueta}\n📅 ${fechaLarga(f)}\n🕐 ${h} h` +
    (c.datos.precio ? `\n💶 ${c.datos.precio}` : "") + `\n👤 ${c.datos.nombre}\n\n${accion}`;
  await botones(c.telefono, body, [
    { id: "ok:reservar", title: c.datos.mover_id ? "Sí, cambiarla" : "Sí, reservar" },
    { id: "otra:hora", title: "Elegir otra hora" },
    { id: "hablar", title: "Hablar con Noemi" },
  ]);
  anotar(c, "a", body);
}

async function confirmarReserva(c: Conv) {
  const s = c.datos.slot as string | undefined;
  if (!s) return menuPrincipal(c);
  const [f, h] = s.split("T");
  const aj = await ajustes();
  let error;
  if (c.datos.mover_id) {
    ({ error } = await db.rpc("bot_mover_cita", { p_id: c.datos.mover_id, p_telefono: c.telefono, p_tipo: c.datos.tipo, p_fecha: f, p_hora: h }));
  } else {
    ({ error } = await db.rpc("bot_reservar", {
      p_tipo: c.datos.tipo, p_fecha: f, p_hora: h, p_nombre: c.datos.nombre, p_telefono: c.telefono,
      p_categoria: c.datos.categoria, p_nota: `WhatsApp${c.datos.nota ? " · " + c.datos.nota : ""}`,
    }));
  }
  if (error) {
    console.error("reserva", error);
    if (String(error.message).includes("HUECO_OCUPADO")) {
      return mostrarHuecos(c, undefined, "¡Vaya! Ese hueco se acaba de ocupar 😅");
    }
    return derivar(c, "Ha habido un problema al guardar la cita 🙈 Noemi te escribirá enseguida para confirmártela.", `Error al guardar cita (${c.datos.etiqueta}, ${f} ${h})`);
  }
  const movida = !!c.datos.mover_id;
  if (!movida) await asegurarClienta(c);
  const body = (movida ? "¡Listo! Tu cita ha quedado cambiada ✨" : "¡Cita reservada! ✨") +
    `\n\n📅 ${fechaLarga(f)} a las ${h} h\n✨ ${c.datos.etiqueta}` +
    (aj.direccion ? `\n📍 ${aj.direccion}` : "") +
    "\n\nSi necesitas cambiarla o cancelarla, escríbeme por aquí. ¡Hasta pronto! 😊";
  await texto(c.telefono, body);
  anotar(c, "a", body);
  if (movida) await avisarNoemi(c, `Ha cambiado su cita (${c.datos.etiqueta}) al ${fechaLarga(f)} a las ${h}`);
  c.estado = "fin"; c.datos = { nombre: c.datos.nombre };
}

async function asegurarClienta(c: Conv) {
  const f = await ficha(c.telefono);
  if (f.tiene_ficha) return;
  const { error } = await db.from("clients").insert({ name: c.datos.nombre, phone: "+" + c.telefono });
  if (error) console.error("No se pudo crear la ficha", error);
}

async function elegirHueco(c: Conv, slot: string) {
  c.datos.slot = slot;
  if (!c.datos.nombre) {
    c.estado = "pidiendo_nombre";
    const body = "¡Perfecto! ¿A nombre de quién hago la reserva? (nombre y apellido)";
    await texto(c.telefono, body); anotar(c, "a", body);
    return;
  }
  await pedirConfirmacion(c);
}

// --- Micropigmentación ---
async function elegirTecnica(c: Conv) {
  c.estado = "tecnica";
  const body = "¡Qué ilusión! 🥰 ¿Qué técnica te gustaría?";
  await lista(c.telefono, body, "Ver técnicas", "Técnicas", [
    { id: "tec:polvo", title: "Efecto polvo", description: "Acabado difuminado tipo maquillaje · 90 €" },
    { id: "tec:hibrida", title: "Híbrida", description: "Pelo a pelo + sombreado · 95 €" },
    { id: "tec:pelo_a_pelo", title: "Pelo a pelo", description: "Trazos finos que imitan el vello · 100 €" },
    { id: "tec:nose", title: "Aún no lo sé", description: "Noemi te asesora en la cita" },
    { id: "tec:combo", title: "Combo amigas (2)", description: "Tú y una amiga el mismo día · 80 € c/u" },
  ]);
  anotar(c, "a", body + " [lista de técnicas]");
}

// --- Retoque ---
async function retoque(c: Conv) {
  const f = await ficha(c.telefono);
  if (f.nombre && !c.datos.nombre) c.datos.nombre = f.nombre;
  if (!f.verificada) {
    c.estado = "retoque_origen";
    const body = "¿La micropigmentación te la hizo Noemi o fue en otro centro?";
    await botones(c.telefono, body, [
      { id: "ret:noemi", title: "Me la hizo Noemi" },
      { id: "ret:otro", title: "En otro centro" },
    ]);
    anotar(c, "a", body);
    return;
  }
  if (!f.ultima_micro) {
    return derivar(c, "¡Genial! Noemi revisará tu ficha y te escribirá personalmente para darte cita 😊",
      "Retoque: es clienta pero no consta la fecha de su última micro");
  }
  const hoy = hoyMadrid();
  let precio: string;
  let tramo: string;
  if (hoy <= sumarMeses(f.ultima_micro, 2)) { precio = "20 €"; tramo = "1-2 meses"; }
  else if (hoy <= sumarMeses(f.ultima_micro, 12)) { precio = "45 €"; tramo = "3-12 meses"; }
  else {
    return derivar(c, "Como ha pasado más de un año desde tu micropigmentación, Noemi prefiere valorarlo personalmente. Si puedes, envíame una foto de tus cejas con buena luz 📸 y ella te escribirá 😊",
      `Retoque de más de 12 meses (última micro: ${fechaLarga(f.ultima_micro)})`);
  }
  c.datos = { ...c.datos, tipo: "corto", categoria: "retoque", etiqueta: `Retoque ${tramo}`, precio,
    desde: [hoy, sumarDias(f.ultima_micro, 28)].sort()[1] };
  const saludo = c.datos.nombre ? `¡Hola, ${String(c.datos.nombre).split(" ")[0]}! 😊 ` : "";
  await mostrarHuecos(c, undefined, `${saludo}Veo que tu micropigmentación fue el ${fechaLarga(f.ultima_micro)}, así que te corresponde el *retoque de ${tramo}* (${precio}).`);
}

// --- Cambiar / cancelar ---
type Cita = { id: string; fecha: string; hora: string; categoria: string; nombre: string };
async function citasFuturas(tel: string): Promise<Cita[]> {
  const { data, error } = await db.rpc("bot_citas_futuras", { p_telefono: tel });
  if (error) console.error("bot_citas_futuras", error);
  return (data ?? []) as Cita[];
}
function describirCita(ci: Cita) { return `${ETIQUETAS[ci.categoria] ?? "Cita"} · ${fechaLarga(ci.fecha)} a las ${hhmm(ci.hora)} h`; }

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
    id: "csel:" + ci.id, title: `${fechaCorta(ci.fecha)} · ${hhmm(ci.hora)}`, description: ETIQUETAS[ci.categoria] ?? "Cita",
  })));
  anotar(c, "a", body);
}

async function opcionesCita(c: Conv, ci: Cita) {
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

async function citaDemasiadoCerca(c: Conv, ci: Cita) {
  const aj = await ajustes();
  return horasHasta(ci.fecha, ci.hora) < Number(aj.antelacion_horas || 12);
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
  const aj = await ajustes();
  const sistema = `Eres el asistente de WhatsApp de Noemi Cuesta, especialista en micropigmentación de cejas en Valencia. Hablas en español de España, con un tono cercano, cálido y profesional, tratando a la clienta de tú. Mensajes breves (máximo 3-4 frases), con algún emoji suave.

Tu tarea: leer el último mensaje de la clienta y clasificar su intención:
- "reservar": quiere pedir cita (micropigmentación, retoque, removedor...).
- "cambiar_cancelar": quiere cambiar, mover o anular una cita que ya tiene.
- "pregunta": hace una pregunta sobre servicios, precios, técnicas, duración, cuidados, horarios o el estudio.
- "hablar_noemi": pide hablar con Noemi o con una persona, se queja, o el tema es delicado o personal.
- "saludo": solo saluda o da las gracias.
- "otro": cualquier otra cosa.

Si es "pregunta", responde en "respuesta" usando EXCLUSIVAMENTE la información de abajo. Si la respuesta no está en esa información, o requiere valorar su caso concreto (pigmento antiguo, trabajos de otro centro, salud, embarazo, alergias, medicación, cicatrices...), pon sabe_responder=false y deja "respuesta" vacía. Nunca inventes precios, fechas, horas libres ni datos. No ofrezcas citas ni horas concretas: para eso hay botones. No des precio de retoque a quien se hizo la micro en otro centro. En cualquier otro caso deja "respuesta" vacía.

INFORMACIÓN DEL NEGOCIO
Noemi Cuesta: micropigmentación y estética en Valencia. Formada con una profesional ganadora del WULOP. Especialista en cejas: efecto polvo, híbrida y pelo a pelo. Materiales y pigmentos profesionales. Estudia la piel y los rasgos de cada clienta antes del diseño.
Horario de citas: lunes y miércoles por la tarde (de 18:45 a 20:45) y sábados (de 9:30 a 14:00 y de 16:00 a 20:45).

Servicios y precios:
${PRECIOS}

Notas:
- Las micropigmentaciones no incluyen retoque; el retoque se paga aparte según el tiempo transcurrido.
- Efecto polvo: acabado difuminado tipo maquillaje en polvo. Híbrida: pelo a pelo combinado con sombreado. Pelo a pelo: trazos finos que imitan el vello natural. Neutralización: para corregir tonos no deseados de micropigmentaciones antiguas (requiere valoración de Noemi).
- Si alguien tiene micropigmentación antigua, viene de otro centro o quiere removedor, Noemi lo valora personalmente con fotos.
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

// ------------------------------------------------------------
// Router principal
// ------------------------------------------------------------
type Entrada = { tipo: "boton"; id: string; titulo: string } | { tipo: "texto"; texto: string } | { tipo: "media"; clase: string };

async function procesarBoton(c: Conv, id: string) {
  const [accion, ...resto] = id.split(":");
  const valor = resto.join(":");
  // Botón de un mensaje antiguo cuya reserva ya no está en curso → empezar de nuevo
  if (["mas", "slot", "ok", "otra"].includes(accion) && !c.datos.tipo) return preguntarServicio(c);
  switch (accion) {
    case "menu":
      if (valor === "reservar") return preguntarServicio(c);
      if (valor === "cambiar") return cambiarOCancelar(c);
      if (valor === "info") {
        c.estado = "info";
        await texto(c.telefono, PRECIOS);
        const body = "¿Tienes alguna duda? Escríbemela y te respondo 😊";
        await botones(c.telefono, body, [
          { id: "menu:reservar", title: "Reservar una cita" },
          { id: "hablar", title: "Hablar con Noemi" },
        ]);
        anotar(c, "a", "[lista de precios] " + body);
        return;
      }
      return menuPrincipal(c, false);
    case "srv":
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
      if (valor === "retoque") return retoque(c);
      if (valor === "removedor") {
        return derivar(c, "¡Perfecto! 😊 Noemi te atenderá personalmente por aquí en cuanto pueda. Si quieres, puedes ir enviándole fotos de tus cejas con buena luz 📸", "Removedor");
      }
      return preguntarServicio(c);
    case "pig":
      if (valor === "si") return derivar(c, MSG_FOTOS, "Micropigmentación con pigmento anterior (le he pedido fotos)");
      return elegirTecnica(c);
    case "tec": {
      if (valor === "combo") {
        return derivar(c, "¡Qué buen plan! 👯‍♀️ Para el combo amigas Noemi organiza personalmente las dos citas. Te escribirá por aquí en cuanto pueda 😊", "Combo amigas: organizar las dos citas");
      }
      const t = TECNICAS[valor];
      if (!t) return elegirTecnica(c);
      const f = await ficha(c.telefono);
      c.datos = { ...c.datos, nombre: c.datos.nombre || f.nombre || undefined, tipo: "micro", categoria: t.categoria,
        etiqueta: t.etiqueta, precio: t.precio, nota: valor === "nose" ? "técnica a decidir" : undefined, desde: undefined };
      return mostrarHuecos(c);
    }
    case "mas": return mostrarHuecos(c, valor);
    case "slot": return elegirHueco(c, valor);
    case "ok": return confirmarReserva(c);
    case "otra": return mostrarHuecos(c);
    case "hablar": return derivar(c, "¡Claro! 😊 Noemi te escribirá personalmente por aquí en cuanto pueda.", "Ha pedido hablar contigo");
    case "ret":
      if (valor === "otro") return derivar(c, MSG_FOTOS, "Retoque de trabajo de otro centro (le he pedido fotos)");
      return derivar(c, "¡Genial! 😊 Noemi revisará tu ficha y te escribirá personalmente para darte cita.", "Retoque: dice que la micro se la hizo Noemi, pero no consta en su ficha");
    case "csel": {
      const ci = await buscarCita(c, valor);
      return ci ? opcionesCita(c, ci) : cambiarOCancelar(c);
    }
    case "cmov": {
      const ci = await buscarCita(c, valor);
      if (!ci) return cambiarOCancelar(c);
      const tipo = tipoDeCategoria(ci.categoria);
      if (!tipo || await citaDemasiadoCerca(c, ci)) {
        return derivar(c, "Para cambiar esta cita, Noemi te escribirá personalmente en cuanto pueda 😊", `Quiere cambiar su cita: ${describirCita(ci)}`);
      }
      c.datos = { ...c.datos, nombre: c.datos.nombre || ci.nombre, mover_id: ci.id, tipo, categoria: ci.categoria,
        etiqueta: ETIQUETAS[ci.categoria] ?? "Cita", precio: undefined, desde: undefined };
      return mostrarHuecos(c);
    }
    case "ccan": {
      const ci = await buscarCita(c, valor);
      if (!ci) return cambiarOCancelar(c);
      if (await citaDemasiadoCerca(c, ci)) {
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
      const { error } = await db.rpc("bot_cancelar_cita", { p_id: ci.id, p_telefono: c.telefono });
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

// Palabras clave: funcionan aunque la IA no esté disponible.
function interpretarSinIA(msg: string): Interpretacion | null {
  const t = msg.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const r = (intencion: Interpretacion["intencion"]): Interpretacion => ({ intencion, sabe_responder: false, respuesta: "" });
  if (/\b(noemi|persona|humano|humana)\b/.test(t)) return r("hablar_noemi");
  if (/(cancel|anular|cambiar|mover|modificar)/.test(t)) return r("cambiar_cancelar");
  if (/(cita|reserv|hueco)/.test(t)) return r("reservar");
  return null;
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
      // En mitad de un paso con botones: recordar que use las opciones.
      if (!sesionNueva && ["servicio", "pigmento", "tecnica", "eligiendo_hueco", "confirmando", "retoque_origen", "opciones_cita", "eligiendo_cita", "confirmar_cancelacion"].includes(c.estado)) {
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

  // Mensajes desde tu WhatsApp personal: solo abren la "ventana" de avisos gratis
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
  if (!c.datos.nombre) {
    const f = await ficha(tel);
    if (f.nombre) c.datos.nombre = f.nombre;
  }

  try {
    if (entrada.tipo === "boton") await procesarBoton(c, entrada.id);
    else if (entrada.tipo === "texto") {
      if (entrada.texto) await procesarTexto(c, entrada.texto, sesionNueva);
    } else if (["image", "video", "document"].includes(entrada.clase)) {
      await derivar(c, "¡Gracias! 😊 Se lo paso a Noemi para que lo vea y te responda personalmente.", `Ha enviado ${entrada.clase === "image" ? "una foto" : entrada.clase === "video" ? "un vídeo" : "un documento"}`);
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
