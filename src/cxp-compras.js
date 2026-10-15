// cxp-compras.js - CxP: Solicitud de compras, Requisición de cotización y Orden de compras (el circuito antes de la factura del suplidor)
import { h, hoja, toast, dinero } from './ui.js';
import {
  listarSolicitudes, detalleSolicitud, crearSolicitud, cambiarEstadoSolicitud, ESTADOS_SOLICITUD,
  listarRequisiciones, detalleRequisicion, crearRequisicion, guardarCotizacion, quitarCotizacion, anularRequisicion, adjudicarRequisicion, ESTADOS_REQUISICION,
  listarOrdenes, detalleOrden, crearOrden, anularOrden, autorizarOrden, actualizarFaltante, ESTADOS_ORDEN,
} from './cxp-db.js';
import { consultar } from './database.js';
import { fechaHoy } from './conta-db.js';
import { tienePermiso } from './auth.js';
import { imprimirOrdenCompra, textoPagoOrden } from './orden-compra-imp.js';
import { selectDe } from './cxp-docs.js';
import { campo, numero, fechaInput, texto, tabla, vacio, fechaCorta, limpiar, renglon } from './conta-ui-comun.js';

// Editor de líneas: busca un producto, pone la cantidad (y el costo si hace falta) y lo agrega. items() devuelve las líneas.
async function editorLineas({ conCosto = false, inicial = [] } = {}) {
  const productos = await consultar('SELECT id, nombre, codigo, costo, stock_actual FROM productos WHERE activo = 1 ORDER BY nombre COLLATE NOCASE');
  const lineas = inicial.map((l) => ({ ...l }));
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar producto por nombre o código', 'aria-label': 'Buscar producto' });
  const sel = h('select', { class: 'campo', 'aria-label': 'Producto' });
  const cant = numero('1', '1'); cant.setAttribute('step', '1'); cant.setAttribute('aria-label', 'Cantidad');
  const costo = numero(''); costo.setAttribute('aria-label', 'Costo por unidad');
  const cuerpo = h('div'); const error = h('p', { class: 'error', role: 'alert' });
  function filtrar() {
    const q = buscar.value.trim().toLowerCase();
    const vis = productos.filter((p) => !q || `${p.nombre} ${p.codigo || ''}`.toLowerCase().includes(q)).slice(0, 60);
    sel.replaceChildren(...vis.map((p) => h('option', { value: String(p.id) }, `${p.nombre} · stock ${p.stock_actual}`)));
    if (vis.length) { sel.value = String(vis[0].id); alElegir(); }
  }
  function alElegir() { const p = productos.find((x) => String(x.id) === sel.value); if (conCosto && p && !costo.value) costo.value = String(p.costo || ''); }
  function pintar() {
    cuerpo.replaceChildren(lineas.length ? tabla(['Producto', 'Cant.', ...(conCosto ? ['Costo', 'Importe'] : []), ''],
      lineas.map((l, i) => [l.nombre, String(l.cantidad), ...(conCosto ? [dinero(l.costo_unitario), dinero(l.cantidad * l.costo_unitario)] : []), h('button', { class: 'btn chico', onClick: () => { lineas.splice(i, 1); pintar(); } }, 'Quitar')]),
      { num: conCosto ? [1, 2, 3] : [1] }) : vacio('Aún no has agregado productos.'),
    conCosto && lineas.length ? h('div', { class: 'totales' }, renglon('Total estimado', dinero(lineas.reduce((s, l) => s + l.cantidad * l.costo_unitario, 0)), 'gran')) : null);
  }
  buscar.addEventListener('input', filtrar); sel.addEventListener('change', alElegir);
  const agregar = () => {
    error.textContent = '';
    const p = productos.find((x) => String(x.id) === sel.value);
    if (!p) { error.textContent = 'Elige un producto.'; return; }
    const c = Number(cant.value);
    if (!Number.isInteger(c) || c <= 0) { error.textContent = 'La cantidad debe ser un número entero mayor que cero.'; return; }
    const k = conCosto ? Number(costo.value) : 0;
    if (conCosto && !(k >= 0 && costo.value !== '')) { error.textContent = 'Escribe el costo por unidad.'; return; }
    const ya = lineas.find((l) => l.producto_id === p.id);
    if (ya) { ya.cantidad += c; if (conCosto) ya.costo_unitario = k; } else lineas.push({ producto_id: p.id, nombre: p.nombre, cantidad: c, costo_unitario: k });
    cant.value = '1'; if (conCosto) costo.value = '';
    pintar();
  };
  filtrar(); pintar();
  return {
    el: h('div', {}, buscar, sel, h('div', { class: 'rejilla' }, campo('Cantidad', cant), conCosto ? campo('Costo por unidad', costo) : h('span')),
      h('button', { class: 'btn', onClick: agregar }, 'Agregar producto'), error, cuerpo),
    items: () => lineas.map((l) => ({ producto_id: l.producto_id, cantidad: l.cantidad, costo_unitario: l.costo_unitario })),
  };
}

