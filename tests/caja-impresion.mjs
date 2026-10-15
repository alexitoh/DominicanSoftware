// Prueba de la cola de caja y la impresión (DOM simulado): el cajero cobra lo que envía el vendedor y el ticket de 80 mm sale solo.
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
  async disparar(t, extra = {}) { for (const f of this.oyentes[t] || []) await f({ target: this, preventDefault() {}, ...extra }); }
  todos(f, out = []) { for (const x of this.hijos) { if (x.nodeType === 1) { if (f(x)) out.push(x); x.todos(f, out); } } return out; }
  querySelectorAll(s) { const t = s.replace(/[^a-z]/g, ''); return this.todos((x) => x.tag === t); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  click() { return this.disparar('click'); }
  scrollIntoView() {}
  focus() {}
  get texto() { return [this.textContent, ...this.hijos].filter((x) => x !== '').map((x) => (typeof x === 'string' ? x : x.texto)).join(' '); }
}
class Txt { constructor(t) { this.nodeType = 3; this.texto = t; this.parentElement = null; } remove() { if (this.parentElement) this.parentElement.hijos = this.parentElement.hijos.filter((x) => x !== this); } }
const impresiones = []; // lo que se mandó a imprimir
globalThis.document = {
  addEventListener() {}, visibilityState: 'visible', documentElement: {}, getElementById: () => null, body: new Nodo('body'), createTextNode: (t) => new Txt(t),
  createElement: (t) => {
    const n = new Nodo(t);
    if (t === 'iframe') {
      let html = '';
      n.contentWindow = { document: { open() { html = ''; }, write(x) { html += x; }, close() {} }, focus() {}, print() { impresiones.push(html); } };
    }
    return n;
  },
};
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.history = { state: null, pushState() {}, back() {} };
globalThis.location = { hash: '', reload() {} };

const bd = await import('../src/database.js');
const auth = await import('../src/auth.js');
const imp = await import('../src/impresion.js');
const { vistaCaja } = await import('../src/caja.js');
imp.fijarImpresionDirecta(true); // la impresión directa solo existe en el navegador
await bd.initDB();
let n = 0; const ok = (t) => { n++; console.log(`  ✔ ${t}`); };
console.log('Caja e impresión (DOM simulado)');
const pausa = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const hoja = () => document.body.todos((x) => x.attrs.role === 'dialog').pop();
const porAria = (a) => hoja().todos((x) => x.attrs['aria-label'] === a)[0];
const boton = (txt) => hoja().todos((x) => x.tag === 'button' && x.texto.includes(txt))[0];

// 1. Impresoras de esta computadora: sin permiso de Caja no se agrega la de 80 mm
imp.agregarImpresora({ nombre: 'HP LaserJet', tipo: 'normal' });
assert.throws(() => imp.agregarImpresora({ nombre: 'EPSON TM-T20', tipo: 'pos80' }), /caja, gerencia o administración/);
await auth.registrarPropietario({ negocio: 'Prueba', nombre: 'Admin', usuario: 'admin', correo: 'a@b.com', clave: 'Clave-segura-123' });
await auth.iniciarSesion('admin', 'Clave-segura-123');
imp.agregarImpresora({ nombre: 'EPSON TM-T20', tipo: 'pos80' });
imp.agregarImpresora({ nombre: 'Brother Oficina', tipo: 'normal' });
assert.equal(imp.predeterminada('pos80').nombre, 'EPSON TM-T20');
assert.equal(imp.predeterminada('normal').nombre, 'HP LaserJet', 'la primera que se agrega queda predeterminada');
imp.predeterminar(imp.impresorasDe('normal').find((x) => x.nombre === 'Brother Oficina').id);
assert.deepEqual(imp.impresorasDe('normal').map((x) => x.nombre), ['Brother Oficina', 'HP LaserJet'], 'la predeterminada sale primero');
assert.throws(() => imp.agregarImpresora({ nombre: 'epson tm-t20', tipo: 'pos80' }), /ya está agregada/);
ok('las impresoras se guardan por computadora; la de 80 mm solo la agrega caja/gerencia/administración y la predeterminada sale primero');

