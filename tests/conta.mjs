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
await bd.ejecutar("INSERT INTO proveedores (nombre, condicion, dias_credito) VALUES ('Distribuidora SA', 'credito', 15)");
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

// ---- activos fijos: revalorización y retiro con venta ----
const cmo = await import('../src/conta-motor.js');
await cd.crearActivo({ codigo: 'AF2', nombre: 'Máquina de soldar', categoria: 'Maquinaria y equipos', ubicacion: 'Taller', fecha_adq: '2027-01-10', costo: 12000, residual: 0, vida_meses: 12 });
const maq = (await cd.listarActivos()).find((x) => x.codigo === 'AF2');
assert.equal(maq.categoria, 'Maquinaria y equipos');
await assert.rejects(() => cd.revalorizarActivo({ activo_id: maq.id, fecha: '2027-04-15', valor_nuevo: 10000 }), /igual al valor en libros/);
await assert.rejects(() => cd.revalorizarActivo({ activo_id: maq.id, fecha: '2026-12-01', valor_nuevo: 50000 }), /antes de la compra/);
const rv = await cd.revalorizarActivo({ activo_id: maq.id, fecha: '2027-04-15', valor_nuevo: 15000, nota: 'avalúo' });
assert.deepEqual([rv.anterior, rv.ajuste], [10000, 5000]);
const maq2 = (await cd.listarActivos()).find((x) => x.codigo === 'AF2');
const dc = cmo.calendarioDepreciacion(maq2, '2028-12-31');
assert.deepEqual(dc.slice(0, 4).map((x) => x.monto), [1000, 1000, 1500, 1500], 'antes 1,000 al mes; después de la revalorización 15,000 / 10 meses restantes');
assert.equal(r2(dc.reduce((s, x) => s + x.monto, 0)), 17000, 'se deprecia todo el costo revalorizado');
assert.deepEqual({ ...cmo.valoresActivo(maq2, '2027-06-30') }, { costo: 17000, dep: 6500, libros: 10500, retirado: false });
const libR = await cd.libroContable({ hasta: '2027-06-30' });
assert.equal(r2(libR.lineas.filter((l) => l.origen === 'revalorizacion' && l.cuenta_id === C['3501'].id).reduce((s, l) => s + l.haber, 0)), 5000, 'el aumento va a Superávit por revalorización');
assert.equal(cm.balanceGeneral(libR.cuentas, libR.lineas, '2027-06-30').cuadra, true);
await assert.rejects(() => cd.bajaActivo(maq.id, '2027-07-20', { motivo: 'venta', precio: 0 }), /precio de venta/);
await assert.rejects(() => cd.bajaActivo(maq.id, '2027-03-01', { motivo: 'desecho' }), /revalorización posterior/);
await cd.bajaActivo(maq.id, '2027-07-20', { motivo: 'venta', precio: 9000, nota: 'Vendida a Pedro' });
const libV = await cd.libroContable({ hasta: '2027-12-31' });
assert.equal(r2(libV.lineas.filter((l) => l.origen === 'baja' && l.cuenta_id === C['6299'].id).reduce((s, l) => s + l.debe, 0)), 10000 + 1500, 'pérdida del retiro: valor en libros 10,500 - 9,000 cobrado');
assert.equal(cm.balanceGeneral(libV.cuentas, libV.lineas, '2027-12-31').cuadra, true);
assert.equal(r2(cmo.calendarioDepreciacion((await cd.listarActivos()).find((x) => x.codigo === 'AF2'), '2028-12-31').reduce((s, x) => s + x.monto, 0)), 6500, 'deja de depreciar al retirarse');
await assert.rejects(() => cd.revalorizarActivo({ activo_id: maq.id, fecha: '2027-08-01', valor_nuevo: 1 }), /dado de baja/);
ok('la revalorización sube el valor y recalcula la depreciación; el retiro por venta registra ganancia o pérdida y el balance cuadra');

// ---- tipos de depreciación, tipos de activo y tasa de inflación ----
assert.equal((await cd.listarDepTipos()).length, 4, 'se siembran 4 tipos de depreciación de ejemplo');
assert.equal((await cd.listarTiposActivo()).length, 8, 'se siembran 8 tipos de activo de ejemplo');
await cd.guardarDepTipo({ nombre: 'Saldo decreciente 20%', metodo: 'saldo_decreciente', tasa_anual: 20 });
await assert.rejects(() => cd.guardarDepTipo({ nombre: 'saldo decreciente 20%', metodo: 'saldo_decreciente', tasa_anual: 10 }), /Ya existe/);
await assert.rejects(() => cd.guardarDepTipo({ nombre: 'Malo', metodo: 'saldo_decreciente', tasa_anual: 0 }), /entre 0 y 100/);
const dep20 = (await cd.listarDepTipos()).find((d) => d.nombre === 'Saldo decreciente 20%');
await cd.guardarTipoActivo({ nombre: 'Vehículos de reparto', vida_meses: 60, residual_pct: 10, dep_tipo_id: dep20.id });
const tVeh = (await cd.listarTiposActivo()).find((t) => t.nombre === 'Vehículos de reparto');
await cd.crearActivo({ codigo: 'AF3', nombre: 'Camión', fecha_adq: '2028-01-15', costo: 120000, residual: 12000, vida_meses: 60, tipo_id: tVeh.id });
const camion = (await cd.listarActivos()).find((x) => x.codigo === 'AF3');
assert.deepEqual([camion.categoria, camion.metodo_dep, camion.tasa_dep, camion.deprecia], ['Vehículos de reparto', 'saldo_decreciente', 20, 1]);
const cs = cmo.calendarioDepreciacion(camion, '2028-04-30');
assert.deepEqual(cs.map((x) => x.monto), [2000, 1966.67, 1933.89].map(r2), 'saldo decreciente: 20% / 12 del valor en libros de cada mes');
const csTodo = cmo.calendarioDepreciacion(camion, '2100-12-31');
assert.equal(r2(csTodo.reduce((x, d) => x + d.monto, 0)), 108000, 'nunca baja del valor residual');
const libC = await cd.libroContable({ hasta: '2028-12-31' });
assert.equal(cm.balanceGeneral(libC.cuentas, libC.lineas, '2028-12-31').cuadra, true);
// terreno: no se deprecia
const tTer = (await cd.listarTiposActivo()).find((t) => t.nombre === 'Terrenos');
await cd.crearActivo({ codigo: 'AF4', nombre: 'Solar', fecha_adq: '2028-01-15', costo: 500000, vida_meses: 60, tipo_id: tTer.id });
const solar = (await cd.listarActivos()).find((x) => x.codigo === 'AF4');
assert.equal(cmo.calendarioDepreciacion(solar, '2030-12-31').length, 0);
assert.equal(cmo.valoresActivo(solar, '2030-12-31').libros, 500000);
// no se borra lo que está en uso; renombrar un tipo actualiza la categoría de sus activos
await assert.rejects(() => cd.eliminarTipoActivo(tVeh.id), /Hay activos/);
await assert.rejects(() => cd.eliminarDepTipo(dep20.id), /en uso/);
await cd.guardarTipoActivo({ id: tVeh.id, nombre: 'Camiones', vida_meses: 60, residual_pct: 10, dep_tipo_id: dep20.id });
assert.equal((await cd.listarActivos()).find((x) => x.codigo === 'AF3').categoria, 'Camiones');
await cd.guardarDepTipo({ nombre: 'Temporal', metodo: 'lineal' });
await cd.eliminarDepTipo((await cd.listarDepTipos()).find((d) => d.nombre === 'Temporal').id);
// inflación
await assert.rejects(() => cd.propuestaInflacion(2028), /No hay tasa/);
await cd.guardarTasaInflacion({ anio: 2028, tasa: 5, fuente: 'Banco Central' });
await cd.guardarTasaInflacion({ anio: 2028, tasa: 4, fuente: 'BCRD' });
assert.equal((await cd.listarTasasInflacion()).length, 1, 'una tasa por año (se actualiza)');
const prop = await cd.propuestaInflacion(2028);
assert.equal(prop.tasa, 4);
const pCam = prop.propuesta.find((p) => p.activo.codigo === 'AF3');
assert.ok(pCam && pCam.ajuste > 0);
assert.ok(!prop.propuesta.some((p) => p.activo.codigo === 'AF4'), 'los terrenos no se ajustan');
assert.ok(!prop.propuesta.some((p) => p.activo.codigo === 'AF2'), 'los retirados no se ajustan');
await assert.rejects(() => cd.aplicarInflacion(2028, []), /al menos un activo/);
const nAj = await cd.aplicarInflacion(2028, [pCam.activo.id]);
assert.equal(nAj, 1);
const camion2 = (await cd.listarActivos()).find((x) => x.codigo === 'AF3');
assert.equal(cmo.valoresActivo(camion2, '2028-12-31').libros, pCam.nuevo, 'el valor en libros queda subido por la tasa');
assert.equal(camion2.revals[0].nota, 'Ajuste por inflación 2028 (4%)');
assert.equal((await cd.propuestaInflacion(2028)).propuesta.some((p) => p.activo.codigo === 'AF3'), false, 'no se ajusta dos veces el mismo año');
const libI = await cd.libroContable({ hasta: '2029-06-30' });
assert.equal(cm.balanceGeneral(libI.cuentas, libI.lineas, '2029-06-30').cuadra, true);
ok('tipos de depreciación y de activo (saldo decreciente, terrenos sin depreciar, uso protegido) y ajuste por inflación con el balance cuadrando');

