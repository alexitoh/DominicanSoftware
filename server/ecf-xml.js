// ecf-xml.js (servidor) - arma el XML del comprobante fiscal electrónico (e-CF) y los demás archivos que pide la DGII.
// Sin dependencias. El XML se escribe ya en forma canónica (sin espacios entre etiquetas, etiquetas vacías abiertas y cerradas,
// sin atributos salvo los de la firma) para que la firma digital coincida byte a byte con lo que la DGII calcula al verificarla.
//
// IMPORTANTE: los nombres de las etiquetas, su orden y las tablas de códigos siguen el formato e-CF v1.0 de la DGII según la
// documentación pública. Hay que validarlos contra los XSD oficiales en el ambiente de pruebas (TesteCF) antes de certificar.

export const TIPOS_ECF = {
  31: 'Factura de crédito fiscal electrónica',
  32: 'Factura de consumo electrónica',
  33: 'Nota de débito electrónica',
  34: 'Nota de crédito electrónica',
  41: 'Comprobante electrónico de compras',
  43: 'Comprobante electrónico para gastos menores',
  44: 'Comprobante electrónico para regímenes especiales',
  45: 'Comprobante electrónico gubernamental',
};
// Los que se pueden emitir desde una venta: el comprobante B de siempre → su equivalente electrónico
export const B_A_E = { B01: 'E31', B02: 'E32', B14: 'E44', B15: 'E45' };
export const NOMBRE_E = Object.fromEntries(Object.entries(TIPOS_ECF).map(([k, v]) => [`E${k}`, v]));
export const LIMITE_RFCE = 250000; // las facturas de consumo menores a este monto se informan con un resumen (RFCE)

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const dinero = (n) => r2(n).toFixed(2);
// Precios unitarios: hasta 4 decimales, mínimo 2
export const precioTxt = (n) => {
  let s = (Math.round((Number(n) + Number.EPSILON) * 10000) / 10000).toFixed(4).replace(/0+$/, '');
  if ((s.split('.')[1] || '').length < 2) s = Number(s).toFixed(2);
  return s;
};
export const cantidadTxt = (n) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);

// ---------- Árbol → texto ----------
// nodo = [nombre, texto | [hijos] | atributos?]. Se usan funciones auxiliares para armarlos.
export const el = (nombre, contenido, attrs) => ({ nombre, contenido, attrs });
// Etiqueta con texto; no se escribe si no hay valor (la DGII rechaza etiquetas vacías)
export const t = (nombre, valor) => (valor === undefined || valor === null || valor === '' ? null : el(nombre, String(valor)));
export const g = (nombre, hijos) => {
  const h = hijos.filter(Boolean);
  return h.length ? el(nombre, h) : null;
};

export function escapar(texto) {
  return String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}
const escaparAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
// Caracteres que XML 1.0 no admite (se quitan antes de escribir)
const limpiarTexto = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');

// Forma canónica (C14N 1.0 inclusiva) de un árbol sin espacios ni comentarios. Los atributos salen ordenados por nombre.
export function serializar(nodo) {
  if (!nodo) return '';
  const attrs = nodo.attrs ? Object.keys(nodo.attrs).sort().map((k) => ` ${k}="${escaparAttr(nodo.attrs[k])}"`).join('') : '';
  const dentro = Array.isArray(nodo.contenido) ? nodo.contenido.map(serializar).join('') : escapar(limpiarTexto(nodo.contenido ?? ''));
  return `<${nodo.nombre}${attrs}>${dentro}</${nodo.nombre}>`;
}
export const conDeclaracion = (xml) => `<?xml version="1.0" encoding="utf-8"?>${xml}`;

// ---------- Fechas (hora de República Dominicana, sin horario de verano) ----------
const dosD = (n) => String(n).padStart(2, '0');
// 'AAAA-MM-DD…' → 'dd-MM-AAAA'
export const fechaDGII = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
export function ahoraDR(ms = Date.now()) {
  const d = new Date(ms - 4 * 3600000); // UTC-4 fijo
  return { fecha: `${dosD(d.getUTCDate())}-${dosD(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`, hora: `${dosD(d.getUTCHours())}:${dosD(d.getUTCMinutes())}:${dosD(d.getUTCSeconds())}` };
}
export const fechaHoraFirma = (ms) => { const a = ahoraDR(ms); return `${a.fecha} ${a.hora}`; };

