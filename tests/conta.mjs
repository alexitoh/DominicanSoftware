// Pruebas del módulo de Contabilidad con el código real (database.js, conta-db.js, conta-motor.js) sobre SQLite de Node.
// Ejecutar con: node --import ./tests/stubs/registrar.mjs tests/conta.mjs
import assert from 'node:assert/strict';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };

const bd = await import('../src/database.js');
const cd = await import('../src/conta-db.js');
const cm = await import('../src/conta-motor.js');
const cn = await import('../src/conta-nomina.js');
const plan = await import('../src/conta-plan.js');
let n = 0; const ok = (t) => { n++; console.log(`  ✔ ${t}`); };
const uno = async (sql, p) => (await bd.consultar(sql, p))[0];
const r2 = cm.r2;
console.log('Contabilidad');
await bd.initDB();

// ---- catálogo y sincronización ----
const cuentas0 = await cd.listarCuentas();
assert.equal(cuentas0.length, plan.PLAN_BASE.length);
assert.ok(cuentas0.every((c) => c.sistema === 1));
const uids = await bd.consultar('SELECT codigo, uid FROM cuentas_contables');
assert.ok(uids.every((c) => c.uid === `cc:${c.codigo}`), 'todas las cuentas base tienen uid fijo (iguales en todos los dispositivos)');
assert.equal(bd.sincronizacionLista(), true);
const C = Object.fromEntries(cuentas0.map((c) => [c.codigo, c]));
const roles = cm.mapaRoles(cuentas0);
assert.ok(Object.keys(plan.ROLES).every((r) => roles[r]), 'cada rol tiene su cuenta');
ok('el catálogo estándar se carga completo, con roles y uid fijo para sincronizar');

// ---- datos del negocio ----
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo', 'incluido')");
await bd.ejecutar("INSERT INTO productos (codigo, nombre, costo, precio, stock_actual) VALUES ('B-1', 'Bocina', 100, 118, 0)");
const pid = (await uno("SELECT id FROM productos WHERE codigo = 'B-1'")).id;
await bd.ejecutar("INSERT INTO proveedores (nombre) VALUES ('Distribuidora SA')");
const prov = (await uno('SELECT id FROM proveedores')).id;
await bd.registrarCompra({ proveedor_id: prov, ncf: 'B0100000001', itbis: 180, items: [{ producto_id: pid, cantidad: 10, costo_unitario: 118 }], actualizarCosto: false });
// compra de 10 × 118 = 1180 (ITBIS 180): inventario 1000 al costo de 100
await bd.ejecutar('UPDATE productos SET costo = 100 WHERE id = ?', [pid]);
const v1 = await bd.registrarVenta({ items: [{ producto_id: pid, cantidad: 2, precio_unitario: 118 }] });               // contado 236 (ITBIS 36), costo 200
const cli = await bd.ejecutar("INSERT INTO clientes (nombre, condicion, dias_credito) VALUES ('Taller Ruiz', 'credito', 30)");
const cid = (await uno("SELECT id FROM clientes WHERE nombre = 'Taller Ruiz'")).id;
const v2 = await bd.registrarVenta({ cliente_id: cid, metodo_pago: 'credito', inicial: 50, dias_credito: 30, items: [{ producto_id: pid, cantidad: 3, precio_unitario: 118 }] }); // 354 (ITBIS 54), costo 300
const vcre = (await uno('SELECT id FROM ventas WHERE numero = ?', [v2])).id;
await bd.registrarCobro({ clienteId: cid, aplicaciones: [{ ventaId: vcre, monto: 100 }], metodos: [{ metodo: 'transferencia', monto: 100, referencia: 'T1' }] });
const v3 = await bd.registrarVenta({ items: [{ producto_id: pid, cantidad: 1, precio_unitario: 118 }], metodo_pago: 'tarjeta' }); // 118 (ITBIS 18), costo 100
const v4 = await bd.registrarVenta({ items: [{ producto_id: pid, cantidad: 1, precio_unitario: 118 }] });
await bd.anularVenta((await uno('SELECT id FROM ventas WHERE numero = ?', [v4])).id);
await bd.abrirCaja(0);
await bd.registrarGasto({ concepto: 'Local', categoria: 'Alquiler', monto: 500, metodo: 'efectivo' });
await bd.registrarGasto({ concepto: 'Internet', categoria: 'Internet y teléfono', monto: 118, itbis: 18, metodo: 'tarjeta', ncf: 'B0100000009' });
await bd.registrarCompra({ proveedor_id: prov, forma_pago: 'credito', inicial: 100, plazo_dias: 15, items: [{ producto_id: pid, cantidad: 1, costo_unitario: 100 }], actualizarCosto: false });

