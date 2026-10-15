// cxc.js - CXC: cuentas por cobrar (facturas a crédito de clientes y sus cobros). Vive dentro de Contabilidad.
import { consultar, redondear } from './database.js';
import { h, dinero } from './ui.js';
import { estadoCuenta } from './cuentas.js';
import { formularioCobro, formularioAbono } from './cobros.js';

const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const SQL = `SELECT v.id, v.numero, v.fecha, v.total, v.cliente_id, COALESCE(c.nombre, v.cliente_nombre, 'Sin cliente') AS cliente, c.telefono AS cliente_tel,
                    (SELECT vence FROM cuentas_cobrar WHERE venta_id = v.id) AS vence,
                    v.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE venta_id = v.id) AS saldo
               FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id
              WHERE v.estado = 'completada' AND v.metodo_pago = 'credito'`;

export async function vistaCxc(raiz) {
  const estado = { filtro: 'pendientes', texto: '' };
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Estado' });
  const buscar = h('input', {
    class: 'campo', type: 'search', placeholder: 'Buscar por cliente o factura', 'aria-label': 'Buscar cuenta por cobrar',
    onInput: (e) => { estado.texto = e.target.value.trim().toLowerCase(); pintar(); },
  });
  const resumen = h('dl', { class: 'resumen' });
  const lista = h('div', { class: 'lista' });
  let todas = [];

  const FILTROS = [['pendientes', 'Pendientes'], ['vencidas', 'Vencidas'], ['pagadas', 'Pagadas'], ['todas', 'Todas']];
  const pintarSegmento = () => segmento.replaceChildren(...FILTROS.map(([id, t]) =>
    h('button', { 'aria-pressed': String(estado.filtro === id), onClick: () => { estado.filtro = id; pintarSegmento(); pintar(); } }, t)));

  async function cargar() { todas = await consultar(`${SQL} ORDER BY v.id DESC`); pintar(); }

  function pintar() {
    const hoy = hoyISO();
    const con = todas.map((c) => ({ c, e: estadoCuenta(c, hoy) }));
    const pend = con.filter((x) => x.e.id !== 'pagada');
    const total = redondear(pend.reduce((s, x) => s + x.c.saldo, 0));
    const vencido = redondear(pend.filter((x) => x.e.id === 'vencida').reduce((s, x) => s + x.c.saldo, 0));
    const clientes = new Set(pend.map((x) => x.c.cliente_id ?? x.c.cliente)).size;
    const dato = (et, val, clase = '') => h('div', {}, h('dt', {}, et), h('dd', { class: clase }, val));
    resumen.replaceChildren(dato('Por cobrar', dinero(total)), dato('Vencido', dinero(vencido), vencido > 0 ? 'deuda' : ''), dato('Clientes', String(clientes)));

    const visibles = con.filter(({ c, e }) => {
      if (estado.filtro === 'pendientes' && e.id === 'pagada') return false;
      if (estado.filtro === 'vencidas' && e.id !== 'vencida') return false;
      if (estado.filtro === 'pagadas' && e.id !== 'pagada') return false;
      if (!estado.texto) return true;
      return [c.cliente, c.numero].some((x) => (x || '').toLowerCase().includes(estado.texto));
    });
    lista.replaceChildren(...(visibles.length
      ? visibles.map(({ c, e }) => h('button', {
          class: 'fila inventario',
          onClick: () => { if (e.id !== 'pagada' && c.cliente_id) formularioAbono({ id: c.id }, cargar); },
        },
          h('span', { class: 'datos' },
            h('strong', {}, c.cliente),
            h('small', {}, `${c.numero || `Venta ${c.id}`}, ${c.fecha.slice(0, 10)}`),
            h('small', { class: e.id === 'vencida' ? 'deuda' : '' }, e.texto)),
          h('span', { class: 'precio' }, dinero(Math.max(0, c.saldo)), h('small', { class: 'bloque' }, `de ${dinero(c.total)}`))))
      : [h('p', { class: 'vacio' }, todas.length ? 'No hay cuentas con ese filtro.' : 'No hay cuentas por cobrar. Aparecen al facturar a crédito a un cliente.')]));
  }

  raiz.replaceChildren(
    h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: () => formularioCobro({ alGuardar: cargar }) }, 'Registrar cobro')),
    resumen,
    h('div', { class: 'filtros' }, buscar, segmento),
    lista);
  pintarSegmento();
  await cargar();
}
