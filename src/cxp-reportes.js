// cxp-reportes.js - CxP: Reporte CxP (antigüedad de saldos) y Reporte Dinámico (tabla dinámica de documentos)
import { h, dinero } from './ui.js';
import { reporteCxp, TRAMOS_CXP, listarTiposProveedor, movimientosCxp, tablaDinamicaCxp, TIPOS_DOC_CXP, DIMENSIONES_CXP } from './cxp-db.js';
import { fechaHoy } from './conta-db.js';
import { selectDe } from './cxp-docs.js';
import { campo, fechaInput, tabla, vacio, fechaCorta, botonCSV, renglon } from './conta-ui-comun.js';

// ---------- Reporte CxP ----------
export async function seccionReporteCxp(raiz) {
  const tipos = await listarTiposProveedor();
  const hasta = fechaInput(fechaHoy());
  const tipo = selectDe(tipos.map((t) => [t.id, t.nombre]), { vacioTexto: 'Todos los tipos', etiqueta: 'Tipo de suplidor' });
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar suplidor', 'aria-label': 'Buscar suplidor' });
  const cuerpo = h('div');
  let detalle = false; let r = null;
  async function cargar() { r = await reporteCxp({ hasta: hasta.value || fechaHoy(), tipoProveedorId: Number(tipo.value) || null }); pintar(); }
  function pintar() {
    const q = buscar.value.trim().toLowerCase();
    const ps = r.proveedores.filter((p) => !q || p.proveedor.toLowerCase().includes(q));
    const t = r.totales;
    const filas = ps.map((p) => [p.proveedor, String(p.facturas), ...TRAMOS_CXP.map((x) => dinero(p[x[0]])), dinero(p.total)]);
    const det = r.detalle.filter((f) => !q || f.proveedor.toLowerCase().includes(q));
    cuerpo.replaceChildren(
      h('div', { class: 'totales' }, renglon('Total por pagar', dinero(t.total), 'gran'), renglon('Vencido', dinero(t.vencido), t.vencido > 0.005 ? 'deuda' : ''), renglon('Facturas pendientes', String(t.facturas))),
      ps.length ? tabla(['Suplidor', 'Fact.', ...TRAMOS_CXP.map((x) => x[1]), 'Total'], [...filas, ['Total', String(t.facturas), ...TRAMOS_CXP.map((x) => dinero(t[x[0]])), dinero(t.total)]],
        { num: [1, 2, 3, 4, 5, 6, 7], clases: { [filas.length]: 'total' } }) : vacio('No hay saldos por pagar con esos filtros.'),
      h('p', { class: 'ayuda' }, 'Los tramos cuentan los días de atraso desde la fecha límite de cada factura. "Al día" = aún no vence.'),
      h('button', { class: 'btn', onClick: () => { detalle = !detalle; pintar(); } }, detalle ? 'Ocultar detalle de facturas' : 'Ver detalle de facturas'),
      detalle && det.length ? tabla(['Factura', 'Suplidor', 'Vence', 'Atraso', 'Saldo'], det.map((f) => [f.numero, f.proveedor, fechaCorta(f.vence), f.atraso > 0 ? `${f.atraso} d` : 'al día', dinero(f.saldo)]), { num: [3, 4] }) : null,
      ps.length ? botonCSV(`cxp-${r.hasta}`, ['Suplidor', 'Tipo de suplidor', 'Facturas', ...TRAMOS_CXP.map((x) => x[1]), 'Total'],
        ps.map((p) => [p.proveedor, p.tipo_proveedor, p.facturas, ...TRAMOS_CXP.map((x) => p[x[0]]), p.total])) : null);
  }
  hasta.addEventListener('change', cargar); tipo.addEventListener('change', cargar); buscar.addEventListener('input', pintar);
  raiz.replaceChildren(h('p', { class: 'ayuda' }, 'Lo que le debes a los suplidores, agrupado por cuánto tiempo llevan vencidas las facturas.'),
    campo('Al día', hasta), campo('Tipo de suplidor', tipo), buscar, cuerpo);
  await cargar();
}

// ---------- Reporte Dinámico ----------
export async function seccionDinamicoCxp(raiz) {
  const hoy = fechaHoy();
  const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`); const hasta = fechaInput(hoy);
  const dim = selectDe(Object.entries(DIMENSIONES_CXP), { valor: 'proveedor', etiqueta: 'Agrupar por' });
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Filtrar por suplidor, número o concepto', 'aria-label': 'Filtrar' });
  const marcados = new Set(Object.keys(TIPOS_DOC_CXP));
  const cajas = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Documentos' });
  const cuerpo = h('div');
  let movs = [];
  async function cargar() { movs = await movimientosCxp({ desde: desde.value || '0000-00-00', hasta: hasta.value || hoy }); pintar(); }
  function pintar() {
    cajas.replaceChildren(...Object.entries(TIPOS_DOC_CXP).map(([id, t]) => h('button', { 'aria-pressed': String(marcados.has(id)), onClick: () => { if (marcados.has(id)) marcados.delete(id); else marcados.add(id); pintar(); } }, t)));
    const r = tablaDinamicaCxp(movs, { dimension: dim.value, tipos: [...marcados], busqueda: buscar.value });
    const cols = Object.keys(TIPOS_DOC_CXP).filter((k) => marcados.has(k));
    const f = (g) => [g.clave, String(g.n), ...cols.map((k) => dinero(g[k])), dinero(g.neto)];
    cuerpo.replaceChildren(
      r.filas.length ? tabla([DIMENSIONES_CXP[dim.value], 'Docs.', ...cols.map((k) => TIPOS_DOC_CXP[k]), 'Neto'], [...r.filas.map(f), f({ clave: 'Total', ...r.total })],
        { num: cols.map((_, i) => i + 1).concat([cols.length + 1, cols.length + 2]), clases: { [r.filas.length]: 'total' } }) : vacio('No hay movimientos con esos filtros.'),
      h('p', { class: 'ayuda' }, 'Neto = facturas + notas de débito − notas de crédito − pagos − anticipos. Es el movimiento del período, no el saldo total. Las compras de contado no cuentan: no crean deuda.'),
      r.filas.length ? botonCSV(`cxp-dinamico-${dim.value}`, [DIMENSIONES_CXP[dim.value], 'Documentos', ...cols.map((k) => TIPOS_DOC_CXP[k]), 'Neto'], r.filas.map((g) => [g.clave, g.n, ...cols.map((k) => g[k]), g.neto])) : null);
  }
  for (const el of [desde, hasta]) el.addEventListener('change', cargar);
  dim.addEventListener('change', pintar); buscar.addEventListener('input', pintar);
  raiz.replaceChildren(h('p', { class: 'ayuda' }, 'Arma tu propio reporte: elige cómo agrupar y qué documentos incluir.'),
    h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), campo('Agrupar por', dim), cajas, buscar, cuerpo);
  await cargar();
}
