// orden-compra-imp.js - Orden de compra impresa: el documento que se le lleva al suplidor para autorizar el despacho (contado o crédito)
import { consultar } from './database.js';
import { imprimirHTML } from './impresion.js';
import { detalleOrden } from './cxp-db.js';

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dinero = (n) => 'RD$ ' + Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const textoPagoOrden = (o) => (o.condicion === 'credito' ? `Crédito a ${o.dias_credito ?? 0} días` : 'Contado');

export async function ordenCompraHTML(id) {
  const o = await detalleOrden(id);
  const cfg = Object.fromEntries((await consultar('SELECT clave, valor FROM config')).map((r) => [r.clave, r.valor]));
  const autorizada = o.estado === 'autorizada' || o.estado === 'recibida';
  const filas = o.items.map((i) => `<tr><td>${esc(i.nombre)}</td><td class="n">${esc(i.cantidad)}</td><td class="n">${dinero(i.costo_unitario)}</td><td class="n">${dinero(i.cantidad * i.costo_unitario)}</td></tr>`).join('');
  return `<style>body{font-family:Arial,sans-serif;font-size:13px;color:#111;margin:24px}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{border-bottom:1px solid #ccc;padding:6px;text-align:left}.n{text-align:right}.caja{border:1px solid #999;padding:8px;margin-top:10px}.firmas{display:flex;gap:40px;margin-top:60px}.firmas div{flex:1;border-top:1px solid #111;text-align:center;padding-top:4px}</style>
<h1>${esc(cfg.negocio_nombre || 'Mi negocio')}</h1>
<div>${[cfg.negocio_rnc && 'RNC ' + esc(cfg.negocio_rnc), esc(cfg.negocio_telefono), esc(cfg.negocio_direccion)].filter(Boolean).join(' · ')}</div>
<h2>ORDEN DE COMPRA ${esc(o.numero)}</h2>
<div class="caja"><b>Suplidor:</b> ${esc(o.proveedor)}${o.proveedor_doc ? ' · ' + esc(o.proveedor_doc) : ''}${o.proveedor_tel ? ' · ' + esc(o.proveedor_tel) : ''}<br>
<b>Fecha:</b> ${esc(o.fecha)}${o.entrega ? ' · <b>Entrega esperada:</b> ' + esc(o.entrega) : ''}<br>
<b>Forma de pago autorizada:</b> ${textoPagoOrden(o)}<br>
<b>Estado:</b> ${autorizada ? 'AUTORIZADA para despacho por ' + esc(o.autorizado_por || '') + ' el ' + esc(o.autorizada_fecha || '') : o.estado === 'anulada' ? 'ANULADA' : 'PENDIENTE DE AUTORIZACIÓN (no despachar)'}</div>
<table><thead><tr><th>Producto</th><th class="n">Cant.</th><th class="n">Costo</th><th class="n">Importe</th></tr></thead><tbody>${filas}</tbody>
<tfoot><tr><th colspan="3" class="n">Total estimado</th><th class="n">${dinero(o.total)}</th></tr></tfoot></table>
${o.notas ? `<p><b>Notas:</b> ${esc(o.notas)}</p>` : ''}
<div class="firmas"><div>Autorizado por</div><div>Recibido por el suplidor</div></div>`;
}

export async function imprimirOrdenCompra(id) { await imprimirHTML(await ordenCompraHTML(id)); }
