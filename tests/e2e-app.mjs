// Prueba con el código REAL de la app (database.js, auth.js, nube-app.js, sync) sobre SQLite de Node.
// Ejecutar con: node --import ./tests/stubs/registrar.mjs tests/e2e-app.mjs
import assert from 'node:assert/strict';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };

const { crearServidor } = await import('../server/index.js');
const { abrirBase } = await import('../server/db.js');
const dbSrv = abrirBase(':memory:');
const servidor = crearServidor({ db: dbSrv, secreto: 'prueba-secreto-largo-1234567890', aprobacionAutomatica: true });
await new Promise((r) => servidor.listen(0, r));
const BASE = `http://127.0.0.1:${servidor.address().port}`;
localStorage.setItem('caraudio_servidor', BASE);

const bd = await import('../src/database.js');
const auth = await import('../src/auth.js');
const na = await import('../src/nube-app.js');
const { crearCliente } = await import('../src/nube.js');
let n = 0; const ok = (t) => { n++; console.log(`  ✔ ${t}`); };
const uno = async (sql, p) => (await bd.consultar(sql, p))[0];

console.log('La app real contra el servidor real');
await bd.initDB();
await na.cargarVinculo();
assert.equal(bd.sincronizacionLista(), true, 'triggers creados');
ok('la base se prepara para sincronizar (columnas y triggers)');

// ---- modo local ----
await auth.registrarPropietario({ negocio: 'Sonido Pro', nombre: 'Dueño', usuario: 'dueno', correo: 'dueno@x.com', clave: 'clave1234' });
await auth.iniciarSesion('dueno', 'clave1234');
await auth.crearUsuario({ nombre: 'Vera Vendedora', usuario: 'vera', correo: '', rol: 'vendedor', permisos: ['ventas', 'clientes'], clave: 'temporal12' });
await bd.ejecutar("INSERT INTO productos (codigo, nombre, costo, precio, stock_actual) VALUES ('B-1', 'Bocina', 50, 100, 10)");
const pid = (await uno("SELECT id FROM productos WHERE codigo = 'B-1'")).id;
await bd.ejecutar("INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo) VALUES (?, 'entrada', 10, 'saldo inicial')", [pid]);
const num1 = await bd.registrarVenta({ items: [{ producto_id: pid, cantidad: 2, precio_unitario: 100 }] });
assert.equal(num1, 'V-000001');
ok('en modo local todo sigue igual (venta V-000001)');

