// i18n.js - idioma de la app (español / inglés)
// Los textos de la app están escritos en español. Con el idioma en inglés, cada texto que se pinta en pantalla
// pasa por traducir(): busca el texto exacto en el diccionario, luego las plantillas con {}, y si no hay coincidencia
// prueba por oraciones y por partes separadas con ", ". Lo que no esté en el diccionario se muestra tal cual.
import { EN } from './idioma-en.js';

let idioma = 'es';
export const getIdioma = () => idioma;
export function setIdioma(l) {
  idioma = l === 'en' ? 'en' : 'es';
  cache.clear();
  try { document.documentElement.lang = idioma; } catch { /* sin documento */ }
}

const exactos = new Map();
const plantillas = [];
const escapar = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
for (const [clave, valor] of Object.entries(EN)) {
  if (clave.includes('{}')) {
    // Cada {} captura texto sin cruzar un fin de oración (". "), para que las plantillas no se traguen otras frases
    const re = new RegExp(`^${clave.split('{}').map(escapar).join('((?:(?![.!?]\\s).)+?)')}$`, 's');
    plantillas.push({ re, valor, peso: clave.replace(/\{\}/g, '').length });
  } else {
    exactos.set(clave, valor);
  }
}
plantillas.sort((a, b) => b.peso - a.peso);

const cache = new Map();

function aplicar(s) {
  if (exactos.has(s)) return exactos.get(s);
  for (const p of plantillas) {
    const m = p.re.exec(s);
    if (m) {
      let i = 0;
      return p.valor.replace(/\{(\d*)\}/g, (_, n) => {
        const g = m[n ? Number(n) : ++i];
        return g == null ? '' : traducir(g, 'en');
      });
    }
  }
  return null;
}

function traducirNucleo(core) {
  const directa = aplicar(core);
  if (directa != null) return directa;
  const oraciones = core.split(/(?<=[.!?])\s+/);
  if (oraciones.length > 1) {
    const t = oraciones.map((o) => traducirNucleo(o));
    if (t.some((x, i) => x !== oraciones[i])) return t.join(' ');
  }
  const partes = core.split(', ');
  if (partes.length > 1) {
    const t = partes.map((p) => traducirNucleo(p));
    if (t.some((x, i) => x !== partes[i])) return t.join(', ');
  }
  return core;
}

// Traduce un texto al idioma indicado (por defecto el de la app). En español devuelve el texto sin cambios.
export function traducir(texto, lang = idioma) {
  if (lang !== 'en' || typeof texto !== 'string') return texto;
  const core = texto.trim();
  if (!core) return texto;
  const clave = core;
  let r = cache.get(clave);
  if (r === undefined) {
    r = traducirNucleo(core);
    if (cache.size > 3000) cache.clear();
    cache.set(clave, r);
  }
  if (r === core) return texto;
  const ini = texto.slice(0, texto.indexOf(core));
  return ini + r + texto.slice(ini.length + core.length);
}

// Hace que las asignaciones directas a textContent también se traduzcan
let instalado = false;
export function instalarTraductor() {
  if (instalado || typeof Node === 'undefined') return;
  const d = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  if (!d?.set) return;
  Object.defineProperty(Node.prototype, 'textContent', {
    configurable: true,
    enumerable: d.enumerable,
    get: d.get,
    set(v) { d.set.call(this, typeof v === 'string' ? traducir(v) : v); },
  });
  instalado = true;
}
