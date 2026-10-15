// conta-ui-diarios.js - pestaña Asientos con tres secciones: Diario, Diarios Cancelados y Concepto
import { h, hoja, toast, dinero } from './ui.js';
import { diariosCancelados, listarConceptos, guardarConcepto, eliminarConcepto, TIPOS_CONCEPTO, listarCuentas } from './conta-db.js';
import { vistaAsientos } from './conta-ui-asientos.js';
import { CATEGORIAS } from './caja.js';
import { campo, texto, selectCuentas, tabla, vacio, fechaCorta, limpiar, renglon } from './conta-ui-comun.js';

const SECCIONES = [['diario', 'Diario'], ['cancelados', 'Diarios Cancelados'], ['conceptos', 'Concepto']];
let seccion = 'diario';

export async function vistaDiarios(raiz) {
  const cuerpo = h('div');
  const barra = h('div', { class: 'segmento conta-tabs', role: 'tablist', 'aria-label': 'Asientos' });
  async function ir(id) {
    seccion = id;
    barra.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    const nueva = h('div');
    try { await FN[id](nueva, () => ir(id)); } catch (e) { nueva.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar: ${e.message || e}`)); }
    if (seccion === id) cuerpo.replaceChildren(nueva);
  }
  barra.append(...SECCIONES.map(([id, t]) => h('button', { 'data-id': id, role: 'tab', onClick: () => ir(id) }, t)));
  raiz.replaceChildren(barra, cuerpo);
  await ir(seccion);
}

async function cancelados(raiz) {
  const [lista, cuentas] = await Promise.all([diariosCancelados(), listarCuentas()]);
  const porId = new Map(cuentas.map((c) => [c.id, c]));
  function detalle(a) {
    hoja(`${a.numero} · ${a.concepto}`, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' }, renglon('Fecha del asiento', fechaCorta(a.fecha)), renglon('Anulado por', a.anulado_por || '—'),
        renglon('Fecha de anulación', a.anulado_fecha ? `${fechaCorta(a.anulado_fecha)} ${String(a.anulado_fecha).slice(11, 16)}` : '—')),
      h('p', { class: 'ayuda' }, `Motivo: ${a.anulado_motivo || 'no se indicó'}`),
      tabla(['Cuenta', 'Débito', 'Crédito'], a.lineas.map((l) => [`${porId.get(l.cuenta_id)?.codigo || ''} · ${porId.get(l.cuenta_id)?.nombre || ''}`, l.debe ? dinero(l.debe) : '', l.haber ? dinero(l.haber) : '']), { num: [1, 2] })));
  }
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Asientos manuales anulados. Nunca se borran: aquí queda quién los anuló, cuándo y por qué. No afectan los reportes.'),
    lista.length ? h('div', { class: 'lista' }, lista.map((a) => h('button', { class: 'fila inventario apagada', onClick: () => detalle(a) },
      h('span', { class: 'datos' }, h('strong', {}, a.concepto),
        h('small', {}, [fechaCorta(a.fecha), a.numero, a.anulado_por && `por ${a.anulado_por}`, a.anulado_motivo].filter(Boolean).join(' · '))),
      h('span', { class: 'precio' }, dinero(a.lineas.reduce((s, l) => s + l.debe, 0)))))) : vacio('No hay diarios cancelados.'));
}

async function conceptos(raiz, recargar) {
  const [lista, cuentas] = await Promise.all([listarConceptos(), listarCuentas(true)]);
  const hojas = cuentas.filter((c) => !c.grupo);

  function formulario(k = null) {
    const nombre = texto(k?.nombre ?? '', 'Ej. Pago de seguro');
    const tipo = h('select', { class: 'campo', 'aria-label': 'Tipo' }, Object.entries(TIPOS_CONCEPTO).map(([v, t]) => h('option', { value: v }, t)));
    tipo.value = k?.tipo ?? 'asiento';
    const debe = selectCuentas(hojas, { valor: k?.cuenta_debe_id || '', vacioTexto: 'Sin cuenta sugerida' });
    const haber = selectCuentas(hojas, { valor: k?.cuenta_haber_id || '', vacioTexto: 'Sin cuenta sugerida' });
    const cat = h('select', { class: 'campo', 'aria-label': 'Categoría de gasto' }, h('option', { value: '' }, 'Ninguna'), CATEGORIAS.map((x) => h('option', { value: x }, x)));
    cat.value = k?.categoria_gasto ?? '';
    const notas = texto(k?.notas ?? '', 'Opcional');
    const activo = h('input', { type: 'checkbox', checked: k ? !!k.activo : true, 'aria-label': 'Activo' });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(k ? 'Editar concepto' : 'Nuevo concepto', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), campo('Se usa en', tipo, 'Asiento: lista rápida al crear un asiento manual. Gasto: lista rápida al registrar un gasto.'),
      campo('Cuenta al débito', debe, 'Solo para conceptos de asiento.'), campo('Cuenta al crédito', haber, 'Solo para conceptos de asiento.'),
      campo('Categoría de gasto', cat, 'Solo para conceptos de gasto.'), campo('Notas', notas),
      h('label', { class: 'etiqueta' }, h('span', {}, 'Disponible'), activo), error,
      h('div', { class: 'acciones' },
        k ? h('button', { class: 'btn peligro', onClick: async () => { try { await eliminarConcepto(k.id); cerrar(); toast('Eliminado'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Eliminar') : null,
        h('button', { class: 'btn primario', onClick: async () => {
          try {
            await guardarConcepto({ id: k?.id ?? null, nombre: nombre.value, tipo: tipo.value, cuenta_debe_id: Number(debe.value) || null, cuenta_haber_id: Number(haber.value) || null, categoria_gasto: cat.value, notas: notas.value, activo: activo.checked ? 1 : 0 });
            cerrar(); toast('Guardado'); await recargar();
          } catch (e) { error.textContent = limpiar(e); }
        } }, 'Guardar'))));
  }
  const nom = (c, d, n) => (c ? `${d} ${c}` : null) ?? n;
  void nom;
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Los conceptos son plantillas para escribir menos: eliges uno y se rellena el texto, las cuentas o la categoría.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nuevo concepto')),
    lista.length ? h('div', { class: 'lista' }, lista.map((k) => h('button', { class: `fila inventario ${k.activo ? '' : 'apagada'}`, onClick: () => formulario(k) },
      h('span', { class: 'datos' }, h('strong', {}, k.nombre),
        h('small', {}, [TIPOS_CONCEPTO[k.tipo], k.debe_codigo && `Débito ${k.debe_codigo}`, k.haber_codigo && `Crédito ${k.haber_codigo}`, k.categoria_gasto].filter(Boolean).join(' · '))))))
      : vacio('Aún no hay conceptos.'));
}

const FN = { diario: vistaAsientos, cancelados, conceptos };