// ---- libro automático ----
const lib = await cd.libroContable();
assert.deepEqual(lib.faltantes, []);
const sumD = r2(lib.lineas.reduce((s, l) => s + l.debe, 0)), sumH = r2(lib.lineas.reduce((s, l) => s + l.haber, 0));
assert.equal(sumD, sumH, 'el libro automático cuadra: débitos = créditos');
const ref = new Set(lib.lineas.map((l) => l.ref));
assert.ok(!lib.lineas.some((l) => l.numero === v4), 'la venta anulada no genera asiento');
assert.ok(ref.has(`venta:${v1}`) && ref.has(`venta:${v2}`));
const hoy = cd.fechaHoy();
const bal = cm.balanceGeneral(lib.cuentas, lib.lineas, hoy);
const saldo = (codigo) => { const f = bal.activos.concat(bal.pasivos, bal.patrimonio).find((x) => x.cuenta.codigo === codigo); return f ? f.monto : 0; };
const er = cm.estadoResultados(lib.cuentas, lib.lineas, '2000-01-01', hoy);
// Ventas netas: (236-36) + (354-54) + (118-18) = 600; ITBIS cobrado 108; costo 200+300+100 = 600
assert.equal(er.totalIngresos, 600); assert.equal(er.totalCostos, 600);
assert.equal(saldo('2110'), 108, 'ITBIS por pagar = ITBIS de las ventas vigentes');
// Gastos: alquiler 500 + internet 100 (sin ITBIS) = 600. ITBIS a favor: compras 180 + gasto 18 (+ compra 3: sin ITBIS)
assert.equal(er.totalGastos, 600);
assert.equal(saldo('1210'), 198, 'ITBIS pagado = 180 + 18');
// CxC: 354 - 50 - 100 = 204. CxP: 1180 + 100 - pagos (1180 + 100 inicial) = 0 salvo lo pendiente de la compra a crédito
assert.equal(saldo('1201'), 204);
assert.equal(saldo('2101'), 0, 'compra de 100 a crédito con inicial 100 → debe 0; la de 1180 pagada al contado');
assert.equal(bal.cuadra, true, `el balance general cuadra (dif ${bal.diferencia})`);
// Caja: ventas efectivo 236 + inicial 50 - gasto 500 - pagos efectivo de compras (1180 + 100)
assert.equal(saldo('1101'), r2(236 + 50 - 500 - 1180 - 100));
assert.equal(saldo('1110'), r2(118 + 100 - 118), 'banco: tarjeta + transferencia - gasto con tarjeta');
// Inventario: 1000 (compra) + 100 (compra) - 600 (costo vendido)
assert.equal(saldo('1301'), 500);
assert.equal(er.utilidadNeta, r2(600 - 600 - 600));
ok('ventas, cobros, compras, pagos y gastos se contabilizan solos; el balance cuadra y las cuentas dan los saldos esperados');

