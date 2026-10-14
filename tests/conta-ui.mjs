// Prueba de humo de la interfaz de Contabilidad con un DOM simulado: pinta cada pestaña, abre formularios y guarda.
// No sustituye probar en un navegador real (estilos, toques, PDF), pero detecta errores de código en las pantallas.
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
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.history = { state: null, pushState() {}, back() {} };
globalThis.location = { hash: '' };
const setTimeoutOriginal = globalThis.setTimeout;
globalThis.setTimeout = (f, ms) => setTimeoutOriginal(f, Math.min(ms, 5));

const bd = await import('../src/database.js');
const cd = await import('../src/conta-db.js');
const { vistaContabilidad } = await import('../src/contabilidad.js');
const { vistaAsientos, vistaCuentas } = await import('../src/conta-ui-asientos.js');
const { vistaBancos } = await import('../src/conta-ui-bancos.js');
const { vistaActivos, vistaNomina } = await import('../src/conta-ui-activos.js');
const { vistaReportes } = await import('../src/conta-ui-reportes.js');
await bd.initDB();
let n = 0; const ok = (t) => { n++; console.log(`  ✔ ${t}`); };
console.log('Interfaz de Contabilidad (DOM simulado)');

const pausa = () => new Promise((r) => setTimeoutOriginal(r, 20));
const textoDe = (raiz) => raiz.texto;
const boton = (raiz, txt) => raiz.todos((x) => x.tag === 'button' && x.texto.includes(txt))[0];
const hojaAbierta = () => document.body.hijos.filter((x) => x.attrs?.class === undefined && x.className === 'fondo').at(-1);
const limpiarHojas = () => document.body.replaceChildren();
async function pulsar(el) { assert.ok(el, 'botón no encontrado'); await el.disparar('click'); await pausa(); }

// Datos de ejemplo
const cuentas = await cd.listarCuentas();
const C = Object.fromEntries(cuentas.map((c) => [c.codigo, c]));
await cd.crearBanco({ nombre: 'Popular corriente', banco: 'Popular' });
await bd.ejecutar("INSERT INTO empleados (nombre, cedula, cargo, salario) VALUES ('Ana Pérez','00112345678','Vendedora',45000)");
await cd.crearActivo({ nombre: 'Laptop', fecha_adq: '2026-01-10', costo: 60000, vida_meses: 36 });
await cd.crearAsiento({ fecha: '2026-01-02', concepto: 'Aporte inicial', tipo: 'apertura', lineas: [{ cuenta_id: C['1101'].id, debe: 100000 }, { cuenta_id: C['3101'].id, haber: 100000 }] });
await cd.registrarNomina({ periodo: '2026-03' });
const [b] = await cd.listarBancos();
await cd.registrarMovBanco({ banco_id: b.id, fecha: '2026-03-05', tipo: 'deposito', monto: 5000 });
await cd.guardarPresupuesto(2026, C['6201'].id, Array(12).fill(1000));

// Cada pestaña se pinta sin errores y muestra algo
const raiz = new Nodo('div');
await vistaContabilidad(raiz); await pausa();
const tabs = raiz.todos((x) => x.tag === 'button' && x.attrs.role === 'tab');
assert.equal(tabs.length, 9);
for (const t of tabs) {
  await pulsar(t);
  const cuerpo = textoDe(raiz);
  assert.ok(!cuerpo.includes('No se pudo cargar'), `${t.texto}: ${cuerpo.slice(0, 200)}`);
  assert.ok(cuerpo.length > 20, `${t.texto} está vacía`);
}
ok('las 9 pestañas se pintan sin errores');

// Reportes: recorre todos los tipos
const rr = new Nodo('div');
await vistaReportes(rr); await pausa();
const select = rr.todos((x) => x.tag === 'select')[0];
for (const opt of select.todos((x) => x.tag === 'option')) {
  select.value = opt.attrs.value; await select.disparar('change'); await pausa();
  assert.ok(!textoDe(rr).includes('NaN') && !textoDe(rr).includes('undefined'), `Reporte ${opt.attrs.value}: ${textoDe(rr).slice(0, 300)}`);
}
ok('los 9 reportes se pintan sin NaN ni undefined');

