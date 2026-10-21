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
class Nodo {
  constructor(tag) { this.tag = tag; this.hijos = []; this.attrs = {}; this.oyentes = {}; this.value = ''; this.checked = false; this.hidden = false; this.className = ''; this.parentElement = null; this.nodeType = 1; this.disabled = false; this.style = {}; this.dataset = {}; this.textContent = ''; }
  getAttribute(k) { return this.attrs[k]; }
  get children() { return this.hijos.filter((x) => x.nodeType === 1); }
  append(...c) { for (const x of c) { if (x == null) continue; if (x.parentElement) x.remove(); x.parentElement = this; this.hijos.push(x); } }
  replaceChildren(...c) { this.hijos.forEach((x) => { x.parentElement = null; }); this.hijos = []; this.append(...c); }
  remove() { if (this.parentElement) { this.parentElement.hijos = this.parentElement.hijos.filter((x) => x !== this); this.parentElement = null; } }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'value') this.value = v; if (k === 'checked') this.checked = true; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.oyentes[t] ||= []).push(f); }
  async disparar(t, extra = {}) { for (const f of this.oyentes[t] || []) await f({ target: this, ...extra }); }
  todos(f, out = []) { for (const x of this.hijos) { if (x.nodeType === 1) { if (f(x)) out.push(x); x.todos(f, out); } } return out; }
  querySelectorAll(s) { const t = s.replace(/[^a-z]/g, ''); return this.todos((x) => x.tag === t); }
  scrollIntoView() {}
  focus() {}
  get texto() { return [this.textContent, ...this.hijos].filter((x) => x !== '').map((x) => (typeof x === 'string' ? x : x.texto)).join(' '); }
  get textoViejo() { return this.hijos.map((x) => (x.nodeType === 3 ? x.texto : x.texto)).join(' '); }
}
class Txt { constructor(t) { this.nodeType = 3; this.texto = t; this.parentElement = null; } remove() { if (this.parentElement) this.parentElement.hijos = this.parentElement.hijos.filter((x) => x !== this); } }
globalThis.document = {
  addEventListener() {}, visibilityState: 'visible', documentElement: {},
  createElement: (t) => new Nodo(t), createTextNode: (t) => new Txt(t), body: new Nodo('body'),
};
document.getElementById = () => null;
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: 'visible', documentElement: {}, createElement: (t) => new Nodo(t), createTextNode: (t) => new Txt(t), body: new Nodo('body'), getElementById: () => null, activeElement: null };
globalThis.history = { state: null, pushState() {}, back() {} };
globalThis.location = { hash: '', reload() {} };
const setTimeoutOriginal = globalThis.setTimeout;
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
const { vistaEcf } = await import('../src/ecf.js');
let n = 0; const ok = (t) => { n++; console.log(`  ✔ ${t}`); };
const uno = async (sql, p) => (await bd.consultar(sql, p))[0];
const pausa = (ms) => new Promise((r) => setTimeoutOriginal(r, ms));
console.log('Pantalla de facturación electrónica (DOM simulado)');
await bd.initDB(); await na.cargarVinculo();
await auth.registrarPropietario({ negocio: 'Audio Pro', nombre: 'Dueño', usuario: 'dueno', correo: 'd@x.com', clave: 'clave1234' });
await auth.iniciarSesion('dueno', 'clave1234');
await bd.ejecutar("INSERT INTO productos (codigo, nombre, costo, precio, stock_actual) VALUES ('B-1', 'Bocina', 50, 100, 50)");
const pid = (await uno("SELECT id FROM productos WHERE codigo = 'B-1'")).id;
const raiz = new Nodo('div');
await vistaEcf(raiz);
assert.match(raiz.texto, /conecta este equipo a la nube/i);
ok('sin la nube conectada la pantalla lo explica');

await auth.registrarNegocioNube({ negocio: 'Audio Pro', nombre: 'Dueño', usuario: 'dueno', correo: 'd@x.com', clave: 'clave1234', rnc: '101123456' });
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo', 'incluido'), ('negocio_rnc', '101123456')");
await nube.guardarNcf('E31', { siguiente: 1, hasta: 10, vence: '2027-12-31' });
await vistaEcf(raiz);
const tabs = raiz.todos((x) => x.tag === 'button' && x.attrs.role === 'tab').map((b) => b.texto);
assert.deepEqual(tabs, ['Comprobantes', 'Emitir E41 / E43', 'Configuración']);
assert.match(raiz.texto, /apagada/);
ok('la bandeja abre y avisa que la facturación electrónica está apagada');

const irA = async (t) => { await raiz.todos((x) => x.tag === 'button' && x.attrs.role === 'tab' && x.texto === t)[0].disparar('click'); await pausa(80); };
await irA('Configuración');
assert.match(raiz.texto, /Todavía no hay certificado cargado/);
assert.match(raiz.texto, /E31 · Factura de crédito fiscal electrónica/);
assert.equal(String(raiz.todos((x) => x.tag === 'input' && x.attrs['aria-label'] === 'E31 próximo')[0].value), '1');
ok('Configuración muestra el certificado pendiente y las ocho secuencias E');

await nube.subirCertificado({ p12: p12.toString('base64'), clave: 'clave-123' });
await nube.guardarNcf('E32', { siguiente: 1, hasta: 10, vence: '' });
await nube.guardarEcf({ activo: true });
await na.refrescarElectronico();
await bd.registrarVenta({ items: [{ producto_id: pid, cantidad: 1, precio_unitario: 100 }] });
await na.sincronizarAhora();
for (let i = 0; i < 20 && (await nube.ecf()).resumen?.aceptado !== 1; i++) await pausa(150);
await irA('Comprobantes');
assert.match(raiz.texto, /E320000000001/);
assert.match(raiz.texto, /Aceptado/);
ok('la bandeja lista el comprobante E32 con su estado Aceptado');

await irA('Configuración');
assert.match(raiz.texto, /Vence el 20/);
ok('Configuración muestra el certificado cargado y su vencimiento');

await irA('Emitir E41 / E43');
assert.match(raiz.texto, /Comprobante de compras/);
ok('la pantalla de emisión manual abre');

console.log(`\n${n} comprobaciones pasaron.`);
servidor.close(); process.exit(0);
