// fechas.js - rango de fechas con calendario (Desde / Hasta) para ventas, compras y reportes
import { h } from './ui.js';

const dos = (n) => String(n).padStart(2, '0');
export const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
};
const primerDiaDelMes = () => `${hoyISO().slice(0, 8)}01`;

// Rango inicial: del primer día del mes a hoy
export const rangoInicial = () => ({ desde: primerDiaDelMes(), hasta: hoyISO() });

const valida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '');

// Condición SQL para una columna de fecha. Las fechas se validan antes, así que se pueden escribir directo.
// Si falta una de las dos, ese lado queda abierto. Si vienen al revés, se invierten.
export function condicionRango(col, rango) {
  let { desde, hasta } = rango || {};
  if (!valida(desde)) desde = null;
  if (!valida(hasta)) hasta = null;
  if (desde && hasta && desde > hasta) [desde, hasta] = [hasta, desde];
  const partes = [];
  if (desde) partes.push(`date(${col}) >= '${desde}'`);
  if (hasta) partes.push(`date(${col}) <= '${hasta}'`);
  return partes.length ? partes.join(' AND ') : '1 = 1';
}

// Dos calendarios (Desde y Hasta). Modifica `rango` y llama a alCambiar() cada vez que se elige una fecha.
export function selectorRango(rango, alCambiar) {
  const campo = (clave, etiqueta) => {
    const input = h('input', {
      class: 'campo', type: 'date', value: rango[clave] || '', 'aria-label': etiqueta,
      onChange: (e) => { rango[clave] = e.target.value; alCambiar(); },
    });
    return h('label', { class: 'etiqueta chica' }, etiqueta, input);
  };
  const el = h('div', { class: 'rango' }, campo('desde', 'Desde'), campo('hasta', 'Hasta'));
  el.hidden = true;
  return { el, mostrar: (si) => { el.hidden = !si; } };
}
