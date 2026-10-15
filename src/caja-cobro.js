// caja-cobro.js - panel para cobrar una venta al contado: forma de pago, efectivo recibido y cambio.
import { h, dinero } from './ui.js';

export const FORMAS_COBRO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque' };

// alCobrar({ metodo, recibido }) debe devolver una promesa; si falla, se muestra el mensaje y se puede reintentar.
export function panelCobro({ total, textoBoton = 'Cobrar e imprimir', alCobrar }) {
  const metodo = h('select', { class: 'campo', 'aria-label': 'Forma de pago', onChange: () => pintar() },
    Object.entries(FORMAS_COBRO).map(([k, t]) => h('option', { value: k }, t)));
  const recibido = h('input', {
    class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '0.00', 'aria-label': 'Efectivo recibido', onInput: () => pintar(),
  });
  const campoRecibido = h('label', { class: 'etiqueta' }, 'Efectivo recibido', recibido);
  const cambio = h('p', { class: 'ayuda', role: 'status' });
  const error = h('p', { class: 'error', role: 'alert' });
  const boton = h('button', { class: 'btn primario', onClick: cobrar }, textoBoton);

  function pintar() {
    const efectivo = metodo.value === 'efectivo';
    campoRecibido.style.display = efectivo ? '' : 'none';
    const r = parseFloat(recibido.value);
    if (!efectivo || !Number.isFinite(r)) { cambio.textContent = ''; return; }
    cambio.className = r >= total ? 'ayuda' : 'deuda';
    cambio.textContent = r >= total ? `Cambio: ${dinero(Math.round((r - total) * 100) / 100)}` : `Faltan ${dinero(Math.round((total - r) * 100) / 100)}`;
  }

  async function cobrar() {
    error.textContent = '';
    const efectivo = metodo.value === 'efectivo';
    const r = parseFloat(recibido.value);
    if (efectivo && Number.isFinite(r) && r + 0.005 < total) { error.textContent = 'El efectivo recibido es menor que el total.'; recibido.focus(); return; }
    boton.disabled = true;
    try {
      await alCobrar({ metodo: metodo.value, recibido: efectivo && Number.isFinite(r) ? r : null });
    } catch (e) {
      boton.disabled = false;
      error.textContent = e.message || String(e);
    }
  }

  pintar();
  return h('div', {},
    h('div', { class: 'totales' }, h('div', { class: 'gran' }, h('span', {}, 'Total a cobrar'), h('span', {}, dinero(total)))),
    h('label', { class: 'etiqueta' }, 'Forma de pago', metodo),
    campoRecibido,
    cambio,
    error,
    h('div', { class: 'acciones' }, boton));
}
