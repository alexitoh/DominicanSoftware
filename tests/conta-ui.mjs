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
const { vistaCajaChica } = await import('../src/conta-ui-cajachica.js');
const { vistaReportes } = await import('../src/conta-ui-reportes.js');
const r2c = (x) => Math.round(x * 100) / 100;
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
assert.equal(tabs.length, 15);
for (const t of tabs) {
  await pulsar(t);
  const cuerpo = textoDe(raiz);
  assert.ok(!cuerpo.includes('No se pudo cargar'), `${t.texto}: ${cuerpo.slice(0, 200)}`);
  assert.ok(cuerpo.length > 20, `${t.texto} está vacía`);
}
ok('las 15 pestañas se pintan sin errores');

// Reportes: recorre todos los tipos
const rr = new Nodo('div');
await vistaReportes(rr); await pausa();
const select = rr.todos((x) => x.tag === 'select')[0];
for (const opt of select.todos((x) => x.tag === 'option')) {
  select.value = opt.attrs.value; await select.disparar('change'); await pausa();
  assert.ok(!textoDe(rr).includes('NaN') && !textoDe(rr).includes('undefined'), `Reporte ${opt.attrs.value}: ${textoDe(rr).slice(0, 300)}`);
}
select.value = 'impuestos'; await select.disparar('change'); await pausa();
assert.ok(textoDe(rr).includes('Formato 608') && textoDe(rr).includes('Formato 607'), 'Impuestos vive dentro de los reportes de contabilidad');
ok('los 10 reportes (incluido Impuestos) se pintan sin NaN ni undefined');

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
// Las cinco secciones de Activos fijos abren, con el activo creado en la lista
for (const [seccion, texto] of [['Depreciación', 'Depreciación de'], ['Reportes AF', 'Reporte'], ['Retiro', 'Activos retirados'], ['Revalorización', 'Revalorizaciones hechas'], ['Tasa de Inflación', 'Nueva tasa de inflación'], ['Tipo de Activo Fijo', 'Nuevo tipo de activo'], ['Tipo de Depreciación', 'Nuevo tipo de depreciación'], ['Activo Fijo', 'Nuevo activo fijo']]) {
  const tab = rac.todos((x) => x.tag === 'button' && x.attrs.role === 'tab' && x.texto.includes(seccion))[0];
  assert.ok(tab, 'falta la sección ' + seccion);
  await pulsar(tab); await pausa();
  assert.ok(textoDe(rac).includes(texto), `la sección ${seccion} debe mostrar "${texto}"`);
  if (/Inflación|Tipo de/.test(seccion)) await pulsar(boton(rac, texto)); // abre el formulario de alta
}
// Caja chica: sus cuatro secciones abren y el flujo crear caja -> desembolso -> reposición funciona desde la interfaz
const rcc = new Nodo('div'); await vistaCajaChica(rcc); await pausa();
for (const [seccion, texto] of [['Desembolso', 'Primero crea una caja chica'], ['Reporte Caja Chica', 'Primero crea una caja chica'], ['Reposición', 'Primero crea una caja chica'], ['Caja Chica', 'Nueva caja chica']]) {
  const tab = rcc.todos((x) => x.tag === 'button' && x.attrs.role === 'tab' && x.texto.includes(seccion))[0];
  assert.ok(tab, 'falta la sección ' + seccion);
  await pulsar(tab); await pausa();
  assert.ok(textoDe(rcc).includes(texto), `la sección ${seccion} debe mostrar "${texto}"`);
}
await pulsar(boton(rcc, 'Nueva caja chica'));
await cd.guardarCajaChica({ nombre: 'Taller', custodio: 'Luis', fondo: 2000, fecha: '2026-03-01' });
await cd.registrarDesembolso({ caja_chica_id: (await cd.listarCajasChicas())[0].id, fecha: '2026-03-02', concepto: 'Tornillos', monto: 150 });
for (const [seccion, texto] of [['Desembolso', 'Registrar desembolso'], ['Reposición', 'Hacer reposición'], ['Reporte Caja Chica', 'Desembolsos por categoría'], ['Caja Chica', 'Taller']]) {
  const tab = rcc.todos((x) => x.tag === 'button' && x.attrs.role === 'tab' && x.texto.includes(seccion))[0];
  await pulsar(tab); await pausa();
  assert.ok(textoDe(rcc).includes(texto), `con una caja creada, ${seccion} debe mostrar "${texto}"`);
}
const rn = new Nodo('div'); await vistaNomina(rn); await pausa();
await pulsar(boton(rn, 'Nueva nómina')); await pulsar(boton(rn, 'Parámetros')); await pulsar(boton(rn, 'Nuevo empleado'));
await pulsar(rn.todos((x) => x.className.includes('fila'))[0]);
assert.ok(!textoDe(document.body).includes('undefined'));
ok('formularios y detalles de catálogo, bancos, activos y nómina abren sin errores');