// ---- caja chica: fondo, desembolsos, reposición, anulaciones y contabilidad ----
assert.ok(C['1102'], 'el catálogo trae la cuenta Caja chica');
await assert.rejects(() => cd.guardarCajaChica({ nombre: 'Oficina', fondo: 0 }), /fondo/);
const ccId = await cd.guardarCajaChica({ nombre: 'Oficina', custodio: 'María', fondo: 5000, fecha: '2029-02-01' });
await assert.rejects(() => cd.guardarCajaChica({ nombre: 'oficina', fondo: 100 }), /Ya existe/);
assert.equal((await cd.listarCajasChicas())[0].saldo, 5000);
await assert.rejects(() => cd.registrarDesembolso({ caja_chica_id: ccId, fecha: '2029-02-02', concepto: 'x', monto: 9000 }), /solo tiene/);
await assert.rejects(() => cd.registrarDesembolso({ caja_chica_id: ccId, fecha: '2029-02-02', concepto: '', monto: 10 }), /concepto/);
await assert.rejects(() => cd.registrarDesembolso({ caja_chica_id: ccId, fecha: '2029-02-02', concepto: 'x', monto: 100, itbis: 200 }), /ITBIS/);
const n1 = await cd.registrarDesembolso({ caja_chica_id: ccId, fecha: '2029-02-03', concepto: 'Café y azúcar', categoria: 'Otros', beneficiario: 'Colmado Pepe', comprobante: 'V-1', ncf: 'b1300000001', itbis: 18, monto: 118 });
const n2 = await cd.registrarDesembolso({ caja_chica_id: ccId, fecha: '2029-02-04', concepto: 'Taxi', categoria: 'Transporte', monto: 400 });
let cch = (await cd.listarCajasChicas())[0];
assert.deepEqual([cch.saldo, cch.por_reponer, cch.n_por_reponer], [4482, 518, 2]);
const movs1 = await cd.movimientosCajaChica(ccId);
assert.equal(movs1.find((m) => m.numero === n1).ncf, 'B1300000001', 'el NCF se guarda en mayúsculas');
// contabilidad: el gasto sale contra Caja chica, con ITBIS aparte
const libCC = await cd.libroContable({ hasta: '2029-12-31' });
const lcc = (cuenta, campo) => r2(libCC.lineas.filter((l) => l.origen === 'cajachica' && l.cuenta_id === C[cuenta].id).reduce((s, l) => s + l[campo], 0));
assert.equal(lcc('1102', 'debe'), 5000); assert.equal(lcc('1102', 'haber'), 518);
assert.equal(lcc('1210', 'debe'), 18, 'el ITBIS del desembolso queda como ITBIS pagado');
assert.equal(lcc('1101', 'haber'), 5000, 'el fondo sale de la Caja general');
assert.equal(cm.balanceGeneral(libCC.cuentas, libCC.lineas, '2029-12-31').cuadra, true);
// anular un desembolso devuelve el dinero al fondo
await cd.anularMovCajaChica((await cd.movimientosCajaChica(ccId)).find((m) => m.numero === n2).id);
cch = (await cd.listarCajasChicas())[0];
assert.deepEqual([cch.saldo, cch.por_reponer], [4882, 118]);
// reposición
await assert.rejects(() => cd.reponerCajaChica({ caja_chica_id: ccId, fecha: '2029-02-01' }), /anterior a un desembolso/);
const rep = await cd.reponerCajaChica({ caja_chica_id: ccId, fecha: '2029-02-10' });
assert.equal(rep.monto, 118); assert.equal(rep.cantidad, 1);
cch = (await cd.listarCajasChicas())[0];
assert.deepEqual([cch.saldo, cch.por_reponer, cch.n_por_reponer], [5000, 0, 0], 'la reposición deja el fondo completo');
await assert.rejects(() => cd.reponerCajaChica({ caja_chica_id: ccId, fecha: '2029-02-11' }), /No hay desembolsos pendientes/);
await assert.rejects(async () => cd.anularMovCajaChica((await cd.movimientosCajaChica(ccId)).find((m) => m.numero === n1).id), /ya fue repuesto|Ya fue repuesto/);
const libRep = await cd.libroContable({ hasta: '2029-12-31' });
assert.equal(cm.balanceGeneral(libRep.cuentas, libRep.lineas, '2029-12-31').cuadra, true);
// anular la reposición deja el desembolso pendiente otra vez
await cd.anularMovCajaChica((await cd.movimientosCajaChica(ccId)).find((m) => m.tipo === 'reposicion').id);
cch = (await cd.listarCajasChicas())[0];
assert.deepEqual([cch.saldo, cch.n_por_reponer], [4882, 1]);
// reposición desde un banco y aumento de fondo
await cd.reponerCajaChica({ caja_chica_id: ccId, fecha: '2029-02-12', banco_id: bp.id });
await cd.aumentarFondo({ caja_chica_id: ccId, monto: 1000, fecha: '2029-02-13' });
cch = (await cd.listarCajasChicas())[0];
assert.deepEqual([cch.fondo, cch.saldo], [6000, 6000]);
await cd.registrarDesembolso({ caja_chica_id: ccId, fecha: '2029-02-14', concepto: 'Compra grande', monto: 5500 });
await assert.rejects(async () => cd.anularMovCajaChica((await cd.movimientosCajaChica(ccId)).find((m) => m.concepto === 'Aumento del fondo').id), /negativo/, 'no se anula un fondo si el saldo quedaría en negativo');
const libB2 = await cd.libroContable({ hasta: '2029-12-31' });
assert.equal(cm.balanceGeneral(libB2.cuentas, libB2.lineas, '2029-12-31').cuadra, true);
ok('caja chica: fondo, desembolsos con ITBIS y NCF, reposición (caja o banco), anulaciones y balance cuadrando');

