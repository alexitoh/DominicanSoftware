// cuentas.js - pago a una compra a crédito (cuenta por pagar). Las pantallas de CxP viven en cxp.js, cxp-docs.js y siguientes.
import { registrarPagoCompra, redondear } from './database.js';
import { h, hoja, toast, dinero } from './ui.js';

const METODOS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque' };
const fechaCorta = (f) => (f || '').slice(0, 10).split('-').reverse().join('/');
const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// Estado de una cuenta: pagada | vencida | porvencer | pendiente
export function estadoCuenta(c, hoy = hoyISO()) {
  if (c.saldo <= 0.005) return { id: 'pagada', texto: 'Pagada' };
  if (!c.vence) return { id: 'pendiente', texto: 'Sin fecha límite' };
  const d = diasEntre(hoy, c.vence);
  if (d < 0) return { id: 'vencida', texto: `Vencida hace ${-d} d` };
  if (d <= 7) return { id: 'porvencer', texto: d === 0 ? 'Vence hoy' : `Vence en ${d} d` };
  return { id: 'pendiente', texto: `Vence ${fechaCorta(c.vence)}` };
}

// compra: { id, numero, total, pagado }
export function formularioPagoCompra(compra, alGuardar = () => {}) {
  const saldo = redondear(compra.total - compra.pagado);
  let cerrar = () => {};
  const campo = (etiqueta, input) => h('label', { class: 'etiqueta' }, etiqueta, input);
  const monto = h('input', { class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', value: saldo, 'aria-label': 'Monto del pago' });
  const metodo = h('select', { class: 'campo', 'aria-label': 'Método de pago' }, Object.entries(METODOS).map(([k, t]) => h('option', { value: k }, t)));
  metodo.value = 'efectivo';
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
