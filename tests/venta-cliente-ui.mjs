// Prueba de la barra de cliente al facturar (DOM simulado): sugerencias, RNC que crea el cliente, teléfono y dirección obligatorios, comprobante automático.
import assert from 'node:assert/strict';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
class Nodo {
  constructor(tag) { this.tag = tag; this.hijos = []; this.attrs = {}; this.oyentes = {}; this.value = ''; this.checked = false; this.hidden = false; this.className = ''; this.parentElement = null; this.nodeType = 1; this.disabled = false; this.style = {}; this.dataset = {}; this.textContent = ''; }
  getAttribute(k) { return this.attrs[k]; }
  get children() { return this.hijos.filter((x) => x.nodeType === 1); }
  get options() { return this.hijos.filter((x) => x.tag === 'option'); }
  append(...c) { for (const x of c) { if (x == null) continue; if (x.parentElement) x.remove(); x.parentElement = this; this.hijos.push(x); } }
  replaceChildren(...c) { this.hijos.forEach((x) => { x.parentElement = null; }); this.hijos = []; this.append(...c); }
  remove() { if (this.parentElement) { this.parentElement.hijos = this.parentElement.hijos.filter((x) => x !== this); this.parentElement = null; } }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'value') this.value = v; if (k === 'checked') this.checked = true; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.oyentes[t] ||= []).push(f); }
  async disparar(t, extra = {}) { for (const f of this.oyentes[t] || []) await f({ target: this, preventDefault() {}, ...extra }); }
  todos(f, out = []) { for (const x of this.hijos) { if (x.nodeType === 1) { if (f(x)) out.push(x); x.todos(f, out); } } return out; }
  querySelector(s) { const m = /^(\w+)(?:\[(data-id)\])?$/.exec(s); return this.todos((x) => x.tag === m[1] && (!m[2] || x.attrs['data-id'] !== undefined))[0] || null; }
  querySelectorAll(s) { const t = s.replace(/[^a-z]/g, ''); return this.todos((x) => x.tag === t); }
  click() { return this.disparar('click'); }
  scrollIntoView() {}
  focus() {}
  get texto() { return [this.textContent, ...this.hijos].filter((x) => x !== '').map((x) => (typeof x === 'string' ? x : x.texto)).join(' '); }
}
class Txt { constructor(t) { this.nodeType = 3; this.texto = t; this.parentElement = null; } remove() { if (this.parentElement) this.parentElement.hijos = this.parentElement.hijos.filter((x) => x !== this); } }
globalThis.document = { addEventListener() {}, visibilityState: 'visible', documentElement: {}, createElement: (t) => new Nodo(t), createTextNode: (t) => new Txt(t), body: new Nodo('body') };
document.getElementById = () => null;
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.history = { state: null, pushState() {}, back() {} };
globalThis.location = { hash: '', reload() {} };

const bd = await import('../src/database.js');
const nb = await import('../src/nube.js');
const { vistaVentas } = await import('../src/ventas.js');
await bd.initDB();
let n = 0; const ok = (t) => { n++; console.log(`  ✔ ${t}`); };
console.log('Barra de cliente al facturar (DOM simulado)');

// Sesión y DGII simuladas
nb.guardarSesionNube({ token: 'x' });
const padron = { 101123456: { nombre: 'ELECTRO SONIDO SRL', regimen: 'NORMAL', activo: true }, 130999888: { nombre: 'TALLER CERRADO SRL', regimen: 'RST', activo: false, estado: 'SUSPENDIDO' } };
let consultas = 0;
nb.nube.consultarRNC = async (num) => {
  consultas++;
  const p = padron[num];
  return p ? { encontrado: true, activo: p.activo, nombre: p.nombre, regimen: p.regimen, estado: p.estado || 'ACTIVO', rnc: num } : { encontrado: false };
};
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo','adicional')");
await bd.ejecutar("INSERT INTO clientes (nombre, telefono, direccion) VALUES ('Juan Pérez','809-555-0001','Calle 1')");
await bd.ejecutar("INSERT INTO clientes (nombre, telefono, direccion) VALUES ('Juana Gómez','809-555-0002','Calle 2')");
await bd.ejecutar("INSERT INTO clientes (nombre, tipo_doc, documento, telefono, direccion) VALUES ('Tienda Completa SRL','rnc','131000111','809-555-0003','Av. Principal 5')");
await bd.ejecutar("INSERT INTO productos (nombre, precio, costo, stock_actual, activo) VALUES ('Bocina 6x9', 1000, 600, 5, 1)");

const raiz = new Nodo('div'); document.body.append(raiz);
await vistaVentas(raiz);
const hoja = () => document.body.todos((x) => x.attrs.role === 'dialog').pop();
const porAria = (a) => hoja().todos((x) => x.attrs['aria-label'] === a)[0];
const pausa = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const escribir = async (campo, v) => { campo.value = v; await campo.disparar('input'); await pausa(); };

