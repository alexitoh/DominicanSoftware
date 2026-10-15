// impresion.js - impresoras de esta computadora, ticket de 80 mm (contado) y factura en hoja normal (crédito).
// Un navegador no puede elegir ni "ver" las impresoras de Windows por su cuenta: el sistema guarda las impresoras que
// agregues en ESTA computadora (nombre y tipo), te deja escoger antes de imprimir y arma el documento con el formato correcto.
// Para que el ticket salga sin ninguna ventana, la computadora del cajero abre Chrome en modo "kiosk-printing" y deja la
// impresora de 80 mm como predeterminada de Windows (ver LEEME).
import { consultar, esWeb } from './database.js';
import { h, hoja, toast, dinero } from './ui.js';
import { tienePermiso } from './auth.js';
import { traducir, getIdioma } from './i18n.js';
import { NOMBRE_COMPROBANTE } from './itbis.js';
import { textoDocumento } from './fiscal.js';

// En el navegador se imprime directo; en la app Android se comparte el PDF (las pruebas fuerzan el modo navegador)
let impresionDirecta = esWeb;
export const fijarImpresionDirecta = (v) => { impresionDirecta = !!v; };

export const TIPOS_IMPRESORA = { normal: 'Impresora normal (hoja carta / A4)', pos80: 'Punto de venta 80 mm' };
const K = 'caraudio_impresoras';

// ---------- Impresoras guardadas en esta computadora ----------
export function leerImpresoras() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem(K) || 'null'); } catch { c = null; }
  const lista = Array.isArray(c?.lista) ? c.lista.filter((x) => x?.id && x.nombre && TIPOS_IMPRESORA[x.tipo]) : [];
  const pred = { normal: null, pos80: null, ...(c?.pred || {}) };
  for (const t of Object.keys(TIPOS_IMPRESORA)) if (!lista.some((x) => x.id === pred[t] && x.tipo === t)) pred[t] = lista.find((x) => x.tipo === t)?.id || null;
  return { lista, pred, auto80: c?.auto80 !== false };
}
function guardar(c) { try { localStorage.setItem(K, JSON.stringify(c)); } catch { /* sin almacenamiento: no se recuerdan */ } }

// Impresoras de un tipo con la predeterminada primero
export function impresorasDe(tipo) {
  const c = leerImpresoras();
  return c.lista.filter((x) => x.tipo === tipo).sort((a, b) => (b.id === c.pred[tipo]) - (a.id === c.pred[tipo]));
}
export const predeterminada = (tipo) => impresorasDe(tipo).find((x) => x.id === leerImpresoras().pred[tipo]) || null;

