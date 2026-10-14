// recibo-pdf.js - recibo de ingreso en PDF
import { jsPDF } from 'jspdf';
import { consultar } from './database.js';
import { dinero } from './ui.js';
import { traducir } from './i18n.js';
import { textoDocumento } from './fiscal.js';
import { fechaLegible, medirImagen, entregarPDF, idiomaDocumento } from './factura.js';

const NOMBRES = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque' };

export async function crearPDFRecibo(reciboId) {
  const [r] = await consultar(
    `SELECT r.*, c.nombre AS cliente, c.telefono AS cliente_tel, c.tipo_doc, c.documento, u.nombre AS cobrador
       FROM recibos r JOIN clientes c ON c.id = r.cliente_id LEFT JOIN usuarios u ON u.id = r.usuario_id WHERE r.id = ?`, [reciboId]);
  if (!r) throw new Error('El recibo no existe');
  const metodos = await consultar('SELECT * FROM recibo_metodos WHERE recibo_id = ? ORDER BY id', [reciboId]);
  const facturas = await consultar(
    `SELECT v.id, v.numero, v.total, SUM(p.monto) AS aplicado,
            v.total - COALESCE((SELECT SUM(x.monto) FROM pagos x WHERE x.venta_id = v.id), 0) AS saldo
       FROM pagos p JOIN ventas v ON v.id = p.venta_id WHERE p.recibo_id = ? GROUP BY v.id ORDER BY v.id`, [reciboId]);
  const cfg = Object.fromEntries((await consultar('SELECT clave, valor FROM config')).map((x) => [x.clave, x.valor]));
  const lang = await idiomaDocumento();
  const L = (t) => traducir(t, lang);

  const doc = new jsPDF({ unit: 'mm', format: 'a5' });
  const M = 12;
  const DER = 148 - M;
  let y = 16;

  let xTexto = M;
  let finLogo = 0;
  if (cfg.negocio_logo) {
    const medida = await medirImagen(cfg.negocio_logo);
    if (medida) {
      const k = Math.min(20 / medida.h, 38 / medida.w);
      try {
        doc.addImage(cfg.negocio_logo, cfg.negocio_logo.startsWith('data:image/png') ? 'PNG' : 'JPEG', M, 9, medida.w * k, medida.h * k);
        xTexto = M + medida.w * k + 4;
        finLogo = 9 + medida.h * k;
      } catch { /* sin logo */ }
    }
  }
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(21, 33, 43);
  doc.text(doc.splitTextToSize(cfg.negocio_nombre || 'Mi negocio', DER - xTexto - 36)[0], xTexto, y);
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(90);
  doc.text(L('RECIBO DE INGRESO'), DER, y - 5, { align: 'right' });
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(21, 33, 43);
  doc.text(r.numero, DER, y + 1, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90);
  if (cfg.negocio_telefono) { y += 5; doc.text(L(`Tel. ${cfg.negocio_telefono}`), xTexto, y); }
  if (cfg.negocio_direccion) { y += 4; doc.text(doc.splitTextToSize(cfg.negocio_direccion, DER - xTexto)[0], xTexto, y); }
  y = Math.max(y, finLogo) + 6;
  doc.setDrawColor(200).line(M, y, DER, y);

  y += 6;
  doc.setTextColor(21, 33, 43);
  doc.text(L(`Fecha: ${fechaLegible(r.fecha)}`), M, y);
  y += 5;
  doc.text(`${L('Recibimos de')}: ${doc.splitTextToSize(r.cliente, 80)[0]}`, M, y);
  if (r.documento) { y += 5; doc.text(L(textoDocumento(r.tipo_doc, r.documento)), M, y); }

  const encabezado = (a, b, c) => {
    y += 8;
    doc.setFont('helvetica', 'bold').setFontSize(9);
    doc.setFillColor(237, 240, 242).rect(M, y - 4.5, DER - M, 7, 'F');
    doc.text(L(a), M + 2, y);
    if (b) doc.text(L(b), 100, y, { align: 'right' });
    doc.text(L(c), DER - 2, y, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    y += 7;
  };

  encabezado('Facturas pagadas', 'Pendiente', 'Aplicado');
  for (const f of facturas) {
    if (y > 180) { doc.addPage(); y = 16; }
    doc.text(f.numero, M + 2, y);
    doc.text(dinero(Math.max(0, f.saldo)), 100, y, { align: 'right' });
    doc.text(dinero(f.aplicado), DER - 2, y, { align: 'right' });
    y += 5.5;
  }

  encabezado('Forma de pago', '', 'Monto');
  for (const m of metodos) {
    if (y > 180) { doc.addPage(); y = 16; }
    const txt = `${L(NOMBRES[m.metodo] || m.metodo)}${m.referencia ? ` (${m.referencia})` : ''}`;
    doc.text(doc.splitTextToSize(txt, 90)[0], M + 2, y);
    doc.text(dinero(m.monto), DER - 2, y, { align: 'right' });
    y += 5.5;
  }

  doc.setDrawColor(200).line(M, y - 2, DER, y - 2);
  y += 5;
  doc.setFont('helvetica', 'bold').setFontSize(12);
  doc.text(L('TOTAL RECIBIDO'), 100, y, { align: 'right' });
  doc.text(dinero(r.total), DER - 2, y, { align: 'right' });
  if (r.notas) {
    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(90);
    y += 7;
    doc.text(doc.splitTextToSize(r.notas, DER - M), M, y);
  }
  doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(90);
  doc.setDrawColor(150).line(M, 192, 70, 192);
  doc.text(L(r.cobrador ? `Recibido por: ${r.cobrador}` : 'Recibido por'), M, 196);

  if (r.estado === 'anulado') {
    doc.setFont('helvetica', 'bold').setFontSize(46).setTextColor(200, 64, 47);
    doc.text(L('ANULADO'), 74, 110, { align: 'center', angle: 30 });
  }
  return doc.output('datauristring').split(',')[1];
}

export async function compartirRecibo(reciboId) {
  const base64 = await crearPDFRecibo(reciboId);
  const [r] = await consultar('SELECT numero FROM recibos WHERE id = ?', [reciboId]);
  const lang = await idiomaDocumento();
  await entregarPDF(base64, `${lang === 'en' ? 'receipt' : 'recibo'}-${r.numero}.pdf`,
    traducir(`Recibo ${r.numero}`, lang), traducir('Enviar recibo', lang));
}
