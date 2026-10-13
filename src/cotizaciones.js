// cotizaciones.js - cotizar trabajos antes de realizarlos: lista, formulario, detalle, PDF y conversión a venta
import { jsPDF } from 'jspdf';
import {
  consultar, registrarCotizacion, actualizarCotizacion, cambiarEstadoCotizacion, eliminarCotizacion,
} from './database.js';
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { hoyISO } from './fechas.js';
import { formularioCliente } from './clientes.js';
import { botonEscaner } from './escaner.js';
import { traducir } from './i18n.js';
import { registrarBitacora } from './auth.js';
import { fechaLegible, medirImagen, entregarPDF, idiomaDocumento } from './factura.js';

const ESTADOS = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', facturada: 'Facturada', vencida: 'Vencida' };
const FILTROS = [['todas', 'Todas'], ['pendiente', 'Pendientes'], ['aprobada', 'Aprobadas'], ['facturada', 'Facturadas']];
const VENCE = "date(c.fecha, '+' || c.validez_dias || ' days')";

const renglon = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));
const fechaCorta = (f) => String(f || '').slice(0, 10).split('-').reverse().join('/');

// Estado que se muestra: una cotización pendiente cuya validez pasó aparece como "Vencida"
export function estadoVisible(c, hoy = hoyISO()) {
  if (c.estado === 'pendiente' && c.vence && c.vence < hoy) return 'vencida';
  return c.estado;
}

