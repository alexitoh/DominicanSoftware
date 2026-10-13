// ui.js - utilidades de interfaz (sin librerías)

import { traducir } from './i18n.js';

let moneda = 'RD$';
export const setMoneda = (m) => { moneda = m || 'RD$'; };

export const dinero = (n) =>
  `${moneda} ${Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ATRIBUTOS_TEXTO = new Set(['placeholder', 'aria-label', 'title', 'alt']);

// Crea un elemento: h('button', { class: 'btn', onClick: fn }, 'Texto')
export function h(tag, attrs = {}, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, ATRIBUTOS_TEXTO.has(k) ? traducir(String(v)) : v);
  }
  for (const c of hijos.flat()) {
    if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(traducir(String(c))));
  }
  return el;
}

export function toast(mensaje, tipo = 'ok') {
  const t = h('div', { class: `toast ${tipo}`, role: 'status' }, mensaje);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// Hoja inferior (ventana emergente). Devuelve la función para cerrarla.
export function hoja(titulo, contenido) {
  const fondo = h('div', { class: 'fondo', onClick: (e) => { if (e.target === fondo) cerrar(); } });
  const cerrar = () => fondo.remove();
  fondo.append(
    h('section', { class: 'hoja', role: 'dialog', 'aria-label': titulo },
      h('header', {},
        h('h2', {}, titulo),
        h('button', { class: 'icono', 'aria-label': 'Cerrar', onClick: cerrar }, '✕')),
      contenido)
  );
  document.body.append(fondo);
  return cerrar;
}

export function confirmar(titulo, texto, textoBoton = 'Confirmar') {
  return new Promise((resolver) => {
    const cerrar = hoja(titulo,
      h('div', { class: 'cuerpo' },
        h('p', {}, texto),
        h('div', { class: 'acciones' },
          h('button', { class: 'btn', onClick: () => { cerrar(); resolver(false); } }, 'Cancelar'),
          h('button', { class: 'btn peligro', onClick: () => { cerrar(); resolver(true); } }, textoBoton))));
  });
}

// Medidor de stock tipo ecualizador: 10 segmentos que se encienden según el nivel.
export function medidor(stock, minimo) {
  const segmentos = 10;
  const tope = minimo > 0 ? minimo * 3 : 10;
  const encendidos = Math.min(segmentos, Math.max(0, Math.round((stock / tope) * segmentos)));
  const estado = stock <= 0 ? 'agotado' : minimo > 0 && stock <= minimo ? 'bajo' : 'ok';
  return h('span', { class: `medidor ${estado}`, role: 'img', 'aria-label': `Stock: ${stock}` },
    Array.from({ length: segmentos }, (_, i) => h('span', { class: i < encendidos ? 'seg on' : 'seg' })));
}