await raiz.todos((x) => x.tag === 'button' && x.texto.includes('Nueva venta'))[0].click(); await pausa();
const barra = porAria('Cliente'); const rnc = porAria('RNC del cliente');
assert.ok(barra && barra.tag === 'input', 'el cliente es una barra de búsqueda');
const sugerencias = () => hoja().todos((x) => x.attrs['aria-label'] === 'Sugerencias de clientes')[0];
const nombres = () => sugerencias().todos((x) => x.tag === 'button').map((b) => b.todos((y) => y.tag === 'strong')[0].texto);
const comprobante = () => hoja().todos((x) => x.attrs['aria-label'] === 'Tipo de comprobante')[0];

// 1. Sugerencias al escribir
await escribir(barra, 'jua');
assert.deepEqual(nombres().sort(), ['Juan Pérez', 'Juana Gómez']);
await escribir(barra, 'juana');
assert.deepEqual(nombres(), ['Juana Gómez']);
await escribir(barra, '809-555-0003'.replace(/-/g, ''));
await escribir(barra, 'tienda');
assert.deepEqual(nombres(), ['Tienda Completa SRL']);
ok('al escribir en la barra salen sugerencias de clientes por nombre');

// 2. Elegir una sugerencia llena la barra y, si tiene RNC, el campo RNC y el comprobante fiscal
await sugerencias().todos((x) => x.tag === 'button')[0].click(); await pausa();
assert.equal(barra.value, 'Tienda Completa SRL');
assert.match(rnc.value, /131/);
assert.match(comprobante().options[0].textContent, /crédito fiscal \(B01\)/);
ok('un cliente con RNC deja el RNC lleno y el comprobante fiscal (B01) puesto solo');

// 3. Cliente sin RNC: consumo
await escribir(barra, 'Juan'); await sugerencias().todos((x) => x.tag === 'button')[0].click(); await pausa();
assert.equal(rnc.value, '');
assert.match(comprobante().options[0].textContent, /consumo \(B02\)/);
ok('un cliente sin RNC lleva factura de consumo (B02)');

// 4. RNC nuevo en la barra: consulta la DGII, crea el cliente y pide teléfono y dirección
await escribir(barra, '101-12345-6');
assert.equal(barra.value, 'ELECTRO SONIDO SRL');
const [creado] = await bd.consultar("SELECT * FROM clientes WHERE documento = '101123456'");
assert.equal(creado.nombre, 'ELECTRO SONIDO SRL'); assert.equal(creado.regimen_dgii, 'NORMAL'); assert.equal(creado.telefono, null);
assert.match(comprobante().options[0].textContent, /\(B01\)/);
assert.ok(porAria('Teléfono del cliente') && porAria('Dirección del cliente'), 'pide teléfono y dirección');
ok('al poner un RNC nuevo el cliente se guarda solo y pide teléfono y dirección');

// 5. No deja cobrar hasta completarlos
await hoja().todos((x) => x.tag === 'button' && x.className === 'resultado')[0].click(); await pausa();
const cobrar = hoja().todos((x) => x.tag === 'button' && x.texto === 'Cobrar')[0];
await cobrar.click(); await pausa();
assert.match(hoja().texto, /Completa el teléfono y la dirección/);
let [v0] = await bd.consultar('SELECT COUNT(*) AS n FROM ventas'); assert.equal(v0.n, 0);
const guardar = () => hoja().todos((x) => x.tag === 'button' && x.texto.includes('Guardar datos'))[0];
await porAria('Teléfono del cliente').disparar('input'); porAria('Teléfono del cliente').value = '809-555-0100';
await guardar().click(); await pausa();
assert.match(hoja().texto, /dirección es obligatoria/);
porAria('Dirección del cliente').value = 'Av. Duarte 10';
await guardar().click(); await pausa();
const [comp] = await bd.consultar("SELECT telefono, direccion FROM clientes WHERE documento = '101123456'");
assert.equal(comp.telefono, '809-555-0100'); assert.equal(comp.direccion, 'Av. Duarte 10');
assert.equal(porAria('Teléfono del cliente'), undefined, 'el aviso desaparece al completarlos');
ok('teléfono y dirección son obligatorios y, al guardarlos, se puede continuar');

// 6. Un RNC que ya existe no se duplica ni consulta la DGII; uno suspendido no se crea
const antes = consultas;
await escribir(barra, '101123456');
assert.equal(consultas, antes);
assert.equal((await bd.consultar("SELECT COUNT(*) AS n FROM clientes WHERE documento = '101123456'"))[0].n, 1);
await escribir(barra, '130999888');
assert.equal((await bd.consultar("SELECT COUNT(*) AS n FROM clientes WHERE documento = '130999888'"))[0].n, 0);
assert.match(hoja().texto, /SUSPENDIDO/);
ok('un RNC ya registrado se reutiliza y uno suspendido no se crea');

// 7. Texto sin elegir cliente no factura como "general" por error
await escribir(barra, 'zzz inexistente');
await cobrar.click(); await pausa();
assert.match(hoja().texto, /Elige un cliente de la lista/);
ok('texto sin cliente elegido no se factura por error como cliente general');

console.log(`\n${n} comprobaciones correctas`);
process.exit(0);