// 2. Datos de prueba: producto, secuencia de NCF, caja abierta y una venta enviada a caja
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('itbis_modo','adicional')");
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('negocio_nombre','Audio <Pro>')");
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('negocio_logo','data:image/png;base64,iVBORw0KGgo=')");
await bd.ejecutar("INSERT OR REPLACE INTO config (clave, valor) VALUES ('negocio_telefono','809-555-1234')");
await bd.guardarSecuenciaNCF('B02', 1, 50);
await bd.ejecutar("INSERT INTO productos (nombre, precio, costo, stock_actual, activo) VALUES ('Bocina 6x9', 1000, 600, 5, 1)");
const [prod] = await bd.consultar("SELECT id FROM productos WHERE nombre = 'Bocina 6x9'");
await bd.abrirCaja(500);
const ticket = await bd.enviarACaja({ cliente_nombre: 'Pedro', items: [{ producto_id: prod.id, cantidad: 2, precio_unitario: 1000, garantia_meses: 6 }], servicios: [{ descripcion: 'Instalación <b>', cantidad: 1, precio_unitario: 300 }] });
assert.match(ticket, /^T-\d{4}$/);
await assert.rejects(() => bd.enviarACaja({ items: [{ producto_id: prod.id, cantidad: 99, precio_unitario: 1 }] }), /Stock insuficiente/);
await assert.rejects(() => bd.cobrarPendiente(1, { metodo_pago: 'credito' }), /forma de pago/);
ok('el vendedor envía la venta a caja: no hay factura, ni NCF, ni descuento de inventario todavía');