const badge = (estado, mapa) => mapa[estado] || estado;

// ---------- Solicitud de compras ----------
export async function seccionSolicitudes(raiz, recargar, ir) {
  const lista = await listarSolicitudes();
  async function nueva() {
    const ed = await editorLineas();
    const quien = texto('', 'Quién la pide (opcional)'); const notas = texto('', 'Para qué se necesita (opcional)'); const fecha = fechaInput(fechaHoy());
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja('Nueva solicitud de compra', h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, 'Lista de lo que hace falta comprar. Se aprueba y luego se cotiza con varios suplidores o se pasa directo a una orden.'),
      h('div', { class: 'rejilla' }, campo('Solicitante', quien), campo('Fecha', fecha)), campo('Notas', notas), ed.el, error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        error.textContent = '';
        try { const r = await crearSolicitud({ solicitante: quien.value, notas: notas.value, fecha: fecha.value, items: ed.items() }); cerrar(); toast(`Solicitud ${r.numero} guardada`); await recargar(); }
        catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar solicitud'))));
  }
  async function detalle(s) {
    const d = await detalleSolicitud(s.id);
    const error = h('p', { class: 'error', role: 'alert' });
    const cambiar = (estado, msg) => async () => { try { await cambiarEstadoSolicitud(s.id, estado); cerrar(); toast(msg); await recargar(); } catch (e) { error.textContent = limpiar(e); } };
    const cerrar = hoja(`Solicitud ${d.numero}`, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, [fechaCorta(d.fecha), d.solicitante, badge(d.estado, ESTADOS_SOLICITUD), d.notas].filter(Boolean).join(' · ')),
      tabla(['Producto', 'Cant.', 'En stock'], d.items.map((i) => [i.nombre, String(i.cantidad), String(i.stock_actual)]), { num: [1, 2] }), error,
      h('div', { class: 'acciones' },
        d.estado === 'pendiente' ? h('button', { class: 'btn primario', onClick: cambiar('aprobada', 'Solicitud aprobada') }, 'Aprobar') : null,
        d.estado === 'pendiente' ? h('button', { class: 'btn', onClick: cambiar('rechazada', 'Solicitud rechazada') }, 'Rechazar') : null,
        d.estado === 'aprobada' ? h('button', { class: 'btn primario', onClick: async () => {
          try { const r = await crearRequisicion({ solicitud_id: d.id, items: d.items.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad })) }); cerrar(); toast(`Requisición ${r.numero} creada`); await recargar(); }
          catch (e) { error.textContent = limpiar(e); }
        } }, 'Pedir cotizaciones') : null,
        d.estado === 'rechazada' ? h('button', { class: 'btn', onClick: cambiar('pendiente', 'Solicitud reabierta') }, 'Reabrir') : null,
        ['pendiente', 'aprobada'].includes(d.estado) ? h('button', { class: 'btn peligro', onClick: cambiar('anulada', 'Solicitud anulada') }, 'Anular') : null)));
  }
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Lo que el negocio necesita comprar. Primero se aprueba; ya aprobada, se piden cotizaciones a los suplidores (Requisición Cotización).'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: nueva }, 'Nueva solicitud')),
    lista.length ? h('div', { class: 'lista' }, lista.map((s) => h('button', { class: `fila inventario ${['anulada', 'rechazada'].includes(s.estado) ? 'apagada' : ''}`, onClick: () => detalle(s) },
      h('span', { class: 'datos' }, h('strong', {}, s.numero), h('small', {}, [fechaCorta(s.fecha), s.solicitante, `${s.lineas} ${s.lineas === 1 ? 'producto' : 'productos'}`].filter(Boolean).join(' · '))),
      h('span', { class: 'precio' }, badge(s.estado, ESTADOS_SOLICITUD))))) : vacio('Aún no hay solicitudes de compra.'));
  void ir;
}

