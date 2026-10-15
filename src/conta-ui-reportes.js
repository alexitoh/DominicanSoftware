// conta-ui-reportes.js - pestaña Reportes contables
import { h, dinero } from './ui.js';
import { libroContable, saldosPorCobrar, saldosPorPagar, listarCentros, fechaHoy } from './conta-db.js';
import { balanza, estadoResultados, balanceGeneral, mayor, diario, flujoEfectivo, antiguedad, TRAMOS_ANTIGUEDAD, porCentroCosto, mapaRoles, r2 } from './conta-motor.js';
import { rangoInicial } from './fechas.js';
import { vistaImpuestos } from './reportes-fiscal.js';
import { campo, tabla, botonCSV, vacio, monto, fechaCorta, selectCuentas } from './conta-ui-comun.js';

const REPORTES = [
  ['balance', 'Balance general'], ['resultados', 'Estado de resultados'], ['balanza', 'Balanza de comprobación'], ['diario', 'Libro diario'],
  ['mayor', 'Libro mayor'], ['flujo', 'Flujo de efectivo'], ['cxc', 'Antigüedad de cuentas por cobrar'], ['cxp', 'Antigüedad de cuentas por pagar'], ['centros', 'Por centro de costo'],
  ['impuestos', 'Impuestos (ITBIS, 607, 606 y 608)'],
];