// 3. Pantalla de Caja: aparece "Por cobrar" y el cajero cobra; el ticket de 80 mm sale solo
const raiz = new Nodo('div'); document.body.append(raiz);
await vistaCaja(raiz); await pausa();
assert.match(raiz.texto, /Por cobrar \(1\)/);
assert.match(raiz.texto, new RegExp(ticket));
await raiz.todos((x) => x.tag === 'button' && x.className === 'fila inventario' && x.texto.includes(ticket))[0].click(); await pausa();
assert.match(hoja().texto, /Pedro/);
porAria('Forma de pago').value = 'efectivo'; await porAria('Forma de pago').disparar('change');
const rec = porAria('Efectivo recibido'); rec.value = '3000'; await rec.disparar('input');
assert.match(hoja().texto, /Cambio: .*286/);
rec.value = '100'; await rec.disparar('input');
await boton('Cobrar e imprimir').click(); await pausa();
assert.match(hoja().texto, /menor que el total/, 'no deja cobrar con efectivo insuficiente');
rec.value = '3000'; await rec.disparar('input');
await boton('Cobrar e imprimir').click(); await pausa(400);
const [venta] = await bd.consultar('SELECT * FROM ventas ORDER BY id DESC LIMIT 1');
assert.equal(venta.metodo_pago, 'efectivo'); assert.equal(venta.total, 2714); // 2300 + ITBIS 18 % sobre 2300 (414)
assert.match(venta.ncf, /^B02/);
assert.equal(venta.usuario_id, (await bd.consultar("SELECT id FROM usuarios WHERE usuario = 'admin'"))[0].id);
assert.equal(venta.cajero_id, venta.usuario_id);
assert.equal((await bd.consultar('SELECT stock_actual FROM productos WHERE id = ?', [prod.id]))[0].stock_actual, 3);
assert.equal(impresiones.length, 1, 'el ticket salió una sola vez y sin preguntar la impresora');
const t = impresiones[0];
assert.match(t, /size: 80mm auto/); assert.match(t, /Audio &lt;Pro&gt;/, 'el nombre se escapa'); assert.match(t, /Instalación &lt;b&gt;/);
assert.match(t, new RegExp(venta.ncf)); assert.match(t, /Recibido/); assert.match(t, /Cambio/); assert.match(t, /Garantía 6 meses, hasta/);
assert.match(t, /<img class="logo" src="data:image\/png/, 'el ticket lleva el logo'); assert.match(t, /Tel\. 809-555-1234/); assert.match(t, /FACTURA DE CONSUMO/i); assert.match(t, /Gracias por su compra\./);
assert.match(raiz.texto, /Por cobrar\s*$|Por cobrar(?!\s*\()/, 'ya no hay ventas por cobrar');
ok('el cajero elige la forma de pago, cobra, nace la factura con NCF y el ticket de 80 mm sale solo con recibido y cambio');

// 4. Factura a crédito: sale en hoja normal y se elige la impresora (la predeterminada primero)
await bd.ejecutar("INSERT INTO clientes (nombre, condicion, dias_credito) VALUES ('Taller Ruiz', 'credito', 30)");
const [cli] = await bd.consultar("SELECT id FROM clientes WHERE nombre = 'Taller Ruiz'");
const numCred = await bd.registrarVenta({ cliente_id: cli.id, metodo_pago: 'credito', items: [{ producto_id: prod.id, cantidad: 1, precio_unitario: 1000 }] });
const [vc] = await bd.consultar('SELECT id FROM ventas WHERE numero = ?', [numCred]);
const pend = imp.imprimirCredito(vc.id); await pausa(100);
assert.match(hoja().attrs['aria-label'], /Imprimir factura/);
const selImp = porAria('Impresora');
assert.equal(selImp.value, imp.predeterminada('normal').id, 'la impresora predeterminada viene elegida');
assert.match(selImp.todos((x) => x.tag === 'option')[0].texto, /Brother Oficina \(predeterminada\)/);
await boton('Imprimir').click(); await pend; await pausa(400);
assert.equal(impresiones.length, 2);
assert.match(impresiones[1], /<img class="logo"/); assert.match(impresiones[1], /Garantía|Comprobante/); assert.doesNotMatch(impresiones[1], /size: 80mm/); assert.match(impresiones[1], /Taller Ruiz/); assert.match(impresiones[1], /Saldo pendiente/);
ok('la factura a crédito sale del vendedor en impresora normal (A4), eligiendo la impresora con la predeterminada primero');

// 5. Dos cajeros no cobran la misma venta
const t2 = await bd.enviarACaja({ cliente_nombre: 'Luis', items: [{ producto_id: prod.id, cantidad: 1, precio_unitario: 1000 }] });
const [p2] = await bd.consultar("SELECT id FROM ventas_pendientes WHERE numero = ?", [t2]);
await bd.cancelarPendiente(p2.id);
await assert.rejects(() => bd.cobrarPendiente(p2.id, { metodo_pago: 'efectivo' }), /cancelada/);
assert.equal((await bd.listarPendientes()).length, 0);
ok('una venta cancelada no se puede cobrar y sale de la lista');

// 6. El cajero no ve el cuadre ni cierra la caja; Contabilidad sí
const { vistaCuadreCaja } = await import('../src/caja.js');
const rc = new Nodo('div'); document.body.append(rc);
await vistaCaja(rc); await pausa();
for (const t of ['esperado', 'Cerrar caja', 'Cierres anteriores', 'Cuadre de caja']) assert.ok(!rc.texto.includes(t), 'el cajero no debe ver: ' + t);
assert.ok(rc.texto.includes('Registrar gasto'));
const rq = new Nodo('div'); document.body.append(rq);
await vistaCuadreCaja(rq); await pausa();
assert.ok(rq.texto.includes('Efectivo esperado en caja') && rq.texto.includes('Cerrar caja'));
const cerrar = rq.todos((x) => x.tag === 'button' && x.texto.includes('Cerrar caja'))[0];
assert.ok(cerrar);
ok('el cajero no ve el cuadre ni el cierre; la vista de Contabilidad muestra el cuadre y el botón de cerrar caja');

// 7. Categorías del negocio: crear, renombrar y eliminar (sembradas una sola vez)
const cats0 = await bd.listarCategorias();
assert.equal(cats0.length, 6, 'las 6 de ejemplo se siembran en una base nueva');
const idNueva = await bd.crearCategoria('  Luces   LED ');
await assert.rejects(() => bd.crearCategoria('luces led'), /ya existe/);
await assert.rejects(() => bd.crearCategoria('  '), /Escribe/);
await bd.renombrarCategoria(idNueva, 'Luces');
await bd.ejecutar('UPDATE productos SET categoria_id = ? WHERE id = ?', [idNueva, prod.id]);
const [conProd] = (await bd.listarCategorias()).filter((c) => c.id === idNueva);
assert.equal(conProd.nombre, 'Luces'); assert.equal(conProd.productos, 1);
await bd.eliminarCategoria(idNueva);
assert.equal((await bd.listarCategorias()).length, 6);
assert.equal((await bd.consultar('SELECT categoria_id c FROM productos WHERE id = ?', [prod.id]))[0].c, null, 'el producto queda sin categoría');
const baja = (await bd.listarCategorias()).find((c) => c.nombre === 'Bocinas');
await bd.eliminarCategoria(baja.id);
assert.equal((await bd.listarCategorias()).length, 5, 'una categoría de ejemplo también se puede eliminar');
ok('las categorías se crean, renombran y eliminan; sus productos quedan sin categoría');

if (process.env.VOLCAR_IMPRESIONES) { const fs = await import('node:fs'); impresiones.forEach((h, i) => fs.writeFileSync(`${process.env.VOLCAR_IMPRESIONES}/impresion-${i}.html`, h)); }
console.log(`\n${n} comprobaciones correctas`);
process.exit(0);