export function agregarImpresora({ nombre, tipo }) {
  const n = String(nombre || '').trim().slice(0, 60);
  if (!n) throw new Error('Escribe el nombre de la impresora, tal como aparece en Windows.');
  if (!TIPOS_IMPRESORA[tipo]) throw new Error('Elige el tipo de impresora.');
  if (tipo === 'pos80' && !tienePermiso('caja')) throw new Error('Solo caja, gerencia o administración pueden agregar la impresora de 80 mm.');
  const c = leerImpresoras();
  if (c.lista.some((x) => x.tipo === tipo && x.nombre.toLowerCase() === n.toLowerCase())) throw new Error('Esa impresora ya está agregada.');
  const nueva = { id: `i${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, nombre: n, tipo };
  c.lista.push(nueva);
  if (!c.pred[tipo]) c.pred[tipo] = nueva.id;
  guardar(c);
  return nueva;
}
export function quitarImpresora(id) {
  const c = leerImpresoras();
  const x = c.lista.find((i) => i.id === id);
  if (x?.tipo === 'pos80' && !tienePermiso('caja')) throw new Error('Solo caja, gerencia o administración pueden quitar la impresora de 80 mm.');
  c.lista = c.lista.filter((i) => i.id !== id);
  guardar(c);
}
export function predeterminar(id) {
  const c = leerImpresoras();
  const x = c.lista.find((i) => i.id === id);
  if (!x) return;
  if (x.tipo === 'pos80' && !tienePermiso('caja')) throw new Error('Solo caja, gerencia o administración pueden cambiar la impresora de 80 mm.');
  c.pred[x.tipo] = id;
  guardar(c);
}
export function fijarAutomatica(valor) {
  if (!tienePermiso('caja')) throw new Error('Solo caja, gerencia o administración pueden cambiar esto.');
  const c = leerImpresoras(); c.auto80 = !!valor; guardar(c);
}

// ---------- Datos de la factura ----------
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const METODOS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque', credito: 'Crédito' };
function fechaLegible(f) {
  const [d, hora] = String(f).split(' ');
  const [a, m, dia] = String(d).split('-');
  return `${dia}/${m}/${a} ${hora?.slice(0, 5) ?? ''}`.trim();
}

export async function cargarFactura(ventaId) {
  const [v] = await consultar(
    `SELECT v.*, c.nombre AS cliente, c.telefono AS cliente_tel, c.tipo_doc AS cliente_tipo_doc, c.documento AS cliente_doc,
            u.nombre AS vendedor, k.nombre AS cajero
       FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id
       LEFT JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN usuarios k ON k.id = v.cajero_id WHERE v.id = ?`, [ventaId]);
  if (!v) throw new Error('La venta no existe');
  const items = await consultar('SELECT d.*, p.nombre FROM venta_detalle d JOIN productos p ON p.id = d.producto_id WHERE d.venta_id = ? ORDER BY d.id', [ventaId]);
  const servicios = await consultar('SELECT * FROM venta_servicios WHERE venta_id = ? ORDER BY id', [ventaId]);
  const [cobro] = await consultar('SELECT vence FROM cuentas_cobrar WHERE venta_id = ?', [ventaId]);
  const garantias = await consultar('SELECT g.*, p.nombre FROM garantias g JOIN productos p ON p.id = g.producto_id WHERE g.venta_id = ? ORDER BY g.id', [ventaId]);
  const cfg = Object.fromEntries((await consultar('SELECT clave, valor FROM config')).map((r) => [r.clave, r.valor]));
  const [{ pagado }] = await consultar('SELECT COALESCE(SUM(monto), 0) AS pagado FROM pagos WHERE venta_id = ?', [ventaId]);
  const lang = cfg.idioma_factura === 'es' || cfg.idioma_factura === 'en' ? cfg.idioma_factura : getIdioma();
  return { v, items, servicios, cobro, garantias, cfg, pagado, L: (t) => traducir(t, lang) };
}

// ---------- Piezas comunes de los formatos ----------
const fechaDD = (f) => String(f || '').split('-').reverse().join('/');
const anuladaMarca = (v, L) => (v.estado === 'anulada'
  ? `<div style="position:fixed;top:40%;left:0;right:0;text-align:center;font:bold 64px Arial,sans-serif;color:rgba(200,64,47,.35);transform:rotate(-25deg)">${esc(L('ANULADA'))}</div>` : '');
const garantiaDe = (f, producto_id) => {
  const g = f.garantias.find((x) => x.producto_id === producto_id);
  return g ? `${f.L('Garantía')} ${g.meses} ${f.L(g.meses === 1 ? 'mes' : 'meses')}, ${f.L('hasta')} ${fechaDD(g.vence)}${g.serie ? `. ${f.L('Serie')}: ${esc(g.serie)}` : ''}` : '';
};

// ---------- Ticket de punto de venta 80 mm (facturas al contado) ----------
export function ticket80HTML(f, { recibido = null } = {}) {
  const { v, items, servicios, cfg, L } = f;
  const itbisSumado = v.itbis > 0 && Math.abs(v.total - (v.subtotal - v.descuento) - v.itbis) < 0.01;
  const tipoCpb = v.ncf ? NOMBRE_COMPROBANTE[String(v.ncf).slice(0, 3)] : null;
  const par = (a, b, clase = '') => `<div class="par ${clase}"><span>${esc(a)}</span><span>${esc(b)}</span></div>`;
  const cambio = recibido != null && recibido >= v.total ? Math.round((recibido - v.total) * 100) / 100 : null;
  const lineas = [
    ...items.map((i) => ({ n: i.nombre, c: i.cantidad, p: i.precio_unitario, t: i.cantidad * i.precio_unitario - (i.descuento || 0), g: garantiaDe(f, i.producto_id) })),
    ...servicios.map((sv) => ({ n: sv.descripcion, c: sv.cantidad, p: sv.precio_unitario, t: sv.cantidad * sv.precio_unitario, g: '' })),
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(v.numero)}</title><style>
@page { size: 80mm auto; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { width: 72mm; padding: 3mm 3mm 8mm; font: 12px/1.35 Arial, Helvetica, sans-serif; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.c { text-align: center; } .b { font-weight: bold; } .gris { color: #333; }
.logo { display: block; margin: 0 auto 3px; max-width: 46mm; max-height: 20mm; filter: grayscale(1) contrast(1.6); }
.neg { font-size: 17px; font-weight: bold; margin: 2px 0; }
.par { display: flex; justify-content: space-between; gap: 6px; } .par span:last-child { text-align: right; white-space: nowrap; }
hr { border: 0; border-top: 1px solid #000; margin: 5px 0; } hr.p { border-top: 1px dashed #000; }
.tipo { font-size: 11px; letter-spacing: .5px; text-transform: uppercase; margin-top: 4px; }
.num { font-size: 16px; font-weight: bold; }
.cab { background: #000; color: #fff; padding: 2px 4px; font-weight: bold; margin: 4px 0 2px; }
.it { margin: 3px 0 4px; } .it .n { font-weight: bold; } .it small { display: block; font-size: 10px; color: #333; }
.total { border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 3px 0; margin: 4px 0; font-size: 16px; font-weight: bold; }
.gracias { margin-top: 8px; font-size: 11px; }
</style></head><body>
${cfg.negocio_logo ? `<img class="logo" src="${esc(cfg.negocio_logo)}" alt="">` : ''}
<div class="c neg">${esc(cfg.negocio_nombre || 'Mi negocio')}</div>
<div class="c gris">${cfg.negocio_rnc ? `RNC ${esc(cfg.negocio_rnc)}<br>` : ''}${cfg.negocio_telefono ? `Tel. ${esc(cfg.negocio_telefono)}<br>` : ''}${esc(cfg.negocio_direccion || '')}</div>
<hr>
<div class="c tipo gris">${esc(L(tipoCpb || 'FACTURA'))}</div>
<div class="c num">${esc(v.numero)}</div>
${v.ncf ? `<div class="c b">NCF ${esc(v.ncf)}</div>` : ''}
<hr class="p">
${par(L('Fecha'), fechaLegible(v.fecha))}
${par(L('Cliente'), v.cliente || v.cliente_nombre || L('Cliente general'))}
${v.cliente_doc ? `<div>${esc(textoDocumento(v.cliente_tipo_doc, v.cliente_doc))}</div>` : ''}
${v.cliente_tel ? `<div>Tel. ${esc(v.cliente_tel)}</div>` : ''}
${v.vendedor ? par(L('Atendió'), v.vendedor) : ''}
${v.cajero ? par(L('Cajero'), v.cajero) : ''}
<div class="cab par"><span>${esc(L('Descripción'))}</span><span>${esc(L('Importe'))}</span></div>
${lineas.map((l) => `<div class="it"><div class="n">${esc(l.n)}</div>${par(`${l.c} x ${dinero(l.p)}`, dinero(l.t))}${l.g ? `<small>${l.g}</small>` : ''}</div>`).join('')}
<hr class="p">
${par(L('Subtotal'), dinero(v.subtotal))}
${v.descuento > 0 ? par(L('Descuento'), `- ${dinero(v.descuento)}`) : ''}
${itbisSumado ? par(L('ITBIS'), dinero(v.itbis)) : ''}
<div class="total par"><span>${esc(L('TOTAL'))}</span><span>${esc(dinero(v.total))}</span></div>
${v.itbis > 0 && !itbisSumado ? `<div class="c gris">${esc(L('ITBIS incluido'))}: ${esc(dinero(v.itbis))}</div>` : ''}
${par(L('Pago'), L(METODOS[v.metodo_pago] || v.metodo_pago))}
${recibido != null ? par(L('Recibido'), dinero(recibido)) : ''}
${cambio != null ? par(L('Cambio'), dinero(cambio), 'b') : ''}
<div class="c gris gracias">${esc(L('Gracias por su compra.'))}</div>
${anuladaMarca(v, L)}
</body></html>`;
}

// ---------- Factura en hoja normal (ventas a crédito): mismo diseño que la factura en PDF ----------
export function facturaA4HTML(f) {
  const { v, items, servicios, cobro, cfg, pagado, L } = f;
  const itbisSumado = v.itbis > 0 && Math.abs(v.total - (v.subtotal - v.descuento) - v.itbis) < 0.01;
  const tipoCpb = v.ncf ? NOMBRE_COMPROBANTE[String(v.ncf).slice(0, 3)] : null;
  const lineas = [
    ...items.map((i) => ({ n: i.nombre, c: i.cantidad, p: i.precio_unitario, t: i.cantidad * i.precio_unitario - (i.descuento || 0), g: garantiaDe(f, i.producto_id) })),
    ...servicios.map((sv) => ({ n: sv.descripcion, c: sv.cantidad, p: sv.precio_unitario, t: sv.cantidad * sv.precio_unitario, g: '' })),
  ];
  const tot = (a, b, clase = '') => `<div class="tot ${clase}"><span>${esc(a)}</span><span>${esc(b)}</span></div>`;
  const dos = (a, b) => `<div class="dos"><span>${a}</span><span>${b}</span></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(v.numero)}</title><style>
@page { size: auto; margin: 14mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font: 13px/1.45 Helvetica, Arial, sans-serif; color: #15212b; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.hoja { max-width: 175mm; margin: 0 auto; }
.cab { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.marca { display: flex; gap: 14px; align-items: center; }
.logo { max-height: 22mm; max-width: 42mm; object-fit: contain; }
.neg { font-size: 22px; font-weight: bold; line-height: 1.15; }
.gris { color: #5a5a5a; } .der { text-align: right; }
.tipo { font-size: 13px; text-transform: uppercase; color: #5a5a5a; } .num { font-size: 17px; font-weight: bold; }
hr { border: 0; border-top: 1px solid #c8c8c8; margin: 10px 0; }
.dos { display: flex; justify-content: space-between; gap: 12px; margin: 2px 0; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th { background: #edf0f2; text-align: left; padding: 6px 8px; font-size: 12px; } th.d, td.d { text-align: right; }
td { padding: 7px 8px 2px; vertical-align: top; } .gar td { padding: 0 8px 6px 8px; font-size: 10.5px; color: #6e6e6e; }
.fin { border-top: 1px solid #c8c8c8; margin-top: 6px; padding-top: 8px; }
.tot { display: flex; justify-content: flex-end; gap: 40px; margin: 3px 0; } .tot span:last-child { min-width: 110px; text-align: right; }
.tot.g { font-size: 17px; font-weight: bold; margin-top: 8px; } .tot.b { font-weight: bold; }
.gracias { text-align: center; color: #5a5a5a; margin-top: 34px; }
</style></head><body><div class="hoja">
<div class="cab">
  <div class="marca">${cfg.negocio_logo ? `<img class="logo" src="${esc(cfg.negocio_logo)}" alt="">` : ''}
    <div><div class="neg">${esc(cfg.negocio_nombre || 'Mi negocio')}</div>
    <div class="gris">${cfg.negocio_rnc ? `RNC ${esc(cfg.negocio_rnc)}<br>` : ''}${cfg.negocio_telefono ? `Tel. ${esc(cfg.negocio_telefono)}<br>` : ''}${esc(cfg.negocio_direccion || '')}</div></div></div>
  <div class="der"><div class="tipo">${esc(L(tipoCpb || 'FACTURA'))}</div><div class="num">${esc(v.numero)}</div></div>
</div>
<hr>
${dos(esc(`${L('Fecha')}: ${fechaLegible(v.fecha)}`), esc(`${L('Pago')}: ${L(METODOS[v.metodo_pago] || v.metodo_pago)}`))}
${dos(esc(`${L('Cliente')}: ${v.cliente || v.cliente_nombre || L('Cliente general')}`), v.cliente_tel ? esc(`Tel. ${v.cliente_tel}`) : '')}
${v.ncf ? dos(esc(`${L('Comprobante')}: ${L(tipoCpb || '')}`), `NCF: ${esc(v.ncf)}`) : ''}
${v.cliente_doc ? `<div>${esc(textoDocumento(v.cliente_tipo_doc, v.cliente_doc))}</div>` : ''}
${v.vendedor ? `<div>${esc(L('Atendió'))}: ${esc(v.vendedor)}</div>` : ''}
<table><thead><tr><th>${esc(L('Cant.'))}</th><th>${esc(L('Descripción'))}</th><th class="d">${esc(L('Precio'))}</th><th class="d">${esc(L('Importe'))}</th></tr></thead><tbody>
${lineas.map((l) => `<tr><td>${esc(l.c)}</td><td>${esc(l.n)}</td><td class="d">${esc(dinero(l.p))}</td><td class="d">${esc(dinero(l.t))}</td></tr>${l.g ? `<tr class="gar"><td></td><td colspan="3">${l.g}</td></tr>` : ''}`).join('')}
</tbody></table>
<div class="fin">
${tot(L('Subtotal'), dinero(v.subtotal))}
${v.descuento > 0 ? tot(L('Descuento'), `- ${dinero(v.descuento)}`) : ''}
${itbisSumado ? tot(L('ITBIS'), dinero(v.itbis)) : ''}
${tot(L('TOTAL'), dinero(v.total), 'g')}
${v.itbis > 0 && !itbisSumado ? tot(L('ITBIS incluido'), dinero(v.itbis)) : ''}
${v.metodo_pago === 'credito' ? `${tot(L('Abonado'), dinero(pagado))}${tot(L('Saldo pendiente'), dinero(Math.max(0, v.total - pagado)), 'b')}${cobro?.vence ? tot(L('Fecha límite'), fechaDD(cobro.vence)) : ''}` : ''}
</div>
<div class="gracias">${esc(L('Gracias por su compra.'))}</div>
${anuladaMarca(v, L)}
</div></body></html>`;
}

// ---------- Imprimir ----------
// Abre el documento en un marco oculto y manda a imprimir. Con Chrome en modo "kiosk-printing" sale directo a la impresora predeterminada.
export function imprimirHTML(html) {
  return new Promise((ok, fallo) => {
    try {
      const marco = document.createElement('iframe');
      marco.setAttribute('aria-hidden', 'true');
      marco.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.append(marco);
      const d = marco.contentWindow.document;
      d.open(); d.write(html); d.close();
      // Se espera a que cargue el logo (máx. 2 s) antes de imprimir
      const imagenes = [...(d.images || [])].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })));
      Promise.race([Promise.all(imagenes), new Promise((r) => setTimeout(r, 2000))]).then(() => setTimeout(() => {
        try { marco.contentWindow.focus(); marco.contentWindow.print(); ok(true); } catch (e) { fallo(e); }
        setTimeout(() => marco.remove(), 60000);
      }, 250));
    } catch (e) { fallo(e); }
  });
}

