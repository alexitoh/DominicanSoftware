// cuentas.js - cuentas por pagar a proveedores (compras a crédito) y sus pagos
import { consultar, registrarPagoCompra, redondear } from './database.js';
import { h, hoja, toast, dinero } from './ui.js';

const METODOS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque' };
const fechaCorta = (f) => (f || '').slice(0, 10).split('-').reverse().join('/');
const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const renglon = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));

// Estado de una cuenta: pagada | vencida | porvencer | pendiente
export function estadoCuenta(c, hoy = hoyISO()) {
  if (c.saldo <= 0.005) return { id: 'pagada', texto: 'Pagada' };
  if (!c.vence) return { id: 'pendiente', texto: 'Sin fecha límite' };
  const d = diasEntre(hoy, c.vence);
  if (d < 0) return { id: 'vencida', texto: `Vencida hace ${-d} d` };
  if (d <= 7) return { id: 'porvencer', texto: d === 0 ? 'Vence hoy' : `Vence en ${d} d` };
  return { id: 'pendiente', texto: `Vence ${fechaCorta(c.vence)}` };
}

const SQL = `SELECT c.id, c.numero, c.fecha, c.total, c.estado, c.referencia, a.vence, p.nombre AS proveedor, p.telefono AS proveedor_tel,
                    c.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos_compra WHERE compra_id = c.id) AS saldo
               FROM cuentas_pagar a
               JOIN compras c ON c.id = a.compra_id
          LEFT JOIN proveedores p ON p.id = c.proveedor_id
              WHERE c.estado = 'completada'`;

// compra: { id, numero, total, pagado }
export function formularioPagoCompra(compra, alGuardar = () => {}) {
  const saldo = redondear(compra.total - compra.pagado);
  let cerrar = () => {};
  const campo = (etiqueta, input) => h('label', { class: 'etiqueta' }, etiqueta, input);
  const monto = h('input', {
    class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', value: saldo, 'aria-label': 'Monto del pago',
  });
  const metodo = h('select', { class: 'campo', 'aria-label': 'Método de pago' },
    Object.entries(METODOS).map(([k, t]) => h('option', { value: k }, t)));
  const nota = h('input', { class: 'campo', placeholder: 'Opcional', autocomplete: 'off' });
  const error = h('p', { class: 'error', role: 'alert' });
  const boton = h('button', { class: 'btn primario', onClick: () => guardar() }, 'Registrar pago');

  async function guardar() {
    error.textContent = '';
    const m = parseFloat(monto.value);
    if (!(m > 0)) { error.textContent = 'Escribe un monto mayor que cero.'; monto.focus(); return; }
    if (redondear(m) > saldo) { error.textContent = `No puede ser mayor que lo pendiente (${dinero(saldo)}).`; monto.focus(); return; }
    boton.disabled = true;
    try {
      await registrarPagoCompra({ compraId: compra.id, monto: m, metodo: metodo.value, nota: nota.value.trim() });
      cerrar();
      toast(redondear(m) === saldo ? 'Cuenta saldada' : 'Pago registrado');
      await alGuardar();
    } catch (e) {
      boton.disabled = false;
      error.textContent = e.message || String(e);
    }
  }

  cerrar = hoja(`Pago a ${compra.numero}`,
    h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, `Total ${dinero(compra.total)}. Pendiente ${dinero(saldo)}. Si pagas en efectivo con la caja abierta, se descuenta del efectivo esperado.`),
      campo('Monto', monto), campo('Método de pago', metodo), campo('Nota', nota), error,
      h('div', { class: 'acciones' }, boton)));
}

// Detalle de una cuenta por pagar (también se usa desde Compras)
export async function detalleCuenta(compraId, alCambiar = () => {}) {
  const [c] = await consultar(`${SQL} AND c.id = ?`, [compraId]);
  if (!c) return false;
  const pagos = await consultar('SELECT * FROM pagos_compra WHERE compra_id = ? ORDER BY id', [compraId]);
  const pagado = redondear(c.total - c.saldo);
  const e = estadoCuenta(c);
  let cerrar = () => {};
  cerrar = hoja(c.numero,
    h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, `${c.proveedor || 'Sin proveedor'}${c.proveedor_tel ? `, ${c.proveedor_tel}` : ''}, ${c.fecha.slice(0, 10)}${c.referencia ? `, Fact. ${c.referencia}` : ''}`),
      h('div', { class: 'totales' },
        renglon('Total de la compra', dinero(c.total)),
        renglon('Pagado', dinero(pagado)),
        renglon('Pendiente', dinero(Math.max(0, c.saldo)), e.id === 'pagada' ? 'gran pagada' : 'gran deuda'),
        renglon('Estado', e.texto, e.id === 'vencida' ? 'deuda' : ''),
        c.vence ? renglon('Fecha límite', fechaCorta(c.vence)) : null),
      h('h3', {}, 'Pagos'),
      pagos.length
        ? h('ul', { class: 'historial detalle' }, pagos.map((p) => h('li', {},
            h('span', {}, `${p.fecha.slice(0, 10)}, ${METODOS[p.metodo] || p.metodo}${p.nota ? `, ${p.nota}` : ''}`),
            h('small', {}, dinero(p.monto)))))
        : h('p', { class: 'ayuda' }, 'Todavía no hay pagos.'),
      c.saldo > 0.005
        ? h('div', { class: 'acciones' },
            h('button', {
              class: 'btn primario',
              onClick: () => formularioPagoCompra({ id: c.id, numero: c.numero, total: c.total, pagado },
                async () => { cerrar(); await alCambiar(); await detalleCuenta(compraId, alCambiar); }),
            }, 'Registrar pago'))
        : null));
  return true;
}

