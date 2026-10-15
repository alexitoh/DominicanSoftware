// Pruebas: padrón de la DGII (servidor), consulta desde la app y tipo de comprobante al facturar.
// Ejecutar con: node --import ./tests/stubs/registrar.mjs tests/dgii.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
let n = 0; const ok = (t) => { n++; console.log(`  ✔ ${t}`); };
console.log('DGII y tipo de comprobante');

const dg = await import('../server/dgii.js');
const sdb = new DatabaseSync(':memory:');
dg.prepararTablaRNC(sdb);

// ---- padrón: .txt y .zip ----
const txt = [
  'RNC|RAZON SOCIAL|ACTIVIDAD ECONOMICA|FECHA INICIO|ESTADO|REGIMEN',
  '101123456|ELECTRO SONIDO SRL|VENTA DE EQUIPOS|15/03/2010|ACTIVO|NORMAL',
  '130999888|DISTRIBUIDORA SA|COMERCIO|01/01/2005|SUSPENDIDO|NORMAL',
  '131000111|TALLER CERRADO SRL|SERVICIOS|10/10/2011|DADO DE BAJA|RST',
  '00112345678|JUAN PEREZ|SERVICIOS|05/05/2015|ACTIVO|RST',
  '',
].join('\r\n');
assert.equal(dg.importarPadron(sdb, Buffer.from(txt, 'latin1')), 4);
let r = dg.consultarRNC(sdb, '101-12345-6');
assert.equal(r.encontrado, true); assert.equal(r.activo, true); assert.equal(r.nombre, 'ELECTRO SONIDO SRL'); assert.equal(r.regimen, 'NORMAL'); assert.equal(r.inicio, '15/03/2010');
r = dg.consultarRNC(sdb, '130999888'); assert.equal(r.activo, false); assert.equal(r.estado, 'SUSPENDIDO');
assert.equal(dg.consultarRNC(sdb, '131000111').estado, 'DADO DE BAJA');
assert.equal(dg.consultarRNC(sdb, '00112345678').activo, true);
assert.equal(dg.consultarRNC(sdb, '999999999').encontrado, false);
assert.ok(dg.consultarRNC(sdb, '123').error);
ok('el listado de la DGII se lee (con encabezado y acentos) y distingue ACTIVO, SUSPENDIDO y DADO DE BAJA');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgii-'));
fs.writeFileSync(path.join(dir, 'DGII_RNC.TXT'), Buffer.from(txt.replace('ELECTRO', 'ELECTRÓ'), 'latin1'));
execFileSync('zip', ['-q', '-j', path.join(dir, 'DGII_RNC.zip'), path.join(dir, 'DGII_RNC.TXT')]);
const sdb2 = new DatabaseSync(':memory:'); dg.prepararTablaRNC(sdb2);
assert.equal(dg.importarPadron(sdb2, fs.readFileSync(path.join(dir, 'DGII_RNC.zip'))), 4);
assert.equal(dg.consultarRNC(sdb2, '101123456').nombre, 'ELECTRÓ SONIDO SRL');
assert.throws(() => dg.importarPadron(sdb2, Buffer.from('nada util aqui')), /No se encontraron/);
assert.equal(dg.consultarRNC(sdb2, '101123456').encontrado, true, 'un archivo malo no borra el listado');
ok('el .zip se descomprime y un archivo inválido no daña el listado');

// ---- la app: mensajes por estatus ----
const { buscarRNC } = await import('../src/dgii.js');
const falso = (fn) => ({ consultarRNC: async (x) => fn(x) });
const por = (num) => dg.consultarRNC(sdb, num);
let res = await buscarRNC('101-12345-6', { cliente: falso(por), hay: () => true });
assert.equal(res.resultado, 'activo'); assert.match(res.mensaje, /ACTIVO/);
res = await buscarRNC('130999888', { cliente: falso(por), hay: () => true });
assert.equal(res.resultado, 'inactivo'); assert.match(res.mensaje, /SUSPENDIDO/);
res = await buscarRNC('131000111', { cliente: falso(por), hay: () => true });
assert.match(res.mensaje, /DADO DE BAJA/);
assert.equal((await buscarRNC('999999999', { cliente: falso(por), hay: () => true })).resultado, 'noEncontrado');
assert.equal((await buscarRNC('12', { cliente: falso(por), hay: () => true })).resultado, 'invalido');
assert.equal((await buscarRNC('101123456', { cliente: falso(por), hay: () => false })).resultado, 'sinNube');
const { ErrorNube } = await import('../src/nube.js');
assert.equal((await buscarRNC('101123456', { cliente: falso(() => { throw new ErrorNube('x', 0, true); }), hay: () => true })).resultado, 'sinConexion');
assert.equal((await buscarRNC('101123456', { cliente: falso(() => ({ padronVacio: true })), hay: () => true })).resultado, 'padronVacio');
ok('la app muestra el estatus (ACTIVO / SUSPENDIDO / DADO DE BAJA / no aparece / sin conexión / listado vacío)');

