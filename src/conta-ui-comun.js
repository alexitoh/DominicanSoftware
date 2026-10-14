// conta-ui-comun.js - piezas de interfaz compartidas por las pestañas de Contabilidad.
import { h, dinero, toast } from './ui.js';
import { exportarTexto } from './database.js';
import { csv } from './itbis.js';
import { TIPOS_CUENTA } from './conta-plan.js';

export const campo = (etiqueta, input, ayuda) => h('label', { class: 'etiqueta' }, etiqueta, input, ayuda ? h('small', { class: 'ayuda' }, ayuda) : null);
export const numero = (valor = '', min = '0') => h('input', { class: 'campo', type: 'number', inputmode: 'decimal', min, step: '0.01', value: valor === 0 ? '' : valor });
export const fechaInput = (valor = '') => h('input', { class: 'campo', type: 'date', value: valor });
export const texto = (valor = '', ph = '') => h('input', { class: 'campo', value: valor ?? '', placeholder: ph, autocomplete: 'off' });
export const renglon = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));
export const monto = (n) => (Math.abs(n) < 0.005 ? '' : dinero(n));
export const vacio = (msg) => h('p', { class: 'ayuda vacio-chico' }, msg);

// Lista de cuentas para un <select>: solo las de detalle y activas (títulos opcionales)
export function selectCuentas(cuentas, { valor = '', vacioTexto = '— Elige una cuenta —', titulos = false, tipos = null } = {}) {
  const s = h('select', { class: 'campo', 'aria-label': 'Cuenta' }, h('option', { value: '' }, vacioTexto),
    cuentas.filter((c) => (titulos || !c.grupo) && c.activo !== 0 && (!tipos || tipos.includes(c.tipo)))
      .map((c) => h('option', { value: String(c.id) }, `${c.codigo} · ${c.nombre}`)));
  s.value = valor ? String(valor) : '';
  return s;
}

// Tabla con desplazamiento horizontal. filas: arreglos de texto o nodos; num: columnas alineadas a la derecha
export function tabla(encabezados, filas, { num = [], clases = null } = {}) {
  const celda = (tag, v, i) => h(tag, { class: num.includes(i) ? 'num' : '' }, v);
  return h('div', { class: 'tabla-caja' }, h('table', { class: 'tabla' },
    h('thead', {}, h('tr', {}, encabezados.map((t, i) => celda('th', t, i)))),
    h('tbody', {}, filas.map((f, r) => h('tr', { class: clases?.[r] || '' }, f.map((v, i) => celda('td', v, i)))))));
}

// Botón para guardar/compartir un reporte como CSV (se abre en Excel)
export function botonCSV(nombre, encabezados, filas) {
  return h('button', {
    class: 'btn',
    onClick: async () => {
      try { await exportarTexto(`${nombre}.csv`, csv(encabezados, filas.map((f) => f.map((x) => (typeof x === 'number' ? x.toFixed(2) : String(x ?? ''))))), 'text/csv'); toast('Archivo listo'); }
      catch (e) { toast(e.message || 'No se pudo exportar', 'error'); }
    },
  }, 'Exportar a Excel (CSV)');
}

export const nombreTipo = (t) => TIPOS_CUENTA[t]?.nombre || t;
export const fechaCorta = (f) => String(f || '').slice(0, 10).split('-').reverse().join('/');
export const limpiar = (e) => String(e?.message || e);