// ---------- Tablas de códigos del formato e-CF ----------
export const FORMA_PAGO = { efectivo: 1, cheque: 2, transferencia: 2, tarjeta: 3, credito: 4 }; // 1 efectivo, 2 cheque/transferencia/depósito, 3 tarjeta, 4 venta a crédito
export const TIPO_INGRESOS = '01'; // ingresos por operaciones (no financieros)
export const UNIDAD_UNIDAD = '43'; // "Unidad"
export const INDICADOR_ITBIS = { 18: 1, 16: 2, 0: 3, exento: 4 };
export const CODIGO_MODIFICACION = { anula: 1, texto: 2, montos: 3, reemplazo_contingencia: 4, consumo: 5 };

// ---------- Líneas y totales ----------
// lineas: [{ nombre, bien = true, cantidad, precio (sin ITBIS), descuento = 0, exento = false, unidad }]
// Cada línea trae su monto base (cantidad × precio − descuento). Devuelve las líneas con `monto` y los totales.
export function calcularTotales(lineas, { tasa = 18, itbisRetenido = 0, isrRetenido = 0, itbisTotal } = {}) {
  const items = lineas.map((l) => {
    const bruto = r2(l.cantidad * l.precio);
    const monto = r2(bruto - (l.descuento || 0));
    return { ...l, monto };
  });
  const gravado = r2(items.filter((i) => !i.exento).reduce((s, i) => s + i.monto, 0));
  const exento = r2(items.filter((i) => i.exento).reduce((s, i) => s + i.monto, 0));
  const itbis = itbisTotal != null ? r2(itbisTotal) : r2(gravado * tasa / 100);
  return { items, gravado, exento, itbis, tasa, total: r2(gravado + exento + itbis), itbisRetenido: r2(itbisRetenido), isrRetenido: r2(isrRetenido) };
}

