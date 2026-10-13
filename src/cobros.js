// cobros.js - abonos a ventas a crédito
import { registrarAbono, redondear } from './database.js';
import { h, hoja, toast, dinero } from './ui.js';

// venta: { id, numero, total, pagado }
// alGuardar se ejecuta después de registrar el abono (para refrescar la pantalla)
export function formularioAbono(venta, alGuardar = () => {}) {
  const saldo = redondear(venta.total - venta.pagado);
  let cerrar = () => {};

  const campo = (etiqueta, input) => h('label', { class: 'etiqueta' }, etiqueta, input);
  const monto = h('input', {
    class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01',
    value: saldo, 'aria-label': 'Monto del abono',
  });
  const metodo = h('select', { class: 'campo', 'aria-label': 'Método de pago' },
    [['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transferencia']]
      .map(([k, t]) => h('option', { value: k }, t)));
  const nota = h('input', { class: 'campo', placeholder: 'Opcional', autocomplete: 'off' });
  const error = h('p', { class: 'error', role: 'alert' });
  const boton = h('button', { class: 'btn primario', onClick: () => guardar() }, 'Registrar abono');

  async function guardar() {
    error.textContent = '';
    const m = parseFloat(monto.value);
    if (!(m > 0)) { error.textContent = 'Escribe un monto mayor que cero.'; monto.focus(); return; }
    if (redondear(m) > saldo) {
      error.textContent = `El abono no puede ser mayor que lo pendiente (${dinero(saldo)}).`;
      monto.focus();
      return;
    }
    boton.disabled = true;
    try {
      await registrarAbono({ ventaId: venta.id, monto: m, metodo: metodo.value, nota: nota.value.trim() });
      cerrar();
      toast(redondear(m) === saldo ? 'Venta saldada' : 'Abono registrado');
      await alGuardar();
    } catch (e) {
      boton.disabled = false;
      error.textContent = e.message || String(e);
    }
  }

  cerrar = hoja(`Abono a ${venta.numero}`,
    h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, `Total ${dinero(venta.total)}. Pendiente ${dinero(saldo)}.`),
      campo('Monto', monto),
      campo('Método de pago', metodo),
      campo('Nota', nota),
      error,
      h('div', { class: 'acciones' }, boton)));
}
