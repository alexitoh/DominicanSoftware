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

// ---------- Ticket de punto de venta 80 mm (facturas al contado) ----------
export function ticket80HTML(f, { recibido = null } = {}) {
  const { v, items, servicios, garantias, cfg, L } = f;
  const itbisSumado = v.itbis > 0 && Math.abs(v.total - (v.subtotal - v.descuento) - v.itbis) < 0.01;
  const tipoCpb = v.ncf ? NOMBRE_COMPROBANTE[String(v.ncf).slice(0, 3)] : null;
  const fila = (a, b, clase = '') => `<div class="fila ${clase}"><span>${esc(a)}</span><span>${esc(b)}</span></div>`;
  const lineas = [
    ...items.map((i) => ({ n: i.nombre, c: i.cantidad, p: i.precio_unitario, t: i.cantidad * i.precio_unitario - (i.descuento || 0) })),
    ...servicios.map((s) => ({ n: s.descripcion, c: s.cantidad, p: s.precio_unitario, t: s.cantidad * s.precio_unitario })),
  ];
  const cambio = recibido != null && recibido >= v.total ? Math.round((recibido - v.total) * 100) / 100 : null;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(v.numero)}</title><style>
@page { size: 80mm auto; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
body { width: 72mm; padding: 3mm 4mm 6mm; font: 12px/1.35 "Courier New", monospace; color: #000; }
.c { text-align: center; } .b { font-weight: bold; } .g { font-size: 15px; }
.fila { display: flex; justify-content: space-between; gap: 6px; } .fila span:last-child { text-align: right; white-space: nowrap; }
hr { border: 0; border-top: 1px dashed #000; margin: 5px 0; }
.it { margin: 3px 0; } .it small { display: block; }
</style></head><body>
<div class="c b g">${esc(cfg.negocio_nombre || 'Mi negocio')}</div>
${cfg.negocio_rnc ? `<div class="c">RNC: ${esc(cfg.negocio_rnc)}</div>` : ''}
${cfg.negocio_direccion ? `<div class="c">${esc(cfg.negocio_direccion)}</div>` : ''}
${cfg.negocio_telefono ? `<div class="c">Tel. ${esc(cfg.negocio_telefono)}</div>` : ''}
<hr>
<div class="c b">${esc(L(tipoCpb || 'Factura'))}</div>
${fila(L('Factura'), v.numero)}
${v.ncf ? fila('NCF', v.ncf) : ''}
${fila(L('Fecha'), fechaLegible(v.fecha))}
${fila(L('Cliente'), v.cliente || v.cliente_nombre || L('Cliente general'))}
${v.cliente_doc ? `<div>${esc(textoDocumento(v.cliente_tipo_doc, v.cliente_doc))}</div>` : ''}
${v.vendedor ? fila(L('Atendió'), v.vendedor) : ''}
${v.cajero ? fila(L('Cajero'), v.cajero) : ''}
<hr>
${lineas.map((l) => `<div class="it"><div>${esc(l.n)}</div>${fila(`${l.c} x ${dinero(l.p)}`, dinero(l.t))}</div>`).join('')}
<hr>
${fila(L('Subtotal'), dinero(v.subtotal))}
${v.descuento > 0 ? fila(L('Descuento'), `- ${dinero(v.descuento)}`) : ''}
${itbisSumado ? fila(L('ITBIS'), dinero(v.itbis)) : ''}
${fila(L('TOTAL'), dinero(v.total), 'b g')}
${v.itbis > 0 && !itbisSumado ? `<div class="c">${esc(L('ITBIS incluido'))}: ${esc(dinero(v.itbis))}</div>` : ''}
<hr>
${fila(L('Pago'), L(METODOS[v.metodo_pago] || v.metodo_pago))}
${recibido != null ? fila(L('Recibido'), dinero(recibido)) : ''}
${cambio != null ? fila(L('Cambio'), dinero(cambio), 'b') : ''}
${garantias.length ? `<hr>${garantias.map((g) => `<div>${esc(g.nombre)}: ${esc(L('Garantía'))} ${g.meses} ${esc(L(g.meses === 1 ? 'mes' : 'meses'))}${g.serie ? ` (${esc(g.serie)})` : ''}</div>`).join('')}` : ''}
<hr>
<div class="c">${esc(L('Gracias por su compra'))}</div>
</body></html>`;
}

// ---------- Factura en hoja normal (ventas a crédito) ----------
export function facturaA4HTML(f) {
  const { v, items, servicios, cobro, garantias, cfg, pagado, L } = f;
  const itbisSumado = v.itbis > 0 && Math.abs(v.total - (v.subtotal - v.descuento) - v.itbis) < 0.01;
  const tipoCpb = v.ncf ? NOMBRE_COMPROBANTE[String(v.ncf).slice(0, 3)] : null;
  const lineas = [
    ...items.map((i) => ({ n: i.nombre, c: i.cantidad, p: i.precio_unitario, t: i.cantidad * i.precio_unitario - (i.descuento || 0) })),
    ...servicios.map((s) => ({ n: `${s.descripcion}`, c: s.cantidad, p: s.precio_unitario, t: s.cantidad * s.precio_unitario })),
  ];
  const tot = (a, b, clase = '') => `<tr class="${clase}"><td colspan="3"></td><td class="d">${esc(a)}</td><td class="d">${esc(b)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(v.numero)}</title><style>
@page { size: A4; margin: 15mm; }
body { font: 13px/1.4 Arial, Helvetica, sans-serif; color: #15212b; margin: 0; }
h1 { font-size: 22px; margin: 0; } .m { color: #555; }
.cab { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #15212b; padding-bottom: 8px; margin-bottom: 10px; }
table { width: 100%; border-collapse: collapse; } th { text-align: left; border-bottom: 1px solid #999; padding: 4px 0; }
td { padding: 4px 0; vertical-align: top; } .d { text-align: right; } .b td { font-weight: bold; font-size: 15px; border-top: 1px solid #999; }
</style></head><body>
<div class="cab"><div><h1>${esc(cfg.negocio_nombre || 'Mi negocio')}</h1>
${cfg.negocio_rnc ? `<div class="m">RNC: ${esc(cfg.negocio_rnc)}</div>` : ''}
${cfg.negocio_direccion ? `<div class="m">${esc(cfg.negocio_direccion)}</div>` : ''}
${cfg.negocio_telefono ? `<div class="m">Tel. ${esc(cfg.negocio_telefono)}</div>` : ''}</div>
<div class="d"><strong>${esc(L(tipoCpb || 'Factura'))}</strong><br>${esc(v.numero)}${v.ncf ? `<br>NCF ${esc(v.ncf)}` : ''}<br>${esc(fechaLegible(v.fecha))}</div></div>
<p><strong>${esc(L('Cliente'))}:</strong> ${esc(v.cliente || v.cliente_nombre || L('Cliente general'))}${v.cliente_tel ? ` &nbsp; Tel. ${esc(v.cliente_tel)}` : ''}
${v.cliente_doc ? `<br>${esc(textoDocumento(v.cliente_tipo_doc, v.cliente_doc))}` : ''}${v.vendedor ? `<br>${esc(L('Atendió'))}: ${esc(v.vendedor)}` : ''}</p>
<table><thead><tr><th>${esc(L('Cant.'))}</th><th>${esc(L('Descripción'))}</th><th class="d">${esc(L('Precio'))}</th><th></th><th class="d">${esc(L('Importe'))}</th></tr></thead><tbody>
${lineas.map((l) => `<tr><td>${esc(l.c)}</td><td>${esc(l.n)}</td><td class="d">${esc(dinero(l.p))}</td><td></td><td class="d">${esc(dinero(l.t))}</td></tr>`).join('')}
${tot(L('Subtotal'), dinero(v.subtotal))}
${v.descuento > 0 ? tot(L('Descuento'), `- ${dinero(v.descuento)}`) : ''}
${itbisSumado ? tot(L('ITBIS'), dinero(v.itbis)) : ''}
${tot(L('TOTAL'), dinero(v.total), 'b')}
${v.metodo_pago === 'credito' ? `${tot(L('Abonado'), dinero(pagado))}${tot(L('Saldo pendiente'), dinero(Math.max(0, v.total - pagado)), 'b')}` : ''}
</tbody></table>
${cobro?.vence ? `<p>${esc(L('Fecha límite de pago'))}: ${esc(cobro.vence.split('-').reverse().join('/'))}</p>` : ''}
${garantias.length ? `<p class="m">${garantias.map((g) => `${esc(g.nombre)}: ${esc(L('Garantía'))} ${g.meses} ${esc(L(g.meses === 1 ? 'mes' : 'meses'))}${g.serie ? ` (${esc(g.serie)})` : ''}`).join('<br>')}</p>` : ''}
</body></html>`;
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
      setTimeout(() => {
        try { marco.contentWindow.focus(); marco.contentWindow.print(); ok(true); } catch (e) { fallo(e); }
        setTimeout(() => marco.remove(), 60000);
      }, 250);
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
