// entrada-factura.js - Compras: dar entrada a la factura del suplidor a partir de una orden de compra autorizada.
// Solo hay que poner lo que falta (Nº de factura, NCF, fecha) y lo que llegó; lo que no llegó queda en back order
// o se marca "no llegará" con una nota para que el comprador lo gestione en otro lado.
import { h, hoja, toast, dinero } from './ui.js';
import { consultar, registrarCompra } from './database.js';
import { listarOrdenes, detalleOrden, marcarOrdenRecibida } from './cxp-db.js';
import { campo, fechaInput, texto, vacio, fechaCorta, limpiar, renglon } from './conta-ui-comun.js';
import { fechaHoy } from './conta-db.js';
import { textoPagoOrden } from './orden-compra-imp.js';

// alGuardar: se llama al terminar. sinOrden: función que abre la compra directa (factura sin orden)
export async function abrirEntradaFactura(alGuardar = () => {}, { ordenId = null, sinOrden = null } = {}) {
  if (ordenId) { await formularioEntrada(ordenId, alGuardar); return; }
  const ordenes = (await listarOrdenes()).filter((o) => ['autorizada', 'parcial'].includes(o.estado));
  const cerrar = hoja('Dar entrada a factura', h('div', { class: 'cuerpo' },
    h('p', { class: 'ayuda' }, 'Elige la orden de compra a la que corresponde la factura que llegó. Solo aparecen las órdenes autorizadas o en back order.'),
    ordenes.length ? h('div', { class: 'lista' }, ordenes.map((o) => h('button', { class: 'fila inventario', onClick: async () => { cerrar(); await formularioEntrada(o.id, alGuardar); } },
      h('span', { class: 'datos' }, h('strong', {}, `${o.numero} · ${o.proveedor}`), h('small', {}, [fechaCorta(o.fecha), o.estado === 'parcial' ? 'Back order' : 'Autorizada', textoPagoOrden(o)].join(' · '))),
      h('span', { class: 'precio' }, dinero(o.total))))) : vacio('No hay órdenes autorizadas esperando factura.'),
    sinOrden ? h('div', { class: 'acciones' }, h('button', { class: 'btn', onClick: () => { cerrar(); sinOrden(); } }, 'Factura sin orden de compra')) : null));
}