export async function vistaReportes(raiz) {
  const est = { tipo: 'balance', rango: { ...rangoInicial(), desde: `${fechaHoy().slice(0, 4)}-01-01` }, cuenta: '' };
  const cuerpo = h('div', { class: 'cuerpo-reporte' });
  const sel = h('select', { class: 'campo', 'aria-label': 'Reporte', onChange: (e) => { est.tipo = e.target.value; pintar(); } }, REPORTES.map(([k, t]) => h('option', { value: k }, t)));
  const desde = h('input', { class: 'campo', type: 'date', value: est.rango.desde, 'aria-label': 'Desde', onChange: (e) => { est.rango.desde = e.target.value; pintar(); } });
  const hasta = h('input', { class: 'campo', type: 'date', value: est.rango.hasta, 'aria-label': 'Hasta', onChange: (e) => { est.rango.hasta = e.target.value; pintar(); } });
  const rango = h('div', { class: 'rango' }, campo('Desde', desde), campo('Hasta', hasta));
  raiz.replaceChildren(h('div', { class: 'filtros' }, sel, rango), cuerpo);

  async function pintar() {
    const { desde: d, hasta: hs } = est.rango;
    if (est.tipo === 'impuestos') { rango.hidden = true; await vistaImpuestos(cuerpo); return; } // tiene su propio selector de mes
    rango.hidden = false;
    desde.parentElement.hidden = ['balance', 'cxc', 'cxp'].includes(est.tipo);
    const lib = await libroContable({ hasta: hs });
    const { cuentas, lineas } = lib;
    const nombre = (c) => `${c.codigo} · ${c.nombre}`;
    let nodos = [];
    const exp = (n, enc, filas) => botonCSV(n, enc, filas);

    if (est.tipo === 'balance') {
      const b = balanceGeneral(cuentas, lineas, hs);
      const bloque = (t, xs, total) => [h('h3', { class: 'seccion' }, t), tabla(['Cuenta', 'Saldo'], [...xs.map((x) => [nombre(x.cuenta), dinero(x.monto)]), ['Total ' + t.toLowerCase(), dinero(total)]], { num: [1], clases: { [xs.length]: 'total' } })];
      nodos = [h('p', { class: 'ayuda' }, `Al ${fechaCorta(hs)}`),
        ...bloque('Activos', b.activos, b.totalActivos), ...bloque('Pasivos', b.pasivos, b.totalPasivos),
        ...bloque('Patrimonio', [...b.patrimonio, { cuenta: { codigo: '', nombre: 'Resultado del ejercicio en curso' }, monto: b.resultado }], b.totalPatrimonio),
        h('p', { class: b.cuadra ? 'ayuda' : 'error' }, b.cuadra ? 'El balance cuadra: Activos = Pasivos + Patrimonio.' : `No cuadra, diferencia ${dinero(b.diferencia)}. Revisa asientos y cuentas sin asignar.`),
        exp(`balance-${hs}`, ['Sección', 'Cuenta', 'Saldo'], [...b.activos.map((x) => ['Activo', nombre(x.cuenta), x.monto]), ...b.pasivos.map((x) => ['Pasivo', nombre(x.cuenta), x.monto]), ...b.patrimonio.map((x) => ['Patrimonio', nombre(x.cuenta), x.monto]), ['Patrimonio', 'Resultado del ejercicio', b.resultado]])];
    } else if (est.tipo === 'resultados') {
      const e = estadoResultados(cuentas, lineas, d, hs);
      const sec = (t, xs, tot) => [h('h3', { class: 'seccion' }, t), tabla(['Cuenta', 'Monto'], [...xs.map((x) => [nombre(x.cuenta), dinero(x.monto)]), ['Total', dinero(tot)]], { num: [1], clases: { [xs.length]: 'total' } })];
      nodos = [h('p', { class: 'ayuda' }, `Del ${fechaCorta(d)} al ${fechaCorta(hs)}`), ...sec('Ingresos', e.ingresos, e.totalIngresos), ...sec('Costos', e.costos, e.totalCostos),
        h('div', { class: 'totales' }, h('div', {}, h('span', {}, 'Utilidad bruta'), h('span', {}, dinero(e.utilidadBruta)))),
        ...sec('Gastos', e.gastos, e.totalGastos),
        h('div', { class: 'totales' }, h('div', {}, h('span', {}, 'Utilidad neta'), h('span', { class: e.utilidadNeta < 0 ? 'deuda' : '' }, dinero(e.utilidadNeta)))),
        exp(`estado-resultados-${d}-${hs}`, ['Sección', 'Cuenta', 'Monto'], [...e.ingresos.map((x) => ['Ingreso', nombre(x.cuenta), x.monto]), ...e.costos.map((x) => ['Costo', nombre(x.cuenta), x.monto]), ...e.gastos.map((x) => ['Gasto', nombre(x.cuenta), x.monto]), ['Utilidad neta', '', e.utilidadNeta]])];
    } else if (est.tipo === 'balanza') {
      const b = balanza(cuentas, lineas, d, hs);
      const t = b.totales;
      const filas = b.filas.map((f) => [nombre(f.cuenta), monto(f.inicialDeudor), monto(f.inicialAcreedor), monto(f.debe), monto(f.haber), monto(f.finalDeudor), monto(f.finalAcreedor)]);
      nodos = [tabla(['Cuenta', 'Inicial deudor', 'Inicial acreedor', 'Débitos', 'Créditos', 'Final deudor', 'Final acreedor'], [...filas, ['Totales', dinero(t.inicialDeudor), dinero(t.inicialAcreedor), dinero(t.debe), dinero(t.haber), dinero(t.finalDeudor), dinero(t.finalAcreedor)]], { num: [1, 2, 3, 4, 5, 6], clases: { [filas.length]: 'total' } }),
        h('p', { class: Math.abs(t.debe - t.haber) < 0.01 ? 'ayuda' : 'error' }, Math.abs(t.debe - t.haber) < 0.01 ? 'Débitos = Créditos ✓' : 'Débitos y créditos no coinciden.'),
        exp(`balanza-${d}-${hs}`, ['Cuenta', 'Inicial deudor', 'Inicial acreedor', 'Débitos', 'Créditos', 'Final deudor', 'Final acreedor'], b.filas.map((f) => [nombre(f.cuenta), f.inicialDeudor, f.inicialAcreedor, f.debe, f.haber, f.finalDeudor, f.finalAcreedor]))];
    } else if (est.tipo === 'diario') {
      const as = diario(lineas, d, hs);
      const mapa = new Map(cuentas.map((c) => [c.id, c]));
      const filas = []; const csvF = [];
      for (const a of as) for (const l of a.lineas) { filas.push([fechaCorta(a.fecha), a.concepto, nombre(mapa.get(l.cuenta_id)), monto(l.debe), monto(l.haber)]); csvF.push([a.fecha, a.numero, a.concepto, nombre(mapa.get(l.cuenta_id)), l.debe, l.haber]); }
      nodos = filas.length ? [tabla(['Fecha', 'Concepto', 'Cuenta', 'Débito', 'Crédito'], filas, { num: [3, 4] }), exp(`diario-${d}-${hs}`, ['Fecha', 'Asiento', 'Concepto', 'Cuenta', 'Débito', 'Crédito'], csvF)] : [vacio('Sin asientos en ese período.')];
    } else if (est.tipo === 'mayor') {
      const s = selectCuentas(cuentas, { valor: est.cuenta, vacioTexto: '— Elige la cuenta —' });
      s.addEventListener('change', () => { est.cuenta = s.value; pintar(); });
      nodos = [campo('Cuenta', s)];
      const c = cuentas.find((x) => String(x.id) === String(est.cuenta));
      if (c) {
        const m = mayor(c, lineas, d, hs);
        nodos.push(tabla(['Fecha', 'Concepto', 'Débito', 'Crédito', 'Saldo'], [['', 'Saldo inicial', '', '', dinero(m.inicial)], ...m.movimientos.map((x) => [fechaCorta(x.fecha), x.concepto, monto(x.debe), monto(x.haber), dinero(x.saldo)]), ['', 'Totales', dinero(m.totalDebe), dinero(m.totalHaber), dinero(m.final)]], { num: [2, 3, 4], clases: { [m.movimientos.length + 1]: 'total' } }),
          exp(`mayor-${c.codigo}-${d}-${hs}`, ['Fecha', 'Concepto', 'Débito', 'Crédito', 'Saldo'], m.movimientos.map((x) => [x.fecha, x.concepto, x.debe, x.haber, x.saldo])));
      }
    } else if (est.tipo === 'flujo') {
      const ids = cuentas.filter((c) => c.rol === 'caja' || c.rol === 'banco' || (c.codigo.startsWith('111') && !c.grupo)).map((c) => c.id);
      const f = flujoEfectivo(cuentas, lineas, ids, d, hs);
      const sec = (t, xs, tot) => [h('h3', { class: 'seccion' }, t), xs.length ? tabla(['Concepto', 'Monto'], [...xs.map((x) => [nombre(x.cuenta), dinero(x.monto)]), ['Total', dinero(tot)]], { num: [1], clases: { [xs.length]: 'total' } }) : vacio('Sin movimientos.')];
      nodos = [h('p', { class: 'ayuda' }, 'Método directo: entradas y salidas reales de caja y bancos, agrupadas por la cuenta contraria.'),
        h('div', { class: 'totales' }, h('div', {}, h('span', {}, 'Efectivo al inicio'), h('span', {}, dinero(f.inicial)))),
        ...sec('Actividades de operación', f.operacion, f.totalOperacion), ...sec('Actividades de inversión', f.inversion, f.totalInversion), ...sec('Actividades de financiamiento', f.financiamiento, f.totalFinanciamiento),
        h('div', { class: 'totales' }, h('div', {}, h('span', {}, 'Variación del período'), h('span', {}, dinero(f.variacion))), h('div', {}, h('span', {}, 'Efectivo al final'), h('span', {}, dinero(f.final)))),
        exp(`flujo-efectivo-${d}-${hs}`, ['Sección', 'Concepto', 'Monto'], [...f.operacion.map((x) => ['Operación', nombre(x.cuenta), x.monto]), ...f.inversion.map((x) => ['Inversión', nombre(x.cuenta), x.monto]), ...f.financiamiento.map((x) => ['Financiamiento', nombre(x.cuenta), x.monto])])];
    } else if (est.tipo === 'cxc' || est.tipo === 'cxp') {
      const items = await (est.tipo === 'cxc' ? saldosPorCobrar() : saldosPorPagar());
      const a = antiguedad(items, fechaHoy());
      const enc = [est.tipo === 'cxc' ? 'Cliente' : 'Proveedor', ...TRAMOS_ANTIGUEDAD.map((x) => x[1]), 'Total'];
      const filas = a.terceros.map((t) => [t.tercero, ...TRAMOS_ANTIGUEDAD.map(([k]) => monto(t[k])), dinero(t.total)]);
      nodos = a.terceros.length ? [tabla(enc, [...filas, ['Totales', ...TRAMOS_ANTIGUEDAD.map(([k]) => dinero(a.totales[k])), dinero(a.totales.total)]], { num: [1, 2, 3, 4, 5, 6], clases: { [filas.length]: 'total' } }),
        exp(`antiguedad-${est.tipo}`, enc, a.terceros.map((t) => [t.tercero, ...TRAMOS_ANTIGUEDAD.map(([k]) => t[k]), t.total]))] : [vacio('No hay saldos pendientes.')];
    } else if (est.tipo === 'centros') {
      const centros = await listarCentros();
      const r = porCentroCosto(cuentas, centros, lineas, d, hs);
      nodos = r.length ? [tabla(['Centro', 'Ingresos', 'Costos', 'Gastos', 'Resultado'], r.map((x) => [x.centro.nombre, dinero(x.ingresos), dinero(x.costos), dinero(x.gastos), dinero(x.resultado)]), { num: [1, 2, 3, 4] }),
        h('p', { class: 'ayuda' }, 'Solo incluye las líneas de asientos manuales a las que se les asignó centro de costo.'),
        exp(`centros-costo-${d}-${hs}`, ['Centro', 'Ingresos', 'Costos', 'Gastos', 'Resultado'], r.map((x) => [x.centro.nombre, x.ingresos, x.costos, x.gastos, x.resultado]))]
        : [vacio('Sin movimientos con centro de costo. Créalos en Ajustes y asígnalos al registrar asientos.')];
    }
    void mapaRoles; void r2;
    cuerpo.replaceChildren(...(lib.faltantes.length ? [h('p', { class: 'error' }, 'Hay documentos sin contabilizar porque falta asignar cuentas (pestaña Cuentas → Función).')] : []), ...nodos);
  }
  await pintar();
}
