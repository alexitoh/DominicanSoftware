// e-CF desde el equipo: la app real (database.js, nube-app.js, cxc-db.js, impresion.js) contra el servidor real y una DGII simulada.
// Ejecutar con: node --import ./tests/stubs/registrar.mjs tests/ecf-cliente.mjs   (necesita openssl)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };

// ---- certificado de prueba y DGII simulada (acepta todo) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecfc-'));
const ssl = (...a) => execFileSync('openssl', a, { stdio: ['pipe', 'pipe', 'pipe'] });
ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k.pem`, '-out', `${tmp}/c.pem`, '-days', '365', '-subj', '/CN=EMPRESA DE PRUEBA SRL');
ssl('pkcs12', '-export', '-inkey', `${tmp}/k.pem`, '-in', `${tmp}/c.pem`, '-out', `${tmp}/p.p12`, '-passout', 'pass:clave-123');
const p12 = fs.readFileSync(`${tmp}/p.p12`);
const json = (c, estado = 200) => ({ ok: estado < 400, status: estado, text: async () => (typeof c === 'string' ? c : JSON.stringify(c)) });
const dgii = { enviados: [], aceptar: true };
const fetchEcf = async (url, opts = {}) => {
  const p = new URL(url).pathname.toLowerCase();
  if (p.endsWith('/semilla')) return json('<SemillaModel><valor>s1</valor><fecha>2026-10-15T21:00:00</fecha></SemillaModel>');
  if (p.endsWith('/validarsemilla')) return json({ token: 'tok', expira: new Date(Date.now() + 3600000).toISOString() });
  if (p.endsWith('/facturaselectronicas')) {
    const t = Buffer.from(opts.body).toString('utf8');
    dgii.enviados.push(/<eNCF>([^<]+)</.exec(t)[1]); return json({ trackId: `t${dgii.enviados.length}` });
  }
  if (p.endsWith('/consultas/estado')) return json({ codigo: '1', estado: 'Aceptado' });
  if (p.endsWith('/recepcion/ecf')) return json({ codigo: '1', estado: 'Aceptado' });
  return json({}, 404);
};

const { crearServidor } = await import('../server/index.js');
const { abrirBase } = await import('../server/db.js');
const dbSrv = abrirBase(':memory:');
const servidor = crearServidor({ db: dbSrv, secreto: 'prueba-ecf-cliente-secreto-12345', aprobacionAutomatica: true, fetchEcf });
await new Promise((r) => servidor.listen(0, r));
localStorage.setItem('caraudio_servidor', `http://127.0.0.1:${servidor.address().port}`);

const bd = await import('../src/database.js');
const auth = await import('../src/auth.js');
const na = await import('../src/nube-app.js');
const { nube } = await import('../src/nube.js');
const cxc = await import('../src/cxc-db.js');
const imp = await import('../src/impresion.js');
const { qrMatriz } = await import('../src/qr.js');
let n = 0; const ok = (t) => { n++; console.log(`  ✔ ${t}`); };
const uno = async (sql, p) => (await bd.consultar(sql, p))[0];
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('e-CF desde el equipo');

await bd.initDB(); await na.cargarVinculo();
await auth.registrarPropietario({ negocio: 'Audio Pro', nombre: 'Dueño', usuario: 'dueno', correo: 'd@x.com', clave: 'clave1234' });
await auth.iniciarSesion('dueno', 'clave1234');
await bd.ejecutar("INSERT INTO productos (codigo, nombre, costo, precio, stock_actual) VALUES ('B-1', 'Bocina', 50, 100, 50)");
const pid = (await uno("SELECT id FROM productos WHERE codigo = 'B-1'")).id;
await auth.registrarNegocioNube({ negocio: 'Audio Pro', nombre: 'Dueño', usuario: 'dueno', correo: 'd@x.com', clave: 'clave1234', rnc: '101123456' });
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo', 'incluido'), ('negocio_rnc', '101123456')");
await bd.ejecutar("INSERT INTO clientes (nombre, tipo_doc, documento, condicion, dias_credito) VALUES ('Taller Sonido SRL', 'rnc', '131880657', 'credito', 30)");
const cli = (await uno("SELECT id FROM clientes WHERE nombre = 'Taller Sonido SRL'")).id;
await nube.guardarNcf('B01', { siguiente: 1, hasta: 50 });
await nube.guardarNcf('B02', { siguiente: 1, hasta: 50 });

// ---- sin e-CF: todo igual que antes ----
await bd.registrarVenta({ cliente_id: cli, items: [{ producto_id: pid, cantidad: 1, precio_unitario: 100 }] });
assert.equal((await uno('SELECT ncf FROM ventas ORDER BY id DESC')).ncf, 'B0100000001');
ok('con la facturación electrónica apagada las ventas siguen saliendo con B01/B02');