// ---- reportes ----
const bz = cm.balanza(lib.cuentas, lib.lineas, '2000-01-01', hoy);
assert.equal(bz.totales.debe, bz.totales.haber);
assert.equal(bz.totales.finalDeudor, bz.totales.finalAcreedor, 'la balanza de comprobación cuadra');
const my = cm.mayor(C['1101'], lib.lineas, '2000-01-01', hoy);
assert.equal(my.final, saldo('1101'));
assert.equal(my.movimientos.at(-1).saldo, my.final, 'el saldo corrido del mayor termina en el saldo final');
const dia = cm.diario(lib.lineas, '2000-01-01', hoy);
assert.ok(dia.every((a) => r2(a.lineas.reduce((s, l) => s + l.debe - l.haber, 0)) === 0), 'cada asiento del diario cuadra');
const ids = [C['1101'].id, C['1110'].id];
const fl = cm.flujoEfectivo(lib.cuentas, lib.lineas, ids, '2000-01-01', hoy);
assert.equal(fl.final, r2(saldo('1101') + saldo('1110')), 'el flujo de efectivo termina en el efectivo de caja y bancos');
assert.equal(fl.inicial, 0);
const cxc = cm.antiguedad((await cd.saldosPorCobrar()).map((x) => ({ ...x })), hoy);
assert.equal(cxc.totales.total, 204); assert.equal(cxc.totales.vigente, 204, 'aún no vence (30 días)');
const cxp = cm.antiguedad(await cd.saldosPorPagar(), hoy);
assert.equal(cxp.totales.total, 0);
const viejo = cm.antiguedad([{ tercero: 'A', vence: '2026-01-01', saldo: 100 }, { tercero: 'A', vence: '2026-06-01', saldo: 50 }, { tercero: 'B', vence: '2099-01-01', saldo: 10 }], '2026-07-01');
assert.equal(viejo.totales.m90, 100); assert.equal(viejo.totales.d30, 50); assert.equal(viejo.totales.vigente, 10);
assert.equal(viejo.terceros[0].tercero, 'A');
ok('balanza, mayor con saldo corrido, diario, flujo de efectivo y antigüedad de saldos cuadran');

// ---- asientos manuales y períodos ----
await assert.rejects(() => cd.crearAsiento({ fecha: '2026-03-01', concepto: 'x', lineas: [{ cuenta_id: C['1101'].id, debe: 100 }, { cuenta_id: C['3101'].id, haber: 90 }] }), /no cuadra/);
await assert.rejects(() => cd.crearAsiento({ fecha: '2026-03-01', concepto: 'x', lineas: [{ cuenta_id: C['1'].id, debe: 100 }, { cuenta_id: C['3101'].id, haber: 100 }] }), /título/);
await assert.rejects(() => cd.crearAsiento({ fecha: '2026-03-01', concepto: '', lineas: [{ cuenta_id: C['1101'].id, debe: 100 }, { cuenta_id: C['3101'].id, haber: 100 }] }), /concepto/);
await assert.rejects(() => cd.crearAsiento({ fecha: '2026-03-01', concepto: 'x', lineas: [{ cuenta_id: C['1101'].id, debe: 100, haber: 5 }, { cuenta_id: C['3101'].id, haber: 95 }] }), /débito y crédito/);
await assert.rejects(() => cd.crearAsiento({ fecha: '2026-03-01', concepto: 'x', lineas: [{ cuenta_id: C['1101'].id, debe: 100 }] }), /al menos dos/);
await cd.guardarCentro({ codigo: 'T1', nombre: 'Taller' });
const centro = (await cd.listarCentros())[0];
const a1 = await cd.crearAsiento({ fecha: '2025-03-01', concepto: 'Aporte de capital', tipo: 'apertura', lineas: [{ cuenta_id: C['1101'].id, debe: 5000 }, { cuenta_id: C['3101'].id, haber: 5000 }] });
assert.match(a1, /^A-[A-Z]?000001$/);
await cd.crearAsiento({ fecha: '2025-05-10', concepto: 'Venta especial', lineas: [{ cuenta_id: C['1101'].id, debe: 1000 }, { cuenta_id: C['4101'].id, haber: 1000, centro_id: centro.id }] });
await cd.crearAsiento({ fecha: '2025-06-10', concepto: 'Pago de luz', lineas: [{ cuenta_id: C['6202'].id, debe: 300, centro_id: centro.id }, { cuenta_id: C['1101'].id, haber: 300 }] });
await cd.cerrarPeriodo('2025-05');
await assert.rejects(() => cd.crearAsiento({ fecha: '2025-05-20', concepto: 'tarde', lineas: [{ cuenta_id: C['1101'].id, debe: 1 }, { cuenta_id: C['3101'].id, haber: 1 }] }), /cerrado/);
await assert.rejects(() => cd.cerrarPeriodo('2025-05'), /ya está cerrado/);
const lib2 = await cd.libroContable();
const cc = cm.porCentroCosto(lib2.cuentas, await cd.listarCentros(), lib2.lineas, '2025-01-01', '2025-12-31');
assert.equal(cc[0].ingresos, 1000); assert.equal(cc[0].gastos, 300); assert.equal(cc[0].resultado, 700);
await cd.reabrirPeriodo('2025-05');
const tonto = await cd.crearAsiento({ fecha: '2025-05-20', concepto: 'por anular', lineas: [{ cuenta_id: C['1101'].id, debe: 1 }, { cuenta_id: C['3101'].id, haber: 1 }] });
await cd.anularAsiento((await uno('SELECT id FROM asientos WHERE numero = ?', [tonto])).id);
assert.ok(!(await cd.libroContable()).lineas.some((l) => l.numero === tonto), 'un asiento anulado sale del libro');
const idTonto = (await uno('SELECT id FROM asientos WHERE numero = ?', [tonto])).id;
await assert.rejects(() => cd.anularAsiento(idTonto), /ya está anulado/);
ok('los asientos manuales se validan (cuadre, títulos, líneas), se anulan y respetan los períodos cerrados; hay reporte por centro de costo');

