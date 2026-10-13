// Prueba con el código REAL de la app (database.js, auth.js, nube-app.js, sync) sobre SQLite de Node.
// Ejecutar con: node --import ./tests/stubs/registrar.mjs tests/e2e-app.mjs
import assert from 'node:assert/strict';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };

const { crearServidor } = await import('../server/index.js');
const { abrirBase } = await import('../server/db.js');
const servidor = crearServidor({ db: abrirBase(':memory:'), secreto: 'prueba-secreto-largo-1234567890', aprobacionAutomatica: true });
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
const { codigo } = await auth.registrarNegocioNube({ negocio: 'Sonido Pro', nombre: 'Dueño', usuario: 'dueno', correo: 'dueno@x.com', clave: 'clave1234' });
assert.match(codigo, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
const entregadas = await auth.subirUsuariosLocales();
assert.deepEqual(entregadas.map((e) => e.usuario), ['vera']);
assert.ok(na.vinculado());
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
const r2 = await cli2.login({ identificador: 'dueno@x.com', clave: 'clave1234', dispositivo: 'segundo-dispositivo-xx' });
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
const visto = await crearCliente({ base: () => BASE }).login({ identificador: 'dueno', clave: 'clave1234', dispositivo: 'tercer-dispositivo-xx' });
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
await auth.cerrarSesion();
await na.vaciarDispositivo();
assert.equal(await auth.existenUsuarios(), false, 'sin usuarios: vuelve a la bienvenida');
assert.equal((await uno('SELECT COUNT(*) AS n FROM productos')).n, 0);
assert.equal(na.vinculado(), false);
const nuevo = await auth.registrarNegocioNube({ negocio: 'Segundo Negocio', nombre: 'Pedro', usuario: 'pedro', correo: 'pedro@x.com', clave: 'clave5678' });
assert.ok(nuevo.codigo);
assert.equal((await uno('SELECT COUNT(*) AS n FROM productos')).n, 0, 'no se mezcla con el negocio anterior');
await na.vaciarDispositivo();
const volver = await auth.entrarConCuentaNube('dueno', 'recuperada88', 'reemplazar');
assert.ok(volver);
assert.equal((await uno('SELECT COUNT(*) AS n FROM productos')).n, 1, 'los datos del primer negocio vuelven desde la nube');
ok('se puede crear otro negocio en el mismo dispositivo y volver al anterior desde la nube');

servidor.close();
console.log(`\n${n} grupos de pruebas correctos`);
process.exit(0);
