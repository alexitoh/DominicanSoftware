// finanzas-motor.js - cálculos puros de Finanzas (sin base de datos): fechas de comparación, razones financieras,
// variación del capital, balance y resultados comparativos, resultados por mes y tabla dinámica del libro.
import { balanceGeneral, estadoResultados, saldoNatural, r2 } from './conta-motor.js';
import { TIPOS_CUENTA } from './conta-plan.js';

const t = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const DIA = 86400000;
export const sumarDias = (f, n) => iso(t(f) + n * DIA);
export const diasEntre = (a, b) => Math.round((t(b) - t(a)) / DIA);

// Períodos para comparar
export function periodoAnterior(desde, hasta) {
  const dias = diasEntre(desde, hasta) + 1;
  return { desde: sumarDias(desde, -dias), hasta: sumarDias(desde, -1) };
}
const anioAntes = (f) => { const a = +f.slice(0, 4) - 1; const r = `${a}-${f.slice(5)}`; return r.endsWith('02-29') ? `${a}-02-28` : r; };
export const mismoPeriodoAnioAnterior = (desde, hasta) => ({ desde: anioAntes(desde), hasta: anioAntes(hasta) });

// ---------- Análisis financiero (razones) ----------
export const RATIOS = [
  { id: 'capitalTrabajo', nombre: 'Capital de trabajo', formato: 'dinero', explica: 'Activos corrientes menos pasivos corrientes: lo que te sobra a corto plazo después de pagar lo que debes.', ok: (v) => (v >= 0 ? 'bien' : 'atencion') },
  { id: 'corriente', nombre: 'Razón corriente', formato: 'veces', explica: 'Activos corrientes ÷ pasivos corrientes. Por encima de 1 puedes cubrir tus deudas de corto plazo.', ok: (v) => (v >= 1.5 ? 'bien' : v >= 1 ? 'regular' : 'atencion') },
  { id: 'acida', nombre: 'Prueba ácida', formato: 'veces', explica: 'Igual que la razón corriente pero sin contar el inventario (que tarda en venderse).', ok: (v) => (v >= 1 ? 'bien' : v >= 0.7 ? 'regular' : 'atencion') },
  { id: 'endeudamiento', nombre: 'Endeudamiento', formato: 'pct', explica: 'Qué parte de tus activos está financiada con deudas.', ok: (v) => (v <= 50 ? 'bien' : v <= 70 ? 'regular' : 'atencion') },
  { id: 'deudaPatrimonio', nombre: 'Deuda sobre patrimonio', formato: 'veces', explica: 'Cuánto debes por cada peso propio invertido en el negocio.', ok: (v) => (v <= 1 ? 'bien' : v <= 2 ? 'regular' : 'atencion') },
  { id: 'margenBruto', nombre: 'Margen bruto', formato: 'pct', explica: 'Lo que queda de cada venta después del costo de la mercancía.', ok: null },
  { id: 'margenNeto', nombre: 'Margen neto', formato: 'pct', explica: 'Lo que queda de cada venta después de todos los costos y gastos.', ok: (v) => (v > 0 ? 'bien' : 'atencion') },
  { id: 'roa', nombre: 'Rendimiento de los activos (ROA)', formato: 'pct', explica: 'Utilidad del período ÷ activos. No está anualizado: depende del largo del período.', ok: null },
  { id: 'roe', nombre: 'Rendimiento del patrimonio (ROE)', formato: 'pct', explica: 'Utilidad del período ÷ patrimonio. No está anualizado.', ok: null },
  { id: 'diasCobro', nombre: 'Días de cobro', formato: 'dias', explica: 'Cuántos días de ventas tienes pendientes de cobrar (usa todas las ventas, no solo las de crédito).', ok: null },
  { id: 'diasInventario', nombre: 'Días de inventario', formato: 'dias', explica: 'Cuántos días de costo de ventas representa tu inventario.', ok: null },
  { id: 'diasPago', nombre: 'Días de pago', formato: 'dias', explica: 'Cuántos días de costos tienes pendientes de pagar a proveedores.', ok: null },
];
const sumaPor = (xs, pred) => r2(xs.filter((x) => pred(x.cuenta)).reduce((s, x) => s + x.monto, 0));
const div = (a, b) => (b > 0.004 ? a / b : null);