// Antes de imprimir se elige la impresora; la predeterminada sale primero. Devuelve { id, nombre } (nombre '' = la del sistema) o null si se cancela.
export function elegirImpresora(tipo) {
  return new Promise((resolver) => {
    const lista = impresorasDe(tipo);
    const sel = h('select', { class: 'campo', 'aria-label': 'Impresora' },
      ...lista.map((x, i) => h('option', { value: x.id }, `${x.nombre}${i === 0 ? ' (predeterminada)' : ''}`)),
      h('option', { value: '' }, 'La predeterminada de Windows'));
    sel.value = lista[0]?.id || '';
    const nuevo = h('input', { class: 'campo', placeholder: 'Nombre de la impresora (como sale en Windows)', autocomplete: 'off', 'aria-label': 'Nueva impresora' });
    const error = h('p', { class: 'error', role: 'alert' });
    let cerrar = () => {};
    const puedeAgregar = tipo === 'normal' || tienePermiso('caja');
    const agregar = () => {
      error.textContent = '';
      try {
        const x = agregarImpresora({ nombre: nuevo.value, tipo });
        sel.replaceChildren(...impresorasDe(tipo).map((y, i) => h('option', { value: y.id }, `${y.nombre}${i === 0 ? ' (predeterminada)' : ''}`)), h('option', { value: '' }, 'La predeterminada de Windows'));
        sel.value = x.id; nuevo.value = '';
      } catch (e) { error.textContent = e.message || String(e); }
    };
    const imprimir = () => {
      const x = impresorasDe(tipo).find((y) => y.id === sel.value) || null;
      cerrar();
      resolver(x ? { id: x.id, nombre: x.nombre } : { id: '', nombre: '' });
    };
    cerrar = hoja(tipo === 'pos80' ? 'Imprimir ticket (80 mm)' : 'Imprimir factura',
      h('div', { class: 'cuerpo' },
        h('label', { class: 'etiqueta' }, 'Impresora', sel),
        h('p', { class: 'ayuda' }, 'Si se abre la ventana de impresión de Windows, confirma que esté seleccionada esa impresora.'),
        puedeAgregar ? h('div', { class: 'rejilla' }, nuevo, h('button', { class: 'btn', onClick: agregar }, 'Agregar impresora')) : null,
        error,
        h('div', { class: 'acciones' },
          h('button', { class: 'btn', onClick: () => { cerrar(); resolver(null); } }, 'Cancelar'),
          h('button', { class: 'btn primario', onClick: imprimir }, 'Imprimir'))));
  });
}