// Gastos, tipos de pago, diarios cancelados, conceptos y períodos: abren y funcionan desde la interfaz
limpiarHojas();
const { vistaGastos } = await import('../src/conta-ui-gastos.js');
const { vistaDiarios } = await import('../src/conta-ui-diarios.js');
const { vistaPeriodos } = await import('../src/conta-ui-periodos.js');
const secc = async (r, nombre) => { const t = r.todos((x) => x.tag === 'button' && x.attrs.role === 'tab' && x.texto.includes(nombre))[0]; assert.ok(t, 'falta ' + nombre); await pulsar(t); await pausa(); };
const rg = new Nodo('div'); await vistaGastos(rg); await pausa();
await secc(rg, 'Tipo de Pago');
assert.ok(textoDe(rg).includes('Efectivo'), 'los tipos de pago sembrados aparecen');
await pulsar(boton(rg, 'Nuevo tipo de pago'));
assert.ok(textoDe(document.body).includes('Método base'));
limpiarHojas();
await secc(rg, 'Gastos');
await pulsar(boton(rg, 'Nuevo gasto'));
const fg = document.body.hijos.at(-1);
fg.todos((x) => x.tag === 'input' && x.attrs.placeholder?.startsWith('Ej. Pago de alquiler'))[0].value = 'Pago de luz';
const mt = fg.todos((x) => x.tag === 'input' && x.attrs.type === 'number'); mt[0].value = '1200';
await pulsar(boton(fg, 'Guardar gasto'));
assert.ok(textoDe(rg).includes('Pago de luz'), 'el gasto aparece en la lista: ' + textoDe(fg).slice(-300));
await secc(rg, 'Reportes de Gasto');
assert.ok(textoDe(rg).includes('Total de gastos') && !textoDe(rg).includes('NaN'), textoDe(rg).slice(0, 500));
limpiarHojas();
await secc(rg, 'Gastos');
await pulsar(rg.todos((x) => x.className.includes('fila'))[0]);
const dg = document.body.hijos.at(-1);
dg.todos((x) => x.tag === 'input' && x.attrs.placeholder === 'Motivo de la anulación')[0].value = 'Duplicado';
await pulsar(boton(dg, 'Anular gasto'));
assert.ok(textoDe(rg).includes('anulado'), 'el gasto anulado se marca');
limpiarHojas();
const rd = new Nodo('div'); await vistaDiarios(rd); await pausa();
await secc(rd, 'Concepto');
await pulsar(boton(rd, 'Nuevo concepto'));
assert.ok(textoDe(document.body).includes('Se usa en'));
limpiarHojas();
await secc(rd, 'Diarios Cancelados');
assert.ok(textoDe(rd).includes('Diarios Cancelados') || textoDe(rd).includes('No hay diarios cancelados') || textoDe(rd).includes('Asientos manuales anulados'));
await secc(rd, 'Diario');
const rp = new Nodo('div'); await vistaPeriodos(rp); await pausa();
assert.ok(textoDe(rp).includes('Enero') && textoDe(rp).includes('Cerrar'));
await secc(rp, 'Período Fiscal');
assert.ok(textoDe(rp).includes('606') && textoDe(rp).includes('IT1') && textoDe(rp).includes('confírmalos con la DGII'));
await pulsar(boton(rp, '606'));
assert.ok(textoDe(document.body).includes('Marcar presentada'));
limpiarHojas();
ok('Gastos (crear/anular), Tipo de Pago, Reportes de Gasto, Concepto, Diarios Cancelados y Períodos abren y funcionan');

