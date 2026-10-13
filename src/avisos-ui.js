// avisos-ui.js - campana de avisos y banner de pago próximo
import { h } from './ui.js';
import { hoja } from './ui.js';
import { vinculado, estadoAvisos, alCambiarAvisos, cargarAvisos, marcarAvisosLeidos } from './nube-app.js';

const CAMPANA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

const fechaCorta = (f) => { const d = new Date(String(f).replace(' ', 'T') + (String(f).length > 10 ? 'Z' : '')); return isNaN(d) ? '' : d.toLocaleDateString(); };

// Botón de la barra: muestra cuántos avisos sin leer hay
export function campanaAvisos() {
  const boton = h('button', { class: 'nav-nube nav-avisos', title: 'Avisos', 'aria-label': 'Avisos', onClick: abrirAvisos });
  const pintar = (e) => {
    boton.style.display = vinculado() ? '' : 'none';
    boton.dataset.nuevos = e.sinLeer > 0 ? '1' : '';
    boton.innerHTML = CAMPANA + (e.sinLeer > 0 ? `<span class="nube-n">${e.sinLeer > 9 ? '9+' : e.sinLeer}</span>` : '');
  };
  pintar(estadoAvisos());
  alCambiarAvisos(pintar);
  return boton;
}

function tarjeta(a) {
  return h('article', { class: `aviso ${a.nivel === 'importante' ? 'importante' : ''} ${a.leido ? '' : 'nuevo'}` },
    h('strong', {}, a.titulo),
    h('p', {}, a.mensaje),
    h('small', { class: 'ayuda' }, fechaCorta(a.fecha)));
}

export async function abrirAvisos() {
  const caja = h('div', { class: 'cuerpo' });
  const pintar = (e) => {
    caja.replaceChildren(...(e.avisos.length ? e.avisos.map(tarjeta) : [h('p', { class: 'vacio' }, 'No tienes avisos.')]));
  };
  pintar(estadoAvisos());
  hoja('Avisos', caja);
  const e = await cargarAvisos();
  if (caja.isConnected) pintar(e);
  marcarAvisosLeidos();
}

// Franja fija arriba cuando el pago se acerca (solo para el administrador; el servidor decide)
export function bannerPago(contenedor) {
  const franja = h('div', { class: 'banner-pago', role: 'status', style: 'display:none' });
  contenedor.before(franja);
  const pintar = (e) => {
    const p = e.avisos.find((a) => a.tipo === 'pago');
    if (!p) { franja.style.display = 'none'; return; }
    franja.style.display = '';
    franja.replaceChildren(h('strong', {}, p.titulo + ': '), p.mensaje);
  };
  pintar(estadoAvisos());
  alCambiarAvisos(pintar);
}
