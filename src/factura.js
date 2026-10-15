// factura.js - genera la factura en PDF y la comparte (WhatsApp, correo, Drive...)
// Requiere: npm install jspdf
import { NOMBRE_COMPROBANTE } from './itbis.js';
import { jsPDF } from 'jspdf';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { consultar, esWeb, descargarArchivo } from './database.js';
import { dinero } from './ui.js';
import { traducir, getIdioma } from './i18n.js';
import { textoDocumento } from './fiscal.js';

const METODOS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque', credito: 'Crédito' };

export function fechaLegible(f) {
  // "2026-10-12 14:20:05" -> "12/10/2026 14:20"
  const [d, hora] = String(f).split(' ');
  const [a, m, dia] = d.split('-');
  return `${dia}/${m}/${a} ${hora?.slice(0, 5) ?? ''}`.trim();
}

// Mide el logo guardado (data URL) para poder dibujarlo sin deformarlo
export function medirImagen(dataUrl) {
  return new Promise((ok) => {
    const img = new Image();
    img.onload = () => ok({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => ok(null);
    img.src = dataUrl;
  });
}

export async function crearPDF(ventaId) {
  const [v] = await consultar(
    `SELECT v.*, c.nombre AS cliente, c.telefono AS cliente_tel, c.tipo_doc AS cliente_tipo_doc, c.documento AS cliente_doc
       FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id WHERE v.id = ?`, [ventaId]);
  if (!v) throw new Error('La venta no existe');
  const items = await consultar(
    `SELECT d.*, p.nombre FROM venta_detalle d
       JOIN productos p ON p.id = d.producto_id WHERE d.venta_id = ? ORDER BY d.id`, [ventaId]);
  const servicios = await consultar('SELECT * FROM venta_servicios WHERE venta_id = ? ORDER BY id', [ventaId]);
  const [cobro] = await consultar('SELECT vence FROM cuentas_cobrar WHERE venta_id = ?', [ventaId]);
  const garantias = await consultar('SELECT * FROM garantias WHERE venta_id = ? ORDER BY id', [ventaId]);
  const cfg = Object.fromEntries((await consultar('SELECT clave, valor FROM config')).map((r) => [r.clave, r.valor]));

  const [{ pagado }] = await consultar('SELECT COALESCE(SUM(monto), 0) AS pagado FROM pagos WHERE venta_id = ?', [ventaId]);

  // Idioma de la factura: el de la app o el que se haya elegido en Ajustes
  const lang = cfg.idioma_factura === 'es' || cfg.idioma_factura === 'en' ? cfg.idioma_factura : getIdioma();
  const L = (texto) => traducir(texto, lang);

  const doc = new jsPDF({ unit: 'mm', format: 'a5' }); // 148 x 210 mm
  const M = 12;
  const DER = 148 - M;
  let y = 16;

  // Encabezado del negocio (con el logo a la izquierda, si hay uno guardado)
  let xTexto = M;
  let finLogo = 0;
  if (cfg.negocio_logo) {
    const medida = await medirImagen(cfg.negocio_logo);
    if (medida) {
      const altoMax = 20;
      const anchoMax = 38;
      const r = Math.min(altoMax / medida.h, anchoMax / medida.w);
      const w = medida.w * r;
      const hLogo = medida.h * r;
      try {
        doc.addImage(cfg.negocio_logo, cfg.negocio_logo.startsWith('data:image/png') ? 'PNG' : 'JPEG', M, 9, w, hLogo);
        xTexto = M + w + 4;
        finLogo = 9 + hLogo;
      } catch { /* si el logo no se puede dibujar, la factura sale sin él */ }
    }
  }
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(21, 33, 43);
  doc.text(doc.splitTextToSize(cfg.negocio_nombre || 'Mi negocio', DER - xTexto - 32)[0], xTexto, y);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90);
  const tipoCpb = v.ncf ? NOMBRE_COMPROBANTE[String(v.ncf).slice(0, 3)] : null;
  doc.text(L(tipoCpb || 'FACTURA').toUpperCase(), DER, y - 5, { align: 'right' });
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(21, 33, 43);
  doc.text(v.numero, DER, y + 1, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90);
  if (cfg.negocio_telefono) { y += 5; doc.text(L(`Tel. ${cfg.negocio_telefono}`), xTexto, y); }
  if (cfg.negocio_direccion) { y += 4; doc.text(doc.splitTextToSize(cfg.negocio_direccion, DER - xTexto)[0], xTexto, y); }
  y = Math.max(y, finLogo);

  y += 6;
  doc.setDrawColor(200).line(M, y, DER, y);

  // Datos de la venta
  y += 6;
  doc.setTextColor(21, 33, 43);
  doc.text(L(`Fecha: ${fechaLegible(v.fecha)}`), M, y);
  doc.text(`${L('Pago')}: ${L(METODOS[v.metodo_pago] || v.metodo_pago)}`, DER, y, { align: 'right' });
  y += 5;
  doc.text(`${L('Cliente')}: ${L(v.cliente || v.cliente_nombre || 'Cliente general')}`, M, y);
  if (v.cliente_tel) doc.text(L(`Tel. ${v.cliente_tel}`), DER, y, { align: 'right' });
  if (v.ncf) { y += 5; doc.text(`${L('Comprobante')}: ${L(tipoCpb || '')}`, M, y); doc.text(`NCF: ${v.ncf}`, DER, y, { align: 'right' }); }
  if (v.cliente_doc) { y += 5; doc.text(`${L(textoDocumento(v.cliente_tipo_doc, v.cliente_doc))}`, M, y); }

  // Tabla de productos
  y += 7;
  doc.setFont('helvetica', 'bold').setFontSize(9);
  doc.setFillColor(237, 240, 242).rect(M, y - 4.5, DER - M, 7, 'F');
  doc.text(L('Cant.'), M + 2, y);
  doc.text(L('Descripción'), M + 16, y);
  doc.text(L('Precio'), 108, y, { align: 'right' });
  doc.text(L('Importe'), DER - 2, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  y += 7;

  for (const it of items) {
    const lineas = doc.splitTextToSize(it.nombre, 62);
    const alto = lineas.length * 4.2 + 2;
    if (y + alto > 185) { doc.addPage(); y = 16; }
    doc.text(String(it.cantidad), M + 2, y);
    doc.text(lineas, M + 16, y);
    doc.text(dinero(it.precio_unitario), 108, y, { align: 'right' });
    doc.text(dinero(it.cantidad * it.precio_unitario - (it.descuento || 0)), DER - 2, y, { align: 'right' });
    y += alto;
    const g = garantias.find((x) => x.producto_id === it.producto_id);
    if (g) {
      const txt = `${L('Garantía')} ${g.meses} ${L(g.meses === 1 ? 'mes' : 'meses')}, ${L('hasta')} ${g.vence.split('-').reverse().join('/')}${g.serie ? `. ${L('Serie')}: ${g.serie}` : ''}`;
      doc.setFontSize(7.5).setTextColor(110);
      const lg = doc.splitTextToSize(txt, 80);
      doc.text(lg, M + 16, y - 1);
      y += lg.length * 3.2 + 1;
      doc.setFontSize(9).setTextColor(21, 33, 43);
    }
  }

  for (const sv of servicios) {
    const lineas = doc.splitTextToSize(sv.descripcion, 62);
    const alto = lineas.length * 4.2 + 2;
    if (y + alto > 185) { doc.addPage(); y = 16; }
    doc.text(String(sv.cantidad), M + 2, y);
    doc.text(lineas, M + 16, y);
    doc.text(dinero(sv.precio_unitario), 108, y, { align: 'right' });
    doc.text(dinero(sv.cantidad * sv.precio_unitario), DER - 2, y, { align: 'right' });
    y += alto;
  }

  // Totales
  if (y > 175) { doc.addPage(); y = 16; }
  doc.setDrawColor(200).line(M, y - 2, DER, y - 2);
  y += 4;
  doc.text(L('Subtotal'), 100, y, { align: 'right' });
  doc.text(dinero(v.subtotal), DER - 2, y, { align: 'right' });
  if (v.descuento > 0) {
    y += 5;
    doc.text(L('Descuento'), 100, y, { align: 'right' });
    doc.text(`- ${dinero(v.descuento)}`, DER - 2, y, { align: 'right' });
  }
  const itbisSumado = v.itbis > 0 && Math.abs(v.total - (v.subtotal - v.descuento) - v.itbis) < 0.01;
  if (itbisSumado) {
    y += 5;
    doc.text(L('ITBIS'), 100, y, { align: 'right' });
    doc.text(dinero(v.itbis), DER - 2, y, { align: 'right' });
  }
  y += 7;
  doc.setFont('helvetica', 'bold').setFontSize(12);
  doc.text(L('TOTAL'), 100, y, { align: 'right' });
  doc.text(dinero(v.total), DER - 2, y, { align: 'right' });
  if (v.itbis > 0 && !itbisSumado) {
    y += 5;
    doc.setFont('helvetica', 'normal').setFontSize(9);
    doc.text(L(`ITBIS incluido: ${dinero(v.itbis)}`), DER - 2, y, { align: 'right' });
  }

  if (v.metodo_pago === 'credito') {
    doc.setFont('helvetica', 'normal').setFontSize(10);
    y += 7;
    doc.text(L('Abonado'), 100, y, { align: 'right' });
    doc.text(dinero(pagado), DER - 2, y, { align: 'right' });
    y += 5;
    doc.setFont('helvetica', 'bold');
    doc.text(L('Saldo pendiente'), 100, y, { align: 'right' });
    doc.text(dinero(Math.max(0, v.total - pagado)), DER - 2, y, { align: 'right' });
    if (cobro?.vence) {
      y += 5;
      doc.setFont('helvetica', 'normal').setFontSize(9);
      doc.text(`${L('Fecha límite')}: ${cobro.vence.split('-').reverse().join('/')}`, DER - 2, y, { align: 'right' });
    }
  }

  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90);
  y += 12;
  doc.text(L('Gracias por su compra.'), 74, y, { align: 'center' });

  if (v.estado === 'anulada') {
    doc.setFont('helvetica', 'bold').setFontSize(46).setTextColor(200, 64, 47);
    doc.text(L('ANULADA'), 74, 110, { align: 'center', angle: 30 });
  }

  // base64 sin el prefijo "data:application/pdf;..."
  return doc.output('datauristring').split(',')[1];
}

// Guarda el PDF y abre el menú de compartir (en el navegador lo descarga)
export async function entregarPDF(base64, path, titulo, dialogo) {
  if (esWeb) { // modo prueba en el navegador: se descarga el PDF
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    descargarArchivo(path, new Blob([bytes], { type: 'application/pdf' }));
    return;
  }
  await Filesystem.writeFile({ path, data: base64, directory: Directory.Cache });
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  await Share.share({ title: titulo, url: uri, dialogTitle: dialogo });
}

export async function idiomaDocumento() {
  const [ci] = await consultar("SELECT valor FROM config WHERE clave = 'idioma_factura'");
  return ci?.valor === 'es' || ci?.valor === 'en' ? ci.valor : getIdioma();
}

export async function compartirFactura(ventaId) {
  const base64 = await crearPDF(ventaId);
  const [v] = await consultar('SELECT numero FROM ventas WHERE id = ?', [ventaId]);
  const lang = await idiomaDocumento();
  await entregarPDF(base64, `${lang === 'en' ? 'invoice' : 'factura'}-${v.numero}.pdf`,
    traducir(`Factura ${v.numero}`, lang), traducir('Enviar factura', lang));
}