// ---- cierre del ejercicio ----
const cierre = await cd.cerrarEjercicio(2025);
assert.equal(cierre.resultado, 700);
await assert.rejects(() => cd.cerrarEjercicio(2025), /ya tiene su asiento de cierre/);
const lib3 = await cd.libroContable({ hasta: '2025-12-31' });
const b25 = cm.balanceGeneral(lib3.cuentas, lib3.lineas, '2025-12-31');
assert.equal(b25.cuadra, true);
assert.equal(b25.resultado, 0, 'tras el cierre, las cuentas de resultados quedan en cero');
assert.equal(b25.patrimonio.find((x) => x.cuenta.codigo === '3301').monto, 700);
assert.equal(cm.estadoResultados(lib3.cuentas, lib3.lineas, '2025-01-01', '2025-12-31').totalIngresos, 1000, 'el estado de resultados del año no cuenta el asiento de cierre');
const lib4 = await cd.libroContable({ hasta: '2026-12-31' });
const c26 = cm.asientoCierre(lib4.cuentas, lib4.lineas, 2026);
assert.ok(c26.lineas.some((l) => l.cuenta_id === C['3201'].id && l.haber === 700), 'la utilidad de 2025 pasa a utilidades acumuladas');
ok('el cierre del ejercicio salda los resultados contra la utilidad del ejercicio, no se repite y no altera el estado de resultados');