// ---- se activa el e-CF ----
await nube.subirCertificado({ p12: p12.toString('base64'), clave: 'clave-123' });
for (const [t, s, h, v] of [['E31', 1, 20, '2027-12-31'], ['E32', 1, 20, ''], ['E34', 1, 20, ''], ['E33', 1, 20, '2027-12-31']]) await nube.guardarNcf(t, { siguiente: s, hasta: h, vence: v });
await nube.guardarEcf({ activo: true, ambiente: 'testecf', extra: { razon: 'Audio Pro SRL', direccion: 'Av. Principal 1', municipio: '010100', provincia: '010000' } });
await na.refrescarElectronico();
assert.equal(na.facturaElectronica(), true);
const antes = dgii.enviados.length;
await bd.registrarVenta({ cliente_id: cli, items: [{ producto_id: pid, cantidad: 2, precio_unitario: 100 }] });
const v1 = await uno('SELECT id, ncf FROM ventas ORDER BY id DESC');
assert.equal(v1.ncf, 'E310000000001', 'cliente con RNC → E31 de 13 caracteres');
await bd.registrarVenta({ items: [{ producto_id: pid, cantidad: 1, precio_unitario: 100 }] });
assert.equal((await uno('SELECT ncf FROM ventas ORDER BY id DESC')).ncf, 'E320000000001', 'consumidor final → E32');
ok('con e-CF activo las ventas salen como E31 (con RNC) y E32 (consumo), con el número del servidor');

// ---- el estado vuelve al equipo y se imprime con QR ----
await na.sincronizarAhora(); await pausa(150); await na.sincronizarAhora();
let doc = await uno('SELECT * FROM ecf_documentos WHERE venta_id = ?', [v1.id]);
for (let i = 0; i < 20 && !doc?.qr_url; i++) { await pausa(150); await na.sincronizarAhora(); doc = await uno('SELECT * FROM ecf_documentos WHERE venta_id = ?', [v1.id]); }
assert.ok(doc, 'llegó el estado del comprobante');
assert.equal(doc.estado, 'aceptado'); assert.equal(doc.ncf, 'E310000000001'); assert.match(doc.codigo_seguridad, /^.{6}$/);
assert.ok(dgii.enviados.includes('E310000000001') && dgii.enviados.length > antes);
const f = await imp.cargarFactura(v1.id);
const html = imp.ticket80HTML(f);
assert.ok(html.includes('E310000000001') && html.includes(doc.codigo_seguridad) && html.includes('<svg'), 'el ticket lleva e-NCF, código de seguridad y QR');
assert.ok(html.includes('Factura de crédito fiscal electrónica'));
assert.ok(qrMatriz(doc.qr_url, 'L').length >= 21);
const a4 = imp.facturaA4HTML(f);
assert.ok(a4.includes(doc.codigo_seguridad) && a4.includes('<svg'));
ok('el estado de la DGII vuelve al equipo: el ticket y la factura A4 muestran e-NCF, código de seguridad y QR');

// ---- nota de crédito electrónica automática ----
await bd.registrarVenta({ cliente_id: cli, metodo_pago: 'credito', inicial: 0, dias_credito: 30, items: [{ producto_id: pid, cantidad: 3, precio_unitario: 100 }] });
const vc = await uno('SELECT id, ncf FROM ventas ORDER BY id DESC');
assert.match(vc.ncf, /^E31/);
const nota = await cxc.crearNota({ tipo: 'credito', cliente_id: cli, venta_id: vc.id, monto: 59, itbis: 9, notas: 'Descuento' });
assert.equal(nota.ncf, 'E340000000001', 'la nota de crédito de una factura electrónica sale como E34');
assert.equal((await uno('SELECT ncf FROM cxc_docs WHERE numero = ?', [nota.numero])).ncf, 'E340000000001');
await na.sincronizarAhora(); await pausa(200); await na.sincronizarAhora();
assert.ok(dgii.enviados.includes('E340000000001'), 'la nota viajó a la DGII');
ok('la nota de crédito de una factura electrónica recibe su E34 solo y se envía a la DGII');

// ---- número que no se pudo usar queda anulado ----
await nube.guardarNcf('E34', { siguiente: 2, hasta: 2, vence: '' });
await assert.rejects(() => cxc.crearNota({ tipo: 'credito', cliente_id: cli, venta_id: vc.id, monto: 99999 }), /no puede ser mayor/);
assert.equal((await nube.ncf()).secuencias.find((x) => x.tipo === 'E34').siguiente, 2, 'una nota rechazada antes de pedir número no gasta secuencia');
ok('una nota inválida no gasta números de la secuencia');

// ---- sin secuencia E: mensaje claro, la venta no se guarda ----
await nube.guardarNcf('E31', { siguiente: 0, hasta: 0, vence: '2027-12-31' });
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo', 'adicional')");
const ventas = (await uno('SELECT COUNT(*) AS n FROM ventas')).n;
await assert.rejects(() => bd.registrarVenta({ cliente_id: cli, items: [{ producto_id: pid, cantidad: 1, precio_unitario: 100 }] }), /E31/);
assert.equal((await uno('SELECT COUNT(*) AS n FROM ventas')).n, ventas);
ok('sin números E disponibles el mensaje nombra el comprobante electrónico (E31) y no se guarda la venta');

// ---- se apaga el e-CF ----
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo', 'incluido')");
await nube.guardarEcf({ activo: false });
await na.refrescarElectronico();
await bd.registrarVenta({ cliente_id: cli, items: [{ producto_id: pid, cantidad: 1, precio_unitario: 100 }] });
assert.equal((await uno('SELECT ncf FROM ventas ORDER BY id DESC')).ncf, 'B0100000002', 'al apagarlo vuelve la numeración B donde iba');
ok('al apagar la facturación electrónica vuelve la numeración B');

console.log(`\n${n} comprobaciones pasaron.`);
servidor.close(); process.exit(0);
