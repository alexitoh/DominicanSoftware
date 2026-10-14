// rnc-registro.js - al registrar un negocio: busca el RNC en el padrón de la DGII (vía el servidor) y completa el nombre y la categoría.
import { h } from './ui.js';
import { nube } from './nube.js';
import { buscarRNC } from './dgii.js';
import { limpiarDocumento } from './fiscal.js';
import { ejecutar } from './database.js';

// rnc, nombre y categoria son los { input } de los campos. antes() se llama antes de consultar (por ejemplo, para guardar la dirección del servidor).
export function enlazarBusquedaRnc({ rnc, nombre, categoria, antes = () => {} }) {
  const msg = h('p', { class: 'ayuda', role: 'status' });
  let consultado = '';
  let nombreAuto = ''; // nombre puesto por la búsqueda: se puede reemplazar si cambian el RNC, pero no uno escrito a mano
  let encontrado = null;
  let yaRegistrado = false;
  const cliente = { consultarRNC: async (n) => { const r = await nube.consultarRNCRegistro(n); yaRegistrado = !!r.registrado; return r; } };

  const mostrar = (texto, error = false) => { msg.className = error ? 'error' : 'ayuda'; msg.textContent = texto; };
  const limpiar = () => { encontrado = null; categoria.input.value = ''; if (nombre.input.value === nombreAuto) nombre.input.value = ''; nombreAuto = ''; };

  async function buscar() {
    const n = limpiarDocumento(rnc.input.value);
    if (!n) { mostrar(''); return null; }
    consultado = n;
    mostrar('Buscando en la DGII…');
    try { await antes(); } catch (e) { mostrar(e.message || String(e), true); return null; }
    const r = await buscarRNC(n, { cliente, hay: () => true });
    if (limpiarDocumento(rnc.input.value) !== n) return null; // cambiaron el RNC mientras se buscaba
    limpiar();
    if (r.resultado === 'activo') {
      encontrado = r.datos;
      if (!nombre.input.value.trim() || nombre.input.value === nombreAuto) { nombre.input.value = r.datos.nombre; nombreAuto = r.datos.nombre; }
      categoria.input.value = r.datos.regimen || 'No informada';
      mostrar(yaRegistrado
        ? `${r.datos.nombre} · ACTIVO en la DGII. Pero ya existe un negocio registrado con este RNC: si es el tuyo, entra con "Ya tengo una cuenta".`
        : `${r.datos.nombre} · ACTIVO en la DGII. Datos completados.`, yaRegistrado);
    } else if (r.resultado === 'inactivo') {
      mostrar(`${r.datos.nombre}: su estatus en la DGII es ${r.datos.estado}. No se completaron los datos; revisa el RNC o regulariza el negocio en la DGII.`, true);
    } else {
      mostrar(r.resultado === 'noEncontrado' ? `${r.mensaje} Revisa el número o escribe los datos a mano.` : r.mensaje, r.resultado === 'noEncontrado' || r.resultado === 'invalido');
    }
    return r;
  }

  rnc.input.addEventListener('blur', () => { const n = limpiarDocumento(rnc.input.value); if ((n.length === 9 || n.length === 11) && n !== consultado) buscar(); });
  rnc.input.addEventListener('input', () => { if (limpiarDocumento(rnc.input.value) !== consultado) { mostrar(''); if (encontrado) limpiar(); } });
  const el = h('div', { class: 'cuerpo' }, h('button', { type: 'button', class: 'btn chico', onClick: buscar }, 'Buscar en la DGII'), msg);
  return { el, buscar, datos: () => encontrado };
}

// Guarda en este dispositivo los datos del negocio (se sincronizan con la nube)
export async function guardarDatosNegocio({ nombre, rnc, categoria }) {
  const pares = [['negocio_nombre', String(nombre || '').trim()], ['negocio_rnc', limpiarDocumento(rnc)], ['negocio_categoria', String(categoria || '').trim()]];
  for (const [k, v] of pares) if (v) await ejecutar('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)', [k, v]);
}