// ---- activos fijos ----
await cd.crearActivo({ codigo: 'AF1', nombre: 'Laptop', fecha_adq: '2026-01-15', costo: 12000, residual: 0, vida_meses: 12 });
await assert.rejects(() => cd.crearActivo({ nombre: 'x', fecha_adq: '2026-01-15', costo: 100, residual: 100, vida_meses: 12 }), /residual/);
await assert.rejects(() => cd.crearActivo({ nombre: 'x', fecha_adq: '2026-01-15', costo: 100, vida_meses: 0 }), /vida útil/);
const libA = await cd.libroContable({ hasta: '2026-06-30' });
const depA = libA.lineas.filter((l) => l.origen === 'depreciacion' && l.cuenta_id === C['6206'].id);
assert.equal(depA.length, 5); assert.equal(r2(depA.reduce((s, l) => s + l.debe, 0)), 5000, 'febrero a junio: 5 cuotas de 1,000');
const a = (await cd.listarActivos())[0];
await cd.bajaActivo(a.id, '2026-04-10');
const libB = await cd.libroContable({ hasta: '2026-12-31' });
assert.equal(r2(libB.lineas.filter((l) => l.origen === 'depreciacion').reduce((s, l) => s + l.debe, 0)), 2000, 'depreciación solo hasta marzo (feb + mar)');
const baja = libB.lineas.filter((l) => l.origen === 'baja');
assert.equal(r2(baja.filter((l) => l.cuenta_id === C['6299'].id).reduce((s, l) => s + l.debe, 0)), 10000, 'la pérdida por baja es el valor en libros');
assert.equal(cm.balanceGeneral(libB.cuentas, libB.lineas, '2026-12-31').cuadra, true);
await assert.rejects(() => cd.bajaActivo(a.id, '2026-05-01'), /ya está dado de baja/);
ok('el activo fijo se contabiliza, se deprecia por mes en línea recta, se da de baja con su pérdida y el balance sigue cuadrando');

// ---- nómina ----
const p = cn.paramsDesde({});
const x = cn.calcularNomina({ salario: 50000 }, p);
assert.equal(x.afp, 1435); assert.equal(x.sfs, 1520); assert.equal(x.isr, 1854);
assert.equal(x.neto, r2(50000 - 1435 - 1520 - 1854));
assert.equal(x.afp_pat, 3550); assert.equal(x.sfs_pat, 3545); assert.equal(x.srl_pat, 550); assert.equal(x.infotep, 500);
assert.equal(cn.calcularNomina({ salario: 20000 }, p).isr, 0, 'bajo la exención no paga ISR');
assert.equal(cn.calcularNomina({ salario: 1000000 }, p).afp, r2(464460 * 0.0287), 'la AFP respeta el tope');
assert.equal(cn.isrAnual(1000000), r2(79776 + (1000000 - 867123) * 0.25));
await cd.guardarEmpleado({ nombre: 'Ana Pérez', cedula: '001-1234567-8', cargo: 'Técnico', salario: 50000 });
await cd.guardarEmpleado({ nombre: 'Luis Gómez', salario: 20000 });
await assert.rejects(() => cd.guardarEmpleado({ nombre: '', salario: 1 }), /nombre/);
const prev = await cd.prepararNomina({ [(await cd.listarEmpleados())[0].id]: { otros_ingresos: 2000, otros_desc: 100 } });
assert.equal(prev.length, 2);
const nom = await cd.registrarNomina({ periodo: '2026-02', ajustes: {} });
await assert.rejects(() => cd.registrarNomina({ periodo: '2026-02' }), /Ya existe la nómina/);
const nid = (await uno('SELECT id FROM nomina_corridas WHERE numero = ?', [nom])).id;
let libN = await cd.libroContable({ hasta: '2026-12-31' });
let bN = cm.balanceGeneral(libN.cuentas, libN.lineas, '2026-12-31');
const sN = (codigo) => (bN.activos.concat(bN.pasivos)).find((f) => f.cuenta.codigo === codigo)?.monto || 0;
const tot = (k) => (x[k] + cn.calcularNomina({ salario: 20000 }, p)[k]);
assert.equal(sN('2130'), r2(x.neto + cn.calcularNomina({ salario: 20000 }, p).neto), 'sueldos por pagar = neto de todos');
assert.equal(sN('2120'), r2(tot('afp') + tot('sfs') + tot('afp_pat') + tot('sfs_pat') + tot('srl_pat') + tot('infotep')), 'TSS por pagar = aportes del empleado y del empleador');
assert.equal(sN('2121'), 1854);
assert.equal(bN.cuadra, true);
await cd.pagarNomina(nid, { metodo: 'transferencia', fecha: '2026-02-28' });
await assert.rejects(() => cd.pagarNomina(nid), /ya está pagada/);
libN = await cd.libroContable({ hasta: '2026-12-31' });
bN = cm.balanceGeneral(libN.cuentas, libN.lineas, '2026-12-31');
assert.equal(sN('2130'), 0, 'al pagar la nómina no quedan sueldos por pagar');
assert.equal(bN.cuadra, true);
await cd.anularNomina(nid);
assert.ok(!(await cd.libroContable({ hasta: '2026-12-31' })).lineas.some((l) => l.numero === nom), 'una nómina anulada sale del libro');
ok('la nómina calcula AFP, SFS, ISR y aportes patronales con topes, se contabiliza, se paga y se anula');

