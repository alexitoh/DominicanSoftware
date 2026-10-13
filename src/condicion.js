// condicion.js - condición de pago de clientes y proveedores: contado o crédito con días para pagar
import { h } from './ui.js';

export const DIAS_POR_DEFECTO = 30;

// Texto corto para listas: "Contado", "Crédito, 30 días" o "" si no está definida
export function textoCondicion(e) {
  if (e?.condicion === 'contado') return 'Contado';
  if (e?.condicion === 'credito') return `Crédito, ${e.dias_credito ?? DIAS_POR_DEFECTO} días`;
  return '';
}

// Campos "Condición de pago" y "Días para pagar" para los formularios.
// `e` es el cliente o proveedor que se edita (o null si es nuevo). valores() devuelve { condicion, dias } o { error }.
export function campoCondicion(e = null) {
  const sinDefinir = e && !e.condicion;
  const select = h('select', { class: 'campo', 'aria-label': 'Condición de pago', onChange: () => actualizar() },
    sinDefinir ? h('option', { value: '' }, 'Sin definir') : null,
    h('option', { value: 'contado' }, 'Contado'),
    h('option', { value: 'credito' }, 'Crédito'));
  select.value = e?.condicion || (sinDefinir ? '' : 'contado');
  const dias = h('input', {
    class: 'campo', type: 'number', inputmode: 'numeric', min: '0', step: '1',
    value: e?.dias_credito ?? DIAS_POR_DEFECTO, 'aria-label': 'Días para pagar',
  });
  const bloqueDias = h('label', { class: 'etiqueta' }, 'Días para pagar', dias,
    h('small', { class: 'ayuda' }, 'Cuántos días tiene para pagar después de comprar.'));
  const actualizar = () => { bloqueDias.hidden = select.value !== 'credito'; };
  actualizar();

  return {
    el: h('div', { class: 'cuerpo sin-borde' }, h('label', { class: 'etiqueta' }, 'Condición de pago', select), bloqueDias),
    valores() {
      if (select.value !== 'credito') return { condicion: select.value || null, dias: null };
      const d = parseInt(dias.value, 10);
      if (!(d >= 0)) return { error: 'Escribe los días para pagar (puede ser 0).', foco: dias };
      return { condicion: 'credito', dias: d };
    },
  };
}
