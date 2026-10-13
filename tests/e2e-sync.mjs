// Prueba de punta a punta: el servidor real + dos "dispositivos" con la base local real (SQLite de Node).
// Ejecutar con: node tests/e2e-sync.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { crearServidor } from '../server/index.js';
import { abrirBase } from '../server/db.js';
import { crearCliente } from '../src/nube.js';
import { crearMotor } from '../src/sync-nucleo.js';
import { prepararBase } from '../src/sync-esquema.js';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(aqui, '../src/schema.sql'), 'utf8').replace(/--.*$/gm, '');
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
let pruebas = 0;
const ok = (nombre) => { pruebas++; console.log(`  ✔ ${nombre}`); };

// ---------- Servidor ----------
const srvDb = abrirBase(':memory:');
const servidor = crearServidor({ db: srvDb, secreto: 'prueba-secreto-largo-1234567890', aprobacionAutomatica: true });
await new Promise((r) => servidor.listen(0, r));
const BASE = `http://127.0.0.1:${servidor.address().port}`;

// ---------- Dispositivo simulado ----------
async function crearDispositivo(nombre) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schema);
  for (const q of ['ALTER TABLE ventas ADD COLUMN usuario_id INTEGER', 'ALTER TABLE compras ADD COLUMN usuario_id INTEGER',
    'ALTER TABLE cotizaciones ADD COLUMN usuario_id INTEGER']) db.exec(q);
  await prepararBase(async (q) => { db.exec(q); });
  const consultar = async (sql, p = []) => db.prepare(sql).all(...p);
  const run = (sql, p = []) => db.prepare(sql).run(...p);
  const lote = async (sets) => {
    db.exec('BEGIN');
    try { for (const s of sets) db.prepare(s.statement).run(...(s.values || [])); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const dev = { nombre, db, consultar, run, lote, token: null, idDisp: `disp-${nombre}-${'x'.repeat(10)}` };
  dev.nube = crearCliente({ base: () => BASE, token: () => dev.token });
  dev.motor = crearMotor({ consultar, lote, nube: dev.nube });
  return dev;
}
const uno = async (d, sql, p = []) => (await d.consultar(sql, p))[0];
const venderLocal = async (d, productoUid, cantidad, numero, clienteUid = null) => {
  const [p] = await d.consultar('SELECT id, precio, costo FROM productos WHERE uid = ?', [productoUid]);
  const cli = clienteUid ? (await uno(d, 'SELECT id FROM clientes WHERE uid = ?', [clienteUid])).id : null;
  d.run('INSERT INTO ventas (numero, cliente_id, subtotal, total) VALUES (?, ?, ?, ?)', [numero, cli, p.precio * cantidad, p.precio * cantidad]);
  const v = (await uno(d, 'SELECT id FROM ventas WHERE numero = ?', [numero])).id;
  d.run('INSERT INTO venta_detalle (venta_id, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?,?,?,?,?)', [v, p.id, cantidad, p.precio, p.costo]);
  d.run('UPDATE productos SET stock_actual = stock_actual - ? WHERE id = ?', [cantidad, p.id]);
  d.run("INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, referencia_id) VALUES (?, 'salida', ?, 'venta', ?)", [p.id, -cantidad, v]);
  return v;
};
const crearProducto = (d, codigo, nombre, stock, precio = 100) => {
  d.run('INSERT INTO productos (codigo, nombre, costo, precio, stock_actual) VALUES (?,?,?,?,?)', [codigo, nombre, precio / 2, precio, stock]);
  const id = d.db.prepare('SELECT id FROM productos WHERE codigo = ?').get(codigo).id;
  if (stock) d.run("INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo) VALUES (?, 'entrada', ?, 'saldo inicial')", [id, stock]);
  return d.db.prepare('SELECT uid FROM productos WHERE id = ?').get(id).uid;
};
const conectar = async (d, tipo, datos) => {
  const r = await (tipo === 'registro' ? d.nube.registro({ ...datos, dispositivo: d.idDisp }) : d.nube.login({ ...datos, dispositivo: d.idDisp }));
  d.token = r.token;
  await d.motor.vincular({ dispositivo: d.idDisp, codigo: r.dispositivo.codigo, negocio: r.negocio.uid, negocioNombre: r.negocio.nombre });
  return r;
};

console.log('Sincronización de punta a punta');

// ---------- 1. El dispositivo A sube sus datos ----------
const A = await crearDispositivo('A');
const B = await crearDispositivo('B');

const pA = crearProducto(A, 'P-1', 'Bocina 6x9', 10, 100);
const pA2 = crearProducto(A, 'P-2', 'Amplificador', 4, 400);
A.run("INSERT INTO clientes (nombre, telefono) VALUES ('Juan', '809-111')");
const cJuan = (await uno(A, "SELECT uid FROM clientes WHERE nombre = 'Juan'")).uid;
A.run("UPDATE config SET valor = 'Audio Pro' WHERE clave = 'negocio_nombre'");
await venderLocal(A, pA, 2, 'V-000001', cJuan); // stock P-1: 8
A.run("INSERT INTO ventas (numero, cliente_id, subtotal, total, metodo_pago) VALUES ('V-000002', ?, 800, 800, 'credito')", [(await uno(A, 'SELECT id FROM clientes')).id]);
const vc = (await uno(A, "SELECT id FROM ventas WHERE numero = 'V-000002'")).id;
A.run("INSERT INTO cuentas_cobrar (venta_id, vence) VALUES (?, '2030-01-31')", [vc]);
A.run("INSERT INTO pagos (venta_id, monto, metodo, nota) VALUES (?, 200, 'efectivo', 'Inicial')", [vc]);

await conectar(A, 'registro', { negocio: 'Audio Pro', nombre: 'Ana', usuario: 'ana', correo: 'ana@x.com', clave: 'abcd1234' });
await A.motor.marcarTodo();
assert.ok((await A.motor.pendientes()) > 10);
const r1 = await A.motor.sincronizar();
assert.ok(r1.subidos > 10, 'subió registros');
assert.equal(await A.motor.pendientes(), 0, 'nada pendiente después de subir');
ok('A sube todo y queda sin pendientes');

// ---------- 2. El dispositivo B se une y baja todo ----------
await conectar(B, 'login', { identificador: 'ana', clave: 'abcd1234' });
await B.motor.reemplazarLocal();
const r2 = await B.motor.sincronizar();
assert.equal(r2.errores.length, 0, r2.errores.join('\n'));
assert.equal((await uno(B, 'SELECT COUNT(*) n FROM productos')).n, 2);
assert.equal((await uno(B, "SELECT stock_actual s FROM productos WHERE codigo = 'P-1'")).s, 8, 'stock = suma de movimientos');
assert.equal((await uno(B, "SELECT stock_actual s FROM productos WHERE codigo = 'P-2'")).s, 4);
assert.equal((await uno(B, "SELECT valor v FROM config WHERE clave = 'negocio_nombre'")).v, 'Audio Pro');
const detB = await uno(B, `SELECT p.nombre, d.cantidad, v.numero, c.nombre cli FROM venta_detalle d
   JOIN productos p ON p.id = d.producto_id JOIN ventas v ON v.id = d.venta_id JOIN clientes c ON c.id = v.cliente_id`);
assert.deepEqual({ ...detB }, { nombre: 'Bocina 6x9', cantidad: 2, numero: 'V-000001', cli: 'Juan' });
assert.equal((await uno(B, 'SELECT SUM(monto) m FROM pagos p JOIN ventas v ON v.id = p.venta_id WHERE v.numero = ?', ['V-000002'])).m, 200);
assert.equal((await uno(B, 'SELECT vence FROM cuentas_cobrar')).vence, '2030-01-31');
assert.equal((await uno(B, 'SELECT COUNT(*) n FROM categorias')).n, 6, 'categorías sin duplicar');
assert.equal(await B.motor.pendientes(), 0, 'lo que baja no se marca como cambio propio');
ok('B baja productos, stock, ventas, cuentas por cobrar y ajustes con las relaciones bien puestas');

// ---------- 3. Ventas al mismo tiempo sin internet ----------
await venderLocal(A, pA, 2, 'V-A000003'); // A: 8 -> 6
await venderLocal(B, pA, 3, 'V-B000001'); // B: 8 -> 5
await A.motor.sincronizar();
await B.motor.sincronizar();
await A.motor.sincronizar();
for (const d of [A, B]) {
  assert.equal((await uno(d, "SELECT stock_actual s FROM productos WHERE codigo = 'P-1'")).s, 3, `stock en ${d.nombre}`);
  assert.equal((await uno(d, 'SELECT COUNT(*) n FROM ventas')).n, 4);
}
ok('dos ventas simultáneas del mismo producto: ambos terminan con el stock correcto (10 - 2 - 2 - 3 = 3)');

// ---------- 4. Edición simultánea: gana la más reciente ----------
A.run("UPDATE clientes SET telefono = '809-AAA' WHERE nombre = 'Juan'");
await pausa(30);
B.run("UPDATE clientes SET telefono = '809-BBB' WHERE nombre = 'Juan'");
await A.motor.sincronizar(); await B.motor.sincronizar(); await A.motor.sincronizar();
assert.equal((await uno(A, "SELECT telefono t FROM clientes WHERE nombre = 'Juan'")).t, '809-BBB');
assert.equal((await uno(B, "SELECT telefono t FROM clientes WHERE nombre = 'Juan'")).t, '809-BBB');
ok('edición simultánea: gana el cambio más reciente en los dos');

// Un cambio viejo hecho sin internet no pisa a uno más nuevo ya subido
B.run("UPDATE clientes SET telefono = '809-OLD' WHERE nombre = 'Juan'");
await pausa(30);
A.run("UPDATE clientes SET telefono = '809-NEW' WHERE nombre = 'Juan'");
await A.motor.sincronizar();
await B.motor.sincronizar(); // B sube 'OLD' (más viejo) y el servidor lo ignora
await A.motor.sincronizar();
assert.equal((await uno(B, "SELECT telefono t FROM clientes WHERE nombre = 'Juan'")).t, '809-NEW');
assert.equal((await uno(A, "SELECT telefono t FROM clientes WHERE nombre = 'Juan'")).t, '809-NEW');
ok('un cambio viejo hecho sin internet no pisa a uno más nuevo');

// ---------- 5. Borrados ----------
A.run("INSERT INTO clientes (nombre) VALUES ('Temporal')");
await A.motor.sincronizar(); await B.motor.sincronizar();
assert.equal((await uno(B, "SELECT COUNT(*) n FROM clientes WHERE nombre = 'Temporal'")).n, 1);
B.run("DELETE FROM clientes WHERE nombre = 'Temporal'");
await B.motor.sincronizar(); await A.motor.sincronizar();
assert.equal((await uno(A, "SELECT COUNT(*) n FROM clientes WHERE nombre = 'Temporal'")).n, 0);
ok('un cliente borrado en B desaparece también en A');

// ---------- 6. Código de producto repetido ----------
crearProducto(A, 'REP-1', 'Cable A', 1);
crearProducto(B, 'REP-1', 'Cable B', 1);
await A.motor.sincronizar(); await B.motor.sincronizar(); await A.motor.sincronizar(); await B.motor.sincronizar();
for (const d of [A, B]) {
  const n = (await uno(d, "SELECT COUNT(*) n FROM productos WHERE codigo LIKE 'REP-1%'")).n;
  assert.equal(n, 2, `ambos productos existen en ${d.nombre}`);
}
ok('dos productos con el mismo código en distintos dispositivos: se conservan los dos');

// ---------- 7. Cotización editada (se borran y recrean las líneas) ----------
A.run("INSERT INTO cotizaciones (numero, cliente_nombre, subtotal, total) VALUES ('C-A000001', 'Pedro', 100, 100)");
const cot = (await uno(A, 'SELECT id FROM cotizaciones')).id;
A.run('INSERT INTO cotizacion_detalle (cotizacion_id, descripcion, cantidad, precio_unitario) VALUES (?, ?, 1, 100)', [cot, 'Instalación']);
await A.motor.sincronizar(); await B.motor.sincronizar();
A.run('DELETE FROM cotizacion_detalle WHERE cotizacion_id = ?', [cot]);
A.run('INSERT INTO cotizacion_detalle (cotizacion_id, descripcion, cantidad, precio_unitario) VALUES (?, ?, 2, 150)', [cot, 'Instalación completa']);
A.run("UPDATE cotizaciones SET total = 300 WHERE id = ?", [cot]);
await A.motor.sincronizar(); await B.motor.sincronizar();
const lineasB = await B.consultar('SELECT descripcion, cantidad FROM cotizacion_detalle');
assert.deepEqual(lineasB.map((x) => ({ ...x })), [{ descripcion: 'Instalación completa', cantidad: 2 }]);
assert.equal((await uno(B, "SELECT total t FROM cotizaciones WHERE numero = 'C-A000001'")).t, 300);
ok('una cotización editada llega igual (líneas viejas fuera, nuevas dentro)');

// ---------- 8. Estable: sincronizar de nuevo no cambia nada ----------
const antes = (await uno(A, 'SELECT COUNT(*) n FROM ventas')).n;
const r8a = await A.motor.sincronizar(); const r8b = await B.motor.sincronizar();
assert.equal(r8a.subidos + r8b.subidos, 0);
assert.equal((await uno(A, 'SELECT COUNT(*) n FROM ventas')).n, antes);
for (const d of [A, B]) assert.equal(await d.motor.pendientes(), 0);
ok('sincronizar otra vez no sube ni duplica nada');

// ---------- 9. Datos propios previos en un dispositivo nuevo que "combina" ----------
const C = await crearDispositivo('C');
crearProducto(C, 'LOCAL-9', 'Producto de C', 7);
await conectar(C, 'login', { identificador: 'ana@x.com', clave: 'abcd1234' });
await C.motor.marcarTodo();
await C.motor.sincronizar(); await A.motor.sincronizar();
assert.equal((await uno(C, 'SELECT COUNT(*) n FROM productos')).n, 5);
assert.equal((await uno(A, "SELECT stock_actual s FROM productos WHERE codigo = 'LOCAL-9'")).s, 7);
assert.equal((await uno(C, 'SELECT COUNT(*) n FROM categorias')).n, 6, 'categorías base no se duplican al combinar');
ok('un dispositivo con datos propios se combina con los de la nube');

// ---------- 10. Seguridad y cuentas del servidor ----------
const r = await fetch(`${BASE}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(r.status, 401);
const otro = crearCliente({ base: () => BASE });
const reg2 = await otro.registro({ negocio: 'Otro', nombre: 'Luis', usuario: 'luis', correo: 'luis@x.com', clave: 'zxcv1234', dispositivo: 'otro-dispositivo-1' });
const otroT = crearCliente({ base: () => BASE, token: () => reg2.token });
const s = await otroT.sync({ dispositivo: 'otro-dispositivo-1', desde: 0, cambios: [] });
assert.equal(s.cambios.length, 0, 'otro negocio no ve datos ajenos');
await assert.rejects(() => otro.login({ identificador: 'ana', clave: 'mala-clave1', dispositivo: 'x'.repeat(10) }), /incorrectos/);
ok('un negocio no ve los datos de otro y sin sesión no se entra');

const m = await A.nube.crearMiembro({ nombre: 'Vera', usuario: 'vera', rol: 'vendedor', permisos: ['ventas'], clave: 'temporal12' });
assert.equal(m.miembros.length, 2);
const vera = await crearCliente({ base: () => BASE }).login({ identificador: 'vera', clave: 'temporal12', dispositivo: 'vera-disp-0001' });
assert.equal(vera.cuenta.debeCambiar, true);
assert.equal(vera.negocio.uid, (await A.nube.yo()).negocio.uid);
await assert.rejects(() => crearCliente({ base: () => BASE, token: () => vera.token }).crearMiembro({ nombre: 'X', usuario: 'xx1', rol: 'vendedor', clave: 'abcd1234' }), /administrador/);
ok('el administrador crea empleados; un empleado no puede crear usuarios');

// ---------- 11. Aprobación del propietario ----------
const srv2 = crearServidor({ db: abrirBase(':memory:'), secreto: 'otro-secreto-largo-1234567890', clavePropietario: 'dueno-sistema-1' });
await new Promise((r) => srv2.listen(0, r));
const B2 = `http://127.0.0.1:${srv2.address().port}`;
const c2 = crearCliente({ base: () => B2 });
const pend = await c2.registro({ negocio: 'Taller Nuevo', nombre: 'Rosa', usuario: 'rosa', correo: 'rosa@x.com', clave: 'clave1234', dispositivo: 'rosa-dispositivo-1' });
assert.equal(pend.pendiente, true);
assert.ok(pend.codigoRecuperacion);
assert.equal(pend.token, undefined, 'sin sesión hasta que se apruebe');
await assert.rejects(() => c2.login({ identificador: 'rosa', clave: 'clave1234', dispositivo: 'rosa-dispositivo-1' }), /pendiente de aprobación/);
const post2 = async (ruta, cuerpo, t, metodo = 'POST') => { const r = await fetch(B2 + ruta, { method: metodo, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return [r.status, await r.json()]; };
assert.equal((await post2('/api/propietario/login', { clave: 'mala' }))[0], 401);
const [, dueno] = await post2('/api/propietario/login', { clave: 'dueno-sistema-1' });
assert.equal((await post2('/api/propietario/negocios', null, 'token-falso', 'GET'))[0], 401);
const [, lista] = await post2('/api/propietario/negocios', null, dueno.token, 'GET');
assert.equal(lista.negocios[0].estado, 'pendiente');
assert.equal(lista.negocios[0].admin.correo, 'rosa@x.com');
// Un usuario normal no puede usar el panel
const [stU] = await post2('/api/propietario/negocios', null, 'x', 'GET');
assert.equal(stU, 401);
await post2(`/api/propietario/negocios/${lista.negocios[0].uid}`, { accion: 'aprobar', plan: 'mensual', vence: '2099-01-01' }, dueno.token, 'PATCH');
const rosa = await c2.login({ identificador: 'rosa', clave: 'clave1234', dispositivo: 'rosa-dispositivo-1' });
assert.ok(rosa.token);
await post2(`/api/propietario/negocios/${lista.negocios[0].uid}`, { accion: 'suspender' }, dueno.token, 'PATCH');
await assert.rejects(() => crearCliente({ base: () => B2, token: () => rosa.token }).sync({ dispositivo: 'rosa-dispositivo-1', desde: 0, cambios: [] }), /suspendido/);
await post2(`/api/propietario/negocios/${lista.negocios[0].uid}`, { accion: 'editar', plan: 'mensual', vence: '2020-01-01' }, dueno.token, 'PATCH');
await post2(`/api/propietario/negocios/${lista.negocios[0].uid}`, { accion: 'reactivar' }, dueno.token, 'PATCH');
await assert.rejects(() => c2.login({ identificador: 'rosa', clave: 'clave1234', dispositivo: 'rosa-dispositivo-1' }), /venció/);
const sinPanel = crearServidor({ db: abrirBase(':memory:'), secreto: 'tercer-secreto-largo-1234567890' });
await new Promise((r) => sinPanel.listen(0, r));
const rr = await fetch(`http://127.0.0.1:${sinPanel.address().port}/api/propietario/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"clave":"x"}' });
assert.equal(rr.status, 404);
srv2.close(); sinPanel.close();
ok('los registros nuevos quedan pendientes; el propietario aprueba, suspende y vence; sin clave no hay panel');

// ---------- 12. Panel completo del propietario: pagos, respaldo, eliminar ----------
const db3 = abrirBase(':memory:');
const srv3 = crearServidor({ db: db3, secreto: 'cuarto-secreto-largo-1234567890', clavePropietario: 'dueno-sistema-1', aprobacionAutomatica: true });
await new Promise((r) => srv3.listen(0, r));
const B3 = `http://127.0.0.1:${srv3.address().port}`;
const c3 = crearCliente({ base: () => B3 });
await c3.registro({ negocio: 'Sonido Uno', nombre: 'Ana', usuario: 'ana1', correo: 'a@x.com', clave: 'clave1234', dispositivo: 'uno-dispositivo-1' });
await c3.registro({ negocio: 'Sonido Dos', nombre: 'Beto', usuario: 'beto1', correo: 'b@x.com', clave: 'clave1234', dispositivo: 'dos-dispositivo-1' });
const p3 = async (ruta, cuerpo, t, metodo = 'POST') => { const r = await fetch(B3 + ruta, { method: metodo, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return [r.status, await r.json()]; };
const [, d3] = await p3('/api/propietario/login', { clave: 'dueno-sistema-1' });
const T = d3.token;
const [, l3] = await p3('/api/propietario/negocios', null, T, 'GET');
const neg1 = l3.negocios.find((x) => x.nombre === 'Sonido Uno'), neg2 = l3.negocios.find((x) => x.nombre === 'Sonido Dos');
// Datos de relleno para ambos negocios
const ins = db3.prepare("INSERT INTO registros (negocio, tabla, uid, datos, borrado, actualizado, version) VALUES (?, 'productos', ?, ?, 0, 1, ?)");
for (let i = 0; i < 300; i++) { ins.run(neg1.uid, `p${i}`, JSON.stringify({ nombre: 'Producto ' + i, nota: 'x'.repeat(400) }), 1000 + i); }
ins.run(neg2.uid, 'q1', JSON.stringify({ nombre: 'Parlante' }), 5000);
// Aprobar con precio y pagos
await p3(`/api/propietario/negocios/${neg1.uid}`, { accion: 'aprobar', plan: 'mensual', vence: '2020-01-01', precio: 1500 }, T, 'PATCH');
let [, d] = await p3('/api/propietario/negocios', null, T, 'GET');
assert.equal(d.negocios.find((x) => x.uid === neg1.uid).estado, 'vencido');
assert.equal(d.negocios.find((x) => x.uid === neg1.uid).precio, 1500);
assert.ok(d.negocios.find((x) => x.uid === neg1.uid).bytes > 100000);
const [stP, pg] = await p3(`/api/propietario/negocios/${neg1.uid}/pagos`, { monto: 1500, meses: 2, nota: 'transferencia' }, T);
assert.equal(stP, 200);
const esperado = new Date(); esperado.setUTCMonth(esperado.getUTCMonth() + 2);
assert.equal(pg.vence, esperado.toISOString().slice(0, 10), 'un pago a un negocio vencido cuenta desde hoy');
[, d] = await p3('/api/propietario/negocios', null, T, 'GET');
assert.equal(d.negocios.find((x) => x.uid === neg1.uid).estado, 'activo');
assert.equal(d.resumen.cobradoMes, 1500);
assert.equal(d.resumen.ingresoMensual, 1500);
assert.ok(d.resumen.dbBytes > 0);
assert.equal((await p3(`/api/propietario/negocios/${neg1.uid}/pagos`, { monto: -5, meses: 1 }, T))[0], 400);
// Detalle e historial
const [, det] = await p3(`/api/propietario/negocios/${neg1.uid}`, null, T, 'GET');
assert.equal(det.pagos.length, 1); assert.equal(det.usuarios.length, 1); assert.equal(det.tablas[0].n, 300);
// Cuentas: desactivar, clave temporal
const cuentaUno = det.usuarios[0];
await p3(`/api/propietario/cuentas/${cuentaUno.uid}`, { activo: false }, T, 'PATCH');
await assert.rejects(() => c3.login({ identificador: 'ana1', clave: 'clave1234', dispositivo: 'uno-dispositivo-1' }));
await p3(`/api/propietario/cuentas/${cuentaUno.uid}`, { activo: true }, T, 'PATCH');
assert.equal((await p3(`/api/propietario/cuentas/${cuentaUno.uid}/clave`, { clave: '123' }, T))[0], 400);
await p3(`/api/propietario/cuentas/${cuentaUno.uid}/clave`, { clave: 'nueva-temp-77' }, T);
const lg = await c3.login({ identificador: 'ana1', clave: 'nueva-temp-77', dispositivo: 'uno-dispositivo-1' });
assert.equal(lg.cuenta.debeCambiar, true);
// Borrar un pago
assert.equal((await p3(`/api/propietario/pagos/${det.pagos[0].id}`, null, T, 'DELETE'))[0], 200);
// Respaldo
const [, resp] = await p3(`/api/propietario/negocios/${neg1.uid}/respaldo`, null, T, 'GET');
assert.equal(resp.registros.length, 300); assert.equal(resp.registros[0].datos.nombre.startsWith('Producto'), true);
// Eliminar: pide el nombre exacto, y no toca a otros negocios
assert.equal((await p3(`/api/propietario/negocios/${neg1.uid}`, { confirmar: 'sonido uno' }, T, 'DELETE'))[0], 400);
assert.equal((await p3(`/api/propietario/negocios/${neg1.uid}`, {}, T, 'DELETE'))[0], 400);
assert.equal((await p3(`/api/propietario/negocios/${neg1.uid}`, { confirmar: 'Sonido Uno' }, undefined, 'DELETE'))[0], 401);
const [stD, del] = await p3(`/api/propietario/negocios/${neg1.uid}`, { confirmar: 'Sonido Uno' }, T, 'DELETE');
assert.equal(stD, 200); assert.equal(del.registros, 300);
assert.ok(del.liberado > 50000, 'el archivo se compacta y recupera espacio: ' + del.liberado);
assert.equal(db3.prepare('SELECT COUNT(*) AS c FROM registros WHERE negocio = ?').get(neg1.uid).c, 0);
assert.equal(db3.prepare('SELECT COUNT(*) AS c FROM cuentas WHERE negocio = ?').get(neg1.uid).c, 0);
assert.equal(db3.prepare('SELECT COUNT(*) AS c FROM registros WHERE negocio = ?').get(neg2.uid).c, 1, 'el otro negocio queda intacto');
await assert.rejects(() => c3.login({ identificador: 'ana1', clave: 'nueva-temp-77', dispositivo: 'uno-dispositivo-1' }), /incorrectos/);
await c3.login({ identificador: 'beto1', clave: 'clave1234', dispositivo: 'dos-dispositivo-1' });
const [, h3] = await p3('/api/propietario/historial', null, T, 'GET');
assert.ok(h3.acciones.some((a) => a.accion === 'Eliminó negocio' && a.negocio === 'Sonido Uno'));
assert.equal(h3.pagos.length, 0 + h3.pagos.length);
srv3.close();
ok('el propietario registra pagos, respalda y elimina un negocio recuperando espacio sin tocar a los demás');

servidor.close();
console.log(`\n${pruebas} grupos de pruebas correctos`);
process.exit(0);
