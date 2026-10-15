// conta-motor.js - motor contable sin dependencias (se prueba solo).
// Idea central: el libro contable = asientos manuales (guardados) + asientos AUTOMÁTICOS que se derivan de los documentos
// del sistema (ventas, compras, cobros, pagos, gastos, activos fijos, nómina y movimientos de banco). Como se derivan,
// siempre coinciden con los documentos: si se anula una venta, su asiento desaparece solo.
import { TIPOS_CUENTA } from './conta-plan.js';

export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const dia = (f) => String(f || '').slice(0, 10);

// ---------- Fechas ----------
export const finDeMes = (periodo) => { // 'AAAA-MM' -> 'AAAA-MM-DD'
  const [a, m] = periodo.split('-').map(Number);
  return `${periodo}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
export const sumarMeses = (periodo, n) => {
  const [a, m] = periodo.split('-').map(Number);
  const t = a * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

// ---------- Roles ----------
export function mapaRoles(cuentas) {
  const m = {};
  for (const c of cuentas) if (c.rol && c.activo !== 0 && !m[c.rol]) m[c.rol] = c;
  return m;
}
export const rolMetodo = (metodo) => (['tarjeta', 'transferencia', 'cheque'].includes(metodo) ? 'banco' : 'caja');

// ---------- Depreciación (línea recta, mensual) ----------
// Empieza el mes siguiente a la adquisición y se registra el último día de cada mes. Termina al agotar la vida útil o al dar de baja.
// Si el activo se revalorizó (a.revals), desde el mes siguiente a esa fecha se deprecia el nuevo valor en libros sobre la vida que le queda.
export function calendarioDepreciacion(a, hasta) {
  if (a.deprecia === 0) return []; // terrenos y otros activos que no se deprecian
  if (a.metodo_dep === 'saldo_decreciente' && a.tasa_dep > 0) return calendarioSaldoDecreciente(a, hasta);
  const vida = Math.max(1, parseInt(a.vida_meses, 10) || 1);
  const residual = a.residual || 0;
  const revs = [...(a.revals || [])].sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : (x.id || 0) - (y.id || 0)));
  let cuota = r2((a.costo - residual) / vida);
  let libros = a.costo;
  let ri = 0;
  const out = [];
  for (let k = 1; k <= vida; k++) {
    const fecha = finDeMes(sumarMeses(dia(a.fecha_adq).slice(0, 7), k));
    if (fecha > hasta) break;
    if (a.estado === 'baja' && a.fecha_baja && fecha > dia(a.fecha_baja)) break;
    while (ri < revs.length && revs[ri].fecha < fecha) {
      libros = r2(revs[ri].valor_nuevo);
      cuota = r2(Math.max(0, libros - residual) / (vida - k + 1));
      ri++;
    }
    const monto = k === vida ? r2(Math.max(0, libros - residual)) : cuota;
    libros = r2(libros - monto);
    out.push({ fecha, monto });
  }
  return out;
}

// Saldo decreciente: cada mes se deprecia (tasa anual / 12) del valor en libros al inicio del mes, sin bajar del valor residual.
function calendarioSaldoDecreciente(a, hasta) {
  const residual = a.residual || 0;
  const tasa = a.tasa_dep / 100 / 12;
  const revs = [...(a.revals || [])].sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : (x.id || 0) - (y.id || 0)));
  let libros = a.costo;
  let ri = 0;
  const out = [];
  for (let k = 1; k <= 1200; k++) {
    const fecha = finDeMes(sumarMeses(dia(a.fecha_adq).slice(0, 7), k));
    if (fecha > hasta) break;
    if (a.estado === 'baja' && a.fecha_baja && fecha > dia(a.fecha_baja)) break;
    while (ri < revs.length && revs[ri].fecha < fecha) { libros = r2(revs[ri].valor_nuevo); ri++; }
    const monto = r2(Math.min(libros - residual, libros * tasa));
    if (!(monto >= 0.01)) break;
    libros = r2(libros - monto);
    out.push({ fecha, monto });
  }
  return out;
}

// Costo (con revalorizaciones), depreciación acumulada y valor en libros de un activo a una fecha
export function valoresActivo(a, fecha) {
  const retirado = a.estado === 'baja' && a.fecha_baja && dia(a.fecha_baja) <= fecha;
  const costo = r2(a.costo + (a.revals || []).filter((r) => r.fecha <= fecha).reduce((s, r) => s + r.ajuste, 0));
  const dep = r2(calendarioDepreciacion(a, fecha).reduce((s, d) => s + d.monto, 0));
  return { costo, dep, libros: retirado ? 0 : r2(costo - dep), retirado: !!retirado };
}

// ---------- Asientos automáticos ----------
// Cada línea: { rol | cuenta_id | categoria, debe, haber, detalle }. La resolución a cuentas reales la hace construirLibro.
export function asientosAutomaticos(f, { inicio = '', hasta = '9999-12-31' } = {}) {
  const out = [];
  const ok = (fecha) => fecha >= (inicio || '0000-00-00') && fecha <= hasta;
  const add = (origen, numero, fecha, concepto, lineas, extra = {}) => {
    fecha = dia(fecha);
    if (!ok(fecha)) return;
    const ls = lineas.filter((l) => (l.debe || 0) > 0.004 || (l.haber || 0) > 0.004).map((l) => ({ ...l, debe: r2(l.debe || 0), haber: r2(l.haber || 0) }));
    if (ls.length) out.push({ ref: `${origen}:${numero}`, origen, numero, fecha, concepto, lineas: ls, ...extra });
  };

  const ventasOk = new Map();
  for (const v of f.ventas || []) {
    if (v.estado !== 'completada') continue;
    ventasOk.set(v.numero, v);
    const neto = r2(v.total - v.itbis);
    const serv = v.subtotal > 0 ? r2(neto * Math.min((v.servicios || 0) / v.subtotal, 1)) : 0;
    const credito = v.metodo_pago === 'credito';
    add('venta', v.numero, v.fecha, `Venta ${v.numero}${v.cliente ? ` · ${v.cliente}` : ''}`, [
      { rol: credito ? 'cxc' : rolMetodo(v.metodo_pago), debe: v.total },
      { rol: 'ventas', haber: r2(neto - serv) }, { rol: 'servicios', haber: serv }, { rol: 'itbis_pagar', haber: v.itbis },
      { rol: 'costo_ventas', debe: v.costo || 0 }, { rol: 'inventario', haber: v.costo || 0 },
    ]);
  }
  for (const p of f.pagos || []) {
    const v = ventasOk.get(p.venta_numero);
    if (!v || v.metodo_pago !== 'credito') continue;
    add('cobro', `P${p.id}`, p.fecha, `Cobro de ${p.venta_numero}`, [{ rol: rolMetodo(p.metodo), debe: p.monto }, { rol: 'cxc', haber: p.monto }]);
  }

  const comprasOk = new Map();
  for (const c of f.compras || []) {
    if (c.estado !== 'completada') continue;
    comprasOk.set(c.numero, c);
    add('compra', c.numero, c.fecha, `Compra ${c.numero}${c.proveedor ? ` · ${c.proveedor}` : ''}`, [
      { rol: 'inventario', debe: r2(c.total - c.itbis) }, { rol: 'itbis_adelantado', debe: c.itbis }, { rol: 'cxp', haber: c.total },
    ]);
  }
  for (const p of f.pagosCompra || []) {
    if (!comprasOk.has(p.compra_numero)) continue;
    add('pagocompra', `P${p.id}`, p.fecha, `Pago de ${p.compra_numero}`, [{ rol: 'cxp', debe: p.monto }, { rol: rolMetodo(p.metodo), haber: p.monto }]);
  }

  for (const g of f.gastos || []) {
    add('gasto', `G${g.id}`, g.fecha, `Gasto: ${g.concepto}`, [
      { categoria: g.categoria || 'Otros', debe: r2(g.monto - (g.itbis || 0)) }, { rol: 'itbis_adelantado', debe: g.itbis || 0 },
      { rol: rolMetodo(g.metodo), haber: g.monto },
    ]);
  }

  // Activos fijos: compra, depreciación mensual (un asiento por mes) y baja
  const finHasta = hasta;
  const depPorMes = new Map();
  for (const a of f.activos || []) {
    add('activo', `A${a.id}`, a.fecha_adq, `Compra de activo: ${a.nombre}`,
      [{ rol: 'activo_fijo', debe: a.costo }, a.contra_cuenta_id ? { cuenta_id: a.contra_cuenta_id, haber: a.costo } : { rol: 'caja', haber: a.costo }]);
    const cal = calendarioDepreciacion(a, finHasta === '9999-12-31' ? (f.hoy || dia(new Date().toISOString())) : finHasta);
    for (const d of cal) {
      const k = d.fecha;
      if (!depPorMes.has(k)) depPorMes.set(k, []);
      depPorMes.get(k).push({ a, monto: d.monto });
    }
    for (const rv of a.revals || []) {
      const aj = r2(rv.ajuste);
      add('revalorizacion', `A${a.id}-R${rv.uid || rv.id}`, rv.fecha, `Revalorización de activo: ${a.nombre}`, aj >= 0
        ? [{ rol: 'activo_fijo', debe: aj }, { rol: 'superavit_reval', haber: aj }]
        : [{ rol: 'gasto_otros', debe: -aj }, { rol: 'activo_fijo', haber: -aj }]);
    }
    if (a.estado === 'baja' && a.fecha_baja) {
      const v = valoresActivo(a, dia(a.fecha_baja));
      const precio = r2(a.baja_precio || 0);
      const dif = r2(v.costo - v.dep - precio); // valor en libros menos lo cobrado: pérdida si es positivo, ganancia si es negativo
      const motivo = { venta: 'Venta', desecho: 'Desecho', perdida: 'Pérdida o robo', donacion: 'Donación' }[a.baja_motivo];
      add('baja', `A${a.id}`, a.fecha_baja, `${motivo ? `${motivo} de activo` : 'Baja de activo'}: ${a.nombre}`, [
        { rol: 'dep_acumulada', debe: v.dep },
        a.baja_cuenta_id ? { cuenta_id: a.baja_cuenta_id, debe: precio } : { rol: 'caja', debe: precio },
        { rol: 'gasto_otros', debe: dif > 0 ? dif : 0 }, { rol: 'otros_ingresos', haber: dif < 0 ? -dif : 0 },
        { rol: 'activo_fijo', haber: v.costo },
      ]);
    }
  }
  for (const [fecha, items] of [...depPorMes.entries()].sort()) {
    add('depreciacion', fecha.slice(0, 7), fecha, `Depreciación de ${fecha.slice(0, 7)}`,
      items.flatMap(({ a, monto }) => [{ rol: 'gasto_depreciacion', debe: monto, detalle: a.nombre }, { rol: 'dep_acumulada', haber: monto, detalle: a.nombre }]));
  }

  // Nómina
  for (const n of f.nominas || []) {
    if (n.estado !== 'vigente') continue;
    const t = n.totales;
    const pat = r2(t.afp_pat + t.sfs_pat + t.srl_pat + t.infotep);
    add('nomina', n.numero, n.fecha, `Nómina ${n.periodo}`, [
      { rol: 'gasto_sueldos', debe: r2(t.salario + t.otros_ingresos) }, { rol: 'gasto_tss', debe: pat },
      { rol: 'sueldos_pagar', haber: t.neto }, { rol: 'tss_pagar', haber: r2(t.afp + t.sfs + pat) },
      { rol: 'isr_pagar', haber: t.isr }, { rol: 'otros_pagar', haber: t.otros_desc },
    ]);
    if (n.pagada) add('pagonomina', n.numero, n.fecha_pago || n.fecha, `Pago de nómina ${n.periodo}`, [{ rol: 'sueldos_pagar', debe: t.neto }, { rol: rolMetodo(n.metodo_pago), haber: t.neto }]);
  }

  // Movimientos de banco (cada uno usa la cuenta contable de su cuenta bancaria)
  for (const m of f.bancoMovs || []) {
    if (m.estado !== 'vigente') continue;
    const banco = { cuenta_id: m.cuenta_banco_id };
    const contra = m.contra_cuenta_id ? { cuenta_id: m.contra_cuenta_id } : { rol: 'caja' };
    let ls;
    if (m.tipo === 'deposito') ls = [{ ...banco, debe: m.monto, detalle: m.referencia }, { ...contra, haber: m.monto }];
    else if (m.tipo === 'retiro' || m.tipo === 'cheque') ls = [{ ...contra, debe: m.monto }, { ...banco, haber: m.monto, detalle: m.referencia }];
    else if (m.tipo === 'comision') ls = [{ rol: 'gasto_bancario', debe: m.monto }, { ...banco, haber: m.monto }];
    else if (m.tipo === 'interes') ls = [{ ...banco, debe: m.monto }, { rol: 'otros_ingresos', haber: m.monto }];
    else if (m.tipo === 'transferencia') ls = [{ cuenta_id: m.cuenta_destino_id, debe: m.monto }, { ...banco, haber: m.monto, detalle: m.referencia }];
    else continue;
    add('banco', m.numero, m.fecha, `${m.detalle || m.tipo}`, ls);
  }
  return out;
}

// ---------- Libro ----------
// manuales: [{ id, numero, fecha, concepto, tipo, estado, lineas:[{cuenta_id, debe, haber, detalle, centro_id}] }]
// Devuelve { lineas, faltantes } con las líneas ya resueltas a cuentas; faltantes = roles sin cuenta (el asiento no se puede contabilizar).
export function construirLibro({ manuales = [], automaticos = [], cuentas, overrides = {} }) {
  const mapa = { ...mapaRoles(cuentas), ...overrides };
  const porCategoria = new Map();
  for (const c of cuentas) if (c.categoria_gasto && c.activo !== 0 && !porCategoria.has(c.categoria_gasto)) porCategoria.set(c.categoria_gasto, c);
  const lineas = [];
  const faltantes = new Set();
  for (const a of manuales) {
    if (a.estado !== 'vigente') continue;
    a.lineas.forEach((l, i) => lineas.push({
      fecha: dia(a.fecha), ref: `asiento:${a.numero}`, origen: 'manual', tipoAsiento: a.tipo, numero: a.numero, concepto: a.concepto,
      cuenta_id: l.cuenta_id, debe: r2(l.debe), haber: r2(l.haber), detalle: l.detalle || '', centro_id: l.centro_id || null, i,
    }));
  }
  for (const a of automaticos) {
    const res = [];
    let completo = true;
    a.lineas.forEach((l, i) => {
      let c = null;
      if (l.cuenta_id) c = { id: l.cuenta_id };
      else if (l.categoria) c = porCategoria.get(l.categoria) || mapa.gasto_otros;
      else c = mapa[l.rol];
      if (!c) { completo = false; faltantes.add(l.rol || l.categoria); return; }
      res.push({
        fecha: a.fecha, ref: a.ref, origen: a.origen, tipoAsiento: 'auto', numero: a.numero, concepto: a.concepto,
        cuenta_id: c.id, debe: l.debe, haber: l.haber, detalle: l.detalle || '', centro_id: null, i,
      });
    });
    if (completo) lineas.push(...res);
  }
  lineas.sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : x.i - y.i));
  return { lineas, faltantes: [...faltantes].filter(Boolean) };
}

// ---------- Saldos ----------
export const saldoNatural = (tipo, debe, haber) => r2(TIPOS_CUENTA[tipo]?.natural === 'haber' ? haber - debe : debe - haber);

function acumular(lineas, filtro) {
  const m = new Map();
  for (const l of lineas) {
    if (!filtro(l)) continue;
    const s = m.get(l.cuenta_id) || { debe: 0, haber: 0 };
    s.debe = r2(s.debe + l.debe); s.haber = r2(s.haber + l.haber);
    m.set(l.cuenta_id, s);
  }
  return m;
}

// Suma de los hijos (por prefijo de código) para las cuentas título
function conTitulos(cuentas, fila) {
  const hojas = cuentas.filter((c) => !c.grupo);
  return cuentas.map((c) => {
    const f = fila(c);
    if (!c.grupo) return f;
    const hijos = hojas.filter((h) => h.codigo.startsWith(c.codigo) && h.tipo === c.tipo).map(fila);
    return Object.fromEntries(Object.keys(f).map((k) => [k, r2(hijos.reduce((s, x) => s + (x[k] || 0), 0))]));
  });
}

export function balanza(cuentas, lineas, desde, hasta) {
  const ini = acumular(lineas, (l) => l.fecha < desde);
  const mov = acumular(lineas, (l) => l.fecha >= desde && l.fecha <= hasta && l.tipoAsiento !== 'cierre');
  const filas = [];
  for (const c of cuentas) {
    const i = ini.get(c.id) || { debe: 0, haber: 0 };
    const m = mov.get(c.id) || { debe: 0, haber: 0 };
    if (!i.debe && !i.haber && !m.debe && !m.haber) continue;
    const saldoIni = r2(i.debe - i.haber);
    const saldoFin = r2(saldoIni + m.debe - m.haber);
    filas.push({ cuenta: c, inicialDeudor: Math.max(saldoIni, 0), inicialAcreedor: Math.max(-saldoIni, 0), debe: m.debe, haber: m.haber, finalDeudor: Math.max(saldoFin, 0), finalAcreedor: Math.max(-saldoFin, 0) });
  }
  const sum = (k) => r2(filas.reduce((s, f) => s + f[k], 0));
  return { filas, totales: { inicialDeudor: sum('inicialDeudor'), inicialAcreedor: sum('inicialAcreedor'), debe: sum('debe'), haber: sum('haber'), finalDeudor: sum('finalDeudor'), finalAcreedor: sum('finalAcreedor') } };
}

export function estadoResultados(cuentas, lineas, desde, hasta) {
  const m = acumular(lineas, (l) => l.fecha >= desde && l.fecha <= hasta && l.tipoAsiento !== 'cierre');
  const lista = (tipo) => cuentas.filter((c) => c.tipo === tipo && !c.grupo).map((c) => {
    const s = m.get(c.id) || { debe: 0, haber: 0 };
    return { cuenta: c, monto: saldoNatural(tipo, s.debe, s.haber) };
  }).filter((x) => Math.abs(x.monto) > 0.004);
  const ingresos = lista('ingreso'), costos = lista('costo'), gastos = lista('gasto');
  const tot = (xs) => r2(xs.reduce((s, x) => s + x.monto, 0));
  const ti = tot(ingresos), tc = tot(costos), tg = tot(gastos);
  return { ingresos, costos, gastos, totalIngresos: ti, totalCostos: tc, totalGastos: tg, utilidadBruta: r2(ti - tc), utilidadNeta: r2(ti - tc - tg) };
}

export function balanceGeneral(cuentas, lineas, hasta) {
  const m = acumular(lineas, (l) => l.fecha <= hasta);
  const lista = (tipo) => cuentas.filter((c) => c.tipo === tipo && !c.grupo).map((c) => {
    const s = m.get(c.id) || { debe: 0, haber: 0 };
    return { cuenta: c, monto: saldoNatural(tipo, s.debe, s.haber) };
  }).filter((x) => Math.abs(x.monto) > 0.004);
  const activos = lista('activo'), pasivos = lista('pasivo'), patrimonio = lista('patrimonio');
  const resultado = r2(['ingreso', 'costo', 'gasto'].reduce((s, t) => s + lista(t).reduce((a, x) => a + (t === 'ingreso' ? x.monto : -x.monto), 0), 0));
  const tot = (xs) => r2(xs.reduce((s, x) => s + x.monto, 0));
  const ta = tot(activos), tp = tot(pasivos), tpat = r2(tot(patrimonio) + resultado);
  return { activos, pasivos, patrimonio, resultado, totalActivos: ta, totalPasivos: tp, totalPatrimonio: tpat, cuadra: Math.abs(ta - tp - tpat) < 0.01, diferencia: r2(ta - tp - tpat) };
}

export function mayor(cuenta, lineas, desde, hasta) {
  const natural = TIPOS_CUENTA[cuenta.tipo].natural;
  const signo = (l) => (natural === 'debe' ? l.debe - l.haber : l.haber - l.debe);
  let saldo = r2(lineas.filter((l) => l.cuenta_id === cuenta.id && l.fecha < desde).reduce((s, l) => s + signo(l), 0));
  const inicial = saldo;
  const movs = lineas.filter((l) => l.cuenta_id === cuenta.id && l.fecha >= desde && l.fecha <= hasta).map((l) => {
    saldo = r2(saldo + signo(l));
    return { ...l, saldo };
  });
  return { inicial, movimientos: movs, final: saldo, totalDebe: r2(movs.reduce((s, l) => s + l.debe, 0)), totalHaber: r2(movs.reduce((s, l) => s + l.haber, 0)) };
}

// Libro diario: líneas agrupadas por asiento
export function diario(lineas, desde, hasta) {
  const grupos = new Map();
  for (const l of lineas) {
    if (l.fecha < desde || l.fecha > hasta) continue;
    if (!grupos.has(l.ref)) grupos.set(l.ref, { ref: l.ref, fecha: l.fecha, numero: l.numero, origen: l.origen, concepto: l.concepto, lineas: [] });
    grupos.get(l.ref).lineas.push(l);
  }
  return [...grupos.values()];
}

// Flujo de efectivo (método directo): lo que entró y salió de caja y bancos, agrupado por la cuenta contraria
export function flujoEfectivo(cuentas, lineas, efectivoIds, desde, hasta) {
  const efec = new Set(efectivoIds);
  const nombre = new Map(cuentas.map((c) => [c.id, c]));
  const inicial = r2(lineas.filter((l) => efec.has(l.cuenta_id) && l.fecha < desde).reduce((s, l) => s + l.debe - l.haber, 0));
  const porRef = new Map();
  for (const l of lineas) {
    if (l.fecha < desde || l.fecha > hasta) continue;
    if (!porRef.has(l.ref)) porRef.set(l.ref, []);
    porRef.get(l.ref).push(l);
  }
  const secciones = { operacion: new Map(), inversion: new Map(), financiamiento: new Map() };
  for (const ls of porRef.values()) {
    const cash = r2(ls.filter((l) => efec.has(l.cuenta_id)).reduce((s, l) => s + l.debe - l.haber, 0));
    if (Math.abs(cash) < 0.005) continue;
    const otras = ls.filter((l) => !efec.has(l.cuenta_id));
    if (!otras.length) continue;
    // reparte el efectivo del asiento entre las cuentas contrarias en proporción a su monto
    const peso = otras.reduce((s, l) => s + Math.abs(l.debe - l.haber), 0) || 1;
    for (const l of otras) {
      const c = nombre.get(l.cuenta_id);
      const parte = r2(cash * Math.abs(l.debe - l.haber) / peso);
      const sec = c.rol === 'activo_fijo' || c.rol === 'dep_acumulada' ? 'inversion'
        : (c.tipo === 'patrimonio' || c.codigo.startsWith('25') ? 'financiamiento' : 'operacion');
      secciones[sec].set(c.id, r2((secciones[sec].get(c.id) || 0) + parte));
    }
  }
  const armar = (m) => [...m.entries()].map(([id, monto]) => ({ cuenta: nombre.get(id), monto })).filter((x) => Math.abs(x.monto) > 0.004).sort((a, b) => b.monto - a.monto);
  const operacion = armar(secciones.operacion), inversion = armar(secciones.inversion), financiamiento = armar(secciones.financiamiento);
  const tot = (xs) => r2(xs.reduce((s, x) => s + x.monto, 0));
  const variacion = r2(tot(operacion) + tot(inversion) + tot(financiamiento));
  return { inicial, operacion, inversion, financiamiento, totalOperacion: tot(operacion), totalInversion: tot(inversion), totalFinanciamiento: tot(financiamiento), variacion, final: r2(inicial + variacion) };
}

// Antigüedad de saldos. items: [{ tercero, documento, vence (AAAA-MM-DD), saldo }]
export const TRAMOS_ANTIGUEDAD = [['vigente', 'Por vencer'], ['d30', '1 a 30 días'], ['d60', '31 a 60 días'], ['d90', '61 a 90 días'], ['m90', 'Más de 90 días']];
export function antiguedad(items, hoy) {
  const dias = (v) => Math.round((Date.UTC(+hoy.slice(0, 4), +hoy.slice(5, 7) - 1, +hoy.slice(8, 10)) - Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10))) / 86400000);
  const tramo = (d) => (d <= 0 ? 'vigente' : d <= 30 ? 'd30' : d <= 60 ? 'd60' : d <= 90 ? 'd90' : 'm90');
  const terceros = new Map();
  const totales = Object.fromEntries(TRAMOS_ANTIGUEDAD.map(([k]) => [k, 0]));
  for (const it of items) {
    if (!(it.saldo > 0.004)) continue;
    const k = tramo(dias(dia(it.vence)));
    if (!terceros.has(it.tercero)) terceros.set(it.tercero, { tercero: it.tercero, total: 0, ...Object.fromEntries(TRAMOS_ANTIGUEDAD.map(([t]) => [t, 0])) });
    const t = terceros.get(it.tercero);
    t[k] = r2(t[k] + it.saldo); t.total = r2(t.total + it.saldo); totales[k] = r2(totales[k] + it.saldo);
  }
  return { terceros: [...terceros.values()].sort((a, b) => b.total - a.total), totales: { ...totales, total: r2(Object.values(totales).reduce((s, x) => s + x, 0)) } };
}

// Presupuesto vs real por cuenta y mes. presupuestos: [{cuenta_id, mes, monto}]
export function presupuestoVsReal(cuentas, lineas, presupuestos, anio) {
  const filas = [];
  const ids = new Set(presupuestos.map((p) => p.cuenta_id));
  for (const c of cuentas) {
    if (!ids.has(c.id)) continue;
    const meses = [];
    for (let mes = 1; mes <= 12; mes++) {
      const pref = `${anio}-${String(mes).padStart(2, '0')}`;
      const real = r2(lineas.filter((l) => l.cuenta_id === c.id && l.tipoAsiento !== 'cierre' && l.fecha.startsWith(pref)).reduce((s, l) => s + saldoNatural(c.tipo, l.debe, l.haber), 0));
      const pr = presupuestos.find((p) => p.cuenta_id === c.id && p.mes === mes);
      meses.push({ mes, presupuesto: r2(pr?.monto || 0), real, diferencia: r2((pr?.monto || 0) - real) });
    }
    const sum = (k) => r2(meses.reduce((s, m) => s + m[k], 0));
    filas.push({ cuenta: c, meses, presupuesto: sum('presupuesto'), real: sum('real'), diferencia: sum('diferencia') });
  }
  return filas;
}

// Ingresos, costos y gastos por centro de costo (solo las líneas que tienen centro)
export function porCentroCosto(cuentas, centros, lineas, desde, hasta) {
  const tipo = new Map(cuentas.map((c) => [c.id, c.tipo]));
  return centros.map((c) => {
    const ls = lineas.filter((l) => l.centro_id === c.id && l.fecha >= desde && l.fecha <= hasta && l.tipoAsiento !== 'cierre');
    const suma = (t) => r2(ls.filter((l) => tipo.get(l.cuenta_id) === t).reduce((s, l) => s + saldoNatural(t, l.debe, l.haber), 0));
    const ingresos = suma('ingreso'), costos = suma('costo'), gastos = suma('gasto');
    return { centro: c, ingresos, costos, gastos, resultado: r2(ingresos - costos - gastos) };
  }).filter((x) => x.ingresos || x.costos || x.gastos);
}

// ---------- Cierre del ejercicio ----------
// Salda ingresos, costos y gastos contra "Utilidad del ejercicio" y pasa la utilidad de años anteriores a "Utilidades acumuladas".
export function asientoCierre(cuentas, lineas, anio) {
  const fin = `${anio}-12-31`;
  const mapa = mapaRoles(cuentas);
  if (!mapa.utilidad_ejercicio || !mapa.utilidades_acum) throw new Error('Faltan las cuentas "Utilidad del ejercicio" y "Utilidades acumuladas".');
  const m = acumular(lineas, (l) => l.fecha <= fin);
  const out = [];
  let neto = 0;
  for (const c of cuentas) {
    if (c.grupo || !['ingreso', 'costo', 'gasto'].includes(c.tipo)) continue;
    const s = m.get(c.id);
    if (!s) continue;
    const saldo = r2(s.debe - s.haber);
    if (Math.abs(saldo) < 0.005) continue;
    out.push({ cuenta_id: c.id, debe: saldo < 0 ? -saldo : 0, haber: saldo > 0 ? saldo : 0, detalle: 'Cierre del ejercicio' });
    neto = r2(neto - saldo); // utilidad = créditos - débitos
  }
  const anterior = m.get(mapa.utilidad_ejercicio.id);
  const saldoAnt = anterior ? r2(anterior.haber - anterior.debe) : 0;
  if (Math.abs(saldoAnt) >= 0.005) {
    out.push({ cuenta_id: mapa.utilidad_ejercicio.id, debe: saldoAnt > 0 ? saldoAnt : 0, haber: saldoAnt < 0 ? -saldoAnt : 0, detalle: 'Pasa a utilidades acumuladas' });
    out.push({ cuenta_id: mapa.utilidades_acum.id, debe: saldoAnt < 0 ? -saldoAnt : 0, haber: saldoAnt > 0 ? saldoAnt : 0, detalle: 'Utilidad de años anteriores' });
  }
  if (Math.abs(neto) >= 0.005) out.push({ cuenta_id: mapa.utilidad_ejercicio.id, debe: neto < 0 ? -neto : 0, haber: neto > 0 ? neto : 0, detalle: `Resultado ${anio}` });
  return { fecha: fin, concepto: `Cierre del ejercicio ${anio}`, resultado: neto, lineas: out };
}

export function validarAsiento(lineas) {
  const ls = lineas.filter((l) => (l.debe || 0) || (l.haber || 0));
  if (ls.length < 2) throw new Error('Un asiento necesita al menos dos líneas con monto.');
  for (const l of ls) {
    if (!l.cuenta_id) throw new Error('Todas las líneas necesitan una cuenta.');
    if (!(l.debe >= 0) || !(l.haber >= 0)) throw new Error('Los montos no pueden ser negativos.');
    if (l.debe > 0 && l.haber > 0) throw new Error('Una línea no puede tener débito y crédito a la vez.');
  }
  const d = r2(ls.reduce((s, l) => s + l.debe, 0)), h = r2(ls.reduce((s, l) => s + l.haber, 0));
  if (Math.abs(d - h) > 0.004) throw new Error(`El asiento no cuadra: débitos ${d.toFixed(2)} y créditos ${h.toFixed(2)}.`);
  return { debe: d, haber: h, lineas: ls };
}