// ---- pasar a la nube ----
const { codigo, identificador: idNegocio, asignado } = await auth.registrarNegocioNube({ negocio: 'Sonido Pro', nombre: 'Dueño', usuario: 'dueno', correo: 'dueno@x.com', clave: 'clave1234' });
assert.match(idNegocio, /^9\d{8}$/, 'sin RNC el sistema asigna un número de 9 dígitos');
assert.equal(asignado, true);
assert.match(codigo, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
const entregadas = await auth.subirUsuariosLocales();
assert.deepEqual(entregadas.map((e) => e.usuario), ['vera']);
assert.ok(na.vinculado());
assert.equal(na.datosVinculo().negocio_id, idNegocio, 'el equipo recuerda el identificador del negocio');
assert.equal((await na.motor.pendientes()), 0);
const num2 = await bd.registrarVenta({ items: [{ producto_id: pid, cantidad: 1, precio_unitario: 100 }] });
assert.equal(num2, 'V-A000002'.replace('2', '2').replace('A0', 'A0'), 'formato con letra del dispositivo');
ok(`conectado a la nube; las ventas nuevas llevan la letra del dispositivo (${num2}); empleados migrados con contraseña temporal`);
await na.sincronizarAhora();

// ---- otro dispositivo (motor) ve los datos ----
const { DatabaseSync } = await import('node:sqlite');
const { prepararBase } = await import('../src/sync-esquema.js');
const { crearMotor } = await import('../src/sync-nucleo.js');
const fs = await import('node:fs');
const esquema = fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
const db2 = new DatabaseSync(':memory:'); db2.exec('PRAGMA foreign_keys = ON'); db2.exec(esquema);
for (const q of ['ALTER TABLE ventas ADD COLUMN usuario_id INTEGER', 'ALTER TABLE compras ADD COLUMN usuario_id INTEGER', 'ALTER TABLE cotizaciones ADD COLUMN usuario_id INTEGER']) db2.exec(q);
await prepararBase(async (q) => { db2.exec(q); });
const lote2 = async (sets) => { db2.exec('BEGIN'); try { for (const s of sets) db2.prepare(s.statement).run(...(s.values || [])); db2.exec('COMMIT'); } catch (e) { db2.exec('ROLLBACK'); throw e; } };
let tok2;
const cli2 = crearCliente({ base: () => BASE, token: () => tok2 });
const motor2 = crearMotor({ consultar: async (s, p = []) => db2.prepare(s).all(...p), lote: lote2, nube: cli2 });
const r2 = await cli2.login({ identificador: 'dueno@x.com', clave: 'clave1234', negocioId: idNegocio, dispositivo: 'segundo-dispositivo-xx' });
tok2 = r2.token;
await motor2.vincular({ dispositivo: 'segundo-dispositivo-xx', codigo: r2.dispositivo.codigo, negocio: r2.negocio.uid, negocioNombre: r2.negocio.nombre });
await motor2.reemplazarLocal();
const s2 = await motor2.sincronizar();
assert.equal(s2.errores.length, 0, s2.errores.join());
assert.equal(db2.prepare("SELECT stock_actual s FROM productos WHERE codigo = 'B-1'").get().s, 7);
assert.equal(db2.prepare('SELECT COUNT(*) n FROM ventas').get().n, 2);
assert.equal(r2.dispositivo.codigo, 'B');
ok('un segundo dispositivo descarga lo que se vendió en el primero (stock 10 - 2 - 1 = 7)');

// ---- ventas en ambos, se juntan ----
const prod2 = db2.prepare("SELECT id FROM productos WHERE codigo = 'B-1'").get().id;
db2.prepare("INSERT INTO ventas (numero, subtotal, total) VALUES ('V-B000001', 300, 300)").run();
const v2 = db2.prepare("SELECT id FROM ventas WHERE numero = 'V-B000001'").get().id;
db2.prepare('INSERT INTO venta_detalle (venta_id, producto_id, cantidad, precio_unitario) VALUES (?,?,3,100)').run(v2, prod2);
db2.prepare('UPDATE productos SET stock_actual = stock_actual - 3 WHERE id = ?').run(prod2);
db2.prepare("INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, referencia_id) VALUES (?, 'salida', -3, 'venta', ?)").run(prod2, v2);
await bd.registrarVenta({ items: [{ producto_id: pid, cantidad: 1, precio_unitario: 100 }] });
await motor2.sincronizar();
await na.sincronizarAhora();
await motor2.sincronizar();
assert.equal((await uno('SELECT stock_actual s FROM productos WHERE id = ?', [pid])).s, 3);
assert.equal(db2.prepare("SELECT stock_actual s FROM productos WHERE codigo = 'B-1'").get().s, 3);
assert.equal((await uno('SELECT COUNT(*) n FROM ventas')).n, 4);
ok('ventas simultáneas en los dos dispositivos: ambos quedan con stock 3 y 4 ventas');

// ---- inicio de sesión con y sin internet ----
await auth.cerrarSesion();
const u = await auth.iniciarSesion('dueno@x.com', 'clave1234');
assert.equal(u.usuario, 'dueno');
await auth.cerrarSesion();
localStorage.setItem('caraudio_servidor', 'http://127.0.0.1:1'); // sin conexión
const off = await auth.iniciarSesion('dueno', 'clave1234');
assert.equal(off.usuario, 'dueno');
await auth.cerrarSesion();
await assert.rejects(() => auth.iniciarSesion('dueno', 'otra-clave99'), /incorrectos/);
ok('entra con internet (por correo o usuario) y también sin internet; la clave mala se rechaza');
localStorage.setItem('caraudio_servidor', BASE);

// ---- empleado con contraseña temporal ----
const temp = entregadas[0].clave;
const vera = await auth.iniciarSesion('vera', temp);
assert.equal(vera.debeCambiar, true);
await auth.cambiarClaveTemporal(vera.id, 'nueva-vera-77');
await auth.cerrarSesion();
const vera2 = await auth.iniciarSesion('vera', 'nueva-vera-77');
assert.equal(vera2.debeCambiar, false);
assert.equal(vera2.rol, 'vendedor');
await assert.rejects(() => auth.crearUsuario({ nombre: 'X', usuario: 'xxx', rol: 'vendedor', permisos: [], clave: 'abcd1234' }), /administrador/);
await auth.cerrarSesion();
ok('el empleado cambia su contraseña temporal en la nube y entra con la nueva; no puede crear usuarios');

// ---- administrador gestiona usuarios en la nube ----
await auth.iniciarSesion('dueno', 'clave1234');
await auth.crearUsuario({ nombre: 'Carlos Cajero', usuario: 'carlos', correo: 'c@x.com', rol: 'cajero', permisos: ['ventas', 'caja'], clave: 'temporal34' });
const lista = await auth.listarUsuarios();
assert.deepEqual(lista.map((x) => x.usuario).sort(), ['carlos', 'dueno', 'vera']);
const carlos = lista.find((x) => x.usuario === 'carlos');
await auth.actualizarUsuario(carlos.id, { nombre: 'Carlos C.', correo: 'c@x.com', rol: 'cajero', permisos: ['ventas'], activo: false });
await assert.rejects(() => auth.iniciarSesion('carlos', 'temporal34'), /desactivada/);
const visto = await crearCliente({ base: () => BASE }).login({ identificador: 'dueno', clave: 'clave1234', negocioId: idNegocio, dispositivo: 'tercer-dispositivo-xx' });
assert.equal(visto.miembros.length, 3);
await auth.restablecerClave(carlos.id, 'otraTemp55');
ok('el administrador crea, desactiva y restablece usuarios, y el servidor lo refleja');

// ---- recuperación ----
const rec = await auth.recuperarConCodigo('dueno', codigo, 'recuperada88');
assert.match(rec.codigo, /^[A-Z0-9]{4}-/);
await auth.cerrarSesion();
await auth.iniciarSesion('dueno', 'recuperada88');
ok('recuperar la contraseña con el código funciona en la nube');

// ---- otro negocio en el mismo dispositivo ----
await na.sincronizarAhora();
assert.equal(await na.motor.pendientes(), 0);
// Secuencias de NCF autorizadas al primer negocio: no deben pasar al siguiente
await bd.guardarSecuenciaNCF('B01', 4, 50);
await bd.guardarSecuenciaNCF('B02', 1, 50);
await auth.cerrarSesion();
await na.vaciarDispositivo();
assert.deepEqual((await bd.leerSecuenciasNCF()).map((s) => [s.sig, s.hasta]).flat().filter(Boolean), [], 'el negocio nuevo no hereda las secuencias de NCF');
assert.equal(await auth.existenUsuarios(), false, 'sin usuarios: vuelve a la bienvenida');
assert.equal((await uno('SELECT COUNT(*) AS n FROM productos')).n, 0);
assert.equal(na.vinculado(), false);
const nuevo = await auth.registrarNegocioNube({ negocio: 'Segundo Negocio', nombre: 'Pedro', usuario: 'pedro', correo: 'pedro@x.com', clave: 'clave5678', rnc: '131-23456-7' });
assert.ok(nuevo.codigo);
assert.equal(nuevo.identificador, '131234567'); assert.equal(nuevo.asignado, false);
assert.equal((await uno('SELECT COUNT(*) AS n FROM productos')).n, 0, 'no se mezcla con el negocio anterior');
await bd.guardarSecuenciaNCF('B01', 900, 950); // las del segundo negocio
await na.vaciarDispositivo();
assert.equal(na.datosVinculo(), null);
// En un equipo nuevo se pide el RNC del negocio; sin él (o mal escrito) no se entra
await assert.rejects(() => auth.entrarConCuentaNube('dueno', 'recuperada88', 'reemplazar'), /Escribe el RNC del negocio/);
await assert.rejects(() => auth.entrarConCuentaNube('dueno', 'recuperada88', 'reemplazar', undefined, '123'), /9 números/);
await assert.rejects(() => auth.entrarConCuentaNube('dueno', 'recuperada88', 'reemplazar', undefined, '131234567'), /incorrectos/, 'ese RNC es de otro negocio');
const volver = await auth.entrarConCuentaNube('dueno', 'recuperada88', 'reemplazar', undefined, idNegocio);
assert.ok(volver);
assert.equal((await uno('SELECT COUNT(*) AS n FROM productos')).n, 1, 'los datos del primer negocio vuelven desde la nube');
assert.equal(na.datosVinculo().negocio_id, idNegocio);
const secVuelta = await bd.leerSecuenciasNCF();
assert.deepEqual([secVuelta.find((s) => s.tipo === 'B01').sig, secVuelta.find((s) => s.tipo === 'B01').hasta], [4, 50], 'al volver al primer negocio recupera SUS secuencias, no las del segundo');
// Ya vinculado, no se vuelve a pedir el RNC
await auth.cerrarSesion();
await auth.iniciarSesion('dueno', 'recuperada88');
ok('se puede crear otro negocio en el mismo dispositivo y volver al anterior desde la nube');

// ---- límite de crédito del cliente ----
await bd.ejecutar("INSERT INTO clientes (nombre, tipo_doc, documento, limite_credito, condicion, dias_credito) VALUES ('Taller Limite', 'rnc', '131234567', 300, 'credito', 30)");
const cLim = (await uno("SELECT id FROM clientes WHERE nombre = 'Taller Limite'")).id;
const pLim = (await uno("SELECT id FROM productos WHERE codigo = 'B-1'")).id;
await bd.ejecutar('UPDATE productos SET stock_actual = 100 WHERE id = ?', [pLim]);
await bd.registrarVenta({ cliente_id: cLim, metodo_pago: 'credito', inicial: 0, dias_credito: 30, items: [{ producto_id: pLim, cantidad: 2, precio_unitario: 100 }] }); // debe 200
await assert.rejects(() => bd.registrarVenta({ cliente_id: cLim, metodo_pago: 'credito', inicial: 0, dias_credito: 30, items: [{ producto_id: pLim, cantidad: 2, precio_unitario: 100 }] }), /límite de crédito/);
await bd.registrarVenta({ cliente_id: cLim, metodo_pago: 'credito', inicial: 100, dias_credito: 30, items: [{ producto_id: pLim, cantidad: 2, precio_unitario: 100 }] }); // 200 + 100 = 300: justo en el límite
await assert.rejects(() => bd.registrarVenta({ cliente_id: cLim, metodo_pago: 'credito', inicial: 0, items: [{ producto_id: pLim, cantidad: 1, precio_unitario: 100 }] }), /límite de crédito/);
await bd.registrarVenta({ cliente_id: cLim, metodo_pago: 'efectivo', items: [{ producto_id: pLim, cantidad: 1, precio_unitario: 100 }] }); // al contado no cuenta
ok('el límite de crédito impide ventas fiadas que lo pasen; al contado se vende normal');

// ---- recibos de ingreso: varios métodos, varias facturas ----
const pend0 = await bd.facturasPendientes(cLim);
assert.equal(pend0.length, 2);
const [f1, f2] = pend0; // 200 y 100 pendientes
assert.equal(f1.saldo, 200); assert.equal(f2.saldo, 100);
const base = { clienteId: cLim, aplicaciones: [{ ventaId: f1.id, monto: 200 }, { ventaId: f2.id, monto: 50 }] };
await assert.rejects(() => bd.registrarCobro({ ...base, metodos: [{ metodo: 'efectivo', monto: 150 }, { metodo: 'cheque', monto: 100 }] }), /número de cheque/);
await assert.rejects(() => bd.registrarCobro({ ...base, metodos: [{ metodo: 'efectivo', monto: 150 }] }), /debe ser igual/);
await assert.rejects(() => bd.registrarCobro({ ...base, aplicaciones: [{ ventaId: f2.id, monto: 150 }], metodos: [{ metodo: 'efectivo', monto: 150 }] }), /no puede pasar/);
await assert.rejects(() => bd.registrarCobro({ ...base, metodos: [{ metodo: 'bitcoin', monto: 250 }] }), /no válido/);
assert.equal((await uno('SELECT COUNT(*) AS n FROM recibos')).n, 0, 'los intentos rechazados no dejan nada');
const cobro1 = await bd.registrarCobro({ ...base, notas: 'Pago parcial', metodos: [{ metodo: 'efectivo', monto: 150 }, { metodo: 'cheque', monto: 100, referencia: 'Cheque 1234 Popular' }] });
assert.match(cobro1.numero, /^R-[A-Z]?000001$/);
const pagosRec = await bd.consultar('SELECT venta_id, monto, metodo FROM pagos WHERE recibo_id = ? ORDER BY id', [cobro1.id]);
assert.deepEqual(pagosRec.map((x) => [x.venta_id === f1.id ? 'F1' : 'F2', x.monto, x.metodo]), [['F1', 150, 'efectivo'], ['F1', 50, 'cheque'], ['F2', 50, 'cheque']]);
const pend1 = await bd.facturasPendientes(cLim);
assert.equal(pend1.length, 1); assert.equal(pend1[0].saldo, 50, 'la segunda factura queda con 50 pendientes (pago parcial)');
assert.equal((await uno('SELECT total FROM recibos WHERE id = ?', [cobro1.id])).total, 250);
assert.equal((await bd.consultar('SELECT metodo, monto, referencia FROM recibo_metodos WHERE recibo_id = ? ORDER BY id', [cobro1.id])).length, 2);
const resCaja = await bd.resumenCaja({ id: -1, fecha_apertura: '2000-01-01 00:00:00', efectivo_inicial: 0 });
assert.equal(resCaja.cheque, 100, 'los cheques cobrados salen aparte del efectivo de la caja');
// otro cobro: el número avanza y una factura saldada ya no se puede cobrar
const cobro2 = await bd.registrarCobro({ clienteId: cLim, aplicaciones: [{ ventaId: f2.id, monto: 50 }], metodos: [{ metodo: 'transferencia', monto: 50, referencia: 'REF-9' }] });
assert.match(cobro2.numero, /000002$/);
assert.equal((await bd.facturasPendientes(cLim)).length, 0);
await assert.rejects(() => bd.registrarCobro({ clienteId: cLim, aplicaciones: [{ ventaId: f2.id, monto: 10 }], metodos: [{ metodo: 'efectivo', monto: 10 }] }), /ya no tiene saldo/);
// anular devuelve la deuda
await bd.anularRecibo(cobro1.id);
assert.equal((await bd.facturasPendientes(cLim)).reduce((s, f) => s + f.saldo, 0), 250);
await assert.rejects(() => bd.anularRecibo(cobro1.id), /ya está anulado/);
assert.equal((await uno('SELECT estado FROM recibos WHERE id = ?', [cobro1.id])).estado, 'anulado');
ok('un recibo cobra varias facturas con efectivo y cheque a la vez, valida lo rechazable, separa el cheque en la caja y se puede anular');

// ---- ITBIS, NCF, 606/607 y reportes de negocio ----
const itb = await import('../src/itbis.js');
const rf = await import('../src/reportes-fiscal.js');
assert.equal(itb.calcularItbis({ lineas: [{ neto: 118, exento: false }], tasa: 18, modo: 'incluido' }), 18);
assert.equal(itb.calcularItbis({ lineas: [{ neto: 118, exento: false }, { neto: 100, exento: true }], tasa: 18, modo: 'incluido' }), 18, 'lo exento no lleva ITBIS');
assert.equal(itb.calcularItbis({ lineas: [{ neto: 118, exento: false }], descuento: 11.8, tasa: 18, modo: 'incluido' }), 16.2, 'el descuento baja la base');
assert.equal(itb.calcularItbis({ lineas: [{ neto: 118 }], tasa: 18, modo: 'no' }), 0);
const mesAct = (await uno("SELECT strftime('%Y-%m', 'now', 'localtime') AS m")).m;
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo', 'incluido')");
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('negocio_rnc', '131234567')");
const nubeNcf = (await import('../src/nube.js')).nube; // con la nube, las secuencias son del negocio y viven en el servidor
await nubeNcf.guardarNcf('B02', { siguiente: 1, hasta: 2 });
await nubeNcf.guardarNcf('B01', { siguiente: 10, hasta: 11 });
await assert.rejects(() => nubeNcf.guardarNcf('B02', { siguiente: 9, hasta: 3 }), /mayor/);
await bd.ejecutar("INSERT INTO productos (codigo, nombre, costo, precio, stock_actual, itbis_exento) VALUES ('EX-1', 'Libro exento', 20, 100, 50, 1)");
await bd.ejecutar("INSERT INTO productos (codigo, nombre, costo, precio, stock_actual) VALUES ('GR-1', 'Cable gravado', 40, 118, 50)");
const pEx = (await uno("SELECT id FROM productos WHERE codigo = 'EX-1'")).id;
const pGr = (await uno("SELECT id FROM productos WHERE codigo = 'GR-1'")).id;
await bd.ejecutar("INSERT INTO clientes (nombre, tipo_doc, documento) VALUES ('Empresa SRL', 'rnc', '101123456')");
const cEmp = (await uno("SELECT id FROM clientes WHERE nombre = 'Empresa SRL'")).id;
await bd.registrarVenta({ items: [{ producto_id: pGr, cantidad: 1, precio_unitario: 118 }] });                       // B02...01, ITBIS 18
await bd.registrarVenta({ cliente_id: cEmp, items: [{ producto_id: pGr, cantidad: 1, precio_unitario: 118 }, { producto_id: pEx, cantidad: 1, precio_unitario: 100 }] }); // B01...10, ITBIS 18
await bd.registrarVenta({ cliente_id: cEmp, metodo_pago: 'credito', dias_credito: 15, items: [{ producto_id: pGr, cantidad: 2, precio_unitario: 118 }] }); // B01...11, ITBIS 36
await bd.registrarVenta({ items: [{ producto_id: pEx, cantidad: 1, precio_unitario: 100 }] });                       // B02...02, ITBIS 0
await bd.registrarVenta({ items: [{ producto_id: pGr, cantidad: 1, precio_unitario: 118 }], metodo_pago: 'tarjeta' }); // sin secuencia: sin NCF
const vf = await bd.consultar("SELECT ncf, itbis, total FROM ventas WHERE ncf IS NOT NULL OR itbis > 0 ORDER BY id DESC LIMIT 5");
const porNcf = Object.fromEntries(vf.filter((x) => x.ncf).map((x) => [x.ncf, x.itbis]));
assert.deepEqual(porNcf, { B0200000001: 18, B0100000010: 18, B0100000011: 36, B0200000002: 0 }, 'B01 para clientes con RNC, B02 para el resto, ITBIS solo de lo gravado');
assert.equal((await uno('SELECT itbis, ncf FROM ventas ORDER BY id DESC LIMIT 1')).ncf, null, 'sin secuencia disponible la venta queda sin NCF');
const sinNcf = await uno('SELECT id FROM ventas ORDER BY id DESC LIMIT 1');
await assert.rejects(() => bd.asignarNCFVenta(sinNcf.id, 'XX'), /formato/);
await assert.rejects(() => bd.asignarNCFVenta(sinNcf.id, 'B0200000001'), /ya se usó/);
await bd.asignarNCFVenta(sinNcf.id, 'B0200000050');
// compras y gastos con comprobante
await bd.ejecutar("INSERT INTO proveedores (nombre, tipo_doc, documento) VALUES ('Distribuidora SA', 'rnc', '130999888')");
const prov = (await uno("SELECT id FROM proveedores WHERE nombre = 'Distribuidora SA'")).id;
await assert.rejects(() => bd.registrarCompra({ proveedor_id: prov, ncf: 'malo', items: [{ producto_id: pGr, cantidad: 1, costo_unitario: 100 }] }), /NCF/);
await assert.rejects(() => bd.registrarCompra({ proveedor_id: prov, itbis: 500, items: [{ producto_id: pGr, cantidad: 1, costo_unitario: 100 }] }), /ITBIS/);
await bd.registrarCompra({ proveedor_id: prov, ncf: 'B0100000777', itbis: 18, items: [{ producto_id: pGr, cantidad: 1, costo_unitario: 118 }] });
await bd.registrarCompra({ proveedor_id: prov, items: [{ producto_id: pGr, cantidad: 1, costo_unitario: 50 }] });
if (!(await bd.cajaAbierta())) await bd.abrirCaja(0);
await bd.registrarGasto({ concepto: 'Internet', categoria: 'Servicios', monto: 59, itbis: 9, ncf: 'B0100000123', documento: '101-00000-1' });
const imp = await rf.datosImpuestos(mesAct);
assert.equal(imp.cobrado, 90, 'ITBIS cobrado: 18 + 18 + 36 + 0 + 18 (la de tarjeta)');
assert.equal(imp.pagado, 27, 'ITBIS pagado: compra 18 + gasto 9');
assert.equal(imp.aPagar, 63);
assert.equal(imp.filas607.length, 5, 'las 5 ventas con NCF entran al 607');
assert.equal(imp.filas606.length, 2, 'compra y gasto con NCF entran al 606');
assert.ok(imp.avisos.some((a) => /compras sin NCF/.test(a)), 'avisa de la compra sin NCF');
const f01 = imp.filas607.find((f) => f[2] === 'B0100000010');
assert.equal(f01.length, 23); assert.equal(f01[0], '101123456'); assert.equal(f01[1], '1'); assert.equal(f01[7], '200.00'); assert.equal(f01[8], '18.00'); assert.equal(f01[16], '218.00', 'pagada en efectivo');
assert.equal(imp.filas607.find((f) => f[2] === 'B0100000011')[19], '236.00', 'la venta a crédito va en la columna de crédito');
const f606 = imp.filas606.find((f) => f[3] === 'B0100000777');
assert.equal(f606.length, 23); assert.equal(f606[8], '100.00'); assert.equal(f606[10], '18.00'); assert.equal(f606[2], '09');
assert.equal(imp.filas606.find((f) => f[3] === 'B0100000123')[0], '101000001', 'el RNC del gasto se limpia');
const txt = itb.textoDGII('607', '131234567', mesAct.replace('-', ''), imp.filas607);
assert.equal(txt.split('\r\n')[0], `607|131234567|${mesAct.replace('-', '')}|5`);
assert.equal(itb.nombreArchivoDGII('607', '13-12345-67', '202601'), 'DGII_F_607_131234567_202601.TXT');
assert.ok(itb.csv(['a', 'b'], [['x,y', 'z']]).includes('"x,y"'));
// negocio y P&L
const neg = await rf.datosNegocio('mes', null);
assert.ok(neg.porCliente.find((x) => x.nombre === 'Empresa SRL'));
assert.ok(neg.porCategoria.length >= 1 && neg.porProducto.length >= 2);
assert.equal(neg.pyg.bruta, neg.pyg.ingresos - neg.pyg.costo);
assert.equal(neg.pyg.neta, Math.round((neg.pyg.bruta - neg.pyg.gastos) * 100) / 100);
assert.equal(neg.pyg.gastos, 50, 'el gasto se muestra sin su ITBIS (59 - 9)');
// flujo de caja
const flujo = await rf.datosFlujo();
assert.ok(flujo.totalEntra > 0);
const sumaEntra = flujo.tramos.reduce((s, t) => s + t.entra, 0);
assert.ok(Math.abs(sumaEntra - flujo.totalEntra) < 0.01, 'todo lo por cobrar cae en algún tramo');
assert.equal(flujo.tramos.at(-1).acumulado, Math.round((flujo.inicial + flujo.totalEntra - flujo.totalSale) * 100) / 100);
ok('el ITBIS y el NCF se asignan solos, los 607/606 y el resumen de ITBIS cuadran, y salen el P&L, las ventas por cliente/producto y el flujo de caja');

// ---- avisos en el dispositivo ----
dbSrv.prepare("INSERT INTO avisos (negocio, titulo, mensaje, nivel, caduca) VALUES (NULL, 'Novedad', 'Hay una versión nueva', 'info', '2099-01-01')").run();
let av = await na.cargarAvisos();
assert.equal(av.avisos.length, 1); assert.equal(av.sinLeer, 1);
await na.marcarAvisosLeidos();
assert.equal(na.estadoAvisos().sinLeer, 0);
assert.equal((await na.cargarAvisos()).sinLeer, 0, 'el servidor recuerda que ya se leyó');
ok('el dispositivo descarga los avisos y los marca como leídos');

// ---- secuencias de NCF del negocio: viven en el servidor y cada factura pide su número ----
{
  const { nube } = await import('../src/nube.js');
  const fv = async (tipo) => (await bd.consultar("SELECT ncf FROM ventas WHERE ncf LIKE ? ORDER BY id", [`${tipo}%`])).map((x) => x.ncf);
  await bd.guardarSecuenciaNCF('B14', 0, 0);
  const antes = (await fv('B14')).length;
  await nube.guardarNcf('B14', { siguiente: 100, hasta: 112 });
  const venta14 = () => bd.registrarVenta({ cliente_id: cEmp, tipo_ncf: 'B14', items: [{ producto_id: pGr, cantidad: 1, precio_unitario: 118 }] });
  await venta14();
  assert.deepEqual((await fv('B14')).slice(antes), ['B1400000100'], 'la primera factura usa el primer número del negocio');
  // Otro equipo del negocio factura en medio: recibe el siguiente, no el mismo
  const otro = await nube.siguienteNcf({ candidatos: ['B14'], clave: 'otro-equipo-clave-1', dispositivo: 'otro-equipo-xxxx' });
  assert.equal(otro.numero, 101);
  await venta14();
  assert.deepEqual((await fv('B14')).slice(antes), ['B1400000100', 'B1400000102'], 'el equipo no usó el 101 que tomó el otro');
  // Sin internet no se factura con comprobante, y no se gasta ningún número ni queda venta a medias
  const ventasAntes = (await uno('SELECT COUNT(*) AS n FROM ventas')).n;
  const base = localStorage.getItem('caraudio_servidor');
  localStorage.setItem('caraudio_servidor', 'http://127.0.0.1:1');
  await assert.rejects(() => venta14(), /no pudo realizar esta factura/);
  localStorage.setItem('caraudio_servidor', base);
  assert.equal((await uno('SELECT COUNT(*) AS n FROM ventas')).n, ventasAntes, 'no se guardó la venta');
  await venta14();
  assert.equal((await fv('B14')).slice(antes).pop(), 'B1400000103', 'al volver el internet sigue la numeración sin saltos');
  // Sin internet no se emite NINGUNA factura, ni siquiera sin comprobante (así no se cruzan números de documento)
  await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo', 'no')");
  localStorage.setItem('caraudio_servidor', 'http://127.0.0.1:1');
  await assert.rejects(() => bd.registrarVenta({ items: [{ producto_id: pGr, cantidad: 1, precio_unitario: 118 }] }), /Por falta de conexión a internet el sistema no pudo realizar esta factura/);
  localStorage.setItem('caraudio_servidor', base);
  await bd.registrarVenta({ items: [{ producto_id: pGr, cantidad: 1, precio_unitario: 118 }] }); // con internet sí
  await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo', 'incluido')");
  // Caso raro 1: el servidor entrega el número pero la respuesta nunca llega (se cae el internet). Se avisa y el número queda anulado
  const fetchReal = globalThis.fetch;
  globalThis.fetch = async (url, op) => { const r = await fetchReal(url, op); if (String(url).endsWith('/api/ncf/siguiente')) throw new TypeError('fetch failed'); return r; };
  const ventasA = (await uno('SELECT COUNT(*) AS n FROM ventas')).n;
  await assert.rejects(() => venta14(), /Por falta de conexión a internet el sistema no pudo realizar esta factura/);
  globalThis.fetch = fetchReal;
  assert.equal((await uno('SELECT COUNT(*) AS n FROM ventas')).n, ventasA, 'no quedó ninguna venta a medias');
  await venta14(); // al volver el internet se anula el número perdido y esta factura sigue
  const lista = await nube.ncf();
  assert.deepEqual(lista.anulados.map((x) => `${x.tipo}${x.numero}`), ['B14104'], 'el comprobante perdido consta como anulado');
  assert.equal((await fv('B14')).slice(antes).pop(), 'B1400000105', 'la factura siguiente usa el número que sigue');
  assert.deepEqual((await bd.consultar('SELECT ncf, origen FROM ncf_anulados ORDER BY id')).map((x) => x.ncf), ['B1400000104'], 'el equipo guarda el comprobante anulado para el 608');
  assert.ok((await bd.consultar("SELECT detalle FROM bitacora WHERE accion = 'Comprobante anulado por el sistema'")).some((x) => x.detalle.includes('B1400000104')), 'consta en la bitácora');
  // Caso raro 2: el número se entrega pero la factura no se puede guardar en el equipo. Se anula y se pide repetir
  await bd.ejecutar("CREATE TRIGGER t_falla_venta BEFORE INSERT ON ventas BEGIN SELECT RAISE(ABORT, 'falla simulada'); END");
  await assert.rejects(() => venta14(), /No se pudo guardar la factura.*B1400000106 quedó anulado.*vuelve a realizar la factura/);
  await bd.ejecutar('DROP TRIGGER t_falla_venta');
  assert.ok((await nube.ncf()).anulados.some((x) => x.numero === 106), 'el número 106 consta como anulado en el servidor');
  assert.deepEqual((await bd.consultar('SELECT ncf FROM ncf_anulados ORDER BY id')).map((x) => x.ncf), ['B1400000104', 'B1400000106']);
  // Reporte: el formato 608 lleva los dos y el resumen avisa
  const rf = await import('../src/reportes-fiscal.js');
  const imp = await rf.datosImpuestos(new Date().toISOString().slice(0, 7));
  const f608 = imp.filas608.map((r) => r[0]);
  assert.ok(f608.includes('B1400000104') && f608.includes('B1400000106'), 'el 608 incluye los comprobantes anulados por el sistema');
  assert.ok(imp.filas608.every((r) => /^\d{8}$/.test(r[1]) && /^(04|08)$/.test(r[2])), 'fecha AAAAMMDD y tipo de anulación');
  assert.ok(imp.avisos.some((a) => /no se llegó a guardar/.test(a) && a.includes('B1400000106')), 'el resumen avisa para actuar');
  await venta14();
  assert.equal((await fv('B14')).slice(antes).pop(), 'B1400000107');
  // Migración: lo que el equipo tenía solo para sí (modo anterior) pasa a ser del negocio
  await bd.guardarSecuenciaNCF('B15', 700, 760);
  const subidos = await na.subirSecuenciasLocales();
  assert.deepEqual(subidos, ['B15']);
  assert.equal((await nube.ncf()).secuencias.find((x) => x.tipo === 'B15').hasta, 760);
  assert.equal((await bd.leerSecuenciasNCF()).find((x) => x.tipo === 'B15').sig, 0, 'el equipo ya no la guarda aparte');
  await bd.guardarSecuenciaNCF('B15', 1, 5);
  assert.deepEqual(await na.subirSecuenciasLocales(), [], 'la secuencia ya definida por el negocio no se pisa');
  assert.equal((await nube.ncf()).secuencias.find((x) => x.tipo === 'B15').hasta, 760);
}
ok('las secuencias de NCF son del negocio: cada factura pide su número al servidor, sin internet no se emite ninguna factura y los números perdidos quedan anulados');

// ---- la bitácora registra quién hizo qué ----
{
  if (!(await bd.cajaAbierta())) await bd.abrirCaja(100);
  await bd.registrarGasto({ concepto: 'Gasolina', monto: 40 });
  await bd.anotar('Producto modificado', 'Bocina: precio 100 → 120');
  const log = (await bd.consultar('SELECT usuario, accion, detalle FROM bitacora')).map((x) => `${x.accion}|${x.detalle}|${x.usuario}`);
  assert.ok(log.some((x) => x.startsWith('Gasto registrado|Gasolina 40')), 'gasto');
  assert.ok(log.some((x) => /^Producto modificado\|Bocina: precio 100 → 120\|\w+/.test(x)), 'con el usuario que lo hizo');
  assert.ok(await bd.consultar('SELECT 1 FROM bitacora WHERE usuario IS NOT NULL LIMIT 1').then((r) => r.length), 'queda el nombre de usuario');
}
ok('la bitácora anota caja, gastos y cambios con el usuario que los hizo');

servidor.close();
console.log(`\n${n} grupos de pruebas correctos`);
process.exit(0);