async function imprimirOCompartir(ventaId, html) {
  if (!impresionDirecta) {
    // En la app Android no hay impresión directa: se comparte la factura en PDF
    const { compartirFactura } = await import('./factura.js');
    await compartirFactura(ventaId);
    return false;
  }
  await imprimirHTML(html);
  return true;
}

// Factura al contado: sale sola por la impresora de 80 mm de caja (sin preguntar, si está configurada); si no, se elige la impresora
export async function imprimirContado(ventaId, { recibido = null } = {}) {
  const f = await cargarFactura(ventaId);
  const c = leerImpresoras();
  if (impresionDirecta && !(c.auto80 && predeterminada('pos80'))) {
    const destino = await elegirImpresora('pos80');
    if (!destino) return false;
  }
  try { return await imprimirOCompartir(ventaId, ticket80HTML(f, { recibido })); } catch (e) { toast(`No se pudo imprimir: ${e.message || e}`, 'error'); return false; }
}

// Factura a crédito: la imprime el vendedor en una impresora normal (siempre se elige antes)
export async function imprimirCredito(ventaId) {
  const f = await cargarFactura(ventaId);
  if (impresionDirecta) {
    const destino = await elegirImpresora('normal');
    if (!destino) return false;
  }
  try { return await imprimirOCompartir(ventaId, facturaA4HTML(f)); } catch (e) { toast(`No se pudo imprimir: ${e.message || e}`, 'error'); return false; }
}