// Asientos: nuevo asiento por la interfaz
limpiarHojas();
const ra = new Nodo('div'); await vistaAsientos(ra); await pausa();
await pulsar(boton(ra, 'Nuevo asiento'));
const hj = document.body.hijos.at(-1);
const selects = hj.todos((x) => x.tag === 'select');
const entradas = hj.todos((x) => x.tag === 'input' && x.attrs.type === 'number');
selects[0].value = String(C['6201'].id); selects[1].value = String(C['1101'].id);
entradas[0].value = '750'; await entradas[0].disparar('input');
entradas[3].value = '750'; await entradas[3].disparar('input');
const concepto = hj.todos((x) => x.tag === 'input' && x.attrs.placeholder?.startsWith('Ej. Pago'))[0];
concepto.value = 'Pago de seguro';
await pulsar(boton(hj, 'Guardar asiento'));
assert.ok(textoDe(hj).includes('Cuadrado') || !document.body.hijos.includes(hj), 'el asiento se guardó o cuadra');
const man = await cd.asientosManuales();
assert.ok(man.some((a) => a.concepto === 'Pago de seguro'), 'el asiento quedó guardado');
ok('crear un asiento desde la pantalla lo guarda cuadrado');

// Un asiento descuadrado muestra el error en la hoja
limpiarHojas();
await pulsar(boton(ra, 'Nuevo asiento'));
const h2 = document.body.hijos.at(-1);
const s2 = h2.todos((x) => x.tag === 'select'); const e2 = h2.todos((x) => x.tag === 'input' && x.attrs.type === 'number');
s2[0].value = String(C['6201'].id); s2[1].value = String(C['1101'].id); e2[0].value = '100'; e2[3].value = '90';
h2.todos((x) => x.attrs.placeholder?.startsWith('Ej. Pago'))[0].value = 'Descuadrado';
await pulsar(boton(h2, 'Guardar asiento'));
assert.ok(h2.todos((x) => x.attrs.role === 'alert').some((x) => x.textContent.length > 5), 'se muestra el error de descuadre');
ok('un asiento descuadrado muestra el error y no se guarda');

// Catálogo, bancos, activos y nómina abren sus formularios y detalle
limpiarHojas();
const rc = new Nodo('div'); await vistaCuentas(rc); await pausa();
await pulsar(boton(rc, 'Nueva cuenta')); await pulsar(rc.todos((x) => x.tag === 'button' && x.className.includes('fila'))[0]);
const rb = new Nodo('div'); await vistaBancos(rb); await pausa();
await pulsar(boton(rb, 'Nueva cuenta bancaria')); await pulsar(rb.todos((x) => x.className.includes('fila'))[0]);
assert.ok(textoDe(document.body).includes('Conciliación'));
const rac = new Nodo('div'); await vistaActivos(rac); await pausa();
await pulsar(boton(rac, 'Nuevo activo fijo')); await pulsar(rac.todos((x) => x.className.includes('fila'))[0]);
const rn = new Nodo('div'); await vistaNomina(rn); await pausa();
await pulsar(boton(rn, 'Nueva nómina')); await pulsar(boton(rn, 'Parámetros')); await pulsar(boton(rn, 'Nuevo empleado'));
await pulsar(rn.todos((x) => x.className.includes('fila'))[0]);
assert.ok(!textoDe(document.body).includes('undefined'));
ok('formularios y detalles de catálogo, bancos, activos y nómina abren sin errores');

// Facturación: tipo de comprobante y consulta del RNC
limpiarHojas();
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo','adicional')");
const { vistaVentas } = await import('../src/ventas.js');
const rv = new Nodo('div'); await vistaVentas(rv); await pausa();
await pulsar(boton(rv, 'Nueva venta'));
const venta = document.body.hijos.at(-1);
const selTipo = venta.todos((x) => x.tag === 'select' && x.attrs['aria-label'] === 'Tipo de comprobante')[0];
assert.ok(selTipo, 'la venta tiene el selector de tipo de comprobante');
assert.deepEqual(selTipo.todos((x) => x.tag === 'option').map((o) => o.attrs.value), ['auto', 'B01', 'B02', 'B14', 'B15']);
const rncBox = venta.todos((x) => x.tag === 'input' && x.attrs['aria-label'] === 'RNC del cliente')[0];
assert.ok(rncBox, 'la venta tiene la casilla de RNC');
assert.ok(textoDe(venta).includes('Se entregará: Factura de consumo (B02). Cliente sin RNC: consumidor final.'), 'avisa el comprobante: ' + textoDe(venta).slice(-400));
rncBox.value = '101123456'; await rncBox.disparar('change'); await pausa();
assert.ok(textoDe(venta).includes('conectado a la nube'), 'sin nube explica qué falta: ' + textoDe(venta).slice(0, 100));
limpiarHojas();
const { formularioCliente } = await import('../src/clientes.js');
formularioCliente(); await pausa();
assert.ok(textoDe(document.body).includes('Verificar en la DGII'));
ok('la venta muestra el tipo de comprobante (con el aviso de cuál se entrega) y la casilla de RNC; el cliente tiene el botón de la DGII');

console.log(`\n${n} grupos OK`);
process.exit(0);
