// banco.js - módulo Banco (dentro de Contabilidad). Trece secciones:
// Banco, Cargo Bancario, Cheque, Conciliación, Crédito Bancario, Cambio Tasa, Depósito Bancario, Moneda, Reporte Banco,
// Reporte Dinámico, Solicitud Pago, Tipo de Cuenta y Transferencia Bancaria.
import { h } from './ui.js';
import { vistaBancos } from './conta-ui-bancos.js';
import { seccionMonedas } from './finanzas-monedas.js';
import {
  seccionMovsBanco, seccionCreditos, seccionSolicitudesPago, seccionTiposCuenta, seccionCatalogoMonedas, seccionReporteBanco, seccionDinamicoBanco,
} from './banco-ui.js';

export const SECCIONES_BANCO = [
  ['banco', 'Banco'], ['cargo', 'Cargo Bancario'], ['cheque', 'Cheque'], ['conciliacion', 'Conciliación'], ['credito', 'Crédito Bancario'], ['tasa', 'Cambio Tasa'], ['deposito', 'Depósito Bancario'],
  ['moneda', 'Moneda'], ['reporte', 'Reporte Banco'], ['dinamico', 'Reporte Dinámico'], ['solicitud', 'Solicitud Pago'], ['tipo', 'Tipo de Cuenta'], ['transferencia', 'Transferencia Bancaria'],
];
let seccion = 'banco';

const FN = {
  banco: (r) => vistaBancos(r), cargo: (r, rec) => seccionMovsBanco(r, rec, 'cargo'), cheque: (r, rec) => seccionMovsBanco(r, rec, 'cheque'),
  conciliacion: (r) => vistaBancos(r, { modo: 'conciliacion' }), credito: seccionCreditos, tasa: seccionMonedas, deposito: (r, rec) => seccionMovsBanco(r, rec, 'deposito'),
  moneda: seccionCatalogoMonedas, reporte: seccionReporteBanco, dinamico: seccionDinamicoBanco, solicitud: seccionSolicitudesPago, tipo: seccionTiposCuenta,
  transferencia: (r, rec) => seccionMovsBanco(r, rec, 'transferencia'),
};

export async function vistaBanco(raiz) {
  const cuerpo = h('div');
  const barra = h('div', { class: 'segmento conta-tabs', role: 'tablist', 'aria-label': 'Banco' });
  async function ir(id) {
    seccion = id;
    barra.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    const nueva = h('div');
    try { await FN[id](nueva, () => ir(id), ir); } catch (e) { nueva.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar: ${e.message || e}`)); }
    if (seccion === id) cuerpo.replaceChildren(nueva);
  }
  barra.append(...SECCIONES_BANCO.map(([id, t]) => h('button', { 'data-id': id, role: 'tab', onClick: () => ir(id) }, t)));
  raiz.replaceChildren(barra, cuerpo);
  await ir(seccion);
}
