// Prueba de punta a punta: el servidor real + dos "dispositivos" con la base local real (SQLite de Node).
// Ejecutar con: node tests/e2e-sync.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { crearServidor } from '../server/index.js';
import { abrirBase, siguienteVersion } from '../server/db.js';
import { importarPadron } from '../server/dgii.js';
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
  await d.motor.vincular({ dispositivo: d.idDisp, codigo: r.dispositivo.codigo, negocio: r.negocio.uid, negocioNombre: r.negocio.nombre, epoca: r.negocio.epoca || 0 });
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
A.run("UPDATE ventas SET cliente_nombre = 'Cliente ambulante X' WHERE numero = 'V-000001'");
const vc = (await uno(A, "SELECT id FROM ventas WHERE numero = 'V-000002'")).id;
A.run("INSERT INTO cuentas_cobrar (venta_id, vence) VALUES (?, '2030-01-31')", [vc]);
A.run("INSERT INTO pagos (venta_id, monto, metodo, nota) VALUES (?, 200, 'efectivo', 'Inicial')", [vc]);

const regA = await conectar(A, 'registro', { negocio: 'Audio Pro', nombre: 'Ana', usuario: 'ana', correo: 'ana@x.com', clave: 'abcd1234' });
const ID_A = regA.negocio.identificador;
assert.match(ID_A, /^9\d{8}$/, 'sin RNC el servidor asigna 9 dígitos');
await A.motor.marcarTodo();
assert.ok((await A.motor.pendientes()) > 10);
const r1 = await A.motor.sincronizar();
assert.ok(r1.subidos > 10, 'subió registros');
assert.equal(await A.motor.pendientes(), 0, 'nada pendiente después de subir');
ok('A sube todo y queda sin pendientes');

// ---------- 2. El dispositivo B se une y baja todo ----------
await conectar(B, 'login', { identificador: 'ana', clave: 'abcd1234', negocioId: ID_A });
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
assert.equal((await uno(B, "SELECT cliente_nombre n FROM ventas WHERE numero = 'V-000001'")).n, 'Cliente ambulante X', 'el nombre del cliente ambulante viaja con la venta');
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
await conectar(C, 'login', { identificador: 'ana@x.com', clave: 'abcd1234', negocioId: ID_A });
await C.motor.marcarTodo();
await C.motor.sincronizar(); await A.motor.sincronizar();
assert.equal((await uno(C, 'SELECT COUNT(*) n FROM productos')).n, 5);
assert.equal((await uno(A, "SELECT stock_actual s FROM productos WHERE codigo = 'LOCAL-9'")).s, 7);
assert.equal((await uno(C, 'SELECT COUNT(*) n FROM categorias')).n, 6, 'categorías base no se duplican al combinar');
ok('un dispositivo con datos propios se combina con los de la nube');

// ---------- 9b. Ficha ampliada del cliente: documento, límite, direcciones y contactos ----------
A.run("UPDATE clientes SET tipo_doc = 'rnc', documento = '101123456', limite_credito = 5000 WHERE nombre = 'Juan'");
const idJuanA = (await uno(A, "SELECT id FROM clientes WHERE nombre = 'Juan'")).id;
A.run("INSERT INTO cliente_direcciones (cliente_id, etiqueta, direccion, referencia) VALUES (?, 'Almacén', 'Calle 5 #10', 'Frente al colmado')", [idJuanA]);
A.run("INSERT INTO cliente_contactos (cliente_id, nombre, cargo, telefono) VALUES (?, 'Marta', 'Compras', '809-222')", [idJuanA]);
await A.motor.sincronizar();
await B.motor.sincronizar();
const juanB = await uno(B, "SELECT id, tipo_doc, documento, limite_credito FROM clientes WHERE nombre = 'Juan'");
assert.deepEqual({ tipo_doc: juanB.tipo_doc, documento: juanB.documento, limite_credito: juanB.limite_credito }, { tipo_doc: 'rnc', documento: '101123456', limite_credito: 5000 });
assert.equal((await uno(B, 'SELECT direccion FROM cliente_direcciones WHERE cliente_id = ?', [juanB.id])).direccion, 'Calle 5 #10', 'la dirección llega ligada al cliente correcto');
assert.equal((await uno(B, 'SELECT nombre FROM cliente_contactos WHERE cliente_id = ?', [juanB.id])).nombre, 'Marta');
// B edita el contacto y borra la dirección: A lo ve
await pausa(5);
B.run("UPDATE cliente_contactos SET telefono = '809-333' WHERE nombre = 'Marta'");
B.run('DELETE FROM cliente_direcciones WHERE cliente_id = ?', [juanB.id]);
await B.motor.sincronizar();
await A.motor.sincronizar();
assert.equal((await uno(A, "SELECT telefono FROM cliente_contactos WHERE nombre = 'Marta'")).telefono, '809-333');
assert.equal((await uno(A, 'SELECT COUNT(*) n FROM cliente_direcciones')).n, 0);
assert.equal(await A.motor.pendientes(), 0);
ok('documento fiscal, límite de crédito, direcciones y contactos del cliente se sincronizan entre dispositivos');

// Recibo de ingreso con dos métodos y su pago ligado
A.run("INSERT INTO recibos (numero, cliente_id, total, notas) VALUES ('R-A000001', ?, 120, 'Abono')", [idJuanA]);
const idRecA = (await uno(A, "SELECT id FROM recibos WHERE numero = 'R-A000001'")).id;
A.run("INSERT INTO recibo_metodos (recibo_id, metodo, monto, referencia) VALUES (?, 'efectivo', 70, NULL)", [idRecA]);
A.run("INSERT INTO recibo_metodos (recibo_id, metodo, monto, referencia) VALUES (?, 'cheque', 50, 'Cheque 77')", [idRecA]);
A.run("INSERT INTO pagos (venta_id, monto, metodo, nota, recibo_id) VALUES (?, 120, 'efectivo', 'Recibo R-A000001', ?)", [vc, idRecA]);
await A.motor.sincronizar();
await B.motor.sincronizar();
const recB = await uno(B, "SELECT id, total, cliente_id FROM recibos WHERE numero = 'R-A000001'");
assert.equal(recB.total, 120);
assert.equal((await uno(B, 'SELECT nombre FROM clientes WHERE id = ?', [recB.cliente_id])).nombre, 'Juan');
assert.equal((await uno(B, 'SELECT COUNT(*) n FROM recibo_metodos WHERE recibo_id = ?', [recB.id])).n, 2);
assert.equal((await uno(B, "SELECT referencia FROM recibo_metodos WHERE metodo = 'cheque'")).referencia, 'Cheque 77');
assert.equal((await uno(B, 'SELECT p.monto FROM pagos p WHERE p.recibo_id = ?', [recB.id])).monto, 120, 'el pago llega ligado a su recibo');
// Anular en B (borra el pago, marca el recibo): A lo ve
await pausa(5);
B.run("UPDATE recibos SET estado = 'anulado' WHERE id = ?", [recB.id]);
B.run('DELETE FROM pagos WHERE recibo_id = ?', [recB.id]);
await B.motor.sincronizar();
await A.motor.sincronizar();
assert.equal((await uno(A, "SELECT estado FROM recibos WHERE numero = 'R-A000001'")).estado, 'anulado');
assert.equal((await uno(A, 'SELECT COUNT(*) n FROM pagos WHERE recibo_id = ?', [idRecA])).n, 0);
ok('los recibos de ingreso, sus métodos de pago y los pagos ligados se sincronizan y se anulan en los dos dispositivos');

