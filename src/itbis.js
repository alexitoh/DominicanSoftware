// itbis.js - cálculo del ITBIS y formatos de la DGII (606 y 607). Sin dependencias: se prueba solo.
import { limpiarDocumento } from './fiscal.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Modo 'incluido': los precios ya traen el ITBIS. Se saca de lo gravado (después del descuento general).
// lineas: [{ neto, exento }]  (neto = cantidad × precio − descuento de línea)
// Modo 'adicional': los precios son netos y el ITBIS se suma encima (precio + 18 %).
export function calcularItbis({ lineas, descuento = 0, tasa = 18, modo = 'adicional' }) {
  if ((modo !== 'incluido' && modo !== 'adicional') || !(tasa > 0)) return 0;
  const subtotal = lineas.reduce((s, l) => s + l.neto, 0);
  if (!(subtotal > 0)) return 0;
  const gravado = lineas.filter((l) => !l.exento).reduce((s, l) => s + l.neto, 0);
  const gravadoNeto = gravado - descuento * (gravado / subtotal);
  return r2(modo === 'adicional' ? gravadoNeto * tasa / 100 : gravadoNeto * tasa / (100 + tasa));
}

// ---------- NCF ----------
export const TIPOS_NCF = { B01: 'Crédito fiscal', B02: 'Consumo', B14: 'Régimen especial', B15: 'Gubernamental' };
// Comprobante que le corresponde a un cliente: el que se le fijó, o el que sale de su RNC y del régimen que tiene en la DGII.
// Sin RNC (9 números) = consumidor final B02. RNC que empieza con 4 = institución del Estado (B15). Régimen especial o zona franca = B14. Si no, B01.
// Es una sugerencia: siempre se puede elegir otro tipo al facturar o fijarlo en la ficha del cliente.
export function comprobanteDeCliente(c) {
  const fijo = String(c?.tipo_comprobante || '').toUpperCase();
  if (TIPOS_NCF[fijo]) return { tipo: fijo, motivo: 'fijado en la ficha del cliente' };
  const doc = limpiarDocumento(c?.documento);
  if (doc.length !== 9) return { tipo: 'B02', motivo: 'cliente sin RNC: consumidor final' };
  const reg = String(c?.regimen_dgii || '').toUpperCase();
  if (doc.startsWith('4')) return { tipo: 'B15', motivo: 'RNC de institución del Estado' };
  if (/ESPECIAL|ZONA.*FRANCA|FRANCA/.test(reg)) return { tipo: 'B14', motivo: `régimen ${c.regimen_dgii} en la DGII` };
  return { tipo: 'B01', motivo: 'cliente con RNC' };
}

// Nombre que lleva la factura según el comprobante
export const NOMBRE_COMPROBANTE = { B01: 'Factura de crédito fiscal', B02: 'Factura de consumo', B14: 'Factura de régimen especial', B15: 'Factura gubernamental' };
export const formatearNCF = (tipo, n) => `${tipo}${String(n).padStart(8, '0')}`;
export const ncfValido = (s) => /^[BE]\d{2}\d{8,10}$/.test(String(s || '').toUpperCase());

// ---------- Fechas y números para los archivos ----------
const aaaammdd = (f) => String(f || '').slice(0, 10).replace(/-/g, '');
const num = (n) => (Math.abs(n) < 0.005 ? '0.00' : r2(n).toFixed(2));
const tipoId = (doc) => (limpiarDocumento(doc).length === 9 ? '1' : '2'); // 1 = RNC, 2 = cédula

// Venta → columna de forma de cobro del 607
function columnasPago607(v) {
  const c = { efectivo: 0, cheque: 0, tarjeta: 0, credito: 0 };
  if (v.metodo_pago === 'credito') c.credito = v.total;
  else if (v.metodo_pago === 'tarjeta') c.tarjeta = v.total;
  else if (v.metodo_pago === 'transferencia' || v.metodo_pago === 'cheque') c.cheque = v.total;
  else c.efectivo = v.total;
  return c;
}