// ---------- PDF ----------
export async function crearPDFCotizacion(id) {
  const [c] = await consultar(
    `SELECT c.*, ${VENCE} AS vence, cl.nombre AS cliente, cl.telefono AS cliente_tel
       FROM cotizaciones c LEFT JOIN clientes cl ON cl.id = c.cliente_id WHERE c.id = ?`, [id]);
  if (!c) throw new Error('La cotización no existe');
  const items = await consultar('SELECT * FROM cotizacion_detalle WHERE cotizacion_id = ? ORDER BY id', [id]);
  const cfg = Object.fromEntries((await consultar('SELECT clave, valor FROM config')).map((r) => [r.clave, r.valor]));
  const lang = await idiomaDocumento();
  const L = (t) => traducir(t, lang);

  const doc = new jsPDF({ unit: 'mm', format: 'a5' });
  const M = 12;
  const DER = 148 - M;
  let y = 16;

  let xTexto = M;
  let finLogo = 0;
  if (cfg.negocio_logo) {
    const medida = await medirImagen(cfg.negocio_logo);
    if (medida) {
      const r = Math.min(20 / medida.h, 38 / medida.w);
      const w = medida.w * r;
      const hLogo = medida.h * r;
      try {
        doc.addImage(cfg.negocio_logo, cfg.negocio_logo.startsWith('data:image/png') ? 'PNG' : 'JPEG', M, 9, w, hLogo);
        xTexto = M + w + 4;
        finLogo = 9 + hLogo;
      } catch { /* sin logo */ }
    }
  }
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(21, 33, 43);
  doc.text(doc.splitTextToSize(cfg.negocio_nombre || 'Mi negocio', DER - xTexto - 38)[0], xTexto, y);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90);
  doc.text(L('COTIZACIÓN'), DER, y - 5, { align: 'right' });
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(21, 33, 43);
  doc.text(c.numero, DER, y + 1, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90);
  if (cfg.negocio_telefono) { y += 5; doc.text(L(`Tel. ${cfg.negocio_telefono}`), xTexto, y); }
  if (cfg.negocio_direccion) { y += 4; doc.text(doc.splitTextToSize(cfg.negocio_direccion, DER - xTexto)[0], xTexto, y); }
  y = Math.max(y, finLogo);

  y += 6;
  doc.setDrawColor(200).line(M, y, DER, y);

  y += 6;
  doc.setTextColor(21, 33, 43);
  doc.text(L(`Fecha: ${fechaLegible(c.fecha)}`), M, y);
  doc.text(`${L('Válida hasta')}: ${fechaCorta(c.vence)}`, DER, y, { align: 'right' });
  y += 5;
  doc.text(`${L('Cliente')}: ${c.cliente || c.cliente_nombre || L('Cliente general')}`, M, y);
  if (c.cliente_tel) doc.text(L(`Tel. ${c.cliente_tel}`), DER, y, { align: 'right' });

  y += 7;
  doc.setFont('helvetica', 'bold').setFontSize(9);
  doc.setFillColor(237, 240, 242).rect(M, y - 4.5, DER - M, 7, 'F');
  doc.text(L('Cant.'), M + 2, y);
  doc.text(L('Descripción'), M + 16, y);
  doc.text(L('Precio'), 108, y, { align: 'right' });
  doc.text(L('Importe'), DER - 2, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  y += 7;

  for (const it of items) {
    const lineas = doc.splitTextToSize(it.descripcion, 62);
    const alto = lineas.length * 4.2 + 2;
    if (y + alto > 185) { doc.addPage(); y = 16; }
    doc.text(String(it.cantidad), M + 2, y);
    doc.text(lineas, M + 16, y);
    doc.text(dinero(it.precio_unitario), 108, y, { align: 'right' });
    doc.text(dinero(it.cantidad * it.precio_unitario), DER - 2, y, { align: 'right' });
    y += alto;
  }

  if (y > 170) { doc.addPage(); y = 16; }
  doc.setDrawColor(200).line(M, y - 2, DER, y - 2);
  y += 4;
  doc.text(L('Subtotal'), 100, y, { align: 'right' });
  doc.text(dinero(c.subtotal), DER - 2, y, { align: 'right' });
  if (c.descuento > 0) {
    y += 5;
    doc.text(L('Descuento'), 100, y, { align: 'right' });
    doc.text(`- ${dinero(c.descuento)}`, DER - 2, y, { align: 'right' });
  }
  y += 7;
  doc.setFont('helvetica', 'bold').setFontSize(12);
  doc.text(L('TOTAL'), 100, y, { align: 'right' });
  doc.text(dinero(c.total), DER - 2, y, { align: 'right' });

  if (c.notas) {
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(21, 33, 43);
    y += 9;
    doc.text(L('Observaciones'), M, y);
    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(70);
    const ln = doc.splitTextToSize(c.notas, DER - M);
    for (const l of ln) {
      y += 4;
      if (y > 196) { doc.addPage(); y = 16; }
      doc.text(l, M, y);
    }
  }

  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(110);
  y += 9;
  if (y > 196) { doc.addPage(); y = 16; }
  doc.text(doc.splitTextToSize(L(`Cotización válida por ${c.validez_dias} días. Esto no es una factura.`), DER - M), 74, y, { align: 'center' });

  return doc.output('datauristring').split(',')[1];
}

export async function compartirCotizacion(id) {
  try {
    const base64 = await crearPDFCotizacion(id);
    const [c] = await consultar('SELECT numero FROM cotizaciones WHERE id = ?', [id]);
    const lang = await idiomaDocumento();
    await entregarPDF(base64, `${lang === 'en' ? 'quote' : 'cotizacion'}-${c.numero}.pdf`,
      traducir(`Cotización ${c.numero}`, lang), traducir('Enviar cotización', lang));
  } catch (e) {
    const msg = String(e?.message || e);
    if (!/cancel/i.test(msg)) toast(`No se pudo crear la cotización: ${msg}`, 'error');
  }
}