export async function vistaCuentas(raiz) {
  const estado = { filtro: 'pendientes', texto: '' };
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Estado' });
  const buscar = h('input', {
    class: 'campo', type: 'search', placeholder: 'Buscar por proveedor o factura', 'aria-label': 'Buscar cuenta',
    onInput: (e) => { estado.texto = e.target.value.trim().toLowerCase(); pintar(); },
  });
  const resumen = h('dl', { class: 'resumen' });
  const lista = h('div', { class: 'lista' });
  let todas = [];

  const FILTROS = [['pendientes', 'Pendientes'], ['vencidas', 'Vencidas'], ['pagadas', 'Pagadas'], ['todas', 'Todas']];
  const pintarSegmento = () => segmento.replaceChildren(...FILTROS.map(([id, t]) =>
    h('button', {
      'aria-pressed': String(estado.filtro === id),
      onClick: () => { estado.filtro = id; pintarSegmento(); pintar(); },
    }, t)));

  async function cargar() {
    todas = await consultar(`${SQL} ORDER BY c.id DESC`);
    pintar();
  }

  function pintar() {
    const hoy = hoyISO();
    const con = todas.map((c) => ({ c, e: estadoCuenta(c, hoy) }));
    const pend = con.filter((x) => x.e.id !== 'pagada');
    const total = redondear(pend.reduce((s, x) => s + x.c.saldo, 0));
    const vencido = redondear(pend.filter((x) => x.e.id === 'vencida').reduce((s, x) => s + x.c.saldo, 0));
    const proveedores = new Set(pend.map((x) => x.c.proveedor)).size;
    const dato = (et, val, clase = '') => h('div', {}, h('dt', {}, et), h('dd', { class: clase }, val));
    resumen.replaceChildren(
      dato('Por pagar', dinero(total)),
      dato('Vencido', dinero(vencido), vencido > 0 ? 'deuda' : ''),
      dato('Proveedores', String(proveedores)));

    const visibles = con.filter(({ c, e }) => {
      if (estado.filtro === 'pendientes' && e.id === 'pagada') return false;
      if (estado.filtro === 'vencidas' && e.id !== 'vencida') return false;
      if (estado.filtro === 'pagadas' && e.id !== 'pagada') return false;
      if (!estado.texto) return true;
      return [c.proveedor, c.numero, c.referencia].some((x) => (x || '').toLowerCase().includes(estado.texto));
    });
    lista.replaceChildren(...(visibles.length
      ? visibles.map(({ c, e }) => h('button', { class: 'fila inventario', onClick: () => detalleCuenta(c.id, cargar) },
          h('span', { class: 'datos' },
            h('strong', {}, c.proveedor || 'Sin proveedor'),
            h('small', {}, `${c.numero}, ${c.fecha.slice(0, 10)}${c.referencia ? `, Fact. ${c.referencia}` : ''}`),
            h('small', { class: e.id === 'vencida' ? 'deuda' : '' }, e.texto)),
          h('span', { class: 'precio' }, dinero(Math.max(0, c.saldo)),
            h('small', { class: 'bloque' }, `de ${dinero(c.total)}`))))
      : [h('p', { class: 'vacio' }, todas.length
          ? 'No hay cuentas con ese filtro.'
          : 'No hay cuentas por pagar. Al registrar una compra, elige "Crédito (por pagar)" como forma de pago.')]));
  }

  raiz.replaceChildren(
    h('header', { class: 'barra' }, h('h1', {}, 'Por pagar')),
    resumen,
    h('div', { class: 'filtros' }, buscar, segmento),
    lista);
  pintarSegmento();
  await cargar();
}