// ---- bancos ----
await cd.crearBanco({ nombre: 'Popular corriente', banco: 'Banco Popular', numero: '123' });
await cd.crearBanco({ nombre: 'BHD ahorros', banco: 'BHD' });
const bancos = await cd.listarBancos();
assert.equal(bancos.length, 2);
assert.equal(bancos[0].cuenta_codigo === '1110' || bancos[1].cuenta_codigo === '1110', true, 'el primer banco usa la cuenta Bancos');
assert.ok(bancos.some((b) => b.cuenta_codigo === '1111'), 'el segundo banco tiene su propia cuenta contable');
const bp = bancos.find((b) => b.nombre === 'Popular corriente'), bh = bancos.find((b) => b.nombre === 'BHD ahorros');
assert.equal(bp.predeterminada, 1);
await cd.registrarMovBanco({ banco_id: bp.id, fecha: '2026-03-05', tipo: 'deposito', monto: 3000, referencia: 'Dep 77' });
await cd.registrarMovBanco({ banco_id: bp.id, fecha: '2026-03-06', tipo: 'comision', monto: 25 });
await cd.registrarMovBanco({ banco_id: bp.id, fecha: '2026-03-07', tipo: 'transferencia', monto: 1000, banco_destino_id: bh.id, referencia: 'TR1' });
await assert.rejects(() => cd.registrarMovBanco({ banco_id: bp.id, fecha: '2026-03-07', tipo: 'transferencia', monto: 5, banco_destino_id: bp.id }), /destino/);
await assert.rejects(() => cd.registrarMovBanco({ banco_id: bp.id, fecha: '2026-03-07', tipo: 'cheque', monto: 5 }), /cheque/);
await assert.rejects(() => cd.registrarMovBanco({ banco_id: bp.id, fecha: '2026-03-07', tipo: 'retiro', monto: 0 }), /mayor que cero/);
const mp = await cd.movimientosBanco(bp.id);
const mh = await cd.movimientosBanco(bh.id);
assert.equal(mh.saldoLibros, 1000, 'la transferencia entra a la cuenta de destino');
const propios = mp.movimientos.filter((m) => m.origen === 'banco');
assert.equal(r2(propios.reduce((s, m) => s + m.entra - m.sale, 0)), r2(3000 - 25 - 1000));
assert.ok(mp.movimientos.some((m) => m.origen === 'venta'), 'las ventas con tarjeta caen en el banco predeterminado');
// conciliación
const dep = mp.movimientos.find((m) => m.detalle === 'Dep 77');
await cd.marcarConciliados(bp.id, [dep.key]);
await cd.marcarConciliados(bp.id, [dep.key]);
let mp2 = await cd.movimientosBanco(bp.id);
assert.equal(mp2.saldoConciliado, 3000);
assert.equal(cd.diferenciaConciliacion(mp2.saldoConciliado, 2975), -25);
await cd.marcarConciliados(bp.id, [dep.key], false);
assert.equal((await cd.movimientosBanco(bp.id)).saldoConciliado, 0);
// conciliación bancaria formal (BHD: solo tiene la transferencia de 1,000)
await cd.registrarMovBanco({ banco_id: bh.id, fecha: '2026-03-08', tipo: 'deposito', monto: 500, referencia: 'DEP-B' });
await cd.registrarMovBanco({ banco_id: bh.id, fecha: '2026-03-09', tipo: 'cheque', monto: 200, referencia: 'CH-1' });
const prep = async (hasta) => cd.prepararConciliacion(bh.id, hasta);
let pc = await prep('2026-03-31');
const kTr = pc.movimientos.find((m) => m.detalle === 'TR1' || /TR1|Transferencia/.test(m.concepto || ''))?.key;
const kDep = pc.movimientos.find((m) => /DEP-B/.test(`${m.detalle} ${m.concepto}`)).key;
assert.ok(kTr && kDep);
// el banco cobró una comisión de 10 que aún no está en libros: el estado de cuenta dice 1,490
let c1 = cd.calcularConciliacion(pc.movimientos, new Set([kTr, kDep]), 1490);
assert.equal(c1.saldoLibros, 1300); assert.equal(c1.chequesTransito, 200); assert.equal(c1.saldoAjustado, 1290);
assert.equal(c1.diferencia, -10); assert.equal(c1.cuadra, false);
await assert.rejects(() => cd.finalizarConciliacion({ banco_id: bh.id, fecha_corte: '2026-03-31', saldo_extracto: 1490, marcas: [kTr, kDep] }), /no cuadra/);
await cd.registrarMovBanco({ banco_id: bh.id, fecha: '2026-03-10', tipo: 'comision', monto: 10 });
pc = await prep('2026-03-31');
const kCom = pc.movimientos.find((m) => /Comisi/i.test(`${m.detalle} ${m.concepto}`)).key;
c1 = cd.calcularConciliacion(pc.movimientos, new Set([kTr, kDep, kCom]), 1490);
assert.equal(c1.cuadra, true); assert.equal(c1.depositosTransito, 0);
const idConc = await cd.finalizarConciliacion({ banco_id: bh.id, fecha_corte: '2026-03-31', saldo_extracto: 1490, marcas: [kTr, kDep, kCom], notas: 'marzo' });
const [reg] = await cd.listarConciliaciones(bh.id);
assert.equal(reg.n_conciliados, 3); assert.equal(reg.cheques_transito, 200); assert.equal(reg.saldo_ajustado, 1290);
assert.equal((await cd.movimientosBanco(bh.id)).saldoConciliado, 1490);
await assert.rejects(() => cd.finalizarConciliacion({ banco_id: bh.id, fecha_corte: '2026-03-15', saldo_extracto: 1490 }), /Ya hay una conciliación/);
await cd.deshacerConciliacion(idConc);
assert.equal((await cd.listarConciliaciones(bh.id)).length, 0);
assert.equal((await cd.movimientosBanco(bh.id)).saldoConciliado, 0, 'al deshacer, los movimientos vuelven a quedar pendientes');
const mov25 = (await bd.consultar("SELECT id FROM banco_movs WHERE tipo = 'comision'"))[0].id;
await cd.anularMovBanco(mov25);
assert.equal(r2((await cd.movimientosBanco(bp.id)).movimientos.filter((m) => m.origen === 'banco').reduce((s, m) => s + m.entra - m.sale, 0)), 2000, 'un movimiento anulado sale del banco');
const libBk = await cd.libroContable({ hasta: '2026-12-31' });
assert.equal(cm.balanceGeneral(libBk.cuentas, libBk.lineas, '2026-12-31').cuadra, true);
ok('cuentas bancarias con cuenta contable propia: depósitos, comisiones, transferencias, conciliación y anulación');