// ---------- Formulario (crear / editar) ----------
export async function formularioCotizacion(id, alGuardar = () => {}) {
  const lineas = []; // { producto_id|null, descripcion, cantidad, precio }
  let cerrar = () => {};
  let existente = null;
  if (id) {
    [existente] = await consultar('SELECT * FROM cotizaciones WHERE id = ?', [id]);
    const det = await consultar('SELECT * FROM cotizacion_detalle WHERE cotizacion_id = ? ORDER BY id', [id]);
    det.forEach((d) => lineas.push({
      producto_id: d.producto_id, descripcion: d.descripcion, cantidad: d.cantidad, precio: d.precio_unitario,
    }));
  }

  const error = h('p', { class: 'error', role: 'alert' });
  const resultados = h('div', { class: 'resultados' });
  const cont = h('div', { class: 'carrito' });
  const totales = h('div', { class: 'totales' });

  const cliente = h('select', { class: 'campo', 'aria-label': 'Cliente', onChange: () => mostrarNombre() });
  const nombreLibre = h('input', {
    class: 'campo', placeholder: 'Nombre del cliente (si no está registrado)', autocomplete: 'off',
    'aria-label': 'Nombre del cliente', value: existente?.cliente_nombre || '',
  });
  const campoNombre = h('label', { class: 'etiqueta' }, 'Nombre del cliente', nombreLibre);
  const mostrarNombre = () => { campoNombre.style.display = cliente.value ? 'none' : ''; };
  const validez = h('input', {
    class: 'campo', type: 'number', inputmode: 'numeric', min: '0', step: '1',
    value: existente ? existente.validez_dias : 15, 'aria-label': 'Días de validez',
  });
  const descuento = h('input', {
    class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '0.00',
    value: existente?.descuento > 0 ? existente.descuento : '', 'aria-label': 'Descuento', onInput: () => pintarTotales(),
  });
  const notas = h('textarea', {
    class: 'campo', rows: '3', 'aria-label': 'Observaciones',
    placeholder: 'Descripción del trabajo, condiciones, tiempo de entrega...',
  });
  notas.value = existente?.notas || '';

  async function cargarClientes() {
    const cs = await consultar('SELECT id, nombre FROM clientes ORDER BY nombre');
    cliente.replaceChildren(h('option', { value: '' }, 'Cliente general'),
      ...cs.map((c) => h('option', { value: c.id }, c.nombre)));
    if (existente?.cliente_id) cliente.value = String(existente.cliente_id);
    mostrarNombre();
  }

  const subtotal = () => lineas.reduce((s, l) => s + l.cantidad * l.precio, 0);
  const descuentoAplicado = (sub) => Math.min(Math.max(parseFloat(descuento.value) || 0, 0), sub);

  function pintarTotales() {
    const sub = subtotal();
    const dto = descuentoAplicado(sub);
    totales.replaceChildren(
      renglon('Subtotal', dinero(sub)),
      dto > 0 ? renglon('Descuento', `- ${dinero(dto)}`) : null,
      renglon('Total', dinero(sub - dto), 'gran'));
  }

  function pintarLineas() {
    if (!lineas.length) {
      cont.replaceChildren(h('p', { class: 'vacio' }, 'Agrega productos de tu inventario o servicios como mano de obra.'));
      return;
    }
    cont.replaceChildren(...lineas.map((l, i) => {
      const importe = h('strong', {}, dinero(l.cantidad * l.precio));
      const actualizar = () => { importe.textContent = dinero(l.cantidad * l.precio); pintarTotales(); };
      return h('div', { class: 'linea' },
        h('div', { class: 'linea-cab' },
          l.producto_id
            ? h('strong', {}, l.descripcion)
            : h('input', {
                class: 'campo', value: l.descripcion, placeholder: 'Descripción del servicio', 'aria-label': 'Descripción',
                onInput: (e) => { l.descripcion = e.target.value; },
              }),
          h('button', { class: 'icono', 'aria-label': 'Quitar línea', onClick: () => { lineas.splice(i, 1); pintarLineas(); pintarTotales(); } }, '✕')),
        h('div', { class: 'linea-pie' },
          h('label', { class: 'etiqueta chica' }, 'Precio',
            h('input', {
              class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', value: l.precio, 'aria-label': 'Precio',
              onInput: (e) => { l.precio = parseFloat(e.target.value) || 0; actualizar(); },
            })),
          h('label', { class: 'etiqueta chica' }, 'Cantidad',
            h('input', {
              class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: l.producto_id ? '1' : '0.5', value: l.cantidad, 'aria-label': 'Cantidad',
              onInput: (e) => { l.cantidad = parseFloat(e.target.value) || 0; actualizar(); },
            })),
          importe));
    }));
  }

  function agregarProducto(p) {
    const l = lineas.find((x) => x.producto_id === p.id);
    if (l) l.cantidad += 1;
    else lineas.push({ producto_id: p.id, descripcion: p.nombre, cantidad: 1, precio: p.precio });
    pintarLineas();
    pintarTotales();
  }

  async function pintarResultados() {
    const like = `%${buscar.value.trim()}%`;
    const filas = await consultar(
      `SELECT * FROM productos WHERE activo = 1 AND (nombre LIKE ? OR codigo LIKE ? OR marca LIKE ?)
        ORDER BY nombre LIMIT 20`, [like, like, like]);
    resultados.replaceChildren(...(filas.length
      ? filas.map((p) => h('button', { class: 'resultado', onClick: () => agregarProducto(p) },
          h('span', { class: 'datos' }, h('strong', {}, p.nombre), h('small', {}, `${p.stock_actual} en stock`)),
          h('span', { class: 'precio' }, dinero(p.precio))))
      : [h('p', { class: 'vacio' }, 'No hay productos con esa búsqueda.')]));
  }

  async function escanear(codigo) {
    const [p] = await consultar('SELECT * FROM productos WHERE activo = 1 AND codigo = ? COLLATE NOCASE', [codigo]);
    if (!p) { toast(`No hay un producto con el código ${codigo}`, 'error'); return true; }
    agregarProducto(p);
    toast(`Agregado: ${p.nombre}`);
    return true;
  }

  const buscar = h('input', {
    class: 'campo', type: 'search', 'aria-label': 'Buscar producto',
    placeholder: 'Buscar producto por nombre, código o marca', onInput: () => pintarResultados(),
  });

  async function guardar() {
    error.textContent = '';
    const datos = {
      cliente_id: cliente.value ? Number(cliente.value) : null,
      cliente_nombre: nombreLibre.value,
      items: lineas.map((l) => ({
        producto_id: l.producto_id, descripcion: l.descripcion, cantidad: l.cantidad, precio_unitario: l.precio,
      })),
      descuento: Math.max(parseFloat(descuento.value) || 0, 0),
      validez_dias: validez.value === '' ? 15 : parseInt(validez.value, 10),
      notas: notas.value.trim(),
    };
    botonGuardar.disabled = true;
    try {
      let idFinal = id;
      if (id) await actualizarCotizacion(id, datos);
      else {
        const numero = await registrarCotizacion(datos);
        [{ id: idFinal }] = await consultar('SELECT id FROM cotizaciones WHERE numero = ?', [numero]);
      }
      cerrar();
      toast('Cotización guardada');
      alGuardar(idFinal);
    } catch (e) {
      botonGuardar.disabled = false;
      error.textContent = e.message || String(e);
    }
  }
  const botonGuardar = h('button', { class: 'btn primario', onClick: guardar }, 'Guardar cotización');

  cerrar = hoja(id ? `Editar ${existente?.numero || 'cotización'}` : 'Nueva cotización',
    h('div', { class: 'cuerpo' },
      h('div', { class: 'cliente-fila' },
        h('label', { class: 'etiqueta' }, 'Cliente', cliente),
        h('button', {
          class: 'btn',
          onClick: () => formularioCliente(null, async (nuevo) => { await cargarClientes(); if (nuevo) { cliente.value = String(nuevo); mostrarNombre(); } }),
        }, 'Nuevo')),
      campoNombre,
      h('div', { class: 'buscador' }, buscar, botonEscaner({
        titulo: 'Escanear productos', ayuda: 'Escanea el código de cada producto para agregarlo a la cotización.', alLeer: escanear,
      })),
      resultados,
      h('button', {
        class: 'btn',
        onClick: () => { lineas.push({ producto_id: null, descripcion: '', cantidad: 1, precio: 0 }); pintarLineas(); pintarTotales(); },
      }, '+ Servicio / mano de obra'),
      h('h3', {}, 'Lo que se cotiza'),
      cont,
      h('div', { class: 'rejilla' },
        h('label', { class: 'etiqueta' }, 'Descuento', descuento),
        h('label', { class: 'etiqueta' }, 'Días de validez', validez)),
      h('label', { class: 'etiqueta' }, 'Observaciones', notas),
      totales,
      error,
      h('div', { class: 'acciones' }, botonGuardar)));

  await cargarClientes();
  pintarLineas();
  pintarTotales();
  await pintarResultados();
}