// ---- tipos de pago, conceptos, gastos de Contabilidad, diarios cancelados y períodos ----
assert.equal((await cd.listarTiposPago()).length, 4, 'se siembran Efectivo, Transferencia, Tarjeta y Cheque');
await assert.rejects(() => cd.guardarTipoPago({ nombre: 'efectivo', metodo: 'efectivo' }), /Ya existe/);
await assert.rejects(() => cd.guardarTipoPago({ nombre: 'X', metodo: 'otro' }), /método base/);
await cd.guardarTipoPago({ nombre: 'Transferencia BHD', metodo: 'transferencia', banco_id: bh.id });
const tEfe = (await cd.listarTiposPago()).find((t) => t.nombre === 'Efectivo');
const tBhd = (await cd.listarTiposPago()).find((t) => t.nombre === 'Transferencia BHD');
const tChe = (await cd.listarTiposPago()).find((t) => t.nombre === 'Cheque');
assert.equal(tChe.requiere_ref, 1);
// conceptos
await cd.guardarConcepto({ nombre: 'Pago de alquiler', tipo: 'gasto', categoria_gasto: 'Alquiler' });
await assert.rejects(() => cd.guardarConcepto({ nombre: 'pago de alquiler', tipo: 'gasto' }), /Ya existe/);
await assert.rejects(() => cd.guardarConcepto({ nombre: 'Mal', tipo: 'asiento', cuenta_debe_id: C['1101'].id, cuenta_haber_id: C['1101'].id }), /no pueden ser la misma/);
await cd.guardarConcepto({ nombre: 'Aporte de capital', tipo: 'asiento', cuenta_debe_id: C['1101'].id, cuenta_haber_id: C['3101'].id });
assert.equal((await cd.listarConceptos()).length, 2);
// gasto desde Contabilidad (sin caja abierta)
await assert.rejects(() => cd.registrarGastoConta({ fecha: '2030-01-10', concepto: 'Alquiler', monto: 100, tipo_pago_id: tChe.id }), /referencia/);
await assert.rejects(() => cd.registrarGastoConta({ fecha: '2030-01-10', concepto: 'Alquiler', monto: 100, itbis: 500, tipo_pago_id: tEfe.id }), /ITBIS/);
await cd.registrarGastoConta({ fecha: '2030-01-10', concepto: 'Alquiler enero', categoria: 'Alquiler', beneficiario: 'Inmobiliaria Sol', documento: '1-30-12345-6', ncf: 'b0100000050', itbis: 0, monto: 20000, tipo_pago_id: tBhd.id });
await cd.registrarGastoConta({ fecha: '2030-01-12', concepto: 'Papelería', categoria: 'Otros', beneficiario: 'Librería Z', itbis: 18, monto: 118, tipo_pago_id: tEfe.id });
await cd.registrarGastoConta({ fecha: '2030-02-03', concepto: 'Luz', categoria: 'Luz y agua', beneficiario: 'Edesur', monto: 3000, tipo_pago_id: tChe.id, referencia: 'CH-77' });
const gl = await cd.listarGastos({ desde: '2030-01-01', hasta: '2030-12-31' });
assert.equal(gl.length, 3); assert.equal(gl.find((g) => g.concepto === 'Alquiler enero').ncf, 'B0100000050'); assert.equal(gl.find((g) => g.concepto === 'Alquiler enero').documento, '1301234 56'.replace(' ', ''));
const libG = await cd.libroContable({ hasta: '2030-12-31' });
const bancoBhd = (await cd.listarBancos()).find((b) => b.id === bh.id);
assert.equal(r2(libG.lineas.filter((l) => l.origen === 'gasto' && l.cuenta_id === bancoBhd.cuenta_id).reduce((s, l) => s + l.haber, 0)), 20000, 'el gasto pagado con la transferencia BHD sale de la cuenta de ese banco');
assert.equal(cm.balanceGeneral(libG.cuentas, libG.lineas, '2030-12-31').cuadra, true);
// reporte de gastos
let rg = await cd.reporteGastos({ desde: '2030-01-01', hasta: '2030-12-31', agrupar: 'categoria' });
assert.equal(rg.n, 3); assert.equal(rg.total, 23118); assert.equal(rg.itbis, 18);
assert.equal(rg.grupos[0].clave, 'Alquiler'); assert.equal(rg.grupos[0].total, 20000);
rg = await cd.reporteGastos({ desde: '2030-01-01', hasta: '2030-12-31', agrupar: 'mes' });
assert.deepEqual(rg.grupos.map((g) => [g.clave, g.total]), [['2030-01', 20118], ['2030-02', 3000]]);
rg = await cd.reporteGastos({ desde: '2030-01-01', hasta: '2030-12-31', agrupar: 'tipo_pago' });
assert.ok(rg.grupos.some((g) => g.clave === 'Transferencia BHD' && g.total === 20000));
await assert.rejects(() => cd.reporteGastos({ agrupar: 'x' }), /Agrupación/);
// anular gasto
const gPap = gl.find((g) => g.concepto === 'Papelería');
await assert.rejects(() => cd.anularGastoConta(gPap.id, ''), /motivo/);
await cd.anularGastoConta(gPap.id, 'duplicado');
assert.equal((await cd.reporteGastos({ desde: '2030-01-01', hasta: '2030-12-31' })).n, 2, 'un gasto anulado sale de los reportes');
await assert.rejects(() => cd.anularGastoConta(gPap.id, 'otra vez'), /ya está anulado/);
const libG2 = await cd.libroContable({ hasta: '2030-12-31' });
assert.equal(libG2.lineas.filter((l) => l.origen === 'gasto' && /Papelería/.test(l.concepto)).length, 0, 'tampoco se contabiliza');
// diarios cancelados
const numA = await cd.crearAsiento({ fecha: '2030-03-01', concepto: 'Prueba a anular', tipo: 'manual', lineas: [{ cuenta_id: C['1101'].id, debe: 10, haber: 0 }, { cuenta_id: C['3101'].id, debe: 0, haber: 10 }] });
const [asA] = await bd.consultar('SELECT id FROM asientos WHERE numero = ?', [numA]);
await cd.anularAsiento(asA.id, 'Error de digitación');
const canc = await cd.diariosCancelados();
assert.equal(canc.length >= 1, true);
const cA = canc.find((a) => a.numero === numA);
assert.equal(cA.anulado_motivo, 'Error de digitación'); assert.ok(cA.anulado_fecha); assert.equal(cA.lineas.length, 2);
// períodos contables
const rp = await cd.resumenPeriodos(2030);
assert.equal(rp.meses.length, 12);
assert.ok(rp.meses[0].asientos >= 1 && rp.meses[0].debitos >= 20000, 'enero 2030 tiene los gastos');
assert.equal(rp.meses[0].cerrado, false);
assert.equal(await cd.cerrarPeriodosHasta('2030-02'), 2);
assert.deepEqual((await cd.resumenPeriodos(2030)).meses.slice(0, 3).map((m) => m.cerrado), [true, true, false]);
await assert.rejects(() => cd.registrarGastoConta({ fecha: '2030-01-20', concepto: 'x', monto: 5, tipo_pago_id: tEfe.id }), /cerrado/);
await cd.reabrirPeriodo('2030-01'); await cd.reabrirPeriodo('2030-02');
// período fiscal
assert.equal(cd.fechaLimite('2030-12', '606'), '2031-01-15'); assert.equal(cd.fechaLimite('2030-03', 'IT1'), '2030-04-20');
assert.equal(cd.estadoDeclaracion('2030-03', '606', null, '2030-03-31'), 'pendiente');
assert.equal(cd.estadoDeclaracion('2030-03', '606', null, '2030-04-10'), 'porpresentar');
assert.equal(cd.estadoDeclaracion('2030-03', '606', null, '2030-04-16'), 'vencida');
assert.equal(cd.estadoDeclaracion('2030-03', 'IT1', null, '2030-04-16'), 'porpresentar');
assert.equal(cd.estadoDeclaracion('2030-03', '606', { id: 1 }, '2031-01-01'), 'presentada');
assert.deepEqual(cd.mesesFiscales(2030, 7).slice(0, 2).concat(cd.mesesFiscales(2030, 7).slice(-1)), ['2030-07', '2030-08', '2031-06']);
await cd.marcarDeclaracion({ periodo: '2030-03', formulario: '607', fecha: '2030-04-12', referencia: 'ACUSE-1' });
await cd.marcarDeclaracion({ periodo: '2030-03', formulario: '607', fecha: '2030-04-13', referencia: 'ACUSE-2' });
const decl = await cd.listarDeclaraciones(cd.mesesFiscales(2030, 1));
assert.equal(decl.length, 1); assert.equal(decl[0].referencia, 'ACUSE-2'); assert.equal(decl[0].clave, '2030-03:607');
await assert.rejects(() => cd.marcarDeclaracion({ periodo: '2030-03', formulario: 'XX', fecha: '2030-04-12' }), /Formulario/);
await cd.quitarDeclaracion('2030-03', '607');
assert.equal((await cd.listarDeclaraciones(['2030-03'])).length, 0);
assert.deepEqual(await cd.configFiscalPeriodo(), { mesInicio: 1 });
await cd.guardarMesInicioFiscal(7);
assert.deepEqual(await cd.configFiscalPeriodo(), { mesInicio: 7 });
await assert.rejects(() => cd.guardarMesInicioFiscal(13), /entre 1 y 12/);
await cd.guardarMesInicioFiscal(1);
ok('tipos de pago, conceptos, gastos desde Contabilidad (con anulación y reportes), diarios cancelados, períodos contables y fiscales');

