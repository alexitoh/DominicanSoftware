// finanzas.js - módulo Finanzas: Análisis Financiero, Balance General, Estado de Resultados, Flujo Efectivo, Variación Capital,
// Conversión Moneda, Diferencia Cambiaria, Presupuesto y Reporte Dinámico.
import { h, dinero } from './ui.js';
import { libroContable, fechaHoy } from './conta-db.js';
import { flujoEfectivo, r2 } from './conta-motor.js';
import {
  RATIOS, analisisFinanciero, periodoAnterior, mismoPeriodoAnioAnterior, balanceComparativo, resultadosComparativo, resultadosPorMes, variacionCapital,
} from './finanzas-motor.js';
import { vistaPresupuesto } from './contabilidad.js';
import { seccionMonedas, seccionDiferencia, seccionDinamicoFinanzas } from './finanzas-monedas.js';
import { campo, fechaInput, tabla, botonCSV, vacio, fechaCorta, renglon } from './conta-ui-comun.js';

export const SECCIONES_FIN = [
  ['analisis', 'Análisis Financiero'], ['balance', 'Balance General'], ['resultados', 'Estado de Resultados'], ['flujo', 'Flujo Efectivo'], ['capital', 'Variación Capital'],
  ['moneda', 'Conversión Moneda'], ['cambiaria', 'Diferencia Cambiaria'], ['presupuesto', 'Presupuesto'], ['dinamico', 'Reporte Dinámico'],
];
let seccion = 'analisis';