// ---------- Detalle ----------
export async function detalleCotizacion(id, { alCambiar = () => {}, convertir = () => {} } = {}) {
  const [c] = await consultar(
    `SELECT c.*, ${VENCE} AS vence, cl.nombre AS cliente, cl.telefono AS cliente_tel, v.numero AS venta_numero, u.nombre AS creador
       FROM cotizaciones c LEFT JOIN clientes cl ON cl.id = c.cliente_id LEFT JOIN ventas v ON v.id = c.venta_id
       LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.id = ?`, [id]);
  if (!c) return;
  const items = await consultar('SELECT * FROM cotizacion_detalle WHERE cotizacion_id = ? ORDER BY id', [id]);
  const est = estadoVisible(c);
  const editable = c.estado !== 'facturada';
  let cerrar = () => {};

  const cambiar = async (estado) => {
    try {
      await cambiarEstadoCotizacion(id, estado);
      cerrar();
      toast(`Cotización ${ESTADOS[estado].toLowerCase()}`);
      await alCambiar();
      await detalleCotizacion(id, { alCambiar, convertir });
    } catch (e) { toast(e.message || 'No se pudo cambiar', 'error'); }
  };
  async function borrar() {
    const ok = await confirmar('Eliminar cotización', `Se eliminará ${c.numero}. Esta acción no se puede deshacer.`, 'Eliminar');
    if (!ok) return;
    try {
      await eliminarCotizacion(id);
      await registrarBitacora('Cotización eliminada', c.numero);
      cerrar();
      toast('Cotización eliminada');
      await alCambiar();
    } catch (e) { toast(e.message || 'No se pudo eliminar', 'error'); }
  }

  cerrar = hoja(c.numero,
    h('div', { class: 'cuerpo' },
      h('p', {}, h('span', { class: `etiqueta-estado ${est}` }, ESTADOS[est]),
        c.venta_numero ? ` Convertida en ${c.venta_numero}.` : ''),
      h('div', { class: 'totales' },
        renglon('Cliente', c.cliente || c.cliente_nombre || 'Cliente general'),
        renglon('Fecha', fechaLegible(c.fecha)),
        c.creador ? renglon('Creada por', c.creador) : null,
        renglon('Válida hasta', fechaCorta(c.vence), est === 'vencida' ? 'deuda' : '')),
      h('h3', {}, 'Lo que se cotiza'),
      h('div', { class: 'lista' }, items.map((it) => h('div', { class: 'fila' },
        h('span', { class: 'datos' }, h('strong', {}, it.descripcion),
          h('small', {}, `${it.cantidad} × ${dinero(it.precio_unitario)}${it.producto_id ? '' : ' (servicio)'}`)),
        h('span', { class: 'precio' }, dinero(it.cantidad * it.precio_unitario))))),
      h('div', { class: 'totales' },
        renglon('Subtotal', dinero(c.subtotal)),
        c.descuento > 0 ? renglon('Descuento', `- ${dinero(c.descuento)}`) : null,
        renglon('Total', dinero(c.total), 'gran')),
      c.notas ? h('p', { class: 'ayuda' }, c.notas) : null,
      editable
        ? h('div', { class: 'acciones' },
            c.estado !== 'aprobada' ? h('button', { class: 'btn', onClick: () => cambiar('aprobada') }, 'Marcar aprobada') : null,
            c.estado !== 'rechazada' ? h('button', { class: 'btn', onClick: () => cambiar('rechazada') }, 'Marcar rechazada') : null,
            c.estado !== 'pendiente' ? h('button', { class: 'btn', onClick: () => cambiar('pendiente') }, 'Volver a pendiente') : null)
        : null,
      h('div', { class: 'acciones' },
        editable ? h('button', { class: 'btn peligro', onClick: borrar }, 'Eliminar') : null,
        editable ? h('button', {
          class: 'btn',
          onClick: () => { cerrar(); formularioCotizacion(id, async () => { await alCambiar(); await detalleCotizacion(id, { alCambiar, convertir }); }); },
        }, 'Editar') : null,
        h('button', { class: 'btn', onClick: () => compartirCotizacion(id) }, 'Compartir PDF'),
        editable && c.estado !== 'rechazada'
          ? h('button', { class: 'btn primario', onClick: () => { cerrar(); convertir(id); } }, 'Convertir en venta')
          : null)));
}