{
// ---- CxC: tipos de cliente, condiciones, notas, anticipos y reportes ----
const cx = await import('../src/cxc-db.js');
assert.equal((await cx.listarCondiciones()).length, 5); assert.equal((await cx.listarTiposCliente()).length, 3); assert.equal((await cx.listarConceptosCxc()).length, 7);
await cx.guardarTipoCliente({ nombre: 'Taller', descuento: 5, limite_credito: 50000 });
await assert.rejects(() => cx.guardarTipoCliente({ nombre: 'taller' }), /Ya existe/);
await assert.rejects(() => cx.guardarTipoCliente({ nombre: 'X', descuento: 120 }), /entre 0 y 100/);
const tTaller = (await cx.listarTiposCliente()).find((t) => t.nombre === 'Taller');
const cond45 = (await cx.listarCondiciones()).find((c) => c.dias === 45);
await cx.guardarCreditoCliente({ cliente_id: cid, tipo_cliente_id: tTaller.id, condicion_pago_id: cond45.id, limite_credito: 9000 });
const cliRow = await uno('SELECT * FROM clientes WHERE id = ?', [cid]);
assert.deepEqual([cliRow.condicion, cliRow.dias_credito, cliRow.limite_credito, cliRow.tipo_cliente_id], ['credito', 45, 9000, tTaller.id]);
await cx.guardarCondicion({ id: cond45.id, nombre: '45 días', dias: 40 });
assert.equal((await uno('SELECT dias_credito FROM clientes WHERE id = ?', [cid])).dias_credito, 40, 'cambiar los días de la condición actualiza a sus clientes');
await assert.rejects(() => cx.eliminarCondicion(cond45.id), /Desactívala/);
await assert.rejects(() => cx.eliminarTipoCliente(tTaller.id), /Desactívalo/);

const saldoFactura = async () => r2((await bd.facturasPendientes(cid)).find((f) => f.id === vcre).saldo);
const saldo0 = await saldoFactura(); assert.equal(saldo0, r2(354 - 50 - 100));
const cxcConceptos = await cx.listarConceptosCxc();
const kDesc = cxcConceptos.find((k) => k.tipo === 'descuento'), kCargo = cxcConceptos.find((k) => k.tipo === 'cargo');
await assert.rejects(() => cx.crearNota({ tipo: 'credito', cliente_id: cid, venta_id: vcre, monto: 9999 }), /no puede ser mayor/);
await assert.rejects(() => cx.crearNota({ tipo: 'credito', cliente_id: cid, venta_id: vcre, monto: 10, concepto_id: kCargo.id }), /descuento o una devolución/);
await assert.rejects(() => cx.crearNota({ tipo: 'debito', cliente_id: cid, venta_id: vcre, monto: 10, concepto_id: kDesc.id }), /tipo cargo/);
const nc = await cx.crearNota({ tipo: 'credito', cliente_id: cid, venta_id: vcre, monto: 59, itbis: 9, concepto_id: kDesc.id });
assert.match(nc.numero, /^NC-/); assert.equal(await saldoFactura(), r2(saldo0 - 59));
const nd = await cx.crearNota({ tipo: 'debito', cliente_id: cid, venta_id: vcre, monto: 20, concepto_id: kCargo.id });
assert.match(nd.numero, /^ND-/); assert.equal(await saldoFactura(), r2(saldo0 - 59 + 20));
const ant = await cx.crearAnticipo({ cliente_id: cid, monto: 500, metodo: 'transferencia', referencia: 'T-77' });
await assert.rejects(() => cx.crearAnticipo({ cliente_id: cid, monto: 10, metodo: 'cheque' }), /número de cheque/);
await assert.rejects(() => cx.aplicarAnticipo({ anticipo_id: ant.id, venta_id: vcre, monto: 600 }), /disponible/);
await cx.aplicarAnticipo({ anticipo_id: ant.id, venta_id: vcre, monto: 100 });
assert.equal(await saldoFactura(), r2(saldo0 - 59 + 20 - 100));
assert.equal((await cx.listarAnticipos({ clienteId: cid }))[0].disponible, 400);
await assert.rejects(() => cx.anularAnticipo(ant.id, 'x'), /ya se aplicó/);
// el libro sigue cuadrando y CxC del libro = saldos de facturas
const lib2 = await cd.libroContable();
assert.deepEqual(lib2.faltantes, []);
assert.equal(r2(lib2.lineas.reduce((s, l) => s + l.debe, 0)), r2(lib2.lineas.reduce((s, l) => s + l.haber, 0)));
const saldoCuenta = (codigo) => r2(lib2.lineas.filter((l) => l.cuenta_id === C[codigo].id).reduce((s, l) => s + l.debe - l.haber, 0));
const porCobrarTotal = r2((await cd.saldosPorCobrar()).reduce((s, x) => s + x.saldo, 0));
assert.equal(saldoCuenta('1201'), porCobrarTotal, 'la cuenta 1201 coincide con lo que deben los clientes');
assert.equal(saldoCuenta('4103'), 50, 'nota de crédito: descuento sin ITBIS');
assert.equal(saldoCuenta('4202'), -20, 'nota de débito: cargo a clientes');
assert.equal(saldoCuenta('2150'), -400, 'anticipo recibido menos lo aplicado');
const bal = cm.balanceGeneral(lib2.cuentas, lib2.lineas, '2099-12-31'); assert.equal(bal.cuadra, true);
// anular
await assert.rejects(() => cx.anularNota(nc.id, ''), /motivo/);
await cx.anularNota(nd.id, 'Error'); assert.equal(await saldoFactura(), r2(saldo0 - 59 - 100));
await cx.anularNota(nc.id, 'Error'); assert.equal(await saldoFactura(), r2(saldo0 - 100));
await assert.rejects(() => cx.anularNota(nc.id, 'otra vez'), /ya está anulada/);
const [apl] = await cx.aplicacionesAnticipo(ant.id); await cx.quitarAplicacion(apl.id); assert.equal(await saldoFactura(), saldo0);
await cx.anularAnticipo(ant.id, 'Devuelto al cliente'); assert.equal((await cx.listarAnticipos({ clienteId: cid }))[0].disponible, 0);
assert.equal(saldoCuenta('1201') > 0, true);
const lib3 = await cd.libroContable(); const sc = (c) => r2(lib3.lineas.filter((l) => l.cuenta_id === C[c].id).reduce((s, l) => s + l.debe - l.haber, 0));
assert.equal(sc('4103'), 0); assert.equal(sc('4202'), 0); assert.equal(sc('2150'), 0, 'anulado: no queda nada contabilizado');
// reportes
await cx.crearNota({ tipo: 'credito', cliente_id: cid, venta_id: vcre, monto: 10 });
const rep = await cx.reporteCxc({ hasta: '2099-01-01' });
assert.equal(rep.clientes.length, 1); assert.equal(rep.totales.total, r2(saldo0 - 10)); assert.equal(rep.totales.t90m, rep.totales.total, 'muy vencida');
assert.equal((await cx.reporteCxc({ hasta: '2099-01-01', tipoClienteId: 9999 })).clientes.length, 0);
const movs = await cx.movimientosCxc({});
const tabla = cx.tablaDinamicaCxc(movs, { dimension: 'cliente' });
assert.equal(tabla.filas.length, 1); assert.equal(tabla.filas[0].factura, 354); assert.equal(tabla.filas[0].credito, 10);
assert.equal(tabla.filas[0].neto, r2(354 - 10 - 100 - 0), 'factura − crédito − recibo (los 50 iniciales y 100 del cobro: ver recibo)');
assert.equal(cx.tablaDinamicaCxc(movs, { dimension: 'documento' }).filas.length >= 2, true);
assert.throws(() => cx.tablaDinamicaCxc(movs, { dimension: 'nada' }), /Agrupación/);
const ec = await cx.estadoCuentaCliente(cid); assert.equal(ec.saldo, r2(saldo0 - 10)); assert.ok(ec.movimientos.length >= 3);
const lcx = await cx.clientesCxc(); assert.equal(lcx.find((c) => c.id === cid).saldo, r2(saldo0 - 10));
const idV1 = (await uno('SELECT id FROM ventas WHERE numero = ?', [v1])).id;
await assert.rejects(() => cx.crearNota({ tipo: 'credito', cliente_id: cid, venta_id: idV1, monto: 5 }), /de este cliente|a crédito/);
ok('CxC: tipos de cliente, condiciones, notas de crédito y débito, anticipos (aplicar/anular), reportes y contabilidad cuadrando');
}

