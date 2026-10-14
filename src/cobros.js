// cobros.js - cobros a clientes: recibos de ingreso con varios métodos de pago aplicados a una o varias facturas
import { consultar, redondear, registrarCobro, anularRecibo, facturasPendientes, METODOS_COBRO } from './database.js';
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { hoyISO } from './fechas.js';
import { compartirRecibo } from './recibo-pdf.js';

const NOMBRES = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque' };
const REFERENCIA = { cheque: 'N.º de cheque y banco', transferencia: 'Referencia (opcional)', tarjeta: 'Últimos 4 dígitos (opcional)', efectivo: '' };
const centavos = (n) => Math.round(Number(n || 0) * 100);

// clienteId: cliente fijo, o null para elegirlo en el formulario.
// ventaId: factura que se marca de entrada (por ejemplo, al tocar "Registrar abono" en una factura).
// alGuardar recibe { id, numero } del recibo creado.
export async function formularioCobro({ clienteId = null, ventaId = null, alGuardar = () => {} } = {}) {
  let cerrar = () => {};
  const error = h('p', { class: 'error', role: 'alert' });
  const boton = h('button', { class: 'btn primario', onClick: () => guardar() }, 'Registrar cobro');

  // ---- cliente ----
  const conDeuda = await consultar(
    `SELECT DISTINCT c.id, c.nombre FROM clientes c JOIN ventas v ON v.cliente_id = c.id
      WHERE v.estado = 'completada' AND v.metodo_pago = 'credito' ORDER BY c.nombre`);
  const pendientesDe = new Map();
  for (const c of conDeuda) if ((await facturasPendientes(c.id)).length) pendientesDe.set(c.id, c);
  if (clienteId && !pendientesDe.has(clienteId)) {
    toast('Este cliente no tiene facturas pendientes');
    return;
  }
  if (!pendientesDe.size) { toast('No hay facturas pendientes de cobro'); return; }
  const selCliente = h('select', { class: 'campo', 'aria-label': 'Cliente', onChange: () => cargarFacturas() },
    ...[...pendientesDe.values()].map((c) => h('option', { value: c.id }, c.nombre)));
  selCliente.value = String(clienteId ?? [...pendientesDe.keys()][0]);
  if (clienteId) selCliente.disabled = true;

  // ---- facturas ----
  let facturas = [];
  let manual = false; // si la persona escribe montos a mano, dejamos de repartir solos
  const filasFacturas = h('div', { class: 'carrito' });
  const aplicadoPorVenta = new Map(); // ventaId -> input

  // ---- métodos ----
  const lineas = []; // { sel, monto, ref, el }
  const contenedorMetodos = h('div', {});
  const resumen = h('p', { class: 'ayuda', 'aria-live': 'polite' });

  function totalRecibido() { return lineas.reduce((s, l) => s + centavos(l.monto.value), 0); }
  function totalAplicado() { return [...aplicadoPorVenta.values()].reduce((s, i) => s + centavos(i.value), 0); }

  function repartir() {
    if (manual) return;
    let resto = totalRecibido();
    for (const f of facturas) {
      const parte = Math.min(resto, centavos(f.saldo));
      aplicadoPorVenta.get(f.id).value = parte > 0 ? (parte / 100).toFixed(2) : '';
      resto -= parte;
    }
  }

  function pintarResumen() {
    const r = totalRecibido(); const a = totalAplicado();
    const dif = r - a;
    resumen.className = dif === 0 ? 'ayuda' : 'error';
    resumen.textContent = `Recibido ${dinero(r / 100)}. Aplicado a facturas ${dinero(a / 100)}.`
      + (dif > 0 ? ` Sobran ${dinero(dif / 100)}: aplícalos a una factura.` : dif < 0 ? ` Faltan ${dinero(-dif / 100)} por cubrir con un método de pago.` : '');
  }

  function agregarLinea(metodo = 'efectivo', monto = '') {
    const sel = h('select', { class: 'campo', 'aria-label': 'Método de pago' }, ...METODOS_COBRO.map((m) => h('option', { value: m }, NOMBRES[m])));
    sel.value = metodo;
    const montoIn = h('input', { class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', value: monto, placeholder: '0.00', 'aria-label': 'Monto' });
    const ref = h('input', { class: 'campo', autocomplete: 'off', 'aria-label': 'Referencia' });
    const quitar = h('button', { class: 'btn chico', 'aria-label': 'Quitar método', onClick: () => { lineas.splice(lineas.indexOf(l), 1); l.el.remove(); cambio(); } }, '✕');
    const l = { sel, monto: montoIn, ref };
    const ajustarRef = () => { ref.placeholder = REFERENCIA[sel.value] || ''; ref.style.display = sel.value === 'efectivo' ? 'none' : ''; };
    sel.addEventListener('change', ajustarRef);
    montoIn.addEventListener('input', cambio);
    l.el = h('div', { class: 'linea-pago' }, h('div', { class: 'par' }, sel, montoIn), ref, lineas.length ? quitar : null);
    ajustarRef();
    lineas.push(l);
    contenedorMetodos.append(l.el);
  }

  function cambio() { repartir(); pintarResumen(); }

  async function cargarFacturas() {
    facturas = await facturasPendientes(Number(selCliente.value));
    if (ventaId) facturas.sort((a, b) => (b.id === ventaId) - (a.id === ventaId)); // la factura elegida se cubre primero
    aplicadoPorVenta.clear();
    manual = false;
    filasFacturas.replaceChildren(...facturas.map((f) => {
      const inp = h('input', { class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '0.00', 'aria-label': `Aplicar a ${f.numero}` });
      inp.addEventListener('input', () => { manual = true; pintarResumen(); });
      aplicadoPorVenta.set(f.id, inp);
      return h('div', { class: 'linea' },
        h('div', { class: 'linea-cab' }, h('strong', {}, f.numero), h('span', { class: 'deuda' }, dinero(f.saldo))),
        h('div', { class: 'linea-pie' },
          h('small', { class: f.vence && f.vence < hoyISO() ? 'deuda' : 'ayuda' },
            `${f.fecha.slice(0, 10)}, total ${dinero(f.total)}${f.vence ? `, ${f.vence < hoyISO() ? 'vencida' : 'vence'} ${f.vence.split('-').reverse().join('/')}` : ''}`),
          inp));
    }));
    // factura marcada de entrada: se propone cobrarla completa
    if (ventaId && aplicadoPorVenta.has(ventaId)) {
      const f = facturas.find((x) => x.id === ventaId);
      if (lineas.length) lineas[0].monto.value = f.saldo;
      cambio();
    } else {
      // por defecto: todo lo pendiente del cliente, repartido de la más antigua
      const total = facturas.reduce((s, f) => s + f.saldo, 0);
      if (lineas.length) lineas[0].monto.value = redondear(total);
      cambio();
    }
  }

  const aplicarTodo = () => {
    manual = false;
    cambio();
  };

  async function guardar() {
    error.textContent = '';
    boton.disabled = true;
    try {
      const metodos = lineas.map((l) => ({ metodo: l.sel.value, monto: Number(l.monto.value), referencia: l.ref.value.trim() }));
      const aplicaciones = facturas.map((f) => ({ ventaId: f.id, monto: Number(aplicadoPorVenta.get(f.id).value) || 0 }));
      const nota = notas.value.trim();
      const r = await registrarCobro({ clienteId: Number(selCliente.value), metodos, aplicaciones, notas: nota });
      cerrar();
      toast(`Cobro registrado: ${r.numero}`);
      await alGuardar(r);
      await detalleRecibo(r.id, { alCambiar: alGuardar });
    } catch (e) {
      boton.disabled = false;
      error.textContent = e.message || String(e);
    }
  }

  const notas = h('input', { class: 'campo', placeholder: 'Opcional', autocomplete: 'off', 'aria-label': 'Nota' });
  agregarLinea();
  await cargarFacturas();

  cerrar = hoja('Cobrar a un cliente', h('div', { class: 'cuerpo' },
    h('label', { class: 'etiqueta' }, 'Cliente', selCliente),
    h('h3', {}, 'Facturas a pagar'),
    h('p', { class: 'ayuda' }, 'Escribe cuánto se aplica a cada factura (pago parcial o total). Se reparte solo de la más antigua a la más nueva.'),
    filasFacturas,
    h('button', { class: 'btn chico', onClick: aplicarTodo }, 'Repartir automáticamente'),
    h('h3', {}, 'Forma de pago'),
    contenedorMetodos,
    h('button', { class: 'btn chico', onClick: () => { agregarLinea('efectivo'); pintarResumen(); } }, 'Agregar otro método de pago'),
    resumen,
    h('label', { class: 'etiqueta' }, 'Nota', notas),
    error,
    h('div', { class: 'acciones' }, boton)));
}

// Compatibilidad: "Registrar abono" de una factura abre el cobro con esa factura marcada
export async function formularioAbono(venta, alGuardar = () => {}) {
  const [v] = await consultar('SELECT cliente_id FROM ventas WHERE id = ?', [venta.id]);
  if (!v?.cliente_id) { toast('La factura no tiene cliente'); return; }
  await formularioCobro({ clienteId: v.cliente_id, ventaId: venta.id, alGuardar });
}

// ---------- Detalle de un recibo ----------
export async function detalleRecibo(id, { alCambiar = () => {} } = {}) {
  const [r] = await consultar(
    `SELECT r.*, c.nombre AS cliente FROM recibos r JOIN clientes c ON c.id = r.cliente_id WHERE r.id = ?`, [id]);
  if (!r) return;
  const metodos = await consultar('SELECT * FROM recibo_metodos WHERE recibo_id = ? ORDER BY id', [id]);
  const aplicado = await consultar(
    `SELECT v.numero, SUM(p.monto) AS monto FROM pagos p JOIN ventas v ON v.id = p.venta_id
      WHERE p.recibo_id = ? GROUP BY v.id ORDER BY v.id`, [id]);
  const anulado = r.estado === 'anulado';
  let cerrar = () => {};
  const error = h('p', { class: 'error', role: 'alert' });
  const fila = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));

  async function anular() {
    const ok = await confirmar('Anular recibo',
      `Las facturas de ${r.cliente} volverán a deber lo que se cobró con ${r.numero}. Si ya cerraste la caja de ese día, el cierre no cambia.`, 'Anular recibo');
    if (!ok) return;
    try { await anularRecibo(id); cerrar(); toast('Recibo anulado'); await alCambiar(); await detalleRecibo(id, { alCambiar }); }
    catch (e) { error.textContent = e.message || String(e); }
  }

  cerrar = hoja(`Recibo ${r.numero}`, h('div', { class: 'cuerpo' },
    h('p', { class: 'ayuda' }, `${r.fecha.slice(0, 16)}, ${r.cliente}${anulado ? ', ANULADO' : ''}`),
    h('h3', {}, 'Facturas pagadas'),
    h('div', { class: 'totales' }, aplicado.map((a) => fila(a.numero, dinero(a.monto)))),
    h('h3', {}, 'Forma de pago'),
    h('div', { class: 'totales' }, metodos.map((m) => fila(`${NOMBRES[m.metodo] || m.metodo}${m.referencia ? ` (${m.referencia})` : ''}`, dinero(m.monto)))),
    h('div', { class: 'totales' }, fila('Total recibido', dinero(r.total), 'gran')),
    r.notas ? h('p', { class: 'ayuda' }, r.notas) : null,
    error,
    h('div', { class: 'acciones' },
      anulado ? null : h('button', { class: 'btn peligro', onClick: anular }, 'Anular recibo'),
      h('button', { class: 'btn primario', onClick: async () => { try { await compartirRecibo(id); } catch (e) { error.textContent = e.message || String(e); } } }, 'Compartir recibo PDF'))));
}

// ---------- Lista de recibos ----------
export async function listaRecibos({ clienteId = null, alCambiar = () => {} } = {}) {
  const filas = await consultar(
    `SELECT r.id, r.numero, r.fecha, r.total, r.estado, c.nombre AS cliente FROM recibos r JOIN clientes c ON c.id = r.cliente_id
      ${clienteId ? 'WHERE r.cliente_id = ?' : ''} ORDER BY r.id DESC LIMIT 100`, clienteId ? [clienteId] : []);
  hoja('Recibos de ingreso', h('div', { class: 'cuerpo' },
    filas.length
      ? filas.map((x) => h('button', { class: 'fila inventario', onClick: () => detalleRecibo(x.id, { alCambiar }) },
          h('span', { class: 'datos' }, h('strong', {}, x.numero), h('small', {}, `${x.fecha.slice(0, 10)}${clienteId ? '' : `, ${x.cliente}`}${x.estado === 'anulado' ? ', anulado' : ''}`)),
          h('span', { class: 'precio' }, dinero(x.total))))
      : h('p', { class: 'vacio' }, 'Todavía no hay recibos.')));
}