export function analisisFinanciero(cuentas, lineas, desde, hasta) {
  const b = balanceGeneral(cuentas, lineas, hasta);
  const e = estadoResultados(cuentas, lineas, desde, hasta);
  const corr = (c, ps) => ps.some((p) => c.codigo.startsWith(p));
  const ac = sumaPor(b.activos, (c) => corr(c, ['11', '12', '13']));
  const pc = sumaPor(b.pasivos, (c) => c.codigo.startsWith('21'));
  const inv = sumaPor(b.activos, (c) => c.rol === 'inventario');
  const cxc = sumaPor(b.activos, (c) => c.rol === 'cxc');
  const cxp = sumaPor(b.pasivos, (c) => c.rol === 'cxp');
  const dias = diasEntre(desde, hasta) + 1;
  const ing = e.totalIngresos;
  const pct = (v) => (v == null ? null : r2(v * 100));
  const valores = {
    capitalTrabajo: r2(ac - pc), corriente: div(ac, pc), acida: div(ac - inv, pc),
    endeudamiento: pct(div(b.totalPasivos, b.totalActivos)), deudaPatrimonio: div(b.totalPasivos, b.totalPatrimonio),
    margenBruto: pct(div(e.utilidadBruta, ing)), margenNeto: pct(div(e.utilidadNeta, ing)),
    roa: pct(div(e.utilidadNeta, b.totalActivos)), roe: pct(div(e.utilidadNeta, b.totalPatrimonio)),
    diasCobro: div(cxc * dias, ing), diasInventario: div(inv * dias, e.totalCostos), diasPago: div(cxp * dias, e.totalCostos),
  };
  for (const k of Object.keys(valores)) if (valores[k] != null) valores[k] = r2(valores[k]);
  return { valores, base: { activosCorrientes: ac, pasivosCorrientes: pc, inventario: inv, cxc, cxp, activos: b.totalActivos, pasivos: b.totalPasivos, patrimonio: b.totalPatrimonio, ingresos: ing, utilidad: e.utilidadNeta, dias } };
}

// ---------- Balance general comparativo ----------
// Devuelve las tres secciones con el saldo de cada cuenta en las dos fechas (la segunda es opcional)
export function balanceComparativo(cuentas, lineas, hasta, comparar = null) {
  const b = balanceGeneral(cuentas, lineas, hasta);
  const c = comparar ? balanceGeneral(cuentas, lineas, comparar) : null;
  const unir = (xs, ys) => {
    const m = new Map();
    for (const x of xs) m.set(x.cuenta.id, { cuenta: x.cuenta, monto: x.monto, anterior: 0 });
    for (const y of ys || []) { const f = m.get(y.cuenta.id) || { cuenta: y.cuenta, monto: 0, anterior: 0 }; f.anterior = y.monto; m.set(y.cuenta.id, f); }
    return [...m.values()].sort((p, q) => p.cuenta.codigo.localeCompare(q.cuenta.codigo));
  };
  const resultado = { cuenta: { codigo: '', nombre: 'Resultado del ejercicio en curso' }, monto: b.resultado, anterior: c ? c.resultado : 0 };
  return {
    activos: unir(b.activos, c?.activos), pasivos: unir(b.pasivos, c?.pasivos), patrimonio: [...unir(b.patrimonio, c?.patrimonio), resultado],
    total: { activos: b.totalActivos, pasivos: b.totalPasivos, patrimonio: b.totalPatrimonio, cuadra: b.cuadra },
    anterior: c ? { activos: c.totalActivos, pasivos: c.totalPasivos, patrimonio: c.totalPatrimonio } : null,
  };
}