// ---- Finanzas: razones, comparativos, variación del capital, monedas y diferencia cambiaria, tabla dinámica ----
{
const fm = await import('../src/finanzas-motor.js');
const fd = await import('../src/finanzas-db.js');
const libF = await cd.libroContable();
const hoyF = cd.fechaHoy();
// monedas y tasas
assert.deepEqual((await fd.listarMonedas()).map((m) => m.codigo), ['EUR', 'USD']);
await assert.rejects(() => fd.guardarMoneda({ codigo: 'DOP', nombre: 'Peso' }), /moneda base/);
await assert.rejects(() => fd.guardarMoneda({ codigo: 'usd', nombre: 'Otra' }), /Ya existe/);
const usd = (await fd.listarMonedas()).find((m) => m.codigo === 'USD'); const eur = (await fd.listarMonedas()).find((m) => m.codigo === 'EUR');
await fd.guardarTasa({ moneda_id: usd.id, fecha: '2020-01-01', tasa: 58 });
await fd.guardarTasa({ moneda_id: usd.id, fecha: '2020-06-01', tasa: 60 });
await fd.guardarTasa({ moneda_id: usd.id, fecha: '2020-06-01', tasa: 60.5 }); // misma fecha: reemplaza
assert.equal((await fd.listarTasas(usd.id)).length, 2);
assert.equal((await fd.tasaEn(usd.id, '2020-03-01')).tasa, 58);
assert.equal((await fd.tasaEn(usd.id, '2019-01-01')), null);
assert.equal((await fd.convertirMoneda({ monto: 100, de: usd.id, a: 'BASE', fecha: '2020-03-01' })).resultado, 5800);
assert.equal((await fd.convertirMoneda({ monto: 6050, de: 'BASE', a: usd.id, fecha: '2020-07-01' })).resultado, 100);
await assert.rejects(() => fd.convertirMoneda({ monto: 1, de: eur.id, a: 'BASE' }), /No hay tasa de EUR/);
await assert.rejects(() => fd.guardarTasa({ moneda_id: usd.id, fecha: '2020-01-02', tasa: 0 }), /tasa/);
// diferencia cambiaria
const prestamo = (await cd.listarCuentas()).find((c) => c.codigo === '2501');
await assert.rejects(() => fd.guardarPartida({ descripcion: 'x', moneda_id: usd.id, cuenta_id: C['1201'].id, monto_ext: 1, tasa_libro: 58 }), /facturas del sistema/);
await assert.rejects(() => fd.guardarPartida({ descripcion: 'x', moneda_id: usd.id, cuenta_id: C['4101'].id, monto_ext: 1, tasa_libro: 58 }), /activo o de pasivo/);
await fd.guardarPartida({ descripcion: 'Cuenta en dólares', moneda_id: usd.id, cuenta_id: C['1110'].id, monto_ext: 1000, tasa_libro: 58, fecha: '2020-01-01' });
await fd.guardarPartida({ descripcion: 'Préstamo en dólares', moneda_id: usd.id, cuenta_id: prestamo.id, monto_ext: 500, tasa_libro: 58, fecha: '2020-01-01' });
const rv = await fd.revaluar(hoyF);
assert.equal(rv.ganancia, 2500, 'activo: 1000 × (60.5 − 58)'); assert.equal(rv.perdida, 1250, 'pasivo: 500 × 2.5');
const antes = r2((await cd.libroContable()).lineas.reduce((s, l) => s + l.debe - l.haber, 0));
const ctb = await fd.contabilizarDiferencia(hoyF);
assert.match(ctb.numero, /^A-/); assert.equal(ctb.partidas, 2);
const libG = await cd.libroContable();
assert.equal(r2(libG.lineas.reduce((s, l) => s + l.debe - l.haber, 0)), antes, 'el asiento cuadra');
const sG = (c) => r2(libG.lineas.filter((l) => l.cuenta_id === C[c].id).reduce((s, l) => s + l.debe - l.haber, 0));
assert.equal(sG('4203'), -2500); assert.equal(sG('6208'), 1250);
await assert.rejects(() => fd.contabilizarDiferencia(hoyF), /No hay diferencias/);
assert.ok((await fd.listarPartidas()).every((p) => p.tasa_libro === 60.5));
assert.equal((await fd.historialDiferencias()).length, 2);
const idP0 = (await fd.listarPartidas())[0].id;
await assert.rejects(() => fd.eliminarPartida(idP0), /ya tiene diferencias/);
// razones, comparativos, variación del capital
const an = fm.analisisFinanciero(libF.cuentas, libF.lineas, '2000-01-01', hoyF);
for (const [k, v] of Object.entries(an.valores)) assert.ok(v == null || Number.isFinite(v), `razón ${k}`);
assert.ok(Number.isFinite(an.valores.corriente) && an.base.pasivosCorrientes === 108 && an.valores.capitalTrabajo === r2(an.base.activosCorrientes - an.base.pasivosCorrientes));
assert.equal(fm.RATIOS.length, Object.keys(an.valores).length);
assert.deepEqual(fm.periodoAnterior('2026-03-01', '2026-03-31'), { desde: '2026-01-29', hasta: '2026-02-28' });
assert.deepEqual(fm.mismoPeriodoAnioAnterior('2024-02-29', '2024-03-31'), { desde: '2023-02-28', hasta: '2023-03-31' });
const bc = fm.balanceComparativo(libG.cuentas, libG.lineas, hoyF, '2020-12-31');
assert.equal(bc.total.cuadra, true); assert.ok(bc.anterior);
const rc = fm.resultadosComparativo(libG.cuentas, libG.lineas, '2000-01-01', hoyF, fm.periodoAnterior('2000-01-01', hoyF));
assert.equal(rc.actual.utilidadNeta, cm.estadoResultados(libG.cuentas, libG.lineas, '2000-01-01', hoyF).utilidadNeta);
const pm = fm.resultadosPorMes(libG.cuentas, libG.lineas, `${hoyF.slice(0, 4)}-01-01`, hoyF);
assert.equal(pm.sumas.utilidad, cm.estadoResultados(libG.cuentas, libG.lineas, `${hoyF.slice(0, 4)}-01-01`, hoyF).utilidadNeta, 'por mes suma lo mismo que el período completo');
const vc = fm.variacionCapital(libG.cuentas, libG.lineas, '2000-01-01', hoyF);
assert.equal(vc.inicial, 0); assert.equal(r2(vc.inicial + vc.filas.reduce((s, f) => s + f.monto, 0)), vc.final);
assert.equal(vc.final, cm.balanceGeneral(libG.cuentas, libG.lineas, hoyF).totalPatrimonio);
const td = fm.tablaDinamicaLibro(libG.lineas, libG.cuentas, { desde: '2000-01-01', hasta: hoyF, tipos: ['ingreso'], filas: 'cuenta', columnas: 'mes' });
assert.equal(td.total, cm.estadoResultados(libG.cuentas, libG.lineas, '2000-01-01', hoyF).totalIngresos);
assert.equal(fm.tablaDinamicaLibro(libG.lineas, libG.cuentas, { filas: 'origen', columnas: 'tipo', medida: 'debe' }).filas.length >= 3, true);
assert.throws(() => fm.tablaDinamicaLibro(libG.lineas, libG.cuentas, { filas: 'x' }), /no válida/);
ok('Finanzas: razones, balance y resultados comparativos, por mes, variación del capital, monedas, conversión, diferencia cambiaria y tabla dinámica');
}