// ventas: [{ncf, fecha, total, itbis, metodo_pago, documento}] → filas del 607 (23 columnas)
export function filas607(ventas) {
  return ventas.filter((v) => v.ncf).map((v) => {
    const p = columnasPago607(v);
    const doc = limpiarDocumento(v.documento);
    return [
      doc, doc ? tipoId(doc) : '', String(v.ncf).toUpperCase(), '', '01', aaaammdd(v.fecha), '',
      num(v.total - v.itbis), num(v.itbis), '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00',
      num(p.efectivo), num(p.cheque), num(p.tarjeta), num(p.credito), '0.00', '0.00', '0.00',
    ];
  });
}

const FORMA_PAGO_606 = { efectivo: '01', cheque: '02', transferencia: '02', tarjeta: '03', credito: '04' };

// compras/gastos con comprobante: [{ncf, fecha, fecha_pago, total, itbis, documento, tipo_bs, bienes(bool), forma}]
export function filas606(docs) {
  return docs.filter((d) => d.ncf).map((d) => {
    const base = d.total - d.itbis;
    const doc = limpiarDocumento(d.documento);
    return [
      doc, doc ? tipoId(doc) : '', d.tipo_bs || (d.bienes ? '09' : '02'), String(d.ncf).toUpperCase(), '',
      aaaammdd(d.fecha), aaaammdd(d.fecha_pago || (d.forma === 'credito' ? '' : d.fecha)),
      d.bienes ? '0.00' : num(base), d.bienes ? num(base) : '0.00', num(base), num(d.itbis),
      '0.00', '0.00', num(d.itbis), '0.00', '0.00', '', '0.00', '0.00', '0.00', '0.00', '0.00',
      FORMA_PAGO_606[d.forma] || '01',
    ];
  });
}

// Archivo de envío: encabezado FORMATO|RNC|PERIODO|CANTIDAD y una línea por registro separada con "|".
// La estructura exacta debe validarse con la herramienta de pre-validación de la DGII antes de enviarla.
export function textoDGII(formato, rnc, periodo, filas) {
  const enc = [formato, limpiarDocumento(rnc), periodo, String(filas.length)].join('|');
  return [enc, ...filas.map((f) => f.join('|'))].join('\r\n') + '\r\n';
}
export const nombreArchivoDGII = (formato, rnc, periodo) => `DGII_F_${formato}_${limpiarDocumento(rnc)}_${periodo}.TXT`;

export const ENCABEZADOS_607 = ['RNC/Cédula', 'Tipo ID', 'NCF', 'NCF modificado', 'Tipo ingreso', 'Fecha', 'Fecha retención', 'Monto facturado', 'ITBIS facturado', 'ITBIS retenido', 'ITBIS percibido', 'Retención renta', 'ISR percibido', 'Selectivo', 'Otros impuestos', 'Propina', 'Efectivo', 'Cheque/Transf.', 'Tarjeta', 'Crédito', 'Bonos', 'Permuta', 'Otras formas'];
export const ENCABEZADOS_606 = ['RNC/Cédula', 'Tipo ID', 'Tipo bienes/servicios', 'NCF', 'NCF modificado', 'Fecha comprobante', 'Fecha pago', 'Monto servicios', 'Monto bienes', 'Total facturado', 'ITBIS facturado', 'ITBIS retenido', 'ITBIS proporcionalidad', 'ITBIS al costo', 'ITBIS por adelantar', 'ITBIS percibido', 'Tipo retención ISR', 'Retención renta', 'ISR percibido', 'Selectivo', 'Otros impuestos', 'Propina', 'Forma de pago'];

export function csv(encabezados, filas) {
  const celda = (x) => (/[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x));
  return '﻿' + [encabezados, ...filas].map((f) => f.map(celda).join(',')).join('\r\n') + '\r\n';
}
