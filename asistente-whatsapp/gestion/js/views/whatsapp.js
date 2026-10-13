// ============================================================
// WhatsApp — chats que el asistente te ha pasado a ti y ajustes
// del asistente. El asistente no contesta en los chats de esta
// lista hasta que pulses «Devolver al asistente».
// ============================================================
import { sb } from '../supabaseClient.js';
import { confirmAction } from '../ui.js';
import { escapeHtml, whatsappLink, normalizePhone, debounce, toast } from '../util.js';

const AJUSTES_EDITABLES = [
  { clave: 'direccion',  label: 'Dirección del estudio', ayuda: 'Se envía a la clienta al confirmar la cita. Vacío = no se envía.', tipo: 'input' },
  { clave: 'info_extra', label: 'Información extra para el asistente', ayuda: 'Cuidados, formas de pago, cómo llegar… El asistente la usa para responder dudas.', tipo: 'textarea' },
];

export async function render(container){
  container.innerHTML = '<p class="empty-msg">Cargando…</p>';
  const [conv, ajustes, clientes] = await Promise.all([
    sb.from('wa_conversaciones')
      .select('telefono, nombre_perfil, motivo_derivacion, derivada_at, ultimo_mensaje_at')
      .eq('atendida_por_noemi', true)
      .order('ultimo_mensaje_at', { ascending: false }),
    sb.from('bot_ajustes').select('clave, valor'),
    sb.from('clients').select('nombre, telefono'),
  ]);
  if(conv.error || ajustes.error){
    console.error(conv.error || ajustes.error);
    container.innerHTML = '<p class="empty-msg">El asistente de WhatsApp todavía no está instalado en la base de datos.</p>';
    return;
  }

  const nombres = {};
  (clientes.data || []).forEach(c=>{ nombres[normalizePhone(c.telefono)] = c.nombre; });
  const valores = Object.fromEntries((ajustes.data || []).map(a=>[a.clave, a.valor]));
  const chats = conv.data || [];

  container.innerHTML = `
    <div class="section-title">Chats que atiendes tú</div>
    <p class="small muted" style="margin-bottom:14px;">El asistente no contesta en estos chats. Cuando termines, pulsa «Devolver al asistente».</p>
    <div id="wa-list">
      ${chats.length ? chats.map(w=>item(w, nombres)).join('') : '<p class="empty-msg">No hay chats pendientes. 🎉</p>'}
    </div>

    <div class="section-title" style="margin-top:28px;">Ajustes del asistente</div>
    <p class="small muted" style="margin-bottom:14px;">Los huecos, servicios, precios y la señal son los de <a href="#/reservas-online">Reservas online</a> y <a href="#/servicios">Servicios y precios</a>. Los cambios se guardan automáticamente.</p>
    <div class="form-grid">
      ${AJUSTES_EDITABLES.map(a=>`
        <label class="field full"><span>${a.label}</span>
          ${a.tipo === 'textarea'
            ? `<textarea data-ajuste="${a.clave}">${escapeHtml(valores[a.clave] || '')}</textarea>`
            : `<input type="text" data-ajuste="${a.clave}" value="${escapeHtml(valores[a.clave] || '')}">`}
          <small class="muted">${a.ayuda}</small>
        </label>`).join('')}
    </div>
  `;

  container.querySelectorAll('[data-devolver]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if(!confirmAction('¿Devolver este chat al asistente? Volverá a contestar automáticamente a esta clienta.')) return;
      const { error } = await sb.rpc('rpc_wa_set_atendida', { p_telefono: btn.dataset.devolver, p_atendida: false });
      if(error){ console.error(error); toast('No se pudo actualizar'); return; }
      toast('Devuelto al asistente');
      render(container);
    });
  });

  container.querySelectorAll('[data-ajuste]').forEach(el=>{
    const save = debounce(async ()=>{
      const { error } = await sb.from('bot_ajustes').update({ valor: el.value.trim() }).eq('clave', el.dataset.ajuste);
      if(error){ console.error(error); toast('No se pudo guardar'); return; }
      toast('Guardado');
    }, 600);
    el.addEventListener('input', save);
  });
}

function item(w, nombres){
  const nombre = nombres[normalizePhone(w.telefono)] || w.nombre_perfil || 'Sin nombre';
  const cuando = w.ultimo_mensaje_at
    ? new Date(w.ultimo_mensaje_at).toLocaleString('es-ES', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })
    : '';
  return `
    <div class="list-item">
      <div class="li-main">
        <div class="li-title">${escapeHtml(nombre)} · +${escapeHtml(w.telefono)}</div>
        <div class="li-sub">${escapeHtml(w.motivo_derivacion || 'Atendida por ti')}${cuando ? ' · ' + cuando : ''}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
          <a class="btn btn-sm btn-outline" href="${whatsappLink(w.telefono)}" target="_blank">Abrir chat</a>
          <button type="button" class="btn btn-sm btn-primary" data-devolver="${escapeHtml(w.telefono)}">Devolver al asistente</button>
        </div>
      </div>
    </div>
  `;
}