// ---------- Estado de resultados comparativo y por mes ----------
export function resultadosComparativo(cuentas, lineas, desde, hasta, comparar = null) {
  const e = estadoResultados(cuentas, lineas, desde, hasta);
  const a = comparar ? estadoResultados(cuentas, lineas, comparar.desde, comparar.hasta) : null;
  const sec = (k) => {
    const m = new Map();
    for (const x of e[k]) m.set(x.cuenta.id, { cuenta: x.cuenta, monto: x.monto, anterior: 0 });
    for (const y of a?.[k] || []) { const f = m.get(y.cuenta.id) || { cuenta: y.cuenta, monto: 0, anterior: 0 }; f.anterior = y.monto; m.set(y.cuenta.id, f); }
    return [...m.values()].sort((p, q) => p.cuenta.codigo.localeCompare(q.cuenta.codigo));
  };
  return { ingresos: sec('ingresos'), costos: sec('costos'), gastos: sec('gastos'), actual: e, anterior: a };
}

export function mesesEntre(desde, hasta) {
  const out = [];
  let a = +desde.slice(0, 4); let m = +desde.slice(5, 7);
  const fin = hasta.slice(0, 7);
  while (`${a}-${String(m).padStart(2, '0')}` <= fin && out.length < 36) { out.push(`${a}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; a++; } }
  return out;
}
// Ingresos, costos y gastos por cuenta en cada mes del rango
export function resultadosPorMes(cuentas, lineas, desde, hasta) {
  const meses = mesesEntre(desde, hasta);
  const porMes = meses.map((mes) => {
    const ini = mes === desde.slice(0, 7) ? desde : `${mes}-01`;
    const fin = mes === hasta.slice(0, 7) ? hasta : `${mes}-31`;
    return estadoResultados(cuentas, lineas, ini, fin);
  });
  const sec = (k) => {
    const m = new Map();
    porMes.forEach((e, i) => { for (const x of e[k]) { const f = m.get(x.cuenta.id) || { cuenta: x.cuenta, meses: meses.map(() => 0), total: 0 }; f.meses[i] = x.monto; f.total = r2(f.total + x.monto); m.set(x.cuenta.id, f); } });
    return [...m.values()].sort((p, q) => p.cuenta.codigo.localeCompare(q.cuenta.codigo));
  };
  const tot = (k) => porMes.map((e) => e[k]);
  const sumar = (xs) => r2(xs.reduce((s, x) => s + x, 0));
  return {
    meses, ingresos: sec('ingresos'), costos: sec('costos'), gastos: sec('gastos'),
    totalIngresos: tot('totalIngresos'), totalCostos: tot('totalCostos'), totalGastos: tot('totalGastos'), utilidad: tot('utilidadNeta'),
    sumas: { ingresos: sumar(tot('totalIngresos')), costos: sumar(tot('totalCostos')), gastos: sumar(tot('totalGastos')), utilidad: sumar(tot('utilidadNeta')) },
  };
}

// ---------- Variación del capital (cambios en el patrimonio) ----------
export function variacionCapital(cuentas, lineas, desde, hasta) {
  const antes = sumarDias(desde, -1);
  const b0 = balanceGeneral(cuentas, lineas, antes); const b1 = balanceGeneral(cuentas, lineas, hasta);
  const e = estadoResultados(cuentas, lineas, desde, hasta);
  const delta = (pred) => r2(sumaPor(b1.patrimonio, pred) - sumaPor(b0.patrimonio, pred));
  const capital = delta((c) => c.rol === 'capital');
  const retiros = delta((c) => c.codigo === '3401');
  const reval = delta((c) => c.rol === 'superavit_reval');
  const inicial = b0.totalPatrimonio; const final = b1.totalPatrimonio;
  const otros = r2(final - inicial - e.utilidadNeta - capital - retiros - reval);
  const filas = [
    { concepto: 'Aportes de capital', monto: capital }, { concepto: 'Utilidad (pérdida) del período', monto: e.utilidadNeta },
    { concepto: 'Retiros del propietario', monto: retiros }, { concepto: 'Superávit por revalorización de activos', monto: reval },
    ...(Math.abs(otros) > 0.004 ? [{ concepto: 'Otros movimientos (asientos manuales al patrimonio)', monto: otros }] : []),
  ];
  return { inicial, filas, final, variacion: r2(final - inicial), cuentas: b1.patrimonio };
}

// ---------- Tabla dinámica del libro contable ----------
export const FILAS_DINAMICO = { cuenta: 'Cuenta', tipo: 'Tipo de cuenta', mes: 'Mes', origen: 'Origen del asiento', centro: 'Centro de costo' };
export const COLUMNAS_DINAMICO = { ninguna: 'Sin columnas', mes: 'Mes', tipo: 'Tipo de cuenta', origen: 'Origen del asiento' };
export const MEDIDAS_DINAMICO = { neto: 'Movimiento neto', debe: 'Débitos', haber: 'Créditos' };
export const ORIGEN_ETIQUETA = { manual: 'Asiento manual', venta: 'Ventas', cobro: 'Cobros', compra: 'Compras', pagocompra: 'Pagos a proveedores', gasto: 'Gastos', activo: 'Activos fijos', baja: 'Baja de activos', revalorizacion: 'Revalorización', depreciacion: 'Depreciación', nomina: 'Nómina', pagonomina: 'Pago de nómina', banco: 'Banco', cajachica: 'Caja chica', notacredito: 'Notas de crédito', notadebito: 'Notas de débito', anticipo: 'Anticipos', aplicacion: 'Anticipos aplicados' };

export function tablaDinamicaLibro(lineas, cuentas, { desde = '0000-01-01', hasta = '9999-12-31', tipos = Object.keys(TIPOS_CUENTA), filas = 'cuenta', columnas = 'ninguna', medida = 'neto', centros = [] } = {}) {
  if (!FILAS_DINAMICO[filas]) throw new Error('Agrupación de filas no válida.');
  if (!COLUMNAS_DINAMICO[columnas]) throw new Error('Agrupación de columnas no válida.');
  if (!MEDIDAS_DINAMICO[medida]) throw new Error('Medida no válida.');
  const porId = new Map(cuentas.map((c) => [c.id, c]));
  const nomCentro = new Map(centros.map((c) => [c.id, c.nombre]));
  const clave = (dim, l, c) => {
    if (dim === 'cuenta') return `${c.codigo} · ${c.nombre}`;
    if (dim === 'tipo') return TIPOS_CUENTA[c.tipo].nombre;
    if (dim === 'mes') return l.fecha.slice(0, 7);
    if (dim === 'origen') return ORIGEN_ETIQUETA[l.origen] || l.origen;
    return l.centro_id ? (nomCentro.get(l.centro_id) || 'Centro') : '(sin centro)';
  };
  const cols = new Set(); const mapa = new Map();
  for (const l of lineas) {
    if (l.fecha < desde || l.fecha > hasta || l.tipoAsiento === 'cierre') continue;
    const c = porId.get(l.cuenta_id);
    if (!c || c.grupo || !tipos.includes(c.tipo)) continue;
    const v = medida === 'debe' ? l.debe : medida === 'haber' ? l.haber : saldoNatural(c.tipo, l.debe, l.haber);
    if (!v) continue;
    const f = clave(filas, l, c); const col = columnas === 'ninguna' ? 'Total' : clave(columnas, l, c);
    cols.add(col);
    const g = mapa.get(f) || { clave: f, valores: {}, total: 0 };
    g.valores[col] = r2((g.valores[col] || 0) + v); g.total = r2(g.total + v);
    mapa.set(f, g);
  }
  const columnasOrden = [...cols].sort((a, b) => a.localeCompare(b));
  const lista = [...mapa.values()].sort((a, b) => (['cuenta', 'mes'].includes(filas) ? a.clave.localeCompare(b.clave) : b.total - a.total));
  const totales = {}; for (const c of columnasOrden) totales[c] = r2(lista.reduce((s, g) => s + (g.valores[c] || 0), 0));
  return { columnas: columnasOrden, filas: lista, totales, total: r2(lista.reduce((s, g) => s + g.total, 0)) };
}