// ---------- 9c. Contabilidad: el catálogo base coincide y los asientos viajan con sus cuentas ----------
const nCuentasA = (await uno(A, 'SELECT COUNT(*) n FROM cuentas_contables')).n;
await A.motor.sincronizar();
await B.motor.sincronizar();
assert.equal((await uno(B, 'SELECT COUNT(*) n FROM cuentas_contables')).n, nCuentasA, 'el catálogo base no se duplica entre dispositivos');
assert.equal((await uno(B, "SELECT uid FROM cuentas_contables WHERE codigo = '1101'")).uid, 'cc:1101');
const idCajaA = (await uno(A, "SELECT id FROM cuentas_contables WHERE codigo = '1101'")).id;
const idCapA = (await uno(A, "SELECT id FROM cuentas_contables WHERE codigo = '3101'")).id;
A.run("INSERT INTO cuentas_contables (codigo, nombre, tipo) VALUES ('6210', 'Publicidad', 'gasto')");
A.run("INSERT INTO asientos (numero, fecha, concepto) VALUES ('A-A000001', '2026-03-01', 'Aporte')");
const idAsA = (await uno(A, "SELECT id FROM asientos WHERE numero = 'A-A000001'")).id;
A.run('INSERT INTO asiento_lineas (asiento_id, cuenta_id, debe, haber) VALUES (?, ?, 5000, 0)', [idAsA, idCajaA]);
A.run('INSERT INTO asiento_lineas (asiento_id, cuenta_id, debe, haber) VALUES (?, ?, 0, 5000)', [idAsA, idCapA]);
A.run("INSERT INTO periodos_cerrados (periodo) VALUES ('2026-02')");
await A.motor.sincronizar();
await B.motor.sincronizar();
const asientoB = await uno(B, "SELECT id FROM asientos WHERE numero = 'A-A000001'");
const lineasConta = await B.consultar('SELECT c.codigo, l.debe, l.haber FROM asiento_lineas l JOIN cuentas_contables c ON c.id = l.cuenta_id WHERE l.asiento_id = ? ORDER BY l.id', [asientoB.id]);
assert.deepEqual(lineasConta.map((l) => [l.codigo, l.debe, l.haber]), [['1101', 5000, 0], ['3101', 0, 5000]]);
assert.equal((await uno(B, "SELECT nombre FROM cuentas_contables WHERE codigo = '6210'")).nombre, 'Publicidad');
assert.equal((await uno(B, "SELECT COUNT(*) n FROM periodos_cerrados WHERE periodo = '2026-02'")).n, 1);
// Anular el asiento en B llega a A
await pausa(5);
B.run("UPDATE asientos SET estado = 'anulado' WHERE id = ?", [asientoB.id]);
await B.motor.sincronizar();
await A.motor.sincronizar();
assert.equal((await uno(A, "SELECT estado FROM asientos WHERE numero = 'A-A000001'")).estado, 'anulado');
ok('el catálogo de cuentas base no se duplica; asientos, cuentas nuevas y períodos cerrados se sincronizan entre dispositivos');

// ---------- 9d. Padrón de la DGII en el servidor ----------
assert.equal((await A.nube.consultarRNC('101123456')).padronVacio, true, 'sin listado cargado avisa que está vacío');
const padron = ['101123456|ELECTRO SONIDO SRL|VENTA|15/03/2010|ACTIVO|NORMAL', '130999888|DISTRIBUIDORA SA|COMERCIO|01/01/2005|SUSPENDIDO|NORMAL'].join('\n');
const sinSesion = await fetch(`${BASE}/api/rnc-importar`, { method: 'POST', body: padron });
assert.equal(sinSesion.status, 401, 'sin sesión no se puede cargar el listado');
const subida = await fetch(`${BASE}/api/rnc-importar`, { method: 'POST', headers: { Authorization: `Bearer ${A.token}` }, body: padron });
assert.equal((await subida.json()).cantidad, 2);
assert.equal((await A.nube.consultarRNC('101-12345-6')).activo, true);
assert.equal((await A.nube.consultarRNC('130999888')).estado, 'SUSPENDIDO');
assert.equal((await A.nube.estadoPadron()).cantidad, 2);
const malo = await fetch(`${BASE}/api/rnc-importar`, { method: 'POST', headers: { Authorization: `Bearer ${A.token}` }, body: 'basura' });
assert.equal(malo.status, 400);
await assert.rejects(() => crearCliente({ base: () => BASE }).consultarRNC('101123456'), /sesión/i);
ok('el servidor guarda el listado de la DGII, lo consulta por RNC con sesión y rechaza archivos inválidos');

