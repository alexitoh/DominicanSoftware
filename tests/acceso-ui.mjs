// Prueba de humo de la pantalla de acceso (login.js) con un DOM simulado y el servidor real:
// registro sin RNC (número asignado), primer inicio en un equipo nuevo (pide el RNC), inicios siguientes (ya no lo pide) y recuperación.
import assert from 'node:assert/strict';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

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
globalThis.history = { state: null, pushState() {}, back() {} };
globalThis.location = { hash: '', reload() {} };
const setTimeoutOriginal = globalThis.setTimeout;

const { crearServidor } = await import('../server/index.js');
const { abrirBase } = await import('../server/db.js');
const servidor = crearServidor({ db: abrirBase(':memory:'), secreto: 'prueba-acceso-secreto-1234567890', aprobacionAutomatica: true });
await new Promise((r) => servidor.listen(0, r));
localStorage.setItem('caraudio_servidor', `http://127.0.0.1:${servidor.address().port}`);

const bd = await import('../src/database.js');
const auth = await import('../src/auth.js');
const na = await import('../src/nube-app.js');
const { asegurarSesion } = await import('../src/login.js');
await bd.initDB();
await na.cargarVinculo();
let n = 0; const ok = (t) => { n++; console.log(`  ✔ ${t}`); };
console.log('Pantalla de acceso (DOM simulado)');

const pausa = (ms = 30) => new Promise((r) => setTimeoutOriginal(r, ms));
const pantalla = () => document.body.todos((x) => x.attrs.id === 'acceso')[0];
const texto = () => pantalla()?.texto || '';
const boton = (txt) => pantalla().todos((x) => x.tag === 'button' && x.texto.includes(txt))[0];
const campoDe = (etiqueta) => pantalla().todos((x) => x.tag === 'label' && x.texto.includes(etiqueta))[0]?.todos((x) => x.tag === 'input')[0];
const hayCampo = (etiqueta) => !!campoDe(etiqueta);
const escribir = (etiqueta, v) => { const i = campoDe(etiqueta); assert.ok(i, `no hay campo "${etiqueta}"`); i.value = v; };
async function pulsar(txt) { const b = boton(txt); assert.ok(b, `no hay botón "${txt}" en: ${texto().slice(0, 160)}`); await b.disparar('click'); await pausa(); }

// ---- 1. Primer equipo: crear el negocio sin RNC ----
let usuario1 = null;
const sesion1 = asegurarSesion().then((u) => { usuario1 = u; });
await pausa();
assert.match(texto(), /Bienvenido/);
await pulsar('Crear mi negocio en la nube');
assert.ok(hayCampo('RNC del negocio (opcional'), 'el registro ofrece el campo RNC');
escribir('Nombre del negocio', 'Hogar');
escribir('Tu nombre', 'Ana');
escribir('Usuario', 'admin');
escribir('Correo', 'ana@x.com');
escribir('Contraseña', 'clave1234');
escribir('Repite la contraseña', 'clave1234');
await pulsar('Crear mi negocio');
await pausa(300);
assert.match(texto(), /Negocio creado en la nube/);
assert.match(texto(), /Número de tu negocio \(asignado\)/);
const idAsignado = pantalla().todos((x) => x.attrs['aria-label'] === 'Identificador del negocio')[0].texto.trim();
assert.match(idAsignado, /^9\d{8}$/);
(pantalla().todos((x) => x.tag === 'input' && x.attrs.type === 'checkbox')[0]).checked = true;
await (pantalla().todos((x) => x.tag === 'input' && x.attrs.type === 'checkbox')[0]).disparar('change');
await pulsar('Continuar');
await sesion1;
assert.equal(usuario1?.usuario, 'admin');
assert.equal(na.datosVinculo().negocio_id, idAsignado);
ok('crear el negocio sin RNC muestra el número asignado, y el equipo lo recuerda');

// ---- 2. Un equipo nuevo pide el RNC una sola vez ----
await auth.cerrarSesion();
await na.vaciarDispositivo();
let usuario2 = null;
const sesion2 = asegurarSesion().then((u) => { usuario2 = u; });
await pausa();
await pulsar('Ya tengo una cuenta');
assert.ok(hayCampo('RNC del negocio (sin guiones)'), 'un equipo nuevo pide el RNC');
escribir('Usuario o correo', 'admin');
escribir('Contraseña', 'clave1234');
await pulsar('Entrar y descargar');
assert.match(texto(), /Escribe el RNC del negocio/, 'sin RNC no entra');
escribir('RNC del negocio', '12345');
await pulsar('Entrar y descargar');
assert.match(texto(), /9 números/);
escribir('RNC del negocio', '131234567');
await pulsar('Entrar y descargar');
assert.match(texto(), /incorrectos/, 'otro RNC: no encuentra el usuario');
// Recuperar contraseña desde aquí también pide el RNC
await pulsar('Olvidaste tu contraseña');
assert.ok(hayCampo('RNC del negocio (sin guiones)'));
await pulsar('Volver');
escribir('RNC del negocio', idAsignado);
escribir('Usuario o correo', 'admin');
escribir('Contraseña', 'clave1234');
await pulsar('Entrar y descargar');
await pausa(300);
await sesion2;
assert.equal(usuario2?.usuario, 'admin');
assert.equal(na.datosVinculo().negocio_id, idAsignado);
ok('en un equipo nuevo se pide el RNC (validado) y entra con el del negocio');

// ---- 3. Ya vinculado: no se vuelve a pedir ----
await auth.cerrarSesion();
let usuario3 = null;
const sesion3 = asegurarSesion().then((u) => { usuario3 = u; });
await pausa();
assert.match(texto(), /Iniciar sesión/);
assert.ok(!hayCampo('RNC'), 'el equipo vinculado no vuelve a pedir el RNC');
escribir('Usuario o correo', 'admin');
escribir('Contraseña', 'clave1234');
await pulsar('Entrar');
await pausa(300);
await sesion3;
assert.equal(usuario3?.usuario, 'admin');
await auth.cerrarSesion();
const sesion4 = asegurarSesion();
await pausa();
await pulsar('Olvidaste tu contraseña');
assert.ok(!hayCampo('RNC'), 'recuperar en un equipo vinculado tampoco lo pide');
ok('con el equipo ya vinculado, ni entrar ni recuperar piden el RNC');

servidor.close();
console.log(`\n${n} grupos OK`);
process.exit(0);
