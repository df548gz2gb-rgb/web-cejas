// ============================================================
// Router hash-based + navegación del drawer.
// ============================================================
import { closeSheet } from './ui.js';

const routes = {
  'inicio':        { title:'Inicio',                 load: () => import('./views/inicio.js') },
  'plan-anual':     { title:'Plan anual',              load: () => import('./views/planAnual.js') },
  'plan-mensual':   { title:'Plan mensual',            load: () => import('./views/planMensual.js') },
  'plan-semanal':   { title:'Plan semanal',            load: () => import('./views/planSemanal.js') },
  'plan-diario':    { title:'Plan diario',              load: () => import('./views/planDiario.js') },
  'reservas-online':{ title:'Reservas online',           load: () => import('./views/reservasOnline.js') },
  'lista-espera':   { title:'Lista de espera',           load: () => import('./views/listaEspera.js') },
  'whatsapp':       { title:'WhatsApp',                  load: () => import('./views/whatsapp.js') },
  'clientes':       { title:'Clientes',                 load: () => import('./views/clientes.js') },
  'personal':       { title:'Información personal',     load: () => import('./views/personal.js') },
  'gastos':         { title:'Diario de gastos',         load: () => import('./views/gastos.js') },
  'produccion':     { title:'Análisis de producción',   load: () => import('./views/produccion.js') },
  'stock':          { title:'Productos / Stock',        load: () => import('./views/stock.js') },
  'por-pedir':      { title:'Por pedir',                load: () => import('./views/porPedir.js') },
  'servicios':      { title:'Servicios y precios',      load: () => import('./views/servicios.js') },
  'archivo':        { title:'Archivo',                  load: () => import('./views/archivo.js') },
};

export function navigate(hash){
  location.hash = hash;
}

function parseHash(){
  const raw = (location.hash || '#/inicio').replace(/^#\//,'');
  const [route, ...rest] = raw.split('/');
  return { route: route || 'inicio', param: rest.join('/') || null };
}

let renderToken = 0;

export async function renderRoute(){
  // Si había una ficha (cita, gasto, producto...) abierta, se
  // cierra siempre al cambiar de apartado. Evita que quede
  // flotando encima de una pantalla distinta y "bloquee" la app
  // (por ejemplo al usar el gesto de atrás del móvil).
  closeSheet();

  const { route, param } = parseHash();
  const cfg = routes[route] || routes['inicio'];
  const content = document.getElementById('content');
  const topbarTitle = document.getElementById('topbar-title');

  document.querySelectorAll('.drawer-menu a').forEach(a=>{
    a.classList.toggle('active', a.dataset.route === route);
  });
  topbarTitle.textContent = cfg.title;
  closeDrawer();

  const myToken = ++renderToken;
  content.innerHTML = '<p class="empty-msg">Cargando…</p>';
  try{
    const mod = await cfg.load();
    if(myToken !== renderToken) return; // otra navegación llegó antes
    content.innerHTML = '';
    content.className = 'content';
    await mod.render(content, param);
  }catch(err){
    console.error(err);
    if(myToken === renderToken){
      content.innerHTML = '<p class="empty-msg">No se pudo cargar esta sección.</p>';
    }
  }
}

export function initRouter(){
  window.addEventListener('hashchange', renderRoute);
  if(!location.hash) location.hash = '#/inicio';
  renderRoute();
}

/* ---------- drawer ---------- */
export function openDrawer(){
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-overlay').hidden = false;
}
export function closeDrawer(){
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-overlay').hidden = true;
}