// ---------- Lista ----------
export async function vistaCotizaciones(contenedor, { convertir }) {
  const filtro = { v: 'todas' };
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Estado' });
  const lista = h('div', { class: 'lista' });
  const resumen = h('dl', { class: 'resumen' });

  async function pintar() {
    segmento.replaceChildren(...FILTROS.map(([id, t]) => h('button', {
      'aria-pressed': String(filtro.v === id),
      onClick: () => { filtro.v = id; pintar(); },
    }, t)));
    const filas = await consultar(
      `SELECT c.*, ${VENCE} AS vence, cl.nombre AS cliente FROM cotizaciones c
         LEFT JOIN clientes cl ON cl.id = c.cliente_id ORDER BY c.id DESC LIMIT 500`);
    const conEstado = filas.map((c) => ({ ...c, est: estadoVisible(c) }));
    const abiertas = conEstado.filter((c) => c.est === 'pendiente' || c.est === 'aprobada');
    const dato = (et, val) => h('div', {}, h('dt', {}, et), h('dd', {}, val));
    resumen.replaceChildren(
      dato('Abiertas', String(abiertas.length)),
      dato('Monto abierto', dinero(abiertas.reduce((s, c) => s + c.total, 0))),
      dato('Facturadas', String(conEstado.filter((c) => c.est === 'facturada').length)));
    const ver = conEstado.filter((c) => filtro.v === 'todas' || c.estado === filtro.v);
    lista.replaceChildren(...(ver.length
      ? ver.map((c) => h('button', { class: 'fila inventario', onClick: () => detalleCotizacion(c.id, { alCambiar: pintar, convertir }) },
          h('span', { class: 'datos' },
            h('strong', {}, c.numero),
            h('small', {}, c.cliente || c.cliente_nombre || 'Cliente general'),
            h('small', {}, `${c.fecha.slice(0, 10).split('-').reverse().join('/')}, válida hasta ${fechaCorta(c.vence)}`),
            h('small', { class: c.est === 'vencida' ? 'deuda' : '' }, ESTADOS[c.est])),
          h('span', { class: 'precio' }, dinero(c.total))))
      : [h('p', { class: 'vacio' }, 'No hay cotizaciones aquí. Toca "Nueva cotización" para crear la primera.')]));
  }

  contenedor.replaceChildren(resumen, h('div', { class: 'filtros' }, segmento), lista);
  await pintar();
  return pintar;
}