// ---------- Requisición de cotización ----------
export async function seccionRequisiciones(raiz, recargar) {
  const lista = await listarRequisiciones();
  async function nueva() {
    const aprobadas = (await listarSolicitudes()).filter((s) => s.estado === 'aprobada');
    const ed = await editorLineas();
    const sol = selectDe(aprobadas.map((s) => [s.id, `${s.numero} · ${s.unidades} unidades`]), { vacioTexto: 'Sin solicitud (armarla aquí)', etiqueta: 'Solicitud aprobada' });
    const notas = texto('', 'Opcional'); const fecha = fechaInput(fechaHoy()); const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja('Nueva requisición de cotización', h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, 'Lo que vas a pedirle a varios suplidores. Elige una solicitud aprobada o arma la lista aquí. Después anotas el precio que cada suplidor te dio.'),
      campo('Solicitud aprobada', sol, 'Si eliges una, se usan sus productos y la solicitud queda atendida.'), ed.el, campo('Notas', notas), campo('Fecha', fecha), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        error.textContent = '';
        try {
          let items = ed.items(); const sid = Number(sol.value) || null;
          if (sid && !items.length) items = (await detalleSolicitud(sid)).items.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad }));
          const r = await crearRequisicion({ items, notas: notas.value, solicitud_id: sid, fecha: fecha.value }); cerrar(); toast(`Requisición ${r.numero} creada`); await recargar();
        } catch (e) { error.textContent = limpiar(e); }
      } }, 'Crear requisición'))));
  }
  async function detalle(r) {
    const d = await detalleRequisicion(r.id);
    const provs = await consultar('SELECT id, nombre FROM proveedores ORDER BY nombre COLLATE NOCASE');
    const error = h('p', { class: 'error', role: 'alert' });
    const abierta = d.estado === 'abierta';
    const recarga = async () => { cerrar(); await recargar(); };
    // cuadro comparativo: una fila por producto, una columna por suplidor; el menor precio va marcado con ★
    const enc = ['Producto', 'Cant.', ...d.proveedores.map((p) => p.nombre)];
    const filas = d.items.map((i) => [i.nombre, String(i.cantidad), ...d.proveedores.map((p) => { const v = d.cot[i.id]?.[p.proveedor_id]; return v == null ? '—' : `${d.mejor[i.id] === p.proveedor_id ? '★ ' : ''}${dinero(v)}`; })]);
    filas.push(['Total cotizado', '', ...d.totales.map((t) => (t.completo ? dinero(t.total) : 'incompleto'))]);
    const provSel = selectDe(provs.map((p) => [p.id, p.nombre]), { etiqueta: 'Suplidor' });
    const precios = {}; const entradas = d.items.map((i) => { const x = numero(''); x.setAttribute('aria-label', `Precio de ${i.nombre}`); precios[i.id] = x; return campo(`${i.nombre} (${i.cantidad})`, x); });
    const entrega = fechaInput('');
    const cerrar = hoja(`Requisición ${d.numero}`, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, [fechaCorta(d.fecha), badge(d.estado, ESTADOS_REQUISICION), d.notas, d.orden_numero && `Orden ${d.orden_numero}`].filter(Boolean).join(' · ')),
      d.proveedores.length ? tabla(enc, filas, { num: enc.map((_, i) => i).slice(1), clases: { [filas.length - 1]: 'total' } }) : tabla(['Producto', 'Cant.'], d.items.map((i) => [i.nombre, String(i.cantidad)]), { num: [1] }),
      d.proveedores.length ? h('p', { class: 'ayuda' }, '★ = el precio más bajo de esa línea.') : h('p', { class: 'ayuda' }, 'Todavía nadie ha cotizado. Anota abajo lo que cada suplidor te responda.'),
      abierta ? h('h3', {}, 'Registrar cotización de un suplidor') : null,
      abierta ? campo('Suplidor', provSel) : null, abierta ? h('div', {}, entradas) : null,
      abierta ? h('button', { class: 'btn', onClick: async () => {
        error.textContent = '';
        try { await guardarCotizacion({ requisicion_id: d.id, proveedor_id: Number(provSel.value), precios: Object.fromEntries(Object.entries(precios).map(([k, x]) => [k, x.value])) }); toast('Cotización guardada'); await recarga(); }
        catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar cotización') : null,
      abierta && d.totales.length ? h('h3', {}, 'Escoger al ganador') : null,
      abierta && d.totales.length ? campo('Fecha de entrega esperada', entrega) : null,
      abierta ? h('div', {}, d.totales.map((t) => h('div', { class: 'acciones' },
        h('button', { class: 'btn primario', 'aria-label': `Ordenar a ${t.nombre}`, onClick: async () => {
          error.textContent = '';
          try { const o = await adjudicarRequisicion({ requisicion_id: d.id, proveedor_id: t.proveedor_id, entrega: entrega.value }); toast(`Orden ${o.numero} creada`); await recarga(); } catch (e) { error.textContent = limpiar(e); }
        } }, `Ordenar a ${t.nombre}${t.completo ? ` (${dinero(t.total)})` : ' (incompleto)'}`),
        h('button', { class: 'btn chico', onClick: async () => { try { await quitarCotizacion(d.id, t.proveedor_id); toast('Cotización quitada'); await recarga(); } catch (e) { error.textContent = limpiar(e); } } }, 'Quitar')))) : null,
      error,
      abierta ? h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: async () => { try { await anularRequisicion(d.id); toast('Requisición anulada'); await recarga(); } catch (e) { error.textContent = limpiar(e); } } }, 'Anular requisición')) : null));
  }
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Pide precio a varios suplidores por lo mismo, compara y escoge. Al ganador se le genera la orden de compra con los precios cotizados.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: nueva }, 'Nueva requisición')),
    lista.length ? h('div', { class: 'lista' }, lista.map((r) => h('button', { class: `fila inventario ${r.estado === 'anulada' ? 'apagada' : ''}`, onClick: () => detalle(r) },
      h('span', { class: 'datos' }, h('strong', {}, r.numero), h('small', {}, [fechaCorta(r.fecha), `${r.lineas} ${r.lineas === 1 ? 'producto' : 'productos'}`, `${r.cotizaciones} ${r.cotizaciones === 1 ? 'cotización' : 'cotizaciones'}`].join(' · '))),
      h('span', { class: 'precio' }, badge(r.estado, ESTADOS_REQUISICION))))) : vacio('Aún no hay requisiciones de cotización.'));
}