// ---------- 9e. El propietario limpia los datos de un negocio y los dispositivos se vacían ----------
const db5 = abrirBase(':memory:');
const srv5 = crearServidor({ db: db5, secreto: 'sexto-secreto-largo-1234567890', clavePropietario: 'dueno-sistema-1', aprobacionAutomatica: true });
await new Promise((r) => srv5.listen(0, r));
const B5 = `http://127.0.0.1:${srv5.address().port}`;
const p5 = async (ruta, cuerpo, t, metodo = 'POST') => { const r = await fetch(B5 + ruta, { method: metodo, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return [r.status, await r.json()]; };
const T5 = (await p5('/api/propietario/login', { clave: 'dueno-sistema-1' }))[1].token;
const D1 = await crearDispositivo('L1');
const D2 = await crearDispositivo('L2');
for (const d of [D1, D2]) { d.nube = crearCliente({ base: () => B5, token: () => d.token }); d.motor = crearMotor({ consultar: d.consultar, lote: d.lote, nube: d.nube }); }
const reg5 = await conectar(D1, 'registro', { negocio: 'Negocio de Prueba', nombre: 'Dani', usuario: 'dani', correo: 'dani@x.com', clave: 'clave1234' });
crearProducto(D1, 'LP-1', 'Producto de prueba', 5, 100);
await D1.motor.marcarTodo();
await D1.motor.sincronizar();
await conectar(D2, 'login', { identificador: 'dani', clave: 'clave1234', negocioId: reg5.negocio.identificador });
await D2.motor.sincronizar();
assert.equal((await uno(D2, "SELECT COUNT(*) n FROM productos WHERE codigo = 'LP-1'")).n, 1, 'el segundo dispositivo ve el producto');
// sin confirmar el nombre exacto no se borra nada
assert.equal((await p5(`/api/propietario/negocios/${reg5.negocio.uid}/limpiar`, { confirmar: 'otro nombre' }, T5))[0], 400);
assert.equal((await p5(`/api/propietario/negocios/${reg5.negocio.uid}/limpiar`, { confirmar: 'Negocio de Prueba' }))[0], 401, 'sin sesión de propietario no se puede');
assert.ok(db5.prepare('SELECT COUNT(*) c FROM registros').get().c > 0);
const limp = await p5(`/api/propietario/negocios/${reg5.negocio.uid}/limpiar`, { confirmar: 'Negocio de Prueba' }, T5);
assert.equal(limp[0], 200);
assert.equal(db5.prepare('SELECT COUNT(*) c FROM registros').get().c, 0, 'el servidor queda sin datos del negocio');
assert.equal(db5.prepare('SELECT COUNT(*) c FROM cuentas').get().c, 1, 'la cuenta del negocio se conserva');
// el dispositivo que seguía con datos viejos no los sube otra vez: se vacía
const rLimp = await D1.motor.sincronizar();
assert.equal(rLimp.reiniciado, true);
assert.equal((await uno(D1, 'SELECT COUNT(*) n FROM productos')).n, 0, 'el dispositivo 1 queda vacío');
await D2.motor.sincronizar();
assert.equal((await uno(D2, 'SELECT COUNT(*) n FROM productos')).n, 0, 'el dispositivo 2 también');
assert.equal(db5.prepare("SELECT COUNT(*) c FROM registros WHERE tabla = 'productos'").get().c, 0, 'los datos viejos no regresaron al servidor');
// y se puede empezar de nuevo con normalidad
crearProducto(D1, 'LP-2', 'Producto nuevo', 3, 50);
await D1.motor.sincronizar();
await D2.motor.sincronizar();
assert.equal((await uno(D2, "SELECT COUNT(*) n FROM productos WHERE codigo = 'LP-2'")).n, 1);
assert.equal((await uno(D2, "SELECT COUNT(*) n FROM productos WHERE codigo = 'LP-1'")).n, 0);
srv5.close();
ok('limpiar datos desde el panel exige el nombre exacto, conserva la cuenta y vacía los dispositivos sin que los datos viejos regresen');

// ---------- 9f. Un producto modificado después de sus movimientos no pierde stock en un equipo nuevo ----------
{
  const P = await crearDispositivo('P'); const Q = await crearDispositivo('Q');
  const pu = crearProducto(P, 'ORD-1', 'Amplificador 8000', 10, 1400);
  const rP = await conectar(P, 'registro', { negocio: 'Orden', nombre: 'Eva', usuario: 'eva', correo: 'eva@x.com', clave: 'abcd1234' });
  await P.motor.marcarTodo(); await P.motor.sincronizar();
  // Más tarde: entra mercancía y el producto se modifica (el costo cambia), así que su versión queda por encima de la de sus movimientos
  const idp = (await uno(P, 'SELECT id FROM productos WHERE uid = ?', [pu])).id;
  P.run("INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo) VALUES (?, 'entrada', 5, 'compra')", [idp]);
  P.run('UPDATE productos SET stock_actual = stock_actual + 5, costo = 900 WHERE id = ?', [idp]);
  await P.motor.sincronizar();
  await conectar(Q, 'login', { identificador: 'eva', clave: 'abcd1234', negocioId: rP.negocio.identificador });
  await Q.motor.reemplazarLocal();
  const rQ = await Q.motor.sincronizar();
  assert.equal(rQ.errores.length, 0, rQ.errores.join('\n'));
  assert.equal((await uno(Q, 'SELECT stock_actual s FROM productos')).s, 15, 'el equipo nuevo ve las 15 unidades');
  assert.equal((await uno(Q, 'SELECT COUNT(*) n FROM movimientos_inventario')).n, 2, 'no se pierde ningún movimiento');
  // Un equipo dañado por la versión anterior (movimiento perdido, stock en 5) se repara solo al sincronizar
  Q.db.exec('UPDATE sync_ctl SET aplicando = 1');
  Q.db.exec("DELETE FROM movimientos_inventario WHERE cantidad = 10"); Q.db.exec('UPDATE productos SET stock_actual = 5');
  Q.db.exec("DELETE FROM config WHERE clave = 'sync_reparado_2'");
  Q.db.exec('UPDATE sync_ctl SET aplicando = 0');
  await Q.motor.sincronizar();
  assert.equal((await uno(Q, 'SELECT stock_actual s FROM productos')).s, 15, 'se recupera el movimiento perdido');
  assert.equal((await uno(Q, 'SELECT COUNT(*) n FROM movimientos_inventario')).n, 2);
  assert.equal(await Q.motor.pendientes(), 0, 'la reparación no genera cambios propios');
  await P.motor.sincronizar();
  assert.equal((await uno(P, 'SELECT stock_actual s FROM productos')).s, 15, 'el equipo original no cambia');
  // Un producto subido por una versión anterior (sin la columna itbis_exento) también se descarga, con su movimiento
  const insReg = (tabla, uid, datos) => srvDb.prepare('INSERT INTO registros (negocio, tabla, uid, datos, borrado, actualizado, version, origen) VALUES (?,?,?,?,0,?,?,?)')
    .run(rP.negocio.uid, tabla, uid, JSON.stringify(datos), Date.now(), siguienteVersion(srvDb), 'equipo-viejo');
  insReg('movimientos_inventario', 'mov-viejo-1', { tipo: 'entrada', cantidad: 7, motivo: 'stock inicial', producto_id: 'prod-viejo-1' });
  insReg('productos', 'prod-viejo-1', { codigo: 'VIEJO-1', nombre: 'Producto de versión anterior', costo: 10, precio: 20, stock_minimo: 0, activo: 1 });
  const rV = await Q.motor.sincronizar();
  assert.equal(rV.errores.length, 0, rV.errores.join('\n'));
  const viejo = await uno(Q, "SELECT stock_actual s, itbis_exento e FROM productos WHERE codigo = 'VIEJO-1'");
  assert.deepEqual({ ...viejo }, { s: 7, e: 0 }, 'el producto antiguo llega con su stock y sin exención');
}
ok('un producto modificado después de sus movimientos no pierde stock en un equipo nuevo, y un equipo dañado se repara solo');

// ---------- 10. Seguridad y cuentas del servidor ----------
const r = await fetch(`${BASE}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(r.status, 401);
const otro = crearCliente({ base: () => BASE });
const reg2 = await otro.registro({ negocio: 'Otro', nombre: 'Luis', usuario: 'luis', correo: 'luis@x.com', clave: 'zxcv1234', dispositivo: 'otro-dispositivo-1' });
const otroT = crearCliente({ base: () => BASE, token: () => reg2.token });
const s = await otroT.sync({ dispositivo: 'otro-dispositivo-1', desde: 0, cambios: [] });
assert.equal(s.cambios.length, 0, 'otro negocio no ve datos ajenos');
await assert.rejects(() => otro.login({ identificador: 'ana', clave: 'mala-clave1', negocioId: ID_A, dispositivo: 'x'.repeat(10) }), /incorrectos/);
ok('un negocio no ve los datos de otro y sin sesión no se entra');

const m = await A.nube.crearMiembro({ nombre: 'Vera', usuario: 'vera', rol: 'vendedor', permisos: ['ventas'], clave: 'temporal12' });
assert.equal(m.miembros.length, 2);
const vera = await crearCliente({ base: () => BASE }).login({ identificador: 'vera', clave: 'temporal12', negocioId: ID_A, dispositivo: 'vera-disp-0001' });
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
assert.match(pend.negocio.identificador, /^9\d{8}$/);
await assert.rejects(() => c2.login({ identificador: 'rosa', clave: 'clave1234', negocioId: pend.negocio.identificador, dispositivo: 'rosa-dispositivo-1' }), /pendiente de aprobación/);
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
const rosa = await c2.login({ identificador: 'rosa', clave: 'clave1234', negocioId: pend.negocio.identificador, dispositivo: 'rosa-dispositivo-1' });
assert.ok(rosa.token);
await post2(`/api/propietario/negocios/${lista.negocios[0].uid}`, { accion: 'suspender' }, dueno.token, 'PATCH');
await assert.rejects(() => crearCliente({ base: () => B2, token: () => rosa.token }).sync({ dispositivo: 'rosa-dispositivo-1', desde: 0, cambios: [] }), /suspendido/);
await post2(`/api/propietario/negocios/${lista.negocios[0].uid}`, { accion: 'editar', plan: 'mensual', vence: '2020-01-01' }, dueno.token, 'PATCH');
await post2(`/api/propietario/negocios/${lista.negocios[0].uid}`, { accion: 'reactivar' }, dueno.token, 'PATCH');
await assert.rejects(() => c2.login({ identificador: 'rosa', clave: 'clave1234', negocioId: pend.negocio.identificador, dispositivo: 'rosa-dispositivo-1' }), /venció/);
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
const reg31 = await c3.registro({ negocio: 'Sonido Uno', nombre: 'Ana', usuario: 'ana1', correo: 'a@x.com', clave: 'clave1234', dispositivo: 'uno-dispositivo-1' });
const reg32 = await c3.registro({ negocio: 'Sonido Dos', nombre: 'Beto', usuario: 'beto1', correo: 'b@x.com', clave: 'clave1234', dispositivo: 'dos-dispositivo-1' });
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
await assert.rejects(() => c3.login({ identificador: 'ana1', clave: 'clave1234', negocioId: reg31.negocio.identificador, dispositivo: 'uno-dispositivo-1' }));
await p3(`/api/propietario/cuentas/${cuentaUno.uid}`, { activo: true }, T, 'PATCH');
assert.equal((await p3(`/api/propietario/cuentas/${cuentaUno.uid}/clave`, { clave: '123' }, T))[0], 400);
await p3(`/api/propietario/cuentas/${cuentaUno.uid}/clave`, { clave: 'nueva-temp-77' }, T);
const lg = await c3.login({ identificador: 'ana1', clave: 'nueva-temp-77', negocioId: reg31.negocio.identificador, dispositivo: 'uno-dispositivo-1' });
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
await assert.rejects(() => c3.login({ identificador: 'ana1', clave: 'nueva-temp-77', negocioId: reg31.negocio.identificador, dispositivo: 'uno-dispositivo-1' }), /incorrectos/);
await c3.login({ identificador: 'beto1', clave: 'clave1234', negocioId: reg32.negocio.identificador, dispositivo: 'dos-dispositivo-1' });
const [, h3] = await p3('/api/propietario/historial', null, T, 'GET');
assert.ok(h3.acciones.some((a) => a.accion === 'Eliminó negocio' && a.negocio === 'Sonido Uno'));
assert.equal(h3.pagos.length, 0 + h3.pagos.length);
srv3.close();
ok('el propietario registra pagos, respalda y elimina un negocio recuperando espacio sin tocar a los demás');

// ---------- 13. Avisos: recordatorio de pago y mensajes del propietario ----------
const db4 = abrirBase(':memory:');
const srv4 = crearServidor({ db: db4, secreto: 'quinto-secreto-largo-1234567890', clavePropietario: 'dueno-sistema-1', aprobacionAutomatica: true });
await new Promise((r) => srv4.listen(0, r));
const B4 = `http://127.0.0.1:${srv4.address().port}`;
const c4 = crearCliente({ base: () => B4 });
const rg1 = await c4.registro({ negocio: 'Aviso Uno', nombre: 'Ana', usuario: 'ana4', correo: 'a4@x.com', clave: 'clave1234', dispositivo: 'av1-dispositivo-1' });
const rg2 = await c4.registro({ negocio: 'Aviso Dos', nombre: 'Beto', usuario: 'beto4', correo: 'b4@x.com', clave: 'clave1234', dispositivo: 'av2-dispositivo-1' });
const cl1 = crearCliente({ base: () => B4, token: () => rg1.token }), cl2 = crearCliente({ base: () => B4, token: () => rg2.token });
const p4 = async (ruta, cuerpo, t, metodo = 'POST') => { const r = await fetch(B4 + ruta, { method: metodo, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return [r.status, await r.json()]; };
const T4 = (await p4('/api/propietario/login', { clave: 'dueno-sistema-1' }))[1].token;
const [, l4] = await p4('/api/propietario/negocios', null, T4, 'GET');
const n1 = l4.negocios.find((x) => x.nombre === 'Aviso Uno'), n2 = l4.negocios.find((x) => x.nombre === 'Aviso Dos');
const enDias = (d) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
// Sin vencimiento cercano no hay recordatorio
await p4(`/api/propietario/negocios/${n1.uid}`, { accion: 'editar', plan: 'mensual', vence: enDias(30) }, T4, 'PATCH');
assert.equal((await cl1.llamar('GET', '/api/avisos')).avisos.length, 0);
// A 5 días: recordatorio automático con el teléfono de contacto
await p4(`/api/propietario/negocios/${n1.uid}`, { accion: 'editar', plan: 'mensual', vence: enDias(5) }, T4, 'PATCH');
let av = await cl1.llamar('GET', '/api/avisos');
assert.equal(av.avisos[0].tipo, 'pago'); assert.equal(av.sinLeer, 1); assert.match(av.avisos[0].mensaje, /5 días.*1-809-230-9980/);
await cl1.llamar('POST', '/api/avisos/leidos', { ids: [av.avisos[0].id] });
assert.equal((await cl1.llamar('GET', '/api/avisos')).sinLeer, 0);
// A 3 días vuelve a aparecer como nuevo
await p4(`/api/propietario/negocios/${n1.uid}`, { accion: 'editar', plan: 'mensual', vence: enDias(3) }, T4, 'PATCH');
assert.equal((await cl1.llamar('GET', '/api/avisos')).sinLeer, 1);
// Un empleado no ve el recordatorio de pago
const emp = await cl1.crearMiembro({ nombre: 'Eva', usuario: 'eva4', rol: 'vendedor', permisos: ['ventas'], clave: 'temporal12' });
const loginEva = await crearCliente({ base: () => B4 }).login({ identificador: 'eva4', clave: 'temporal12', negocioId: rg1.negocio.identificador, dispositivo: 'av1-dispositivo-2' });
assert.equal((await crearCliente({ base: () => B4, token: () => loginEva.token }).llamar('GET', '/api/avisos')).avisos.length, 0);
// Mensaje a un cliente
assert.equal((await p4('/api/propietario/avisos', { destino: 'negocios', negocios: [n2.uid], titulo: '', mensaje: 'x' }, T4))[0], 400);
assert.equal((await p4('/api/propietario/avisos', { destino: 'negocios', negocios: [], titulo: 'a', mensaje: 'x' }, T4))[0], 400);
assert.equal((await p4('/api/propietario/avisos', { destino: 'negocios', negocios: [n2.uid], titulo: 'a', mensaje: 'x' }))[0], 401);
const [, env] = await p4('/api/propietario/avisos', { destino: 'negocios', negocios: [n2.uid], titulo: 'Hola Beto', mensaje: 'Mantenimiento mañana', nivel: 'importante' }, T4);
assert.equal(env.enviados, 1);
assert.equal((await cl2.llamar('GET', '/api/avisos')).avisos[0].titulo, 'Hola Beto');
assert.equal((await cl1.llamar('GET', '/api/avisos')).avisos.some((a) => a.titulo === 'Hola Beto'), false, 'el mensaje de otro cliente no se ve');
// Mensaje masivo
await p4('/api/propietario/avisos', { destino: 'todos', titulo: 'Novedad', mensaje: 'Nueva versión', dias: 5 }, T4);
for (const c of [cl1, cl2]) assert.equal((await c.llamar('GET', '/api/avisos')).avisos.some((a) => a.titulo === 'Novedad'), true);
// Leído y conteo en el panel
const a2 = await cl2.llamar('GET', '/api/avisos');
await cl2.llamar('POST', '/api/avisos/leidos', { ids: a2.avisos.map((x) => x.id) });
const [, lista4] = await p4('/api/propietario/avisos', null, T4, 'GET');
const masivo = lista4.avisos.find((x) => x.titulo === 'Novedad');
assert.equal(masivo.destino, 'Todos los clientes'); assert.equal(masivo.leidos, 1); assert.ok(masivo.total >= 3);
// Caducidad y borrado
db4.prepare("UPDATE avisos SET caduca = '2000-01-01' WHERE titulo = 'Novedad'").run();
assert.equal((await cl1.llamar('GET', '/api/avisos')).avisos.some((a) => a.titulo === 'Novedad'), false);
const idHola = lista4.avisos.find((x) => x.titulo === 'Hola Beto').id;
assert.equal((await p4(`/api/propietario/avisos/${idHola}`, null, T4, 'DELETE'))[0], 200);
assert.equal((await cl2.llamar('GET', '/api/avisos')).avisos.some((a) => a.titulo === 'Hola Beto'), false);
// Eliminar el negocio borra sus mensajes
await p4('/api/propietario/avisos', { destino: 'negocios', negocios: [n2.uid], titulo: 'Se va', mensaje: 'x' }, T4);
await p4(`/api/propietario/negocios/${n2.uid}`, { confirmar: 'Aviso Dos' }, T4, 'DELETE');
assert.equal(db4.prepare('SELECT COUNT(*) AS c FROM avisos WHERE negocio = ?').get(n2.uid).c, 0);
srv4.close();
ok('recordatorio de pago a 7/3/1 días solo para el administrador; mensajes a un cliente o masivos con lectura, caducidad y borrado');


// ---------- 11. Un mismo usuario en distintos negocios: el RNC identifica el negocio ----------
const db6 = abrirBase(':memory:');
const srv6 = crearServidor({ db: db6, secreto: 'septimo-secreto-largo-1234567890', clavePropietario: 'dueno-sistema-1', aprobacionAutomatica: true });
await new Promise((r) => srv6.listen(0, r));
const B6 = `http://127.0.0.1:${srv6.address().port}`;
const c6 = crearCliente({ base: () => B6 });
// Padrón de la DGII de prueba y la consulta de RNC que usa la pantalla de registro (sin sesión)
importarPadron(db6, Buffer.from(['RNC|RAZON SOCIAL|ACTIVIDAD ECONOMICA|FECHA INICIO|ESTADO|REGIMEN',
  '131234567|HOGAR SRL|VENTA DE ARTICULOS DEL HOGAR|15/03/2010|ACTIVO|NORMAL',
  '130999888|TALLER CERRADO SRL|SERVICIOS|01/01/2005|SUSPENDIDO|RST', ''].join('\r\n'), 'latin1'));
const consultaReg = async (n, ip = '7.7.7.7') => { const r = await fetch(`${B6}/api/rnc-registro/${n}`, { headers: { 'x-forwarded-for': ip } }); return [r.status, await r.json().catch(() => ({}))]; };
const [, rcActivo] = await consultaReg('131-23456-7');
assert.equal(rcActivo.encontrado, true); assert.equal(rcActivo.nombre, 'HOGAR SRL'); assert.equal(rcActivo.regimen, 'NORMAL'); assert.equal(rcActivo.activo, true);
assert.equal(rcActivo.registrado, false, 'todavía nadie lo registró');
const [, rcSusp] = await consultaReg('130999888');
assert.equal(rcSusp.activo, false); assert.match(rcSusp.estado, /SUSPENDIDO/);
assert.equal((await consultaReg('999999999'))[1].encontrado, false);
assert.match((await consultaReg('123'))[1].error, /9 números/);
const hogar = await c6.registro({ negocio: 'Hogar', rnc: '131-23456-7', nombre: 'Ana', usuario: 'admin', correo: 'dueno@x.com', clave: 'clave1234', dispositivo: 'hogar-dispositivo-1' });
assert.equal(hogar.negocio.identificador, '131234567', 'el RNC se guarda sin guiones');
assert.equal(hogar.negocio.idTipo, 'rnc');
assert.equal((await consultaReg('131234567'))[1].registrado, true, 'ahora la consulta avisa que ya existe un negocio con ese RNC');
// Tope de consultas sin sesión por IP
let tope = 0;
for (let i = 0; i < 45; i++) if ((await consultaReg('131234567', '8.8.8.8'))[0] === 429) tope++;
assert.ok(tope >= 4, 'después de 40 consultas por minuto se frena');
assert.equal((await consultaReg('131234567', '8.8.4.4'))[0], 200, 'otra IP no se ve afectada');
// El mismo usuario y el mismo correo en otro negocio (sin RNC): ya no hay conflicto
const ups = await c6.registro({ negocio: 'UPS', nombre: 'Luis', usuario: 'admin', correo: 'dueno@x.com', clave: 'otraClave99', dispositivo: 'ups-dispositivo-1' });
assert.match(ups.negocio.identificador, /^9\d{8}$/, 'sin RNC: 9 dígitos asignados');
assert.equal(ups.negocio.idTipo, 'asignado');
assert.notEqual(ups.negocio.uid, hogar.negocio.uid);
// RNC repetido o mal escrito
await assert.rejects(() => c6.registro({ negocio: 'Otro Hogar', rnc: '131234567', nombre: 'X', usuario: 'xxx', correo: 'x@x.com', clave: 'clave1234' }), /Ya existe un negocio registrado con ese RNC/);
await assert.rejects(() => c6.registro({ negocio: 'Mal', rnc: '12345', nombre: 'X', usuario: 'xxx', correo: 'x@x.com', clave: 'clave1234' }), /9 números/);
await assert.rejects(() => c6.registro({ negocio: 'Mal', rnc: 'ABC123456', nombre: 'X', usuario: 'xxx', correo: 'x@x.com', clave: 'clave1234' }), /9 números/);
// Acceso: cada clave entra solo a su negocio
const lh = await c6.login({ identificador: 'admin', clave: 'clave1234', negocioId: '131234567', dispositivo: 'hogar-dispositivo-1' });
assert.equal(lh.negocio.uid, hogar.negocio.uid);
assert.equal(lh.negocio.identificador, '131234567');
const lu = await c6.login({ identificador: 'dueno@x.com', clave: 'otraClave99', negocioId: ups.negocio.identificador, dispositivo: 'ups-dispositivo-1' });
assert.equal(lu.negocio.uid, ups.negocio.uid, 'el correo repetido también se separa por negocio');
await assert.rejects(() => c6.login({ identificador: 'admin', clave: 'clave1234', negocioId: ups.negocio.identificador, dispositivo: 'x'.repeat(10) }), /incorrectos/);
await assert.rejects(() => c6.login({ identificador: 'admin', clave: 'clave1234', negocioId: '999999999', dispositivo: 'x'.repeat(10) }), /incorrectos/);
await assert.rejects(() => c6.login({ identificador: 'admin', clave: 'clave1234', dispositivo: 'x'.repeat(10) }), /Escribe el RNC del negocio/);
await assert.rejects(() => c6.login({ identificador: 'admin', clave: 'clave1234', negocioId: '12ab', dispositivo: 'x'.repeat(10) }), /9 números/);
// Un equipo ya vinculado entra con el uid del negocio, sin volver a escribir el RNC
const luid = await c6.login({ identificador: 'admin', clave: 'clave1234', negocioUid: hogar.negocio.uid, dispositivo: 'hogar-dispositivo-1' });
assert.equal(luid.negocio.uid, hogar.negocio.uid);
// Empleados: el mismo usuario puede existir en otro negocio, pero no repetirse dentro del suyo
const tHogar = crearCliente({ base: () => B6, token: () => lh.token });
const tUps = crearCliente({ base: () => B6, token: () => lu.token });
await tHogar.crearMiembro({ nombre: 'Vera', usuario: 'vera', rol: 'vendedor', permisos: ['ventas'], clave: 'temporal12' });
await tUps.crearMiembro({ nombre: 'Vera U', usuario: 'vera', rol: 'vendedor', permisos: ['ventas'], clave: 'temporal34' });
await assert.rejects(() => tHogar.crearMiembro({ nombre: 'Vera 2', usuario: 'vera', rol: 'vendedor', permisos: [], clave: 'temporal56' }), /ya existe en tu negocio/);
const veraU = await c6.login({ identificador: 'vera', clave: 'temporal34', negocioId: ups.negocio.identificador, dispositivo: 'ups-disp-0002' });
assert.equal(veraU.negocio.uid, ups.negocio.uid);
// Recuperar contraseña también necesita el negocio
await assert.rejects(() => c6.recuperar({ identificador: 'admin', codigo: hogar.codigoRecuperacion, clave: 'nueva12345', negocioId: ups.negocio.identificador }), /no son correctos/);
await c6.recuperar({ identificador: 'admin', codigo: hogar.codigoRecuperacion, clave: 'nueva12345', negocioId: '131234567' });
await c6.login({ identificador: 'admin', clave: 'nueva12345', negocioId: '131234567', dispositivo: 'hogar-dispositivo-1' });
// Panel del propietario: ve el identificador y solo él lo cambia
const p6 = async (ruta, cuerpo, t, metodo = 'POST') => { const r = await fetch(B6 + ruta, { method: metodo, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }); return [r.status, await r.json().catch(() => ({}))]; };
const T6 = (await p6('/api/propietario/login', { clave: 'dueno-sistema-1' }))[1].token;
const [, l6] = await p6('/api/propietario/negocios', null, T6, 'GET');
const nUps = l6.negocios.find((x) => x.nombre === 'UPS'), nHogar = l6.negocios.find((x) => x.nombre === 'Hogar');
assert.equal(nHogar.identificador, '131234567'); assert.equal(nHogar.idTipo, 'rnc');
assert.equal(nHogar.dgii.nombre, 'HOGAR SRL'); assert.equal(nHogar.dgii.regimen, 'NORMAL'); assert.equal(nUps.dgii, null, 'un número asignado no se verifica en la DGII');
assert.equal(nUps.identificador, ups.negocio.identificador); assert.equal(nUps.idTipo, 'asignado');
const rutaId = (n) => `/api/propietario/negocios/${n.uid}/identificador`;
assert.equal((await p6(rutaId(nUps), { identificador: '131234567' }, 'token-falso', 'PATCH'))[0], 401, 'sin la clave del propietario no se cambia');
assert.equal((await p6(rutaId(nUps), { identificador: lu.token }, lh.token, 'PATCH'))[0], 401, 'un usuario del negocio tampoco puede');
assert.equal((await p6(rutaId(nUps), { identificador: '12345' }, T6, 'PATCH'))[0], 400);
const [stDup, dup] = await p6(rutaId(nUps), { identificador: '131234567' }, T6, 'PATCH');
assert.equal(stDup, 409); assert.match(dup.error, /Hogar/);
// Cuando UPS obtiene RNC, el propietario se lo asigna
const [stOk, cambio] = await p6(rutaId(nUps), { identificador: '401-00000-1' }, T6, 'PATCH');
assert.equal(stOk, 200); assert.equal(cambio.identificador, '401000001'); assert.equal(cambio.idTipo, 'rnc');
await assert.rejects(() => c6.login({ identificador: 'dueno@x.com', clave: 'otraClave99', negocioId: ups.negocio.identificador, dispositivo: 'x'.repeat(10) }), /incorrectos/, 'el número viejo ya no sirve para equipos nuevos');
const lu2 = await c6.login({ identificador: 'dueno@x.com', clave: 'otraClave99', negocioId: '401000001', dispositivo: 'ups-dispositivo-1' });
assert.equal(lu2.negocio.uid, ups.negocio.uid); assert.equal(lu2.negocio.identificador, '401000001');
const luid2 = await c6.login({ identificador: 'dueno@x.com', clave: 'otraClave99', negocioUid: ups.negocio.uid, dispositivo: 'ups-dispositivo-1' });
assert.equal(luid2.negocio.identificador, '401000001', 'un equipo ya vinculado sigue entrando y aprende el número nuevo');
// Asignar un número al azar
const [, az] = await p6(rutaId(nUps), { asignar: true }, T6, 'PATCH');
assert.match(az.identificador, /^9\d{8}$/); assert.equal(az.idTipo, 'asignado');
const [, hist] = await p6('/api/propietario/historial', null, T6, 'GET');
assert.ok(JSON.stringify(hist).includes('Cambió identificador'), 'queda en la bitácora del propietario');
// ---------- 11b. Secuencias de NCF: del negocio, en el servidor, con bloques por equipo ----------
{
  const cH = crearCliente({ base: () => B6, token: () => lh.token });
  const cU = crearCliente({ base: () => B6, token: () => lu.token });
  assert.ok((await cH.ncf()).secuencias.every((x) => x.siguiente === 0 && x.disponibles === 0), 'un negocio nuevo no hereda secuencias');
  await cH.guardarNcf('B01', { siguiente: 1, hasta: 12 });
  assert.equal((await cH.ncf()).secuencias.find((x) => x.tipo === 'B01').disponibles, 12);
  assert.equal((await cU.ncf()).secuencias.find((x) => x.tipo === 'B01').disponibles, 0, 'otro negocio no ve ni gasta esas secuencias');
  await assert.rejects(() => cH.guardarNcf('B99', { siguiente: 1, hasta: 2 }), /desconocido/);
  await assert.rejects(() => cH.guardarNcf('B01', { siguiente: 5, hasta: 2 }), /mayor/);
  await assert.rejects(() => cH.guardarNcf('B01', { siguiente: 3, hasta: 0 }), /los dos vacíos/);
  // Cada factura pide su número en el momento; dos equipos a la vez nunca reciben el mismo
  let seq = 0; const sig = (c, cand = ['B01'], clave = `pedido-${++seq}-xxxxxxxx`) => c.siguienteNcf({ candidatos: cand, clave, dispositivo: 'hogar-dispositivo-1' });
  const pedidos = await Promise.all(Array.from({ length: 10 }, (_, i) => sig(i % 2 ? cH : crearCliente({ base: () => B6, token: () => lh.token }))));
  const nums = pedidos.map((r) => r.numero).sort((x, y) => x - y);
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'diez pedidos simultáneos: números consecutivos, sin repetir ni saltar');
  assert.equal((await sig(cH)).numero, 11);
  assert.deepEqual(await sig(cH), { tipo: 'B01', numero: 12, quedan: 0 });
  assert.deepEqual(await sig(cH), { tipo: null, numero: 0, quedan: 0 }, 'agotada: no entrega nada');
  // Preferencias: si el primero no tiene números se usa el siguiente de la lista
  await cH.guardarNcf('B02', { siguiente: 50, hasta: 60 });
  assert.deepEqual(await sig(cH, ['B01', 'B02']), { tipo: 'B02', numero: 50, quedan: 10 });
  await assert.rejects(() => sig(cH, ['B77']), /Indica el tipo/);
  // El mismo pedido repetido (se cortó el internet antes de la respuesta) devuelve el mismo número
  const r1 = await sig(cH, ['B02'], 'clave-repetida-1'); const r2 = await sig(cH, ['B02'], 'clave-repetida-1');
  assert.equal(r1.numero, 51); assert.equal(r2.numero, 51); assert.equal(r2.repetido, true);
  assert.equal((await sig(cH, ['B02'])).numero, 52, 'y el siguiente pedido sigue sin saltos');
  await assert.rejects(() => cH.siguienteNcf({ candidatos: ['B02'], dispositivo: 'x' }), /clave/);
  // Anular un número entregado: consta y no se anula dos veces ni lo que nunca se emitió
  assert.equal((await cH.anularNcf({ clave: 'clave-repetida-1', motivo: 'prueba' })).anulado, true);
  assert.equal((await cH.anularNcf({ clave: 'clave-repetida-1' })).anulado, false);
  assert.equal((await cH.anularNcf({ clave: 'nunca-existio-xx' })).anulado, false);
  assert.deepEqual((await cH.ncf()).anulados.map((x) => `${x.tipo}${x.numero}`), ['B0251']);
  assert.equal((await sig(cU, ['B01', 'B02'])).tipo, null, 'otro negocio no gasta los números de este');
  // Bajar el próximo número avisa
  const baja = await cH.guardarNcf('B01', { siguiente: 3, hasta: 20 });
  assert.match(baja.aviso, /repetir/);
}
ok('las secuencias de NCF son del negocio: cada factura pide su número al servidor, sin repetir ni saltar, y un negocio nuevo no hereda las de otro');

// ---------- 11c. Auditoría por negocio en el panel del propietario ----------
{
  const nid = hogar.negocio.uid; const cuenta = hogar.cuenta?.uid || lh.cuenta.uid;
  const ins = (tabla, uid, datos) => db6.prepare('INSERT INTO registros (negocio, tabla, uid, datos, borrado, actualizado, version, origen) VALUES (?,?,?,?,0,?,?,?)')
    .run(nid, tabla, uid, JSON.stringify(datos), Date.now(), siguienteVersion(db6), 'disp');
  ins('bitacora', 'b1', { fecha: '2026-10-10 09:00:00', usuario: 'admin', accion: 'Inicio de sesión', detalle: '', usuario_id: cuenta });
  ins('bitacora', 'b2', { fecha: '2026-10-11 10:30:00', usuario: 'admin', accion: 'Producto modificado', detalle: 'Amplificador: precio 1400 → 1500', usuario_id: cuenta });
  ins('bitacora', 'b3', { fecha: '2026-10-12 11:00:00', usuario: 'otro', accion: 'Ajuste de inventario', detalle: 'Bocina: -2 (Uso interno)', usuario_id: null });
  ins('ventas', 'v1', { numero: 'V-A000001', fecha: '2026-10-11 12:00:00', total: 1500, ncf: 'B0200000001', estado: 'completada', usuario_id: cuenta });
  ins('compras', 'c1', { numero: 'C-000001', fecha: '2026-10-12 08:00:00', total: 900, referencia: 'F1', estado: 'anulada', usuario_id: cuenta });
  const aud = (c) => p6(`/api/propietario/negocios/${nid}/auditoria`, c, T6, 'POST');
  const [, todo] = await aud({});
  assert.ok(todo.total >= 5, `Se esperaban al menos 5 movimientos y hay ${todo.total}`);
  const propios = todo.eventos.filter((e) => e.fuente !== 'servidor');
  assert.deepEqual(propios.slice(0, 2).map((e) => e.accion), ['Ajuste de inventario', 'Compra registrada'], 'los más recientes primero');
  assert.match(propios[1].detalle, /anulada/);
  assert.ok(todo.eventos.some((e) => e.fuente === 'servidor' && e.accion === 'Cambió secuencia NCF'), 'incluye lo que se cambió desde el servidor');
  const venta = todo.eventos.find((e) => e.accion === 'Venta registrada');
  assert.match(venta.usuario, /@admin/, 'el usuario se identifica por la cuenta');
  assert.match(venta.detalle, /V-A000001.*B0200000001/);
  const [, soloAdmin] = await aud({ usuario: 'admin' });
  assert.ok(soloAdmin.eventos.every((e) => /admin/i.test(e.usuario)) && soloAdmin.eventos.length >= 4);
  assert.ok(!soloAdmin.eventos.some((e) => e.accion === 'Ajuste de inventario'), 'lo de otro usuario no aparece');
  const [, rango] = await aud({ desde: '2026-10-11', hasta: '2026-10-11' });
  assert.deepEqual(rango.eventos.map((e) => e.accion).sort(), ['Producto modificado', 'Venta registrada']);
  const [, buscado] = await aud({ q: 'amplificador' });
  assert.equal(buscado.eventos.length, 1);
  const [, pag] = await aud({ limite: 2, desplazar: 2 });
  assert.equal(pag.eventos.length, 2); assert.equal(pag.total, todo.total);
  const [st] = await p6(`/api/propietario/negocios/${nid}/auditoria`, {}, null, 'POST');
  assert.equal(st, 401, 'sin clave de propietario no hay acceso');
  const [, ncfAud] = await aud({ q: 'secuencia' });
  assert.ok(ncfAud.eventos.every((e) => e.fuente === 'servidor'), 'los cambios de secuencia hechos en el servidor también constan');
}
ok('el propietario audita cada negocio: quién hizo qué, con filtros por usuario, fecha y texto');

srv6.close();
ok('mismo usuario y correo en negocios distintos; el RNC (o número asignado) identifica el negocio; solo el propietario lo cambia');

// ---------- 12. Bases anteriores: usuario y correo dejan de ser únicos en todo el servidor ----------
const rutaVieja = path.join(os.tmpdir(), `viejo-${process.pid}.db`);
for (const x of ['', '-wal', '-shm']) fs.rmSync(rutaVieja + x, { force: true });
const viejo = new DatabaseSync(rutaVieja);
viejo.exec(`CREATE TABLE negocios (uid TEXT PRIMARY KEY, nombre TEXT NOT NULL, activo INTEGER NOT NULL DEFAULT 1, plan TEXT NOT NULL DEFAULT 'prueba', vence TEXT, creado TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE cuentas (uid TEXT PRIMARY KEY, negocio TEXT NOT NULL REFERENCES negocios(uid), nombre TEXT NOT NULL, usuario TEXT NOT NULL UNIQUE, correo TEXT UNIQUE, rol TEXT NOT NULL DEFAULT 'vendedor', permisos TEXT, activo INTEGER NOT NULL DEFAULT 1, hash TEXT NOT NULL, recup_hash TEXT, debe_cambiar INTEGER NOT NULL DEFAULT 0, creado TEXT NOT NULL DEFAULT (datetime('now')), ultimo_acceso TEXT);
  INSERT INTO negocios (uid, nombre) VALUES ('n1', 'Hogar'), ('n2', 'UPS');
  INSERT INTO cuentas (uid, negocio, nombre, usuario, correo, hash) VALUES ('c1', 'n1', 'Ana', 'ana', 'a@x.com', 'h');`);
viejo.close();
const migrada = abrirBase(rutaVieja);
const idsViejos = migrada.prepare('SELECT identificador, id_tipo FROM negocios ORDER BY uid').all();
assert.ok(idsViejos.every((x) => /^9\d{8}$/.test(x.identificador) && x.id_tipo === 'asignado'), 'los negocios existentes reciben un número asignado');
assert.notEqual(idsViejos[0].identificador, idsViejos[1].identificador);
migrada.prepare("INSERT INTO cuentas (uid, negocio, nombre, usuario, correo, hash) VALUES ('c2', 'n2', 'Ana 2', 'ana', 'a@x.com', 'h')").run();
assert.throws(() => migrada.prepare("INSERT INTO cuentas (uid, negocio, nombre, usuario, hash) VALUES ('c3', 'n2', 'Dup', 'ana', 'h')").run(), /UNIQUE/);
assert.equal(migrada.prepare('SELECT COUNT(*) AS n FROM cuentas').get().n, 2);
migrada.close();
assert.equal(abrirBase(rutaVieja).prepare('SELECT COUNT(*) AS n FROM cuentas').get().n, 2, 'abrirla otra vez no rompe nada');
for (const x of ['', '-wal', '-shm']) fs.rmSync(rutaVieja + x, { force: true });
ok('una base anterior se migra: los negocios reciben su número y el usuario se repite solo entre negocios distintos');

servidor.close();
console.log(`\n${pruebas} grupos de pruebas correctos`);
process.exit(0);
