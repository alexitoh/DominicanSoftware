// ecf.js (servidor) - facturación electrónica (e-CF): arma el comprobante de cada venta, lo firma con el certificado del negocio,
// lo envía a la DGII, consulta el resultado y publica el estado a los equipos (tabla sincronizada "ecf_documentos").
// El certificado y su contraseña se guardan cifrados y nunca salen del servidor.
import crypto from 'node:crypto';
import { construirECF, construirRFCE, construirANECF, ajustarLineas, calcularTotales, fechaDGII, fechaHoraFirma, urlQR, FORMA_PAGO, LIMITE_RFCE, TIPOS_ECF, serializar, conDeclaracion } from './ecf-xml.js';
import { leerP12, firmarArbol, codigoSeguridad } from './ecf-firma.js';
import { crearClienteDGII, ErrorDGII, AMBIENTES } from './ecf-dgii.js';
import { siguienteVersion } from './db.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const ESTADOS_FINALES = ['aceptado', 'condicional', 'rechazado', 'anulado'];
const MAX_INTENTOS = 12;
export const esENCF = (s) => /^E(31|32|33|34|41|43|44|45)\d{10}$/.test(String(s || ''));
const soloDigitos = (x) => String(x || '').replace(/\D/g, '');

// ---------- Tablas ----------
export function prepararTablasEcf(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ecf_config (
      negocio TEXT PRIMARY KEY,
      activo INTEGER NOT NULL DEFAULT 0,
      ambiente TEXT NOT NULL DEFAULT 'testecf',
      p12 TEXT,
      clave TEXT,
      info TEXT,
      extra TEXT,
      actualizado TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Cada comprobante electrónico: lo que se firmó, a quién se envió y qué respondió la DGII
    CREATE TABLE IF NOT EXISTS ecf_envios (
      uid TEXT PRIMARY KEY,
      negocio TEXT NOT NULL,
      origen TEXT NOT NULL,            -- venta | nota | manual | anulacion
      origen_uid TEXT,
      tipo TEXT NOT NULL,              -- 31, 32, 33, 34, 41, 43, 44, 45
      encf TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | enviado | aceptado | condicional | rechazado | error | incompleto | anulado
      track_id TEXT,
      codigo_seguridad TEXT,
      fecha_firma TEXT,
      monto REAL NOT NULL DEFAULT 0,
      xml TEXT,
      xml_resumen TEXT,
      datos TEXT,
      qr_url TEXT,
      mensaje TEXT,
      ambiente TEXT,
      intentos INTEGER NOT NULL DEFAULT 0,
      proximo INTEGER NOT NULL DEFAULT 0,
      creado TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (negocio, encf)
    );
    CREATE INDEX IF NOT EXISTS idx_ecf_envios_pend ON ecf_envios(estado, proximo);
    CREATE INDEX IF NOT EXISTS idx_registros_hijos ON registros(negocio, tabla, json_extract(datos, '$.venta_id'));
  `);
  try { db.exec('ALTER TABLE ncf_secuencias ADD COLUMN vence TEXT'); } catch { /* ya existe */ }
}

// ---------- Cifrado del certificado ----------
const llave = (secreto) => crypto.createHash('sha256').update(`ecf-certificado:${secreto}`).digest();
export function cifrar(texto, secreto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', llave(secreto), iv);
  const ct = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function descifrar(b64, secreto) {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', llave(secreto), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// ---------- Configuración del negocio ----------
const EXTRA_CAMPOS = ['razon', 'comercial', 'direccion', 'municipio', 'provincia', 'correo', 'telefono'];
export function leerConfig(db, negocio) {
  const f = db.prepare('SELECT * FROM ecf_config WHERE negocio = ?').get(negocio);
  let info = null; let extra = {};
  try { info = f?.info ? JSON.parse(f.info) : null; } catch { /* sin datos */ }
  try { extra = f?.extra ? JSON.parse(f.extra) : {}; } catch { /* sin datos */ }
  return { activo: !!f?.activo, ambiente: f?.ambiente || 'testecf', certificado: info, tieneCertificado: !!f?.p12, extra };
}

export function guardarConfig(db, negocio, { activo, ambiente, extra }) {
  if (ambiente !== undefined && !AMBIENTES[ambiente]) throw new Error('Ambiente desconocido.');
  const actual = leerConfig(db, negocio);
  const nuevoExtra = { ...actual.extra };
  if (extra) for (const k of EXTRA_CAMPOS) if (k in extra) nuevoExtra[k] = String(extra[k] ?? '').trim().slice(0, 150);
  db.prepare(`INSERT INTO ecf_config (negocio, activo, ambiente, extra) VALUES (?, ?, ?, ?)
              ON CONFLICT(negocio) DO UPDATE SET activo = excluded.activo, ambiente = excluded.ambiente, extra = excluded.extra, actualizado = datetime('now')`)
    .run(negocio, (activo ?? actual.activo) ? 1 : 0, ambiente ?? actual.ambiente, JSON.stringify(nuevoExtra));
  return leerConfig(db, negocio);
}

// Guarda el certificado .p12 (en base64) y su contraseña, después de comprobar que se puede leer
export function guardarCertificado(db, negocio, secreto, p12Base64, clave) {
  const buf = Buffer.from(String(p12Base64 || ''), 'base64');
  if (buf.length < 100 || buf.length > 200000) throw new Error('El archivo del certificado no es válido.');
  const { info } = leerP12(buf, clave); // lanza un error claro si la contraseña o el archivo no sirven
  if (info.vencido) throw new Error(`El certificado venció el ${info.vence}.`);
  leerConfig(db, negocio);
  db.prepare(`INSERT INTO ecf_config (negocio, p12, clave, info) VALUES (?, ?, ?, ?)
              ON CONFLICT(negocio) DO UPDATE SET p12 = excluded.p12, clave = excluded.clave, info = excluded.info, actualizado = datetime('now')`)
    .run(negocio, cifrar(buf.toString('base64'), secreto), cifrar(String(clave ?? ''), secreto), JSON.stringify(info));
  return info;
}

export function quitarCertificado(db, negocio) {
  db.prepare("UPDATE ecf_config SET p12 = NULL, clave = NULL, info = NULL, activo = 0, actualizado = datetime('now') WHERE negocio = ?").run(negocio);
}

function credenciales(db, negocio, secreto) {
  const f = db.prepare('SELECT p12, clave FROM ecf_config WHERE negocio = ?').get(negocio);
  if (!f?.p12) throw new ErrorFalta('Falta subir el certificado digital de la empresa.');
  let p12; let clave;
  try { p12 = Buffer.from(descifrar(f.p12, secreto), 'base64'); clave = descifrar(f.clave, secreto); } catch {
    throw new ErrorFalta('No se pudo abrir el certificado guardado. Súbelo otra vez.');
  }
  return leerP12(p12, clave);
}
// Un problema que se arregla con una acción de la persona (no se reintenta solo)
class ErrorFalta extends Error {}

// ---------- Lectura de los datos sincronizados ----------
const leerReg = (db, negocio, tabla, uid) => {
  if (!uid) return null;
  const r = db.prepare('SELECT datos, borrado FROM registros WHERE negocio = ? AND tabla = ? AND uid = ?').get(negocio, tabla, uid);
  if (!r || r.borrado || !r.datos) return null;
  try { return JSON.parse(r.datos); } catch { return null; }
};
const hijosReg = (db, negocio, tabla, uidPadre) => db.prepare(
  "SELECT uid, datos FROM registros WHERE negocio = ? AND tabla = ? AND borrado = 0 AND json_extract(datos, '$.venta_id') = ? ORDER BY version")
  .all(negocio, tabla, uidPadre).map((r) => ({ uid: r.uid, ...JSON.parse(r.datos) }));

function datosEmisor(db, negocio, extra) {
  const cfg = (k) => leerReg(db, negocio, 'config', k)?.valor;
  const neg = db.prepare('SELECT nombre, identificador, id_tipo FROM negocios WHERE uid = ?').get(negocio) || {};
  const rnc = soloDigitos(cfg('negocio_rnc') || (neg.id_tipo === 'rnc' ? neg.identificador : ''));
  return {
    rnc, razon: extra.razon || cfg('negocio_nombre') || neg.nombre || '', comercial: extra.comercial || '',
    direccion: extra.direccion || cfg('negocio_direccion') || '', municipio: extra.municipio || '', provincia: extra.provincia || '',
    telefono: extra.telefono || cfg('negocio_telefono') || '', correo: extra.correo || '',
  };
}
const configFiscalServidor = (db, negocio) => {
  const v = (k) => leerReg(db, negocio, 'config', k)?.valor;
  const tasa = Number(v('itbis_tasa')); return { modo: v('itbis_modo') || 'incluido', tasa: tasa > 0 ? tasa : 18 };
};

function compradorDe(cli, nombreSuelto) {
  const doc = soloDigitos(cli?.documento);
  const rnc = cli && (cli.tipo_doc === 'rnc' || cli.tipo_doc === 'cedula') && (doc.length === 9 || doc.length === 11) ? doc : '';
  return { rnc, razon: cli?.nombre || nombreSuelto || '', direccion: cli?.direccion || '' };
}

// Venta sincronizada → datos del comprobante. Los precios del XML van sin ITBIS; los centavos se ajustan para que cuadre con la factura.
export function documentoDeVenta(db, negocio, ventaUid, extra = {}) {
  const v = leerReg(db, negocio, 'ventas', ventaUid);
  if (!v) throw new ErrorFalta('La venta todavía no llegó al servidor.');
  if (!esENCF(v.ncf)) throw new ErrorFalta('La venta no tiene un comprobante electrónico.');
  const { modo, tasa } = configFiscalServidor(db, negocio);
  const detalle = hijosReg(db, negocio, 'venta_detalle', ventaUid);
  const servicios = hijosReg(db, negocio, 'venta_servicios', ventaUid);
  if (!detalle.length && !servicios.length) throw new ErrorFalta('La venta todavía no tiene sus productos en el servidor.');
  // Cada línea: monto neto como lo ve la factura (con ITBIS si los precios lo incluyen) después de su descuento
  const lineasApp = [
    ...detalle.map((d) => {
      const p = leerReg(db, negocio, 'productos', d.producto_id);
      return { nombre: p?.nombre || 'Artículo', bien: true, cantidad: Number(d.cantidad), precio: Number(d.precio_unitario), descuento: Number(d.descuento || 0), exento: !!p?.itbis_exento };
    }),
    ...servicios.map((s) => ({ nombre: s.descripcion || 'Servicio', bien: false, cantidad: Number(s.cantidad), precio: Number(s.precio_unitario), descuento: 0, exento: false })),
  ];
  const neto = lineasApp.map((l) => r2(l.cantidad * l.precio - l.descuento));
  const S = r2(neto.reduce((a, b) => a + b, 0));
  const D = r2(v.descuento || 0);
  // Reparto del descuento general en proporción a cada línea (la última recibe el resto)
  let resto = D;
  const netoFinal = neto.map((n, i) => {
    const parte = i === neto.length - 1 ? resto : r2(S > 0 ? D * n / S : 0);
    resto = r2(resto - parte);
    return r2(n - parte);
  });
  const factor = modo === 'incluido' ? 1 + tasa / 100 : 1;
  const baseExenta = r2(lineasApp.reduce((s, l, i) => s + (l.exento ? netoFinal[i] : 0), 0));
  const itbis = r2(v.itbis || 0);
  const baseGravada = r2(Number(v.total) - itbis - baseExenta);
  let lineas = lineasApp.map((l, i) => {
    const sinItbis = l.exento ? 1 : factor; // precio unitario sin ITBIS
    const precio = l.precio / sinItbis;
    const baseLinea = l.exento ? netoFinal[i] : netoFinal[i] / factor;
    return { nombre: l.nombre, bien: l.bien, cantidad: l.cantidad, precio, exento: l.exento, descuento: r2(l.cantidad * precio - baseLinea) };
  });
  lineas = ajustarLineas(lineas, baseGravada, baseExenta);
  const cli = leerReg(db, negocio, 'clientes', v.cliente_id);
  const tipo = v.ncf.slice(1, 3);
  const credito = v.metodo_pago === 'credito';
  let limite = null;
  if (credito) {
    const cc = db.prepare("SELECT datos FROM registros WHERE negocio = ? AND tabla = 'cuentas_cobrar' AND borrado = 0 AND json_extract(datos, '$.venta_id') = ?").get(negocio, ventaUid);
    limite = cc ? JSON.parse(cc.datos).vence : null;
  }
  const comprador = compradorDe(cli, v.cliente_nombre);
  if (['31', '44', '45'].includes(tipo) && !comprador.rnc) throw new ErrorFalta(`El comprobante E${tipo} necesita el RNC del cliente. Corrige la ficha del cliente y reintenta.`);
  if (tipo === '32' && Number(v.total) >= LIMITE_RFCE && !comprador.rnc) throw new ErrorFalta('Las facturas de consumo desde RD$250,000 llevan el RNC o la cédula del cliente.');
  return {
    tipo, encf: v.ncf, fecha: fechaDGII(v.fecha), emisor: datosEmisor(db, negocio, extra), comprador,
    tipoPago: credito ? 2 : 1, fechaLimitePago: limite ? fechaDGII(limite) : null,
    formasPago: [{ forma: FORMA_PAGO[v.metodo_pago] || 1, monto: Number(v.total) }],
    lineas, tasa, itbisTotal: itbis,
  };
}

// Nota de crédito o débito (cxc_docs) → datos del comprobante
export function documentoDeNota(db, negocio, docUid, extra = {}) {
  const n = leerReg(db, negocio, 'cxc_docs', docUid);
  if (!n) throw new ErrorFalta('La nota todavía no llegó al servidor.');
  if (!esENCF(n.ncf)) throw new ErrorFalta('La nota no tiene un comprobante electrónico.');
  const venta = leerReg(db, negocio, 'ventas', n.venta_id);
  if (!venta?.ncf) throw new ErrorFalta('La factura que modifica la nota no tiene comprobante.');
  const cli = leerReg(db, negocio, 'clientes', n.cliente_id);
  const { tasa } = configFiscalServidor(db, negocio);
  const monto = r2(n.monto); const itbis = r2(n.itbis || 0);
  const concepto = leerReg(db, negocio, 'cxc_conceptos', n.concepto_id)?.nombre || (n.tipo === 'credito' ? 'Nota de crédito' : 'Nota de débito');
  const tipo = n.ncf.slice(1, 3);
  const comprador = compradorDe(cli, null);
  if (!comprador.rnc) throw new ErrorFalta('La nota necesita el RNC del cliente.');
  const dias = (Date.parse(String(n.fecha).slice(0, 10)) - Date.parse(String(venta.fecha).slice(0, 10))) / 86400000;
  const base = r2(monto - itbis);
  return {
    tipo, encf: n.ncf, fecha: fechaDGII(n.fecha), emisor: datosEmisor(db, negocio, extra), comprador,
    tipoPago: 2, fechaLimitePago: fechaDGII(n.fecha), formasPago: [{ forma: 4, monto }],
    lineas: [{ nombre: concepto, bien: false, cantidad: 1, precio: base, exento: itbis === 0, descuento: 0 }],
    tasa, itbisTotal: itbis, notaCreditoMas30: dias > 30,
    referencia: { ncf: venta.ncf, fecha: fechaDGII(venta.fecha), codigo: 3, razon: String(n.notas || concepto).slice(0, 90) },
  };
}

// Comprobante emitido a mano (compras a informales E41, gastos menores E43…): los datos vienen listos
export function documentoManual(db, negocio, encf, datos, extra = {}) {
  const tipo = encf.slice(1, 3);
  return {
    tipo, encf, fecha: datos.fecha, emisor: datosEmisor(db, negocio, extra), comprador: datos.comprador || null,
    tipoPago: datos.tipoPago || 1, fechaLimitePago: datos.fechaLimitePago || null,
    formasPago: datos.formasPago || null, lineas: datos.lineas, tasa: datos.tasa || 18, itbisTotal: datos.itbisTotal,
    itbisRetenido: datos.itbisRetenido || 0, isrRetenido: datos.isrRetenido || 0, referencia: datos.referencia || null,
  };
}

// ---------- Cola ----------
const ahoraTxt = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function crearEnvio(db, negocio, { uid, origen, origenUid = null, encf, datos = null, monto = 0 }) {
  const previo = db.prepare('SELECT uid FROM ecf_envios WHERE negocio = ? AND (uid = ? OR encf = ?)').get(negocio, uid, encf);
  if (previo) return previo.uid;
  db.prepare('INSERT INTO ecf_envios (uid, negocio, origen, origen_uid, tipo, encf, datos, monto) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uid, negocio, origen, origenUid, encf.slice(1, 3), encf, datos ? JSON.stringify(datos) : null, monto);
  return uid;
}
export const encolarVenta = (db, negocio, ventaUid, encf, monto) => crearEnvio(db, negocio, { uid: `venta-${ventaUid}`, origen: 'venta', origenUid: ventaUid, encf, monto });
export const encolarNota = (db, negocio, docUid, encf, monto) => crearEnvio(db, negocio, { uid: `nota-${docUid}`, origen: 'nota', origenUid: docUid, encf, monto });
export const encolarManual = (db, negocio, encf, datos, monto) => crearEnvio(db, negocio, { uid: `manual-${encf}`, origen: 'manual', encf, datos, monto });
export function encolarAnulacion(db, negocio, tipo, desde, hasta) {
  const encf = `E${tipo}${String(desde).padStart(10, '0')}`;
  const uid = `anulacion-${tipo}-${desde}-${hasta}`;
  if (db.prepare('SELECT 1 FROM ecf_envios WHERE negocio = ? AND uid = ?').get(negocio, uid)) return uid;
  // El número no tiene un comprobante propio: se guarda con su propio identificador
  db.prepare('INSERT INTO ecf_envios (uid, negocio, origen, tipo, encf, datos) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid, negocio, 'anulacion', String(tipo), `${encf}-${hasta}`, JSON.stringify({ tipo, desde, hasta }));
  return uid;
}

// Escribe el estado en la tabla sincronizada para que lo vean los equipos (y quede en la factura impresa)
function publicar(db, negocio, e) {
  if (e.origen === 'anulacion') return;
  const datos = {
    ncf: e.encf, tipo: e.tipo, estado: e.estado, track_id: e.track_id || null, codigo_seguridad: e.codigo_seguridad || null,
    fecha_firma: e.fecha_firma || null, mensaje: e.mensaje || null, monto: e.monto || 0, qr_url: e.qr_url || null, ambiente: e.ambiente || null,
    venta_id: e.origen === 'venta' ? e.origen_uid : null, cxc_doc_id: e.origen === 'nota' ? e.origen_uid : null,
  };
  db.prepare(`INSERT INTO registros (negocio, tabla, uid, datos, borrado, actualizado, version, origen) VALUES (?, 'ecf_documentos', ?, ?, 0, ?, ?, 'servidor')
              ON CONFLICT(negocio, tabla, uid) DO UPDATE SET datos = excluded.datos, borrado = 0, actualizado = excluded.actualizado, version = excluded.version, origen = excluded.origen`)
    .run(negocio, e.uid, JSON.stringify(datos), Date.now(), siguienteVersion(db));
}

function guardarEnvio(db, negocio, uid, cambios) {
  const cols = Object.keys(cambios);
  db.prepare(`UPDATE ecf_envios SET ${cols.map((c) => `${c} = ?`).join(', ')}, actualizado = datetime('now') WHERE negocio = ? AND uid = ?`).run(...cols.map((c) => cambios[c]), negocio, uid);
  const e = db.prepare('SELECT * FROM ecf_envios WHERE negocio = ? AND uid = ?').get(negocio, uid);
  publicar(db, negocio, e);
  return e;
}

const espera = (intentos) => Math.min(30000 * 2 ** Math.max(0, intentos - 1), 3600000);

// Avanza un comprobante un paso: lo arma y firma si hace falta, lo envía y consulta su resultado.
// ctx = { db, secreto, fetchFn, ahora, cacheToken }
export async function avanzar(ctx, negocio, uid) {
  const { db } = ctx;
  let e = db.prepare('SELECT * FROM ecf_envios WHERE negocio = ? AND uid = ?').get(negocio, uid);
  if (!e || ESTADOS_FINALES.includes(e.estado)) return e;
  const cfg = leerConfig(db, negocio);
  const ahora = (ctx.ahora || Date.now)();
  try {
    if (!cfg.activo) throw new ErrorFalta('La facturación electrónica no está activada. Actívala en Ajustes → Facturación electrónica.');
    const cred = credenciales(db, negocio, ctx.secreto);
    if (cred.info.vencido) throw new ErrorFalta(`El certificado venció el ${cred.info.vence}.`);
    const dgii = crearClienteDGII({ ambiente: cfg.ambiente, credenciales: cred, fetchFn: ctx.fetchFn, ahora: ctx.ahora, cacheToken: ctx.cacheToken });
    const nombre = `${datosEmisor(db, negocio, cfg.extra).rnc}${e.encf}.xml`;

    if (e.origen === 'anulacion') {
      const d = JSON.parse(e.datos);
      const emisor = datosEmisor(db, negocio, cfg.extra);
      const firmado = firmarArbol(construirANECF({ rnc: emisor.rnc, tipo: d.tipo, desde: d.desde, hasta: d.hasta, ms: ahora }), cred);
      const r = await dgii.anularRango(firmado.xml, `${emisor.rnc}${e.encf.split('-')[0]}.xml`);
      return guardarEnvio(db, negocio, uid, { estado: 'anulado', xml: firmado.xml, mensaje: r.mensaje || 'Rango anulado en la DGII.', ambiente: cfg.ambiente, proximo: 0 });
    }

    // 1) Armar y firmar (una sola vez: lo que se firmó es lo que se imprime y lo que se reenvía)
    if (!e.xml) {
      const d = e.origen === 'venta' ? documentoDeVenta(db, negocio, e.origen_uid, cfg.extra)
        : e.origen === 'nota' ? documentoDeNota(db, negocio, e.origen_uid, cfg.extra)
          : documentoManual(db, negocio, e.encf, JSON.parse(e.datos || '{}'), cfg.extra);
      if (!d.emisor.rnc) throw new ErrorFalta('Falta el RNC de la empresa. Regístralo en Ajustes → Datos fiscales.');
      if (!d.emisor.razon) throw new ErrorFalta('Falta el nombre de la empresa.');
      const sec = db.prepare('SELECT vence FROM ncf_secuencias WHERE negocio = ? AND tipo = ?').get(negocio, `E${d.tipo}`);
      if (!['32', '34'].includes(d.tipo)) {
        if (!sec?.vence) throw new ErrorFalta(`Falta la fecha de vencimiento de la secuencia E${d.tipo} (Ajustes → Facturación electrónica).`);
        d.vence = fechaDGII(sec.vence);
      }
      d.firmaMs = ahora;
      const { raiz, totales } = construirECF(d);
      const firmado = firmarArbol(raiz, cred);
      const codigo = codigoSeguridad(firmado.firma);
      const fFirma = fechaHoraFirma(ahora);
      const resumen = d.tipo === '32' && totales.total < LIMITE_RFCE;
      let xmlResumen = null;
      if (resumen) xmlResumen = firmarArbol(construirRFCE(d, totales, codigo), cred).xml;
      const qr = urlQR({ ambiente: cfg.ambiente, rncEmisor: d.emisor.rnc, rncComprador: d.comprador?.rnc, encf: e.encf, fechaEmision: d.fecha, montoTotal: totales.total, fechaFirma: fFirma, codigoSeguridad: codigo, resumen });
      e = guardarEnvio(db, negocio, uid, { xml: firmado.xml, xml_resumen: xmlResumen, codigo_seguridad: codigo, fecha_firma: fFirma, qr_url: qr, monto: totales.total, ambiente: cfg.ambiente });
    }

    // 2) Enviar
    if (!e.track_id && e.estado !== 'enviado') {
      if (e.xml_resumen) {
        const r = await dgii.enviarRFCE(e.xml_resumen, nombre);
        const estado = r.estado === 'aceptado' || r.estado === 'condicional' || r.estado === 'rechazado' ? r.estado : 'enviado';
        return guardarEnvio(db, negocio, uid, { estado, mensaje: r.mensaje || '', intentos: 0, proximo: estado === 'enviado' ? ahora + 30000 : 0 });
      }
      const r = await dgii.enviarECF(e.xml, nombre);
      e = guardarEnvio(db, negocio, uid, { estado: 'enviado', track_id: r.trackId, mensaje: '', intentos: 0, proximo: ahora + 5000 });
    }

    // 3) Consultar el resultado
    if (e.track_id) {
      const r = await dgii.estado(e.track_id);
      if (r.estado === 'aceptado' || r.estado === 'condicional' || r.estado === 'rechazado') {
        return guardarEnvio(db, negocio, uid, { estado: r.estado, mensaje: r.mensaje || '', proximo: 0 });
      }
      if (r.estado === 'noEncontrado' && ahora - Date.parse(`${e.creado.replace(' ', 'T')}Z`) > 15 * 60000) {
        // La DGII no tiene el envío: se vuelve a mandar el mismo documento firmado
        return guardarEnvio(db, negocio, uid, { track_id: null, estado: 'error', mensaje: 'La DGII no encontró el envío; se reenviará.', proximo: ahora + 30000 });
      }
      return guardarEnvio(db, negocio, uid, { estado: 'enviado', mensaje: r.mensaje || '', proximo: ahora + Math.min(30000 * 2 ** Math.min(e.intentos, 5), 600000), intentos: e.intentos + 1 });
    }
    return e;
  } catch (err) {
    const falta = err instanceof ErrorFalta;
    const dgiiError = err instanceof ErrorDGII;
    // Si la DGII rechazó el archivo con un error que no se arregla reintentando, queda para revisión
    const definitivo = dgiiError && !err.reintentable;
    const intentos = e.intentos + 1;
    const estado = falta || definitivo || intentos >= MAX_INTENTOS ? 'incompleto' : 'error';
    return guardarEnvio(db, negocio, uid, { estado, mensaje: String(err.message || err).slice(0, 600), intentos, proximo: estado === 'error' ? ahora + espera(intentos) : 0 });
  }
}

// Procesa los comprobantes que ya les toca (los de un negocio o de todos)
export async function procesarPendientes(ctx, { negocio = null, limite = 25 } = {}) {
  const ahora = (ctx.ahora || Date.now)();
  const filas = ctx.db.prepare(`SELECT negocio, uid FROM ecf_envios WHERE estado IN ('pendiente', 'enviado', 'error') AND proximo <= ? ${negocio ? 'AND negocio = ?' : ''} ORDER BY proximo, creado LIMIT ?`)
    .all(...[ahora, ...(negocio ? [negocio] : []), limite]);
  const res = [];
  for (const f of filas) res.push(await avanzar(ctx, f.negocio, f.uid));
  return res;
}

// El usuario pide reintentar: con `reconstruir` se vuelve a armar el XML desde los datos actuales (cuando el rechazo fue por un dato que ya se corrigió)
export function reintentar(db, negocio, uid, { reconstruir = false } = {}) {
  const e = db.prepare('SELECT * FROM ecf_envios WHERE negocio = ? AND uid = ?').get(negocio, uid);
  if (!e) throw new Error('No existe ese comprobante.');
  if (['aceptado', 'condicional', 'anulado'].includes(e.estado)) throw new Error('Ese comprobante ya fue aceptado por la DGII.');
  const base = { estado: 'pendiente', mensaje: '', intentos: 0, proximo: 0 };
  return guardarEnvio(db, negocio, uid, reconstruir || e.estado === 'rechazado' ? { ...base, xml: null, xml_resumen: null, track_id: null } : base);
}

export function listarEnvios(db, negocio, { limite = 100 } = {}) {
  return db.prepare("SELECT uid, origen, tipo, encf, estado, track_id, codigo_seguridad, fecha_firma, monto, mensaje, ambiente, intentos, creado, actualizado FROM ecf_envios WHERE negocio = ? AND origen != 'anulacion' ORDER BY creado DESC, rowid DESC LIMIT ?").all(negocio, limite);
}
export function resumenEnvios(db, negocio) {
  const filas = db.prepare("SELECT estado, COUNT(*) AS n FROM ecf_envios WHERE negocio = ? AND origen != 'anulacion' GROUP BY estado").all(negocio);
  return Object.fromEntries(filas.map((f) => [f.estado, f.n]));
}
export const xmlDe = (db, negocio, uid) => db.prepare('SELECT encf, xml, xml_resumen FROM ecf_envios WHERE negocio = ? AND uid = ?').get(negocio, uid);

// Prueba la conexión con la DGII (pide un token con el certificado guardado)
export async function probarConexion(ctx, negocio) {
  const cfg = leerConfig(ctx.db, negocio);
  const cred = credenciales(ctx.db, negocio, ctx.secreto);
  const dgii = crearClienteDGII({ ambiente: cfg.ambiente, credenciales: cred, fetchFn: ctx.fetchFn, ahora: ctx.ahora, cacheToken: new Map() });
  await dgii.token(true);
  return { ok: true, ambiente: cfg.ambiente };
}

export { TIPOS_ECF, calcularTotales, serializar, conDeclaracion };
