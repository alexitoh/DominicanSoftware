// cxc-reportes.js - CxC: Reporte CxC (antigüedad de saldos) y Reporte Dinámico (tabla dinámica de documentos)
import { h, dinero } from './ui.js';
import {
  reporteCxc, TRAMOS_CXC, listarTiposCliente, listarCondiciones, movimientosCxc, tablaDinamicaCxc, TIPOS_DOC_CXC, DIMENSIONES_CXC,
} from './cxc-db.js';
import { fechaHoy } from './conta-db.js';
import { campo, fechaInput, tabla, vacio, fechaCorta, botonCSV, renglon } from './conta-ui-comun.js';

const selectDe = (items, { valor = '', vacioTexto = null, etiqueta = 'Elegir' } = {}) => {
  const s = h('select', { class: 'campo', 'aria-label': etiqueta }, vacioTexto != null ? h('option', { value: '' }, vacioTexto) : null, items.map(([v, t]) => h('option', { value: String(v) }, t)));
  s.value = String(valor ?? '');
  if (s.value === '' && vacioTexto == null && items.length) s.value = String(items[0][0]);
  return s;
};

// ---------- Reporte CxC ----------
export async function seccionReporteCxc(raiz) {
  const [tipos, conds] = await Promise.all([listarTiposCliente(), listarCondiciones()]);
  const hasta = fechaInput(fechaHoy());
  const tipo = selectDe(tipos.map((t) => [t.id, t.nombre]), { vacioTexto: 'Todos los tipos', etiqueta: 'Tipo de cliente' });
  const cond = selectDe(conds.map((t) => [t.id, t.nombre]), { vacioTexto: 'Todas las condiciones', etiqueta: 'Condición de pago' });
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar cliente', 'aria-label': 'Buscar cliente' });
  const cuerpo = h('div');
  let detalle = false;
  let r = null;

  async function cargar() {
    r = await reporteCxc({ hasta: hasta.value || fechaHoy(), tipoClienteId: Number(tipo.value) || null, condicionId: Number(cond.value) || null });
    pintar();
  }
  function pintar() {
    const q = buscar.value.trim().toLowerCase();
    const cs = r.clientes.filter((c) => !q || c.cliente.toLowerCase().includes(q));
    const t = r.totales;
    const filas = cs.map((c) => [c.cliente, String(c.facturas), ...TRAMOS_CXC.map((x) => dinero(c[x[0]])), dinero(c.total)]);
    const det = r.detalle.filter((f) => !q || f.cliente.toLowerCase().includes(q));
    cuerpo.replaceChildren(
      h('div', { class: 'totales' }, renglon('Total por cobrar', dinero(t.total), 'gran'), renglon('Vencido', dinero(t.vencido), t.vencido > 0.005 ? 'deuda' : ''), renglon('Facturas pendientes', String(t.facturas))),
      cs.length ? tabla(['Cliente', 'Fact.', ...TRAMOS_CXC.map((x) => x[1]), 'Total'], [...filas, ['Total', String(t.facturas), ...TRAMOS_CXC.map((x) => dinero(t[x[0]])), dinero(t.total)]],
        { num: [1, 2, 3, 4, 5, 6, 7], clases: { [filas.length]: 'total' } }) : vacio('No hay saldos por cobrar con esos filtros.'),
      h('p', { class: 'ayuda' }, 'Los tramos cuentan los días de atraso desde la fecha límite de cada factura. "Al día" = aún no vence.'),
      h('button', { class: 'btn', onClick: () => { detalle = !detalle; pintar(); } }, detalle ? 'Ocultar detalle de facturas' : 'Ver detalle de facturas'),
      detalle && det.length ? tabla(['Factura', 'Cliente', 'Vence', 'Atraso', 'Saldo'], det.map((f) => [f.numero, f.cliente, fechaCorta(f.vence), f.atraso > 0 ? `${f.atraso} d` : 'al día', dinero(f.saldo)]), { num: [3, 4] }) : null,
      cs.length ? botonCSV(`cxc-${r.hasta}`, ['Cliente', 'Tipo de cliente', 'Condición', 'Facturas', ...TRAMOS_CXC.map((x) => x[1]), 'Total'],
        cs.map((c) => [c.cliente, c.tipo_cliente, c.condicion, c.facturas, ...TRAMOS_CXC.map((x) => c[x[0]]), c.total])) : null);
  }
  for (const el of [hasta, tipo, cond]) el.addEventListener('change', cargar);
  buscar.addEventListener('input', pintar);
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Lo que te deben los clientes, agrupado por cuánto tiempo llevan vencidos.'),
    campo('Al día', hasta), h('div', { class: 'rejilla' }, campo('Tipo de cliente', tipo), campo('Condición de pago', cond)), buscar, cuerpo);
  await cargar();
}

// ---------- Reporte Dinámico ----------
export async function seccionDinamico(raiz) {
  const hoy = fechaHoy();
  const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`); const hasta = fechaInput(hoy);
  const dim = selectDe(Object.entries(DIMENSIONES_CXC), { valor: 'cliente', etiqueta: 'Agrupar por' });
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Filtrar por cliente, número o motivo', 'aria-label': 'Filtrar' });
  const marcados = new Set(Object.keys(TIPOS_DOC_CXC));
  const cajas = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Documentos' });
  const cuerpo = h('div');
  let movs = [];

  async function cargar() { movs = await movimientosCxc({ desde: desde.value || '0000-00-00', hasta: hasta.value || hoy }); pintar(); }
  function pintar() {
    cajas.replaceChildren(...Object.entries(TIPOS_DOC_CXC).map(([id, t]) => h('button', { 'aria-pressed': String(marcados.has(id)), onClick: () => { if (marcados.has(id)) marcados.delete(id); else marcados.add(id); pintar(); } }, t)));
    const r = tablaDinamicaCxc(movs, { dimension: dim.value, tipos: [...marcados], busqueda: buscar.value });
    const cols = Object.keys(TIPOS_DOC_CXC).filter((k) => marcados.has(k));
    const f = (g) => [g.clave, String(g.n), ...cols.map((k) => dinero(g[k])), dinero(g.neto)];
    cuerpo.replaceChildren(
      r.filas.length ? tabla([DIMENSIONES_CXC[dim.value], 'Docs.', ...cols.map((k) => TIPOS_DOC_CXC[k]), 'Neto'], [...r.filas.map(f), f({ clave: 'Total', ...r.total })],
        { num: cols.map((_, i) => i + 1).concat([cols.length + 1, cols.length + 2]), clases: { [r.filas.length]: 'total' } }) : vacio('No hay movimientos con esos filtros.'),
      h('p', { class: 'ayuda' }, 'Neto = facturas + notas de débito − notas de crédito − recibos − anticipos. Es el movimiento del período, no el saldo total.'),
      r.filas.length ? botonCSV(`cxc-dinamico-${dim.value}`, [DIMENSIONES_CXC[dim.value], 'Documentos', ...cols.map((k) => TIPOS_DOC_CXC[k]), 'Neto'], r.filas.map((g) => [g.clave, g.n, ...cols.map((k) => g[k]), g.neto])) : null);
  }
  for (const el of [desde, hasta]) el.addEventListener('change', cargar);
  dim.addEventListener('change', pintar); buscar.addEventListener('input', pintar);
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Arma tu propio reporte: elige cómo agrupar y qué documentos incluir.'),
    h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), campo('Agrupar por', dim), cajas, buscar, cuerpo);
  await cargar();
}