// Reimpresión desde el detalle de una venta (según su forma de pago)
export const imprimirVenta = async (ventaId) => {
  const [v] = await consultar('SELECT metodo_pago FROM ventas WHERE id = ?', [ventaId]);
  return v?.metodo_pago === 'credito' ? imprimirCredito(ventaId) : imprimirContado(ventaId);
};

// ---------- Pantalla de impresoras (Ajustes y Caja) ----------
export function abrirImpresoras() {
  const cont = h('div', { class: 'cuerpo' });
  let cerrar = () => {};
  const error = h('p', { class: 'error', role: 'alert' });
  const intento = (fn) => { error.textContent = ''; try { fn(); pintar(); } catch (e) { error.textContent = e.message || String(e); } };
  const nombre = h('input', { class: 'campo', placeholder: 'Nombre de la impresora (como sale en Windows)', autocomplete: 'off', 'aria-label': 'Nombre de la impresora' });
  const tipo = h('select', { class: 'campo', 'aria-label': 'Tipo de impresora' },
    ...Object.entries(TIPOS_IMPRESORA).map(([k, t]) => h('option', { value: k }, t)));
  function pintar() {
    const c = leerImpresoras();
    cont.replaceChildren(
      h('p', { class: 'ayuda' }, 'Estas impresoras son de ESTA computadora. La impresora normal se usa para las facturas a crédito y todo lo demás; la de punto de venta 80 mm, para las facturas al contado que se cobran en caja.'),
      ...(c.lista.length ? c.lista.map((x) => h('div', { class: 'fila inventario' },
        h('span', { class: 'datos' }, h('strong', {}, x.nombre), h('small', {}, `${TIPOS_IMPRESORA[x.tipo]}${c.pred[x.tipo] === x.id ? ' · predeterminada' : ''}`)),
        h('span', { class: 'acciones' },
          c.pred[x.tipo] === x.id ? null : h('button', { class: 'btn chico', onClick: () => intento(() => predeterminar(x.id)) }, 'Predeterminar'),
          h('button', { class: 'btn chico peligro', onClick: () => intento(() => quitarImpresora(x.id)) }, 'Quitar'))))
        : [h('p', { class: 'vacio' }, 'Aún no hay impresoras agregadas.')]),
      h('h3', {}, 'Agregar impresora'),
      h('label', { class: 'etiqueta' }, 'Tipo', tipo),
      h('label', { class: 'etiqueta' }, 'Nombre', nombre),
      h('button', { class: 'btn', onClick: () => intento(() => { agregarImpresora({ nombre: nombre.value, tipo: tipo.value }); nombre.value = ''; }) }, 'Agregar'),
      tienePermiso('caja')
        ? h('label', { class: 'etiqueta' },
            h('input', { type: 'checkbox', checked: c.auto80 ? 'checked' : undefined, onChange: (e) => intento(() => fijarAutomatica(e.target.checked)) }),
            ' Al cobrar, imprimir el ticket de 80 mm automáticamente (sin elegir impresora)')
        : null,
      h('p', { class: 'ayuda' }, 'Para que el ticket salga sin ninguna ventana: en la computadora del cajero deja la impresora de 80 mm como predeterminada de Windows y abre el sistema con un acceso directo de Chrome que termine en --kiosk-printing.'),
      error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn', onClick: () => cerrar() }, 'Cerrar')));
  }
  cerrar = hoja('Impresoras', cont);
  pintar();
}