// ---- presupuesto ----
await cd.guardarPresupuesto(2026, C['6202'].id, [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
await cd.guardarPresupuesto(2026, C['6202'].id, [200, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
await assert.rejects(() => cd.guardarPresupuesto(2026, C['6202'].id, [1, 2]), /12 montos/);
await cd.crearAsiento({ fecha: '2026-01-20', concepto: 'Luz enero', lineas: [{ cuenta_id: C['6202'].id, debe: 150 }, { cuenta_id: C['1101'].id, haber: 150 }] });
const lp = await cd.libroContable({ hasta: '2026-12-31' });
const pv = cm.presupuestoVsReal(lp.cuentas, lp.lineas, await cd.listarPresupuestos(2026), 2026);
assert.equal(pv.length, 1); assert.equal(pv[0].meses[0].presupuesto, 200); assert.equal(pv[0].meses[0].real, 150); assert.equal(pv[0].meses[0].diferencia, 50);
assert.equal(pv[0].presupuesto, 1300, 'el segundo guardado reemplaza al primero');
ok('el presupuesto se guarda por mes y se compara con lo real');

// ---- catálogo editable ----
await assert.rejects(() => cd.crearCuenta({ codigo: '1101', nombre: 'Dup', tipo: 'activo' }), /Ya existe/);
await cd.crearCuenta({ codigo: '6210', nombre: 'Publicidad', tipo: 'gasto', categoria_gasto: 'Publicidad' });
await bd.registrarGasto({ concepto: 'Volantes', categoria: 'Publicidad', monto: 40, metodo: 'efectivo' });
const lc = await cd.libroContable();
assert.ok(lc.lineas.some((l) => l.concepto === 'Gasto: Volantes' && l.cuenta_id === (lc.cuentas.find((c) => c.codigo === '6210')).id), 'un gasto va a la cuenta de su categoría');
await bd.registrarGasto({ concepto: 'Cosa rara', categoria: 'Inventada', monto: 10, metodo: 'efectivo' });
assert.ok((await cd.libroContable()).lineas.some((l) => l.concepto === 'Gasto: Cosa rara' && l.cuenta_id === C['6299'].id), 'sin cuenta para la categoría va a Otros gastos');
await assert.rejects(() => cd.eliminarCuenta(C['1101'].id), /trae el sistema/);
const nueva = (await cd.listarCuentas()).find((c) => c.codigo === '6210');
await cd.crearAsiento({ fecha: '2026-02-02', concepto: 'Publicidad', lineas: [{ cuenta_id: nueva.id, debe: 5 }, { cuenta_id: C['1101'].id, haber: 5 }] });
await assert.rejects(() => cd.eliminarCuenta(nueva.id), /ya se usa/);
await assert.rejects(() => cd.editarCuenta(nueva.id, { codigo: '6210', nombre: 'Publicidad', tipo: 'activo' }), /tipo/);
// quitar el rol de caja deja sin contabilizar lo que lo necesita
await cd.editarCuenta(C['1101'].id, { codigo: '1101', nombre: 'Caja general', tipo: 'activo', rol: null });
const sinCaja = await cd.libroContable();
assert.ok(sinCaja.faltantes.includes('caja'), 'avisa de qué rol falta en lugar de contabilizar mal');
await cd.editarCuenta(C['1101'].id, { codigo: '1101', nombre: 'Caja general', tipo: 'activo', rol: 'caja' });
ok('el catálogo se edita: cuentas nuevas por categoría de gasto, protecciones, y aviso si falta una cuenta de rol');

// ---- fecha de inicio contable ----
await cd.guardarInicioConta('2099-01-01');
assert.ok(!(await cd.libroContable()).lineas.some((l) => l.origen === 'venta'), 'antes de la fecha de inicio no se contabilizan los documentos');
await cd.guardarInicioConta('');
assert.ok((await cd.libroContable()).lineas.some((l) => l.origen === 'venta'));
await assert.rejects(() => cd.guardarInicioConta('mañana'), /no es válida/);
ok('la fecha de inicio contable deja fuera los documentos anteriores');

console.log(`\n${n} grupos de pruebas correctos`);
process.exit(0);