async function formularioEntrada(ordenId, alGuardar) {
  const o = await detalleOrden(ordenId);
  if (!['autorizada', 'parcial'].includes(o.estado)) { toast('Esa orden no está esperando factura', 'error'); return; }
  const [prov] = await consultar('SELECT nombre, condicion, dias_credito FROM proveedores WHERE id = ?', [o.proveedor_id]);
  const credito = prov?.condicion === 'credito';
  const textoPago = credito ? `Crédito a ${prov.dias_credito ?? 30} días` : 'Contado';
  const referencia = texto('', 'Número de la factura'); referencia.setAttribute('aria-label', 'Número de factura');
  const ncf = texto('', 'B0100000001 (opcional)'); ncf.setAttribute('aria-label', 'NCF de la factura');
  const fecha = fechaInput(fechaHoy()); fecha.setAttribute('aria-label', 'Fecha de la factura');
  const itbis = h('input', { class: 'campo', type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'ITBIS de la factura' });
  const metodo = h('select', { class: 'campo', 'aria-label': 'Forma de pago' }, [['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transferencia'], ['cheque', 'Cheque']].map(([k, t]) => h('option', { value: k }, t)));
  metodo.value = 'efectivo';
  const actualizarCosto = h('input', { type: 'checkbox', checked: true });
  const error = h('p', { class: 'error', role: 'alert' });
  const total = h('div', { class: 'totales' });
  const pendientes = o.items.filter((i) => i.pendiente > 0);

  const filas = pendientes.map((i) => {
    const llego = h('input', { class: 'campo', type: 'number', min: '0', step: '1', inputmode: 'numeric', value: String(i.pendiente), 'aria-label': `Llegó ${i.nombre}` });
    const costo = h('input', { class: 'campo', type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: String(i.costo_unitario), 'aria-label': `Costo ${i.nombre}` });
    const accion = h('select', { class: 'campo', 'aria-label': `Lo que falta de ${i.nombre}` }, h('option', { value: 'backorder' }, 'Queda en back order'), h('option', { value: 'no_llegara' }, 'No llegará'));
    accion.value = 'backorder';
    const nota = texto('', 'Nota: por qué no llegó / qué se hará'); nota.setAttribute('aria-label', `Nota de ${i.nombre}`);
    const falta = h('div', { class: 'cuerpo sin-borde' }, campo('Lo que no llegó', accion), campo('Nota para el comprador', nota));
    const cant = () => Math.max(parseInt(llego.value, 10) || 0, 0);
    const ver = () => { falta.style.display = cant() < i.pendiente ? '' : 'none'; pintarTotal(); };
    llego.addEventListener('input', ver); costo.addEventListener('input', pintarTotal);
    const bloque = h('div', { class: 'cuerpo sin-borde' },
      h('strong', {}, i.nombre), h('small', { class: 'ayuda' }, `Pedido ${i.cantidad} · ya recibido ${i.recibido} · pendiente ${i.pendiente}`),
      h('div', { class: 'rejilla' }, campo('Llegó', llego), campo('Costo', costo)), falta);
    return { i, llego, costo, accion, nota, cant, ver, bloque };
  });
  function pintarTotal() { total.replaceChildren(renglon('Total de lo que llegó', dinero(filas.reduce((s, f) => s + f.cant() * (parseFloat(f.costo.value) || 0), 0)), 'gran'), renglon('Forma de pago', textoPago)); }

  let btn;
  async function registrar() {
    error.textContent = '';
    if (!referencia.value.trim()) { error.textContent = 'Escribe el número de la factura del suplidor.'; return; }
    if (!fecha.value) { error.textContent = 'Escribe la fecha de la factura.'; return; }
    const items = []; const faltantes = {};
    for (const f of filas) {
      const n = f.cant();
      if (n > f.i.pendiente) { error.textContent = `De "${f.i.nombre}" solo faltan ${f.i.pendiente} por recibir.`; return; }
      if (n > 0) items.push({ producto_id: f.i.producto_id, cantidad: n, costo_unitario: parseFloat(f.costo.value) || 0 });
      if (n < f.i.pendiente) {
        if (f.accion.value === 'no_llegara' && !f.nota.value.trim()) { error.textContent = `Escribe la nota de "${f.i.nombre}": por qué no llegará y qué se hará.`; return; }
        faltantes[f.i.id] = { accion: f.accion.value, nota: f.nota.value };
      }
    }
    if (!items.length) { error.textContent = 'No se recibió ningún producto. Para uno que no va a llegar, ábrelo en la orden y márcalo "No llegará".'; return; }
    btn.disabled = true;
    try {
      const numero = await registrarCompra({
        proveedor_id: o.proveedor_id, referencia: referencia.value.trim(), ncf: ncf.value.trim() || null, itbis: parseFloat(itbis.value) || 0,
        fecha_factura: fecha.value, items, actualizarCosto: actualizarCosto.checked, actualizarPrecio: false,
        forma_pago: credito ? 'credito' : metodo.value, plazo_dias: credito ? (prov.dias_credito ?? 30) : null,
      });
      await marcarOrdenRecibida(o.id, numero, faltantes);
      cerrar(); toast(`Factura registrada (${numero})`);
      await alGuardar(numero);
    } catch (e) { btn.disabled = false; error.textContent = limpiar(e); }
  }
  btn = h('button', { class: 'btn primario', onClick: registrar }, 'Registrar entrada');
  const cerrar = hoja(`Entrada de factura · ${o.numero}`, h('div', { class: 'cuerpo' },
    h('p', { class: 'ayuda' }, `${o.proveedor} · ${textoPago} (según el perfil del suplidor)`),
    campo('Número de factura', referencia), h('div', { class: 'rejilla' }, campo('NCF', ncf), campo('Fecha de la factura', fecha)), campo('ITBIS incluido', itbis),
    credito ? null : campo('Pagado con', metodo),
    h('h3', {}, 'Productos de la orden'), ...filas.map((f) => f.bloque),
    h('label', { class: 'casilla' }, actualizarCosto, 'Actualizar el costo de cada producto con este precio de compra'),
    total, error, h('div', { class: 'acciones' }, btn)));
  filas.forEach((f) => f.ver());
}