// Reparte el descuento general y ajusta los centavos para que las líneas sumen exactamente la base indicada.
// lineas: [{ cantidad, precio (unitario YA sin ITBIS), descuento, exento }]; baseGravada/baseExenta: lo que deben sumar las líneas.
export function ajustarLineas(lineas, baseGravada, baseExenta) {
  const out = lineas.map((l) => ({ ...l, descuento: r2(l.descuento || 0) }));
  for (const [esExento, objetivo] of [[false, baseGravada], [true, baseExenta]]) {
    const idx = out.map((l, i) => (!!l.exento === esExento ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const suma = r2(idx.reduce((s, i) => s + (r2(out[i].cantidad * out[i].precio) - out[i].descuento), 0));
    const dif = r2(suma - objetivo); // lo que sobra (descuento que falta repartir)
    if (Math.abs(dif) < 0.005) continue;
    // El resto se carga a la línea de mayor monto
    const mayor = idx.reduce((a, b) => ((out[b].cantidad * out[b].precio - out[b].descuento) > (out[a].cantidad * out[a].precio - out[a].descuento) ? b : a), idx[0]);
    out[mayor].descuento = r2(out[mayor].descuento + dif);
  }
  return out;
}

// ---------- El comprobante ----------
// d = {
//   tipo: '31', encf, vence ('dd-MM-AAAA', según la secuencia), fecha ('dd-MM-AAAA'),
//   emisor: { rnc, razon, comercial, direccion, municipio, provincia, telefono, correo },
//   comprador: { rnc, razon, direccion } | null,
//   tipoPago: 1 | 2, fechaLimitePago, formasPago: [{ forma, monto }],
//   lineas: [...], tasa, itbisTotal, itbisRetenido, isrRetenido,
//   referencia: { ncf, fecha, codigo, razon }, notaCreditoMas30: bool,
//   firmaMs
// }
export function construirECF(d) {
  const tipo = String(d.tipo);
  if (!TIPOS_ECF[tipo]) throw new Error(`Tipo de e-CF no admitido: ${tipo}`);
  if (!/^E\d{12}$/.test(String(d.encf || '')) || d.encf.slice(1, 3) !== tipo) throw new Error(`El e-NCF ${d.encf} no corresponde a un E${tipo}.`);
  if (!d.lineas?.length) throw new Error('El comprobante necesita al menos una línea.');
  const tot = calcularTotales(d.lineas, { tasa: d.tasa ?? 18, itbisTotal: d.itbisTotal, itbisRetenido: d.itbisRetenido, isrRetenido: d.isrRetenido });
  const esNota = tipo === '33' || tipo === '34';
  const sinComprador = tipo === '43';
  const llevaVence = tipo !== '32' && tipo !== '34';
  const llevaIngresos = !['41', '43'].includes(tipo);
  const llevaPago = tipo !== '43';
  const llevaMontoGravado = tipo !== '43';
  const e = d.emisor;

  const idDoc = g('IdDoc', [
    t('TipoeCF', tipo),
    t('eNCF', d.encf),
    llevaVence ? t('FechaVencimientoSecuencia', d.vence) : null,
    tipo === '34' ? t('IndicadorNotaCredito', d.notaCreditoMas30 ? 1 : 0) : null,
    llevaMontoGravado ? t('IndicadorMontoGravado', 0) : null, // los precios del XML van sin ITBIS
    llevaIngresos ? t('TipoIngresos', d.tipoIngresos || TIPO_INGRESOS) : null,
    llevaPago ? t('TipoPago', d.tipoPago || 1) : null,
    llevaPago && Number(d.tipoPago) === 2 ? t('FechaLimitePago', d.fechaLimitePago) : null,
    llevaPago && d.formasPago?.length ? g('TablaFormasPago', d.formasPago.slice(0, 7).map((f) => g('FormaDePago', [t('FormaPago', f.forma), t('MontoPago', dinero(f.monto))]))) : null,
  ]);
  const emisor = g('Emisor', [
    t('RNCEmisor', e.rnc),
    t('RazonSocialEmisor', String(e.razon || '').slice(0, 150)),
    t('NombreComercial', e.comercial ? String(e.comercial).slice(0, 150) : null),
    t('DireccionEmisor', String(e.direccion || 'N/D').slice(0, 100)),
    t('Municipio', e.municipio),
    t('Provincia', e.provincia),
    e.telefono ? g('TablaTelefonoEmisor', [t('TelefonoEmisor', String(e.telefono).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3'))]) : null,
    t('CorreoEmisor', e.correo),
    t('FechaEmision', d.fecha),
  ]);
  const c = d.comprador;
  const comprador = sinComprador || !c || (!c.rnc && !c.razon) ? null : g('Comprador', [
    t('RNCComprador', c.rnc),
    t('RazonSocialComprador', c.razon ? String(c.razon).slice(0, 150) : null),
    t('DireccionComprador', c.direccion ? String(c.direccion).slice(0, 100) : null),
  ]);
  const totales = g('Totales', [
    tot.gravado > 0 ? t('MontoGravadoTotal', dinero(tot.gravado)) : null,
    tot.gravado > 0 ? t('MontoGravadoI1', dinero(tot.gravado)) : null,
    tot.exento > 0 ? t('MontoExento', dinero(tot.exento)) : null,
    tot.gravado > 0 ? t('ITBIS1', tot.tasa) : null,
    tot.gravado > 0 ? t('TotalITBIS', dinero(tot.itbis)) : null,
    tot.gravado > 0 ? t('TotalITBIS1', dinero(tot.itbis)) : null,
    t('MontoTotal', dinero(tot.total)),
    tipo === '41' ? t('TotalITBISRetenido', dinero(tot.itbisRetenido)) : null,
    tipo === '41' ? t('TotalISRRetencion', dinero(tot.isrRetenido)) : null,
  ]);
  const detalles = el('DetallesItems', tot.items.map((it, i) => el('Item', [
    t('NumeroLinea', i + 1),
    t('IndicadorFacturacion', it.exento ? INDICADOR_ITBIS.exento : INDICADOR_ITBIS[tot.tasa] || 1),
    tipo === '41' ? g('Retencion', [t('IndicadorAgenteRetencionoPercepcion', 1), t('MontoITBISRetenido', dinero(i === 0 ? tot.itbisRetenido : 0))]) : null,
    t('NombreItem', String(it.nombre || 'Artículo').slice(0, 80)),
    t('IndicadorBienoServicio', it.bien === false ? 2 : 1),
    t('CantidadItem', cantidadTxt(it.cantidad)),
    t('UnidadMedida', it.unidad || UNIDAD_UNIDAD),
    t('PrecioUnitarioItem', precioTxt(it.precio)),
    it.descuento > 0 ? t('DescuentoMonto', dinero(it.descuento)) : null,
    it.descuento > 0 ? g('TablaSubDescuento', [g('SubDescuento', [t('TipoSubDescuento', '$'), t('MontoSubDescuento', dinero(it.descuento))])]) : null,
    t('MontoItem', dinero(it.monto)),
  ])));
  const ref = esNota && d.referencia ? g('InformacionReferencia', [
    t('NCFModificado', d.referencia.ncf),
    t('FechaNCFModificado', d.referencia.fecha),
    t('CodigoModificacion', d.referencia.codigo || CODIGO_MODIFICACION.montos),
    t('RazonModificacion', d.referencia.razon ? String(d.referencia.razon).slice(0, 90) : null),
  ]) : null;
  if (esNota && !ref) throw new Error('Las notas de crédito y débito necesitan el comprobante que modifican.');
  const raiz = el('ECF', [
    el('Encabezado', [t('Version', '1.0'), idDoc, emisor, comprador, totales].filter(Boolean)),
    detalles,
    ref,
    t('FechaHoraFirma', fechaHoraFirma(d.firmaMs)),
  ].filter(Boolean));
  return { raiz, totales: tot };
}

// ---------- Resumen de factura de consumo (RFCE) ----------
// Se envía en lugar del e-CF completo cuando la factura de consumo es menor de RD$250,000. `ecf` es el resultado de construirECF y
// `codigoSeguridad` los 6 caracteres tomados de la firma del e-CF completo.
export function construirRFCE(d, totales, codigoSeguridad) {
  const c = d.comprador;
  return el('RFCE', [
    el('Encabezado', [
      t('Version', '1.0'),
      g('IdDoc', [t('TipoeCF', '32'), t('eNCF', d.encf), t('TipoIngresos', d.tipoIngresos || TIPO_INGRESOS), t('TipoPago', d.tipoPago || 1),
        d.formasPago?.length ? g('TablaFormasPago', d.formasPago.slice(0, 7).map((f) => g('FormaDePago', [t('FormaPago', f.forma), t('MontoPago', dinero(f.monto))]))) : null]),
      g('Emisor', [t('RNCEmisor', d.emisor.rnc), t('RazonSocialEmisor', String(d.emisor.razon || '').slice(0, 150)), t('FechaEmision', d.fecha)]),
      c && (c.rnc || c.razon) ? g('Comprador', [t('RNCComprador', c.rnc), t('RazonSocialComprador', c.razon ? String(c.razon).slice(0, 150) : null)]) : null,
      g('Totales', [
        totales.gravado > 0 ? t('MontoGravadoTotal', dinero(totales.gravado)) : null,
        totales.gravado > 0 ? t('MontoGravadoI1', dinero(totales.gravado)) : null,
        totales.exento > 0 ? t('MontoExento', dinero(totales.exento)) : null,
        totales.gravado > 0 ? t('TotalITBIS', dinero(totales.itbis)) : null,
        totales.gravado > 0 ? t('TotalITBIS1', dinero(totales.itbis)) : null,
        t('MontoTotal', dinero(totales.total)),
      ]),
      t('CodigoSeguridadeCF', codigoSeguridad),
    ].filter(Boolean)),
  ]);
}

// ---------- Anulación de rangos de e-NCF (los números que no se usaron) ----------
export function construirANECF({ rnc, tipo, desde, hasta, ms }) {
  const cantidad = hasta - desde + 1;
  const pref = `E${String(tipo).padStart(2, '0')}`;
  const sec = (n) => `${pref}${String(n).padStart(10, '0')}`;
  return el('ANECF', [
    el('Encabezado', [t('Version', '1.0'), t('RncEmisor', rnc), t('CantidadeNCFAnulados', cantidad), t('FechaHoraAnulacioneNCF', fechaHoraFirma(ms))]),
    el('DetalleAnulacion', [el('Anulacion', [
      t('NoLinea', 1), t('TipoeCF', String(tipo)),
      el('TablaRangoSecuenciasAnuladoseNCF', [el('Secuencias', [t('SecuenciaeNCFDesde', sec(desde)), t('SecuenciaeNCFHasta', sec(hasta))])]),
      t('CantidadeNCFAnulados', cantidad),
    ])]),
  ]);
}

// ---------- Dirección de verificación que va en el código QR ----------
const AMBIENTE_QR = { testecf: 'TestECF', certecf: 'CertECF', ecf: 'ecf' };
const codif = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function urlQR({ ambiente = 'testecf', rncEmisor, rncComprador, encf, fechaEmision, montoTotal, fechaFirma, codigoSeguridad, resumen = false }) {
  const amb = AMBIENTE_QR[ambiente] || 'TestECF';
  if (resumen) return `https://fc.dgii.gov.do/${amb}/ConsultaTimbreFC?RncEmisor=${codif(rncEmisor)}&ENCF=${codif(encf)}&MontoTotal=${codif(dinero(montoTotal))}&CodigoSeguridad=${codif(codigoSeguridad)}`;
  const partes = [`RncEmisor=${codif(rncEmisor)}`];
  if (rncComprador) partes.push(`RncComprador=${codif(rncComprador)}`);
  partes.push(`ENCF=${codif(encf)}`, `FechaEmision=${codif(fechaEmision)}`, `MontoTotal=${codif(dinero(montoTotal))}`, `FechaFirma=${codif(fechaFirma)}`, `CodigoSeguridad=${codif(codigoSeguridad)}`);
  return `https://ecf.dgii.gov.do/${amb}/ConsultaTimbre?${partes.join('&')}`;
}