// ---- tipo de comprobante al facturar ----
const bd = await import('../src/database.js');
await bd.initDB();
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo','adicional')");
await bd.guardarSecuenciaNCF('B01', 1, 5);
await bd.guardarSecuenciaNCF('B02', 1, 5);
await bd.ejecutar("INSERT INTO productos (nombre, codigo, precio, costo, stock_actual) VALUES ('Bocina','BC1',1000,500,50)");
await bd.ejecutar("INSERT INTO clientes (nombre, tipo_doc, documento) VALUES ('Con RNC','rnc','101123456')");
await bd.ejecutar("INSERT INTO clientes (nombre) VALUES ('Sin RNC')");
const [{ id: pid }] = await bd.consultar("SELECT id FROM productos WHERE codigo='BC1'");
const [{ id: conRnc }] = await bd.consultar("SELECT id FROM clientes WHERE nombre='Con RNC'");
const [{ id: sinRnc }] = await bd.consultar("SELECT id FROM clientes WHERE nombre='Sin RNC'");
const vender = (extra) => bd.registrarVenta({ items: [{ producto_id: pid, cantidad: 1, precio_unitario: 1000 }], ...extra });
const ncfDe = async (num) => (await bd.consultar('SELECT ncf FROM ventas WHERE numero = ?', [num]))[0].ncf;
assert.match(await ncfDe(await vender({ cliente_id: conRnc })), /^B01/, 'automático con RNC = B01');
assert.match(await ncfDe(await vender({ cliente_id: sinRnc })), /^B02/, 'automático sin RNC = B02');
assert.match(await ncfDe(await vender({ cliente_id: conRnc, tipo_ncf: 'B02' })), /^B02/, 'consumo aunque tenga RNC');
assert.match(await ncfDe(await vender({ cliente_id: conRnc, tipo_ncf: 'ninguno' })), /^B01/, 'encendida, siempre hay comprobante');
await assert.rejects(vender({ cliente_id: sinRnc, tipo_ncf: 'B01' }), /necesita un cliente con RNC/);
await assert.rejects(vender({ tipo_ncf: 'B01' }), /necesita un cliente con RNC/);
await assert.rejects(vender({ cliente_id: conRnc, tipo_ncf: 'B14' }), /No hay números disponibles de B14/);
await bd.guardarSecuenciaNCF('B14', 1, 1);
assert.match(await ncfDe(await vender({ cliente_id: conRnc, tipo_ncf: 'B14' })), /^B14/);
await assert.rejects(vender({ cliente_id: conRnc, tipo_ncf: 'B14' }), /No hay números disponibles/);
const [{ n: ventas }] = await bd.consultar('SELECT COUNT(*) AS n FROM ventas');
assert.equal(ventas, 5, 'las ventas rechazadas no se guardan ni gastan números');
const sec = await bd.leerSecuenciasNCF();
assert.equal(sec.find((s) => s.tipo === 'B01').sig, 3, 'B01 solo gastó 2 números (las fallidas no gastan)');
// ITBIS sumado al precio
const fila = async (num) => (await bd.consultar('SELECT subtotal, descuento, itbis, total, ncf FROM ventas WHERE numero = ?', [num]))[0];
await bd.guardarSecuenciaNCF('B02', 20, 50);
const v1 = await fila(await vender({ cliente_id: sinRnc }));
assert.deepEqual([v1.subtotal, v1.itbis, v1.total], [1000, 180, 1180], 'precio 1,000 + 18 % = 1,180');
assert.match(v1.ncf, /^B02/, 'cliente sin RNC: consumidor final');
const v2 = await fila(await vender({ descuento: 100 }));
assert.deepEqual([v2.itbis, v2.total], [162, 1062], 'el ITBIS se calcula después del descuento');
await bd.ejecutar("UPDATE productos SET itbis_exento = 1 WHERE id = ?", [pid]);
const v3 = await fila(await vender({}));
assert.deepEqual([v3.itbis, v3.total], [0, 1000], 'producto exento no paga ITBIS');
await bd.ejecutar("UPDATE productos SET itbis_exento = 0 WHERE id = ?", [pid]);
await bd.ejecutar("UPDATE clientes SET limite_credito = 1100, condicion = 'credito', dias_credito = 30 WHERE id = ?", [sinRnc]);
await assert.rejects(vender({ cliente_id: sinRnc, metodo_pago: 'credito' }), /límite de crédito/, 'el límite de crédito cuenta el ITBIS (1,180 > 1,100)');
await bd.guardarSecuenciaNCF('B02', 0, 0);
await assert.rejects(vender({ cliente_id: sinRnc }), /no hay números disponibles/, 'sin secuencia no se vende sin comprobante');
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo','no')");
const v4 = await fila(await vender({ cliente_id: sinRnc }));
assert.deepEqual([v4.itbis, v4.total, v4.ncf], [0, 1000, null], 'apagada: sin ITBIS ni comprobante');
// Comprobante automático según el cliente
const itb = await import('../src/itbis.js');
assert.deepEqual(itb.comprobanteDeCliente({ documento: '101123456' }), { tipo: 'B01', motivo: 'contribuyente con RNC' });
assert.equal(itb.comprobanteDeCliente({ documento: '00112345678' }).tipo, 'B02', 'cédula = consumidor final');
assert.equal(itb.comprobanteDeCliente({ documento: '401001234', regimen_dgii: 'NORMAL' }).tipo, 'B15', 'institución del Estado');
assert.equal(itb.comprobanteDeCliente({ documento: '130111222', nombre: 'Ministerio de Obras Públicas', regimen_dgii: 'NORMAL' }).tipo, 'B15', 'nombre de entidad pública');
assert.equal(itb.comprobanteDeCliente({ documento: '130111222', regimen_dgii: 'NORMAL' }).tipo, 'B01');
assert.equal(itb.comprobanteDeCliente({ documento: '130111222', regimen_dgii: 'Régimen Simplificado' }, [{ texto: 'SIMPLIFICADO', tipo: 'B02' }]).tipo, 'B02', 'regla propia (sin acentos ni mayúsculas)');
assert.equal(itb.comprobanteDeCliente({ documento: '130999888', regimen_dgii: 'REGIMEN ESPECIAL' }).tipo, 'B14');
assert.equal(itb.comprobanteDeCliente({ documento: '130999888', regimen_dgii: 'ZONA FRANCA' }).tipo, 'B14');
assert.equal(itb.comprobanteDeCliente({ documento: '130999888', tipo_comprobante: 'B01', regimen_dgii: 'ESPECIAL' }).tipo, 'B01', 'lo fijado en la ficha manda');
await bd.ejecutar("INSERT INTO clientes (nombre, tipo_doc, documento, regimen_dgii) VALUES ('Zona Franca SA','rnc','130777666','ESPECIAL')");
await bd.ejecutar("INSERT INTO clientes (nombre, tipo_doc, documento, tipo_comprobante) VALUES ('Fijo B02','rnc','131555444','B02')");
const idZf = (await bd.consultar("SELECT id FROM clientes WHERE nombre='Zona Franca SA'"))[0].id;
const idFijo = (await bd.consultar("SELECT id FROM clientes WHERE nombre='Fijo B02'"))[0].id;
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo','adicional')");
await bd.guardarSecuenciaNCF('B02', 20, 50);
await assert.rejects(vender({ cliente_id: idZf }), /le corresponde B14/, 'automático pide B14 y avisa si no hay secuencia');
await bd.guardarSecuenciaNCF('B14', 5, 9);
assert.equal((await bd.leerReglasComprobante()).length, itb.REGLAS_COMPROBANTE_BASE.length, 'sin configurar usa las reglas base');
await bd.guardarReglasComprobante([{ texto: ' especial ', tipo: 'B14' }, { texto: '', tipo: 'B01' }]);
assert.deepEqual(await bd.leerReglasComprobante(), [{ texto: 'ESPECIAL', tipo: 'B14' }], 'las reglas vacías se descartan');
await assert.rejects(bd.guardarReglasComprobante([{ texto: 'X', tipo: 'B99' }]), /Elige el comprobante/);
assert.match(await ncfDe(await vender({ cliente_id: idZf })), /^B14/, 'régimen especial en la DGII = B14 automático');
assert.match(await ncfDe(await vender({ cliente_id: idFijo })), /^B02/, 'comprobante fijado en la ficha');
assert.match(await ncfDe(await vender({ cliente_id: idZf, tipo_ncf: 'B01' })), /^B01/, 'elección manual manda sobre el automático');
await bd.guardarSecuenciaNCF('B02', 0, 0);
await bd.guardarSecuenciaNCF('B02', 20, 50);
ok('el comprobante automático sale del cliente: B01 con RNC, B14 si su régimen en la DGII es especial, B15 del Estado, B02 sin RNC; se puede fijar o elegir a mano');
ok('ITBIS 18 % sumado al precio (con descuento, exentos y límite de crédito); consumidor final B02; apagada = sin comprobante');
ok('el tipo de comprobante se respeta: B01/B02/B14, exige RNC y secuencia, y no gasta números si falla');
console.log(`\n${n} grupos OK`);
process.exit(0);