// ---- CxP: tipos de suplidor, notas, anticipos, pagos, reportes y el circuito de compras ----
{
const xp = await import('../src/cxp-db.js');
assert.equal((await xp.listarTiposProveedor()).length, 3);
await xp.guardarTipoProveedor({ nombre: 'Importador' });
await assert.rejects(() => xp.guardarTipoProveedor({ nombre: 'importador' }), /Ya existe/);
const tImp = (await xp.listarTiposProveedor()).find((t) => t.nombre === 'Importador');
await bd.ejecutar("INSERT INTO proveedores (nombre, dias_credito, condicion) VALUES ('Distribuidora Sur', 30, 'credito')");
const sid = (await uno("SELECT id FROM proveedores WHERE nombre = 'Distribuidora Sur'")).id;
await xp.guardarTipoDeProveedor(sid, tImp.id);
await assert.rejects(() => xp.eliminarTipoProveedor(tImp.id), /Desactívalo/);
const cp = await bd.registrarCompra({ proveedor_id: sid, forma_pago: 'credito', plazo_dias: 30, itbis: 90, items: [{ producto_id: pid, cantidad: 5, costo_unitario: 118 }], actualizarCosto: false }); // 590
const idC = (await uno('SELECT id FROM compras WHERE numero = ?', [cp])).id;
const saldoC = async () => r2((await xp.detalleFacturaSuplidor(idC)).saldo);
assert.equal(await saldoC(), 590);
const sct = (codigo, lib) => r2(lib.lineas.filter((l) => l.cuenta_id === C[codigo].id).reduce((s, l) => s + l.debe - l.haber, 0));
// notas
await assert.rejects(() => xp.crearNotaProveedor({ tipo: 'credito', proveedor_id: sid, compra_id: idC, monto: 9999 }), /no puede ser mayor/);
const ncp = await xp.crearNotaProveedor({ tipo: 'credito', proveedor_id: sid, compra_id: idC, monto: 59, itbis: 9, concepto: 'Devolución de mercancía' });
assert.match(ncp.numero, /^NCP-/); assert.equal(await saldoC(), 531);
const ndp = await xp.crearNotaProveedor({ tipo: 'debito', proveedor_id: sid, compra_id: idC, monto: 20, concepto: 'Flete o transporte' });
assert.match(ndp.numero, /^NDP-/); assert.equal(await saldoC(), 551);
// anticipo
const anp = await xp.crearAnticipoProveedor({ proveedor_id: sid, monto: 300, metodo: 'transferencia', referencia: 'T-9' });
await assert.rejects(() => xp.crearAnticipoProveedor({ proveedor_id: sid, monto: 10, metodo: 'cheque' }), /número de cheque/);
await assert.rejects(() => xp.aplicarAnticipoProveedor({ anticipo_id: anp.id, compra_id: idC, monto: 400 }), /disponible/);
await xp.aplicarAnticipoProveedor({ anticipo_id: anp.id, compra_id: idC, monto: 100 });
assert.equal(await saldoC(), 451);
assert.equal((await xp.listarAnticiposProveedor({ proveedorId: sid }))[0].disponible, 200);
await assert.rejects(() => xp.anularAnticipoProveedor(anp.id, 'x'), /ya se aplicó/);
// contabilidad: cuadra y la cuenta por pagar coincide con las facturas
const libP = await cd.libroContable();
assert.deepEqual(libP.faltantes, []);
assert.equal(r2(libP.lineas.reduce((s, l) => s + l.debe, 0)), r2(libP.lineas.reduce((s, l) => s + l.haber, 0)), 'el libro cuadra con CxP');
const porPagarTotal = r2((await cd.saldosPorPagar()).reduce((s, x) => s + x.saldo, 0));
assert.equal(-sct('2101', libP), porPagarTotal, 'la cuenta 2101 coincide con lo que se debe a los suplidores');
assert.equal(sct('5102', libP), -50, 'nota de crédito: descuento sin ITBIS');
assert.equal(sct('6209', libP), 20, 'nota de débito: cargo del suplidor');
assert.equal(sct('1220', libP), 200, 'anticipo entregado menos lo aplicado');
assert.equal(cm.balanceGeneral(libP.cuentas, libP.lineas, '2099-12-31').cuadra, true);
// pago repartido (las facturas más antiguas primero) y límites
await assert.rejects(() => xp.pagarSuplidor({ proveedor_id: sid, monto: 99999 }), /no puede ser mayor/);
const pg = await xp.pagarSuplidor({ proveedor_id: sid, monto: 51, metodo: 'efectivo' });
assert.equal(pg.aplicados.length, 1); assert.equal(await saldoC(), 400);
// anulaciones
await assert.rejects(() => xp.anularNotaProveedor(ncp.id, ''), /motivo/);
await xp.anularNotaProveedor(ndp.id, 'Error'); assert.equal(await saldoC(), 380);
await xp.anularNotaProveedor(ncp.id, 'Error'); assert.equal(await saldoC(), 439);
await assert.rejects(() => xp.anularNotaProveedor(ncp.id, 'otra vez'), /ya está anulada/);
const [apl] = await xp.aplicacionesAnticipoProveedor(anp.id); await xp.quitarAplicacionProveedor(apl.id); assert.equal(await saldoC(), 539);
await xp.anularAnticipoProveedor(anp.id, 'Devuelto'); assert.equal((await xp.listarAnticiposProveedor({ proveedorId: sid }))[0].disponible, 0);
const libQ = await cd.libroContable();
assert.equal(sct('5102', libQ), 0); assert.equal(sct('6209', libQ), 0); assert.equal(sct('1220', libQ), 0, 'anulado: no queda nada contabilizado');
// el 606 no toma una nota como forma de pago
await xp.crearNotaProveedor({ tipo: 'credito', proveedor_id: sid, compra_id: idC, monto: 10 });
// reportes
const rep = await xp.reporteCxp({ hasta: '2099-01-01' });
const fila = rep.proveedores.find((x) => x.proveedor_id === sid);
assert.equal(fila.total, 529); assert.equal(fila.t90m, 529, 'muy vencida');
assert.equal((await xp.reporteCxp({ hasta: '2099-01-01', tipoProveedorId: 9999 })).proveedores.length, 0);
assert.equal((await xp.reporteCxp({ hasta: '2099-01-01', tipoProveedorId: tImp.id })).proveedores.length, 1);
const movs = await xp.movimientosCxp({});
const tb = xp.tablaDinamicaCxp(movs, { dimension: 'proveedor' });
const tf = tb.filas.find((x) => x.clave === 'Distribuidora Sur');
assert.equal(tf.factura, 590); assert.equal(tf.credito, 10); assert.equal(tf.pago, 51);
assert.equal(tf.neto, r2(590 - 10 - 51));
assert.ok(xp.tablaDinamicaCxp(movs, { dimension: 'documento' }).filas.length >= 2);
assert.throws(() => xp.tablaDinamicaCxp(movs, { dimension: 'nada' }), /Agrupación/);
const ec = await xp.estadoCuentaProveedor(sid); assert.equal(ec.saldo, 529); assert.ok(ec.movimientos.length >= 2);
const lista = await xp.proveedoresCxp(); assert.equal(lista.find((x) => x.id === sid).saldo, 529);
assert.equal((await xp.listarComprasContado({})).every((c) => c.numero !== cp), true, 'la compra a crédito no es de contado');
assert.ok((await xp.listarComprasContado({})).length >= 1);
const idOtra = (await uno('SELECT id FROM compras WHERE proveedor_id <> ? LIMIT 1', [sid])).id;
await assert.rejects(() => xp.crearNotaProveedor({ tipo: 'credito', proveedor_id: sid, compra_id: idOtra, monto: 5 }), /de este suplidor|a crédito/);

// circuito de compras: solicitud → requisición → orden → factura
const sol = await xp.crearSolicitud({ solicitante: 'Almacén', items: [{ producto_id: pid, cantidad: 12 }] });
assert.match(sol.numero, /^SC-/);
await assert.rejects(() => xp.crearRequisicion({ items: [{ producto_id: pid, cantidad: 12 }], solicitud_id: sol.id }), /aprobada/);
await assert.rejects(() => xp.cambiarEstadoSolicitud(sol.id, 'atendida'), /no puede pasar/);
await xp.cambiarEstadoSolicitud(sol.id, 'aprobada');
const rq = await xp.crearRequisicion({ items: [{ producto_id: pid, cantidad: 12 }], solicitud_id: sol.id });
assert.match(rq.numero, /^RQ-/); assert.equal((await xp.detalleSolicitud(sol.id)).estado, 'atendida');
const prov2 = (await uno('SELECT id FROM proveedores WHERE id <> ? ORDER BY id LIMIT 1', [sid])).id;
let dq = await xp.detalleRequisicion(rq.id); const linea = dq.items[0].id;
await assert.rejects(() => xp.guardarCotizacion({ requisicion_id: rq.id, proveedor_id: sid, precios: {} }), /al menos un precio/);
await xp.guardarCotizacion({ requisicion_id: rq.id, proveedor_id: sid, precios: { [linea]: 110 } });
await xp.guardarCotizacion({ requisicion_id: rq.id, proveedor_id: prov2, precios: { [linea]: 95 } });
await xp.guardarCotizacion({ requisicion_id: rq.id, proveedor_id: prov2, precios: { [linea]: 97 } }); // se reemplaza
dq = await xp.detalleRequisicion(rq.id);
assert.equal(dq.proveedores.length, 2); assert.equal(dq.mejor[linea], prov2); assert.equal(dq.totales.find((t) => t.proveedor_id === prov2).total, 1164);
const oc = await xp.adjudicarRequisicion({ requisicion_id: rq.id, proveedor_id: prov2, entrega: '2099-01-01' });
assert.match(oc.numero, /^OC-/);
assert.equal((await xp.detalleRequisicion(rq.id)).estado, 'adjudicada');
await assert.rejects(() => xp.adjudicarRequisicion({ requisicion_id: rq.id, proveedor_id: prov2 }), /ya no está abierta/);
let doc = await xp.detalleOrden(oc.id); assert.equal(doc.total, 1164); assert.equal(doc.estado, 'pendiente');
const stock0 = (await uno('SELECT stock_actual FROM productos WHERE id = ?', [pid])).stock_actual;
const cn2 = await bd.registrarCompra({ proveedor_id: prov2, items: [{ producto_id: pid, cantidad: 12, costo_unitario: 97 }], actualizarCosto: false });
await assert.rejects(() => xp.marcarOrdenRecibida(oc.id, cn2), /autorizada/);
await xp.autorizarOrden(oc.id);
doc = await xp.detalleOrden(oc.id); assert.equal(doc.estado, 'autorizada'); assert.ok(doc.autorizado_por);
await assert.rejects(() => xp.autorizarOrden(oc.id), /pendiente/);
await xp.marcarOrdenRecibida(oc.id, cn2);
doc = await xp.detalleOrden(oc.id); assert.equal(doc.estado, 'recibida'); assert.equal(doc.factura, cn2);
assert.equal((await uno('SELECT stock_actual FROM productos WHERE id = ?', [pid])).stock_actual, stock0 + 12);
await assert.rejects(() => xp.anularOrden(oc.id), /recibido/);
await xp.guardarCondicionProveedor(sid, { condicion: 'credito', dias: 45 });
await bd.ejecutar("INSERT INTO proveedores (nombre, condicion) VALUES ('Solo Contado SRL', 'contado')");
const scId = (await uno("SELECT id FROM proveedores WHERE nombre = 'Solo Contado SRL'")).id;
await assert.rejects(() => bd.registrarCompra({ proveedor_id: scId, forma_pago: 'credito', items: [{ producto_id: pid, cantidad: 1, costo_unitario: 10 }], actualizarCosto: false }), /no tiene crédito autorizado/);
const oc3 = await xp.crearOrden({ proveedor_id: sid, items: [{ producto_id: pid, cantidad: 1, costo_unitario: 50 }] });
let d3 = await xp.detalleOrden(oc3.id); assert.equal(d3.condicion, 'credito'); assert.equal(d3.dias_credito, 45);
const oc4 = await xp.crearOrden({ proveedor_id: sid, condicion: 'contado', items: [{ producto_id: pid, cantidad: 1, costo_unitario: 50 }] });
d3 = await xp.detalleOrden(oc4.id); assert.equal(d3.condicion, 'contado'); assert.equal(d3.dias_credito, null);
await assert.rejects(() => xp.crearOrden({ proveedor_id: sid, condicion: 'credito', dias_credito: -3, items: [{ producto_id: pid, cantidad: 1, costo_unitario: 50 }] }), /días/);
await xp.autorizarOrden(oc3.id); await xp.anularOrden(oc3.id); await xp.anularOrden(oc4.id);
const { ordenCompraHTML } = await import('../src/orden-compra-imp.js');
assert.ok((await ordenCompraHTML(oc.id)).includes('AUTORIZADA') && (await ordenCompraHTML(oc.id)).includes(oc.numero));
const oc2 = await xp.crearOrden({ proveedor_id: sid, items: [{ producto_id: pid, cantidad: 1, costo_unitario: 50 }] });
await xp.anularOrden(oc2.id); assert.equal((await xp.detalleOrden(oc2.id)).estado, 'anulada');
await assert.rejects(() => xp.crearOrden({ proveedor_id: sid, items: [] }), /al menos un producto/);
await assert.rejects(() => xp.crearOrden({ proveedor_id: sid, items: [{ producto_id: pid, cantidad: 1.5, costo_unitario: 1 }] }), /enteros/);
{
  // Entrada de factura desde una orden: contado, crédito y parcial amarrados al catálogo de cuentas
  const lib0 = await cd.libroContable();
  const sal = (lib, codigo) => r2(lib.lineas.filter((l) => l.cuenta_id === C[codigo].id).reduce((a, l) => a + l.debe - l.haber, 0));
  const antes = { inv: sal(lib0, '1301'), cxp: sal(lib0, '2101'), caja: sal(lib0, '1101') };
  await xp.guardarCondicionProveedor(sid, { condicion: 'contado' });
  const oa = await xp.crearOrden({ proveedor_id: sid, items: [{ producto_id: pid, cantidad: 10, costo_unitario: 100 }] });
  await xp.autorizarOrden(oa.id);
  const fa = await bd.registrarCompra({ proveedor_id: sid, items: [{ producto_id: pid, cantidad: 6, costo_unitario: 100 }], forma_pago: 'efectivo', actualizarCosto: false });
  await xp.marcarOrdenRecibida(oa.id, fa, {});
  assert.equal((await xp.detalleOrden(oa.id)).estado, 'parcial');
  await xp.guardarCondicionProveedor(sid, { condicion: 'credito', dias: 30 });
  const fb = await bd.registrarCompra({ proveedor_id: sid, items: [{ producto_id: pid, cantidad: 4, costo_unitario: 100 }], forma_pago: 'credito', actualizarCosto: false });
  await xp.marcarOrdenRecibida(oa.id, fb, {});
  assert.equal((await xp.detalleOrden(oa.id)).estado, 'recibida');
  const lib1 = await cd.libroContable();
  assert.deepEqual(lib1.faltantes, []);
  assert.equal(r2(lib1.lineas.reduce((a, l) => a + l.debe, 0)), r2(lib1.lineas.reduce((a, l) => a + l.haber, 0)));
  assert.equal(r2(sal(lib1, '1301') - antes.inv), 1000, 'el inventario recibido entra a 1301');
  assert.equal(r2(sal(lib1, '2101') - antes.cxp), -400, 'solo lo comprado a crédito queda en cuentas por pagar (2101)');
  assert.equal(r2(sal(lib1, '1101') - antes.caja), -600, 'lo de contado sale de caja (1101)');
}
ok('CxP: tipos de suplidor, notas de crédito y débito, anticipos, pagos repartidos, reportes, contabilidad cuadrando y circuito solicitud → requisición → orden → factura');
}

console.log(`\n${n} grupos de pruebas correctos`);
process.exit(0);