// CxC: las 10 secciones abren y el flujo de notas, anticipos y créditos funciona desde la interfaz
limpiarHojas();
const { vistaCxc } = await import('../src/cxc.js');
const cx = await import('../src/cxc-db.js');
await bd.ejecutar("INSERT INTO productos (codigo, nombre, costo, precio, stock_actual) VALUES ('CX-1', 'Amplificador', 1000, 2000, 10)");
const pCx = (await bd.consultar("SELECT id FROM productos WHERE codigo = 'CX-1'"))[0].id;
await bd.ejecutar("INSERT INTO clientes (nombre, condicion, dias_credito) VALUES ('Cliente CxC', 'credito', 30)");
const cCx = (await bd.consultar("SELECT id FROM clientes WHERE nombre = 'Cliente CxC'"))[0].id;
await bd.registrarVenta({ cliente_id: cCx, metodo_pago: 'credito', items: [{ producto_id: pCx, cantidad: 1, precio_unitario: 2000 }] });
const rcx = new Nodo('div'); await vistaCxc(rcx); await pausa();
const SECCIONES_ESPERADAS = ['Cliente', 'Descuento y Devolución', 'Nota de Crédito', 'Nota de Débito', 'Recibo', 'Anticipo CxC', 'Condición de Pago', 'Reporte CxC', 'Reporte Dinámico', 'Tipo de Cliente'];
const tabsCx = rcx.todos((x) => x.tag === 'button' && x.attrs.role === 'tab');
assert.deepEqual(tabsCx.map((t) => t.texto.trim()), SECCIONES_ESPERADAS);
const verSeccion = async (nombre) => { await pulsar(rcx.todos((x) => x.tag === 'button' && x.attrs.role === 'tab' && x.texto.trim() === nombre)[0]); const t = textoDe(rcx); assert.ok(!t.includes('No se pudo cargar') && !t.includes('NaN') && !t.includes('undefined'), `${nombre}: ${t.slice(0, 300)}`); return t; };
for (const sec of SECCIONES_ESPERADAS) await verSeccion(sec);
ok('CxC tiene las 10 secciones y todas se pintan sin errores');
// Cliente: estado de cuenta y crédito
await verSeccion('Cliente');
assert.ok(textoDe(rcx).includes('Cliente CxC'));
await pulsar(rcx.todos((x) => x.className.includes('fila') && x.texto.includes('Cliente CxC'))[0]);
let hj2 = document.body.hijos.at(-1);
assert.ok(textoDe(hj2).includes('Guardar crédito') && textoDe(hj2).includes('Facturas pendientes') && textoDe(hj2).includes('Nuevo recibo'));
const selCond = hj2.todos((x) => x.tag === 'select' && x.attrs['aria-label'] === 'Condición de pago')[0];
selCond.value = String((await cx.listarCondiciones()).find((k) => k.dias === 60).id);
hj2.todos((x) => x.tag === 'input' && x.attrs['aria-label'] === 'Límite de crédito')[0].value = '8000';
await pulsar(boton(hj2, 'Guardar crédito'));
const cRow = (await bd.consultar('SELECT condicion, dias_credito, limite_credito FROM clientes WHERE id = ?', [cCx]))[0];
assert.deepEqual([cRow.condicion, cRow.dias_credito, cRow.limite_credito], ['credito', 60, 8000]);
limpiarHojas();
ok('el crédito del cliente (condición y límite) se guarda desde CxC → Cliente');
// Nota de crédito desde la pantalla
await verSeccion('Nota de Crédito');
await pulsar(boton(rcx, 'Nueva nota de crédito'));
hj2 = document.body.hijos.at(-1);
const montos = hj2.todos((x) => x.tag === 'input' && x.attrs.type === 'number'); montos[0].value = '250';
await pulsar(boton(hj2, 'Guardar nota'));
assert.ok(textoDe(rcx).includes('NC-') && textoDe(rcx).includes('Cliente CxC'), 'la nota aparece: ' + textoDe(rcx).slice(0, 400));
assert.equal(r2c((await bd.facturasPendientes(cCx))[0].saldo), 1750);
limpiarHojas();
// Nota de débito
await verSeccion('Nota de Débito');
await pulsar(boton(rcx, 'Nueva nota de débito'));
hj2 = document.body.hijos.at(-1);
hj2.todos((x) => x.tag === 'input' && x.attrs.type === 'number')[0].value = '100';
await pulsar(boton(hj2, 'Guardar nota'));
assert.ok(textoDe(rcx).includes('ND-'));
assert.equal(r2c((await bd.facturasPendientes(cCx))[0].saldo), 1850);
limpiarHojas();
// Anticipo: crear y aplicar
await verSeccion('Anticipo CxC');
await pulsar(boton(rcx, 'Nuevo anticipo'));
hj2 = document.body.hijos.at(-1);
hj2.todos((x) => x.tag === 'input' && x.attrs.type === 'number')[0].value = '600';
await pulsar(boton(hj2, 'Guardar anticipo'));
assert.ok(textoDe(rcx).includes('AN-') && textoDe(rcx).includes('600'), textoDe(rcx).slice(0, 300));
limpiarHojas();
await pulsar(rcx.todos((x) => x.className.includes('fila') && x.texto.includes('AN-'))[0]);
hj2 = document.body.hijos.at(-1);
hj2.todos((x) => x.tag === 'input' && x.attrs.type === 'number')[0].value = '400';
await pulsar(boton(hj2, 'Aplicar'));
assert.equal(r2c((await bd.facturasPendientes(cCx))[0].saldo), 1450);
limpiarHojas();
ok('notas de crédito y débito y anticipos (crear y aplicar) funcionan desde la pantalla y mueven el saldo');
// Reportes
await verSeccion('Reporte CxC');
assert.ok(textoDe(rcx).includes('Cliente CxC') && textoDe(rcx).includes('Total por cobrar'));
await pulsar(boton(rcx, 'Ver detalle de facturas')); assert.ok(textoDe(rcx).includes('Atraso'));
await verSeccion('Reporte Dinámico');
const dimSel = rcx.todos((x) => x.tag === 'select' && x.attrs['aria-label'] === 'Agrupar por')[0];
for (const o of dimSel.todos((x) => x.tag === 'option')) { dimSel.value = o.attrs.value; await dimSel.disparar('change'); await pausa(); assert.ok(!textoDe(rcx).includes('NaN') && !textoDe(rcx).includes('undefined'), 'dinámico ' + o.attrs.value); }
assert.ok(textoDe(rcx).includes('Neto'));
// Catálogos
await verSeccion('Tipo de Cliente'); await pulsar(boton(rcx, 'Nuevo tipo de cliente')); assert.ok(textoDe(document.body).includes('Descuento sugerido')); limpiarHojas();
await verSeccion('Condición de Pago'); await pulsar(boton(rcx, 'Nueva condición de pago')); assert.ok(textoDe(document.body).includes('Días para pagar')); limpiarHojas();
await verSeccion('Descuento y Devolución'); await pulsar(boton(rcx, 'Nuevo motivo')); assert.ok(textoDe(document.body).includes('Porcentaje sugerido')); limpiarHojas();
await verSeccion('Recibo'); assert.ok(textoDe(rcx).includes('Nuevo recibo'));
ok('reportes CxC y dinámico, y los catálogos (tipo de cliente, condición, motivos) abren sin errores');

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
assert.ok(textoDe(venta).includes('Se entregará: Factura de consumo (B02), cliente sin RNC: consumidor final.'), 'avisa el comprobante: ' + textoDe(venta).slice(-400));
rncBox.value = '101123456'; await rncBox.disparar('change'); await pausa();
assert.ok(textoDe(venta).includes('conectado a la nube'), 'sin nube explica qué falta: ' + textoDe(venta).slice(0, 100));
limpiarHojas();
const { formularioCliente } = await import('../src/clientes.js');
formularioCliente(); await pausa();
assert.ok(textoDe(document.body).includes('Verificar en la DGII') && textoDe(document.body).includes('Se le dará: Factura de consumo (B02)'));
ok('la venta muestra el tipo de comprobante (con el aviso de cuál se entrega) y la casilla de RNC; el cliente tiene el botón de la DGII');

console.log(`\n${n} grupos OK`);
process.exit(0);