// ---------- Orden de compras ----------
export async function seccionOrdenes(raiz, recargar) {
  const todas = await listarOrdenes();
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar por suplidor o número', 'aria-label': 'Buscar orden' });
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Filtro de órdenes' });
  const resumen = h('div', { class: 'totales' }); const lista = h('div');
  const FILTROS = [['abiertas', 'Abiertas'], ['pendiente', 'Por autorizar'], ['autorizada', 'Autorizadas'], ['parcial', 'Back order'], ['recibida', 'Recibidas'], ['todas', 'Todas']];
  let filtro = 'abiertas';
  const abierta = (o) => ['pendiente', 'autorizada', 'parcial'].includes(o.estado);
  function pintar() {
    segmento.replaceChildren(...FILTROS.map(([id, t]) => h('button', { 'aria-pressed': String(filtro === id), onClick: () => { filtro = id; pintar(); } }, t)));
    const q = buscar.value.trim().toLowerCase();
    const vis = todas.filter((o) => (filtro === 'todas' || (filtro === 'abiertas' ? abierta(o) : o.estado === filtro)) && (!q || `${o.proveedor} ${o.numero}`.toLowerCase().includes(q)));
    const abiertas = todas.filter(abierta);
    resumen.replaceChildren(renglon('En órdenes abiertas', dinero(abiertas.reduce((t, o) => t + o.total, 0)), 'gran'),
      renglon('Por autorizar', String(todas.filter((o) => o.estado === 'pendiente').length)), renglon('En back order', String(todas.filter((o) => o.estado === 'parcial').length)));
    lista.replaceChildren(vis.length ? h('div', { class: 'lista' }, vis.map((o) => h('button', { class: `fila inventario ${o.estado === 'anulada' ? 'apagada' : ''}`, onClick: () => detalle(o) },
      h('span', { class: 'datos' }, h('strong', {}, o.proveedor), h('small', {}, `${o.numero} · ${fechaCorta(o.fecha)}${o.entrega ? ` · entrega ${fechaCorta(o.entrega)}` : ''}`), h('small', {}, `${badge(o.estado, ESTADOS_ORDEN)} · ${textoPagoOrden(o)}${o.estado === 'parcial' ? ` · faltan ${o.unidades_pendientes}` : ''}`)),
      h('span', { class: 'precio' }, dinero(o.total))))) : vacio('No hay órdenes con ese filtro.'));
  }
  buscar.addEventListener('input', pintar);

  async function nueva() {
    const provs = await consultar('SELECT id, nombre, condicion, dias_credito FROM proveedores ORDER BY nombre COLLATE NOCASE');
    if (!provs.length) { toast('Primero crea un suplidor'); return; }
    const ed = await editorLineas({ conCosto: true });
    const prov = selectDe(provs.map((p) => [p.id, p.nombre]), { etiqueta: 'Suplidor' });
    const pago = h('p', { class: 'ayuda' }, '');
    const verPago = () => { const p = provs.find((x) => String(x.id) === prov.value); pago.textContent = `Forma de pago: ${p?.condicion === 'credito' ? `crédito a ${p.dias_credito ?? 30} días` : 'contado'} (según el perfil del suplidor).`; };
    prov.addEventListener('change', verPago); verPago();
    const entrega = fechaInput(''); const notas = texto('', 'Opcional'); const fecha = fechaInput(fechaHoy()); const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja('Nueva orden de compra', h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, 'Lo que le pides a un suplidor. Se autoriza, se imprime para llevárselo y, cuando llega su factura, se le da entrada desde Compras. No mueve inventario hasta entonces.'),
      campo('Suplidor', prov), pago, h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('Entrega esperada', entrega)), campo('Notas', notas), ed.el, error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        error.textContent = '';
        try { const r = await crearOrden({ proveedor_id: Number(prov.value), items: ed.items(), entrega: entrega.value, notas: notas.value, fecha: fecha.value }); cerrar(); toast(`Orden ${r.numero} guardada`); await recargar(); }
        catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar orden'))));
  }

  // Un producto que no llegó: el comprador lo ve con su nota y decide (otro suplidor) o lo devuelve a back order
  function gestionar(l, cerrarDetalle) {
    const nota = texto(l.nota || '', 'Qué pasó y qué se hará'); nota.setAttribute('aria-label', 'Nota del faltante');
    const error = h('p', { class: 'error', role: 'alert' });
    const accion = async (a) => { try { await actualizarFaltante(l.id, { accion: a, nota: nota.value }); cerrar(); cerrarDetalle(); toast('Orden actualizada'); await recargar(); } catch (e) { error.textContent = limpiar(e); } };
    const cerrar = hoja(l.nombre, h('div', { class: 'cuerpo' }, h('p', { class: 'ayuda' }, `Faltan ${l.cantidad - l.recibido} de ${l.cantidad}.`), campo('Nota', nota), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: () => accion('no_llegara') }, 'No llegará'), l.no_llegara ? h('button', { class: 'btn', onClick: () => accion('backorder') }, 'Volver a back order') : h('button', { class: 'btn', onClick: () => accion('backorder') }, 'Guardar nota (sigue en back order)'))));
  }
  async function detalle(o) {
    const d = await detalleOrden(o.id);
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(`Orden ${d.numero}`, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, [d.proveedor, fechaCorta(d.fecha), d.entrega && `Entrega ${fechaCorta(d.entrega)}`, d.factura && `Última factura ${d.factura}`, d.notas].filter(Boolean).join(' · ')),
      h('ul', { class: 'historial detalle' }, d.items.map((i) => h('li', {},
        h('strong', {}, `${i.cantidad}×`), h('span', {}, `${i.nombre}, ${dinero(i.costo_unitario)} c/u${i.recibido ? ` · recibido ${i.recibido}` : ''}${i.no_llegara ? ' · NO LLEGARÁ' : i.pendiente > 0 && d.estado === 'parcial' ? ` · back order ${i.pendiente}` : ''}${i.nota ? ` · Nota: ${i.nota}` : ''}`),
        h('small', {}, dinero(i.cantidad * i.costo_unitario)),
        d.estado === 'parcial' && (i.pendiente > 0 || i.no_llegara) ? h('button', { class: 'btn', 'aria-label': `Gestionar ${i.nombre}`, onClick: () => gestionar(i, cerrar) }, 'Gestionar') : null))),
      h('div', { class: 'totales' }, renglon('Total estimado', dinero(d.total), 'gran'), renglon('Estado', badge(d.estado, ESTADOS_ORDEN)), renglon('Forma de pago', textoPagoOrden(d)), d.autorizado_por ? renglon('Autorizada por', `${d.autorizado_por} · ${fechaCorta(d.autorizada_fecha)}`) : null),
      error,
      h('div', { class: 'acciones' },
        d.estado !== 'anulada' ? h('button', { class: 'btn', onClick: async () => { try { await imprimirOrdenCompra(d.id); } catch (e) { error.textContent = limpiar(e); } } }, 'Imprimir orden') : null,
        d.estado === 'pendiente' && tienePermiso('autorizar_compras') ? h('button', { class: 'btn primario', onClick: async () => { try { await autorizarOrden(d.id); cerrar(); toast('Despacho autorizado'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, `Autorizar despacho (${textoPagoOrden(d)})`) : null,
        ['autorizada', 'parcial'].includes(d.estado) ? h('p', { class: 'ayuda' }, 'Cuando llegue su factura, dale entrada en Inventario → Dar entrada a factura.') : null,
        ['pendiente', 'autorizada'].includes(d.estado) ? h('button', { class: 'btn peligro', onClick: async () => { try { await anularOrden(d.id); cerrar(); toast('Orden anulada'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Anular orden') : null)));
  }

  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Pedidos a suplidores. Pendiente → autorizada (contado o crédito según el perfil del suplidor) → se imprime y se le lleva → al llegar su factura, en Inventario → "Dar entrada a factura".'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: nueva }, 'Nueva orden de compra')),
    buscar, segmento, resumen, lista);
  pintar();
}