export async function vistaFinanzas(raiz) {
  const cuerpo = h('div');
  const barra = h('div', { class: 'segmento conta-tabs', role: 'tablist', 'aria-label': 'Finanzas' });
  async function ir(id) {
    seccion = id;
    barra.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    const nueva = h('div');
    try { await FN[id](nueva, () => ir(id)); } catch (e) { nueva.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar: ${e.message || e}`)); }
    if (seccion === id) cuerpo.replaceChildren(nueva);
  }
  barra.append(...SECCIONES_FIN.map(([id, t]) => h('button', { 'data-id': id, role: 'tab', onClick: () => ir(id) }, t)));
  raiz.replaceChildren(h('header', { class: 'barra' }, h('h1', {}, 'Finanzas')), barra, cuerpo);
  await ir(seccion);
}

const selectDe = (items, valor, etiqueta) => {
  const s = h('select', { class: 'campo', 'aria-label': etiqueta }, items.map(([v, t]) => h('option', { value: v }, t)));
  s.value = valor;
  return s;
};
const inicioAnio = () => `${fechaHoy().slice(0, 4)}-01-01`;
const nombre = (c) => (c.codigo ? `${c.codigo} · ${c.nombre}` : c.nombre);
const varPct = (a, b) => (Math.abs(b) < 0.005 ? (Math.abs(a) < 0.005 ? '' : 'nuevo') : `${a >= b ? '+' : ''}${Math.round(((a - b) / Math.abs(b)) * 1000) / 10}%`);
const pctDe = (m, base) => (Math.abs(base) < 0.005 ? '' : `${Math.round((m / base) * 1000) / 10}%`);

// ---------- Análisis Financiero ----------
const fmt = (formato, v) => (v == null ? '—' : formato === 'dinero' ? dinero(v) : formato === 'veces' ? `${v.toFixed(2)} veces` : formato === 'pct' ? `${v.toFixed(1)} %` : `${Math.round(v)} días`);
const ETIQUETA = { bien: 'Bien', regular: 'Regular', atencion: 'Atención' };

async function seccionAnalisis(raiz) {
  const desde = fechaInput(inicioAnio()); const hasta = fechaInput(fechaHoy());
  const cuerpo = h('div');
  async function pintar() {
    const d = desde.value || inicioAnio(); const hs = hasta.value || fechaHoy();
    const lib = await libroContable({ hasta: hs });
    const a = analisisFinanciero(lib.cuentas, lib.lineas, d, hs);
    const p = periodoAnterior(d, hs);
    const b = analisisFinanciero(lib.cuentas, lib.lineas, p.desde, p.hasta);
    const fila = (r) => {
      const v = a.valores[r.id]; const estado = v != null && r.ok ? r.ok(v) : null;
      return h('div', { class: 'fila inventario' },
        h('span', { class: 'datos' }, h('strong', {}, r.nombre), h('small', {}, r.explica), h('small', {}, `Período anterior: ${fmt(r.formato, b.valores[r.id])}`)),
        h('span', { class: 'precio' }, fmt(r.formato, v), estado ? h('small', { class: `bloque ${estado === 'atencion' ? 'deuda' : ''}` }, ETIQUETA[estado]) : null));
    };
    cuerpo.replaceChildren(
      h('p', { class: 'ayuda' }, `Del ${fechaCorta(d)} al ${fechaCorta(hs)}, comparado con ${fechaCorta(p.desde)} al ${fechaCorta(p.hasta)}. Los activos y pasivos son al cierre de cada período.`),
      h('div', { class: 'totales' }, renglon('Activos', dinero(a.base.activos)), renglon('Pasivos', dinero(a.base.pasivos)), renglon('Patrimonio', dinero(a.base.patrimonio)),
        renglon('Ingresos del período', dinero(a.base.ingresos)), renglon('Utilidad del período', dinero(a.base.utilidad), 'gran')),
      h('h3', { class: 'seccion' }, 'Liquidez y endeudamiento'), h('div', { class: 'lista' }, RATIOS.slice(0, 5).map(fila)),
      h('h3', { class: 'seccion' }, 'Rentabilidad'), h('div', { class: 'lista' }, RATIOS.slice(5, 9).map(fila)),
      h('h3', { class: 'seccion' }, 'Rotación'), h('div', { class: 'lista' }, RATIOS.slice(9).map(fila)),
      h('p', { class: 'ayuda' }, 'Las etiquetas Bien, Regular y Atención son referencias generales, no un diagnóstico: cada negocio tiene su propia realidad. Consúltalo con tu contador.'),
      botonCSV(`analisis-financiero-${d}-${hs}`, ['Indicador', 'Actual', 'Período anterior'], RATIOS.map((r) => [r.nombre, a.valores[r.id] ?? '', b.valores[r.id] ?? ''])));
  }
  desde.addEventListener('change', pintar); hasta.addEventListener('change', pintar);
  raiz.replaceChildren(h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), cuerpo);
  await pintar();
}

// ---------- Balance General ----------
async function seccionBalance(raiz) {
  const hasta = fechaInput(fechaHoy());
  const modo = selectDe([['ninguna', 'Sin comparar'], ['anio', 'Cierre del año anterior'], ['mes', 'Cierre del mes anterior'], ['fecha', 'Otra fecha']], 'anio', 'Comparar con');
  const otra = fechaInput(''); otra.hidden = true;
  const cuerpo = h('div');
  async function pintar() {
    const hs = hasta.value || fechaHoy();
    otra.hidden = modo.value !== 'fecha';
    let comp = null;
    if (modo.value === 'anio') comp = `${+hs.slice(0, 4) - 1}-12-31`;
    else if (modo.value === 'mes') comp = new Date(Date.UTC(+hs.slice(0, 4), +hs.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);
    else if (modo.value === 'fecha') comp = otra.value || null;
    const lib = await libroContable({ hasta: hs });
    const b = balanceComparativo(lib.cuentas, lib.lineas, hs, comp);
    const base = b.total.activos;
    const enc = comp ? ['Cuenta', 'Saldo', '% activos', fechaCorta(comp), 'Variación'] : ['Cuenta', 'Saldo', '% activos'];
    const fila = (x) => (comp ? [nombre(x.cuenta), dinero(x.monto), pctDe(x.monto, base), dinero(x.anterior), varPct(x.monto, x.anterior)] : [nombre(x.cuenta), dinero(x.monto), pctDe(x.monto, base)]);
    const sec = (t, xs, total, ant) => [h('h3', { class: 'seccion' }, t),
      tabla(enc, [...xs.map(fila), comp ? [`Total ${t.toLowerCase()}`, dinero(total), pctDe(total, base), dinero(ant), varPct(total, ant)] : [`Total ${t.toLowerCase()}`, dinero(total), pctDe(total, base)]],
        { num: comp ? [1, 2, 3, 4] : [1, 2], clases: { [xs.length]: 'total' } })];
    cuerpo.replaceChildren(
      h('p', { class: 'ayuda' }, `Al ${fechaCorta(hs)}${comp ? `, comparado con el ${fechaCorta(comp)}` : ''}.`),
      ...sec('Activos', b.activos, b.total.activos, b.anterior?.activos ?? 0), ...sec('Pasivos', b.pasivos, b.total.pasivos, b.anterior?.pasivos ?? 0), ...sec('Patrimonio', b.patrimonio, b.total.patrimonio, b.anterior?.patrimonio ?? 0),
      h('p', { class: b.total.cuadra ? 'ayuda' : 'error' }, b.total.cuadra ? 'El balance cuadra: Activos = Pasivos + Patrimonio.' : 'El balance no cuadra. Revisa los asientos y las cuentas sin asignar.'),
      botonCSV(`balance-general-${hs}`, ['Sección', 'Cuenta', 'Saldo', 'Comparativo'],
        [...b.activos.map((x) => ['Activo', nombre(x.cuenta), x.monto, x.anterior]), ...b.pasivos.map((x) => ['Pasivo', nombre(x.cuenta), x.monto, x.anterior]), ...b.patrimonio.map((x) => ['Patrimonio', nombre(x.cuenta), x.monto, x.anterior])]));
  }
  for (const el of [hasta, modo, otra]) el.addEventListener('change', pintar);
  raiz.replaceChildren(h('div', { class: 'rejilla' }, campo('Al', hasta), campo('Comparar con', modo)), otra, cuerpo);
  await pintar();
}

// ---------- Estado de Resultados ----------
async function seccionResultados(raiz) {
  const desde = fechaInput(inicioAnio()); const hasta = fechaInput(fechaHoy());
  const comp = selectDe([['ninguna', 'Sin comparar'], ['anterior', 'Período anterior'], ['anio', 'Mismo período del año pasado']], 'anterior', 'Comparar con');
  const vista = selectDe([['resumen', 'Resumen'], ['mensual', 'Por mes']], 'resumen', 'Vista');
  const cuerpo = h('div');
  async function pintar() {
    const d = desde.value || inicioAnio(); const hs = hasta.value || fechaHoy();
    const lib = await libroContable({ hasta: hs });
    if (vista.value === 'mensual') {
      const r = resultadosPorMes(lib.cuentas, lib.lineas, d, hs);
      const enc = ['Cuenta', ...r.meses, 'Total'];
      const sec = (t, xs, tots, suma) => [h('h3', { class: 'seccion' }, t),
        tabla(enc, [...xs.map((x) => [nombre(x.cuenta), ...x.meses.map(dinero), dinero(x.total)]), ['Total', ...tots.map(dinero), dinero(suma)]], { num: enc.map((_, i) => i).slice(1), clases: { [xs.length]: 'total' } })];
      cuerpo.replaceChildren(h('p', { class: 'ayuda' }, `Del ${fechaCorta(d)} al ${fechaCorta(hs)}, mes por mes.`),
        ...sec('Ingresos', r.ingresos, r.totalIngresos, r.sumas.ingresos), ...sec('Costos', r.costos, r.totalCostos, r.sumas.costos), ...sec('Gastos', r.gastos, r.totalGastos, r.sumas.gastos),
        tabla(['', ...r.meses, 'Total'], [['Utilidad neta', ...r.utilidad.map(dinero), dinero(r.sumas.utilidad)]], { num: enc.map((_, i) => i).slice(1), clases: { 0: 'total' } }),
        botonCSV(`resultados-mensual-${d}-${hs}`, enc, [...r.ingresos, ...r.costos, ...r.gastos].map((x) => [nombre(x.cuenta), ...x.meses, x.total])));
      return;
    }
    const p = comp.value === 'anterior' ? periodoAnterior(d, hs) : comp.value === 'anio' ? mismoPeriodoAnioAnterior(d, hs) : null;
    const r = resultadosComparativo(lib.cuentas, lib.lineas, d, hs, p);
    const ing = r.actual.totalIngresos;
    const enc = p ? ['Cuenta', 'Monto', '% ingresos', 'Anterior', 'Variación'] : ['Cuenta', 'Monto', '% ingresos'];
    const fila = (x) => (p ? [nombre(x.cuenta), dinero(x.monto), pctDe(x.monto, ing), dinero(x.anterior), varPct(x.monto, x.anterior)] : [nombre(x.cuenta), dinero(x.monto), pctDe(x.monto, ing)]);
    const tot = (m, a) => (p ? [dinero(m), pctDe(m, ing), dinero(a), varPct(m, a)] : [dinero(m), pctDe(m, ing)]);
    const sec = (t, xs, m, a) => [h('h3', { class: 'seccion' }, t), tabla(enc, [...xs.map(fila), ['Total', ...tot(m, a)]], { num: enc.map((_, i) => i).slice(1), clases: { [xs.length]: 'total' } })];
    const A = r.anterior;
    const util = (t, m, a) => h('div', { class: 'totales' }, h('div', {}, h('span', {}, t), h('span', { class: m < 0 ? 'deuda' : '' }, `${dinero(m)} · ${pctDe(m, ing) || '—'} de ingresos`)), p ? h('div', {}, h('span', {}, 'Período de comparación'), h('span', {}, `${dinero(a)} (${varPct(m, a) || '—'})`)) : null);
    cuerpo.replaceChildren(
      h('p', { class: 'ayuda' }, `Del ${fechaCorta(d)} al ${fechaCorta(hs)}${p ? `, comparado con ${fechaCorta(p.desde)} al ${fechaCorta(p.hasta)}` : ''}.`),
      ...sec('Ingresos', r.ingresos, ing, A?.totalIngresos ?? 0), ...sec('Costos', r.costos, r.actual.totalCostos, A?.totalCostos ?? 0), util('Utilidad bruta', r.actual.utilidadBruta, A?.utilidadBruta ?? 0),
      ...sec('Gastos', r.gastos, r.actual.totalGastos, A?.totalGastos ?? 0), util('Utilidad neta', r.actual.utilidadNeta, A?.utilidadNeta ?? 0),
      botonCSV(`estado-resultados-${d}-${hs}`, ['Sección', 'Cuenta', 'Monto', 'Comparativo'], [...r.ingresos.map((x) => ['Ingreso', nombre(x.cuenta), x.monto, x.anterior]), ...r.costos.map((x) => ['Costo', nombre(x.cuenta), x.monto, x.anterior]), ...r.gastos.map((x) => ['Gasto', nombre(x.cuenta), x.monto, x.anterior]), ['Utilidad neta', '', r.actual.utilidadNeta, A?.utilidadNeta ?? '']]));
  }
  for (const el of [desde, hasta, comp, vista]) el.addEventListener('change', pintar);
  raiz.replaceChildren(h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), h('div', { class: 'rejilla' }, campo('Comparar con', comp), campo('Vista', vista)), cuerpo);
  await pintar();
}

// ---------- Flujo Efectivo ----------
async function seccionFlujo(raiz) {
  const desde = fechaInput(inicioAnio()); const hasta = fechaInput(fechaHoy());
  const cuerpo = h('div');
  async function pintar() {
    const d = desde.value || inicioAnio(); const hs = hasta.value || fechaHoy();
    const lib = await libroContable({ hasta: hs });
    const ids = lib.cuentas.filter((c) => c.rol === 'caja' || c.rol === 'banco' || c.rol === 'caja_chica' || (c.codigo.startsWith('111') && !c.grupo)).map((c) => c.id);
    const f = flujoEfectivo(lib.cuentas, lib.lineas, ids, d, hs);
    const sec = (t, xs, tot) => [h('h3', { class: 'seccion' }, t), xs.length ? tabla(['Concepto', 'Monto'], [...xs.map((x) => [nombre(x.cuenta), dinero(x.monto)]), ['Total', dinero(tot)]], { num: [1], clases: { [xs.length]: 'total' } }) : vacio('Sin movimientos.')];
    cuerpo.replaceChildren(
      h('p', { class: 'ayuda' }, `Método directo, del ${fechaCorta(d)} al ${fechaCorta(hs)}: lo que realmente entró y salió de caja y bancos, agrupado por la cuenta contraria.`),
      h('div', { class: 'totales' }, renglon('Efectivo al inicio', dinero(f.inicial))),
      ...sec('Actividades de operación', f.operacion, f.totalOperacion), ...sec('Actividades de inversión', f.inversion, f.totalInversion), ...sec('Actividades de financiamiento', f.financiamiento, f.totalFinanciamiento),
      h('div', { class: 'totales' }, renglon('Variación del período', dinero(f.variacion)), renglon('Efectivo al final', dinero(f.final), 'gran')),
      botonCSV(`flujo-efectivo-${d}-${hs}`, ['Sección', 'Concepto', 'Monto'], [...f.operacion.map((x) => ['Operación', nombre(x.cuenta), x.monto]), ...f.inversion.map((x) => ['Inversión', nombre(x.cuenta), x.monto]), ...f.financiamiento.map((x) => ['Financiamiento', nombre(x.cuenta), x.monto])]));
  }
  desde.addEventListener('change', pintar); hasta.addEventListener('change', pintar);
  raiz.replaceChildren(h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), cuerpo);
  await pintar();
}

// ---------- Variación Capital ----------
async function seccionCapital(raiz) {
  const desde = fechaInput(inicioAnio()); const hasta = fechaInput(fechaHoy());
  const cuerpo = h('div');
  async function pintar() {
    const d = desde.value || inicioAnio(); const hs = hasta.value || fechaHoy();
    const lib = await libroContable({ hasta: hs });
    const v = variacionCapital(lib.cuentas, lib.lineas, d, hs);
    cuerpo.replaceChildren(
      h('p', { class: 'ayuda' }, `Cómo cambió el patrimonio del ${fechaCorta(d)} al ${fechaCorta(hs)}.`),
      tabla(['Concepto', 'Monto'], [['Patrimonio al inicio', dinero(v.inicial)], ...v.filas.map((f) => [f.concepto, dinero(f.monto)]), ['Patrimonio al final', dinero(v.final)]], { num: [1], clases: { 0: 'total', [v.filas.length + 1]: 'total' } }),
      h('div', { class: 'totales' }, renglon('Variación del período', dinero(v.variacion), `gran ${v.variacion < 0 ? 'deuda' : ''}`)),
      h('h3', { class: 'seccion' }, 'Patrimonio al final, por cuenta'),
      tabla(['Cuenta', 'Saldo'], v.cuentas.map((x) => [nombre(x.cuenta), dinero(x.monto)]), { num: [1] }),
      botonCSV(`variacion-capital-${d}-${hs}`, ['Concepto', 'Monto'], [['Patrimonio al inicio', v.inicial], ...v.filas.map((f) => [f.concepto, f.monto]), ['Patrimonio al final', v.final]]));
  }
  desde.addEventListener('change', pintar); hasta.addEventListener('change', pintar);
  raiz.replaceChildren(h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), cuerpo);
  await pintar();
}

const FN = {
  analisis: seccionAnalisis, balance: seccionBalance, resultados: seccionResultados, flujo: seccionFlujo, capital: seccionCapital,
  moneda: seccionMonedas, cambiaria: seccionDiferencia, presupuesto: vistaPresupuesto, dinamico: seccionDinamicoFinanzas,
};
void r2;
