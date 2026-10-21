// Pruebas de facturación electrónica (e-CF): XML, firma digital, cliente de la DGII y cola del servidor.
// Ejecutar con: node tests/ecf.mjs   (necesita openssl y xmllint para verificar la firma de forma independiente)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { crearServidor } from '../server/index.js';
import { abrirBase } from '../server/db.js';
import { crearCliente } from '../src/nube.js';
import * as X from '../server/ecf-xml.js';
import * as F from '../server/ecf-firma.js';
import { crearClienteDGII, ErrorDGII, normalizarEstado } from '../server/ecf-dgii.js';
import * as ECF from '../server/ecf.js';

let n = 0; const ok = (t) => { n++; console.log(`  ✔ ${t}`); };
console.log('Facturación electrónica (e-CF)');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecf-'));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });

// ---------- Certificado de prueba (autofirmado) ----------
const ssl = (...a) => sh('openssl', a);
ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k.pem`, '-out', `${tmp}/c.pem`, '-days', '365', '-subj', '/CN=EMPRESA DE PRUEBA SRL/serialNumber=101123456');
ssl('pkcs12', '-export', '-inkey', `${tmp}/k.pem`, '-in', `${tmp}/c.pem`, '-out', `${tmp}/prueba.p12`, '-passout', 'pass:clave-123');
ssl('pkcs12', '-export', '-legacy', '-inkey', `${tmp}/k.pem`, '-in', `${tmp}/c.pem`, '-out', `${tmp}/legacy.p12`, '-passout', 'pass:clave-123');
ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/kv.pem`, '-out', `${tmp}/cv.pem`, '-days', '1', '-subj', '/CN=VENCIDO');
const p12 = fs.readFileSync(`${tmp}/prueba.p12`);
const cred = F.leerP12(p12, 'clave-123');

// ---------- Certificado ----------
assert.equal(cred.info.vencido, false);
assert.match(cred.info.sujeto, /EMPRESA DE PRUEBA SRL/);
assert.equal(F.leerP12(fs.readFileSync(`${tmp}/legacy.p12`), 'clave-123').info.serie, cred.info.serie, 'lee también .p12 antiguos (RC2/3DES)');
assert.throws(() => F.leerP12(p12, 'otra'), /contraseña/);
assert.throws(() => F.leerP12(Buffer.from('esto no es un certificado'.repeat(10)), 'x'), /No se pudo leer/);
ok('lee el certificado .p12 (moderno y antiguo) y avisa si la contraseña o el archivo no sirven');

// ---------- XML ----------
const base = {
  tipo: '31', encf: 'E310000000001', vence: '31-12-2028', fecha: '15-10-2026',
  emisor: { rnc: '101123456', razon: 'ELECTRO SONIDO & CIA <SRL>', direccion: 'Av. Principal 1', telefono: '8092309980', municipio: '010100', provincia: '010000', correo: 'info@x.com' },
  comprador: { rnc: '131880657', razon: 'CLIENTE SA', direccion: 'Calle 2' },
  tipoPago: 1, formasPago: [{ forma: 1, monto: 1180 }], lineas: [{ nombre: 'Bocina 6x9', cantidad: 1, precio: 1000 }], firmaMs: Date.UTC(2026, 9, 16, 1, 5, 9),
};
const { raiz, totales } = X.construirECF(base);
const sinFirma = X.serializar(raiz);
assert.equal(totales.total, 1180);
assert.match(sinFirma, /^<ECF><Encabezado><Version>1\.0<\/Version><IdDoc><TipoeCF>31<\/TipoeCF><eNCF>E310000000001<\/eNCF><FechaVencimientoSecuencia>31-12-2028<\/FechaVencimientoSecuencia>/);
assert.match(sinFirma, /<RazonSocialEmisor>ELECTRO SONIDO &amp; CIA &lt;SRL&gt;<\/RazonSocialEmisor>/, 'escapa & < >');
assert.match(sinFirma, /<FechaEmision>15-10-2026<\/FechaEmision>/);
assert.match(sinFirma, /<MontoGravadoTotal>1000\.00<\/MontoGravadoTotal><MontoGravadoI1>1000\.00<\/MontoGravadoI1><ITBIS1>18<\/ITBIS1><TotalITBIS>180\.00<\/TotalITBIS><TotalITBIS1>180\.00<\/TotalITBIS1><MontoTotal>1180\.00<\/MontoTotal>/);
assert.match(sinFirma, /<IndicadorFacturacion>1<\/IndicadorFacturacion><NombreItem>Bocina 6x9<\/NombreItem><IndicadorBienoServicio>1<\/IndicadorBienoServicio><CantidadItem>1\.00<\/CantidadItem><UnidadMedida>43<\/UnidadMedida><PrecioUnitarioItem>1000\.00<\/PrecioUnitarioItem><MontoItem>1000\.00<\/MontoItem>/);
assert.match(sinFirma, /<FechaHoraFirma>15-10-2026 21:05:09<\/FechaHoraFirma><\/ECF>$/, 'la hora de la firma es la de República Dominicana (UTC-4)');
assert.doesNotMatch(sinFirma, /<[A-Za-z]+><\/[A-Za-z]+>/, 'ninguna etiqueta vacía');
assert.throws(() => X.construirECF({ ...base, encf: 'E320000000001' }), /no corresponde/);
assert.throws(() => X.construirECF({ ...base, lineas: [] }), /al menos una línea/);
ok('el XML del E31 sale en orden, escapado, sin etiquetas vacías y con la hora dominicana');

// Tipos: cada uno lleva lo que le toca
const t32 = X.serializar(X.construirECF({ ...base, tipo: '32', encf: 'E320000000001', comprador: null }).raiz);
assert.doesNotMatch(t32, /FechaVencimientoSecuencia|<Comprador>/, 'el E32 no lleva vencimiento y sin cliente no lleva comprador');
const t41 = X.serializar(X.construirECF({ ...base, tipo: '41', encf: 'E410000000001', itbisRetenido: 0, isrRetenido: 0 }).raiz);
assert.match(t41, /<TotalITBISRetenido>0\.00<\/TotalITBISRetenido><TotalISRRetencion>0\.00<\/TotalISRRetencion>/);
assert.match(t41, /<Retencion><IndicadorAgenteRetencionoPercepcion>1<\/IndicadorAgenteRetencionoPercepcion><MontoITBISRetenido>0\.00<\/MontoITBISRetenido><\/Retencion>/);
assert.doesNotMatch(t41.split('<DetallesItems>')[0], /TipoIngresos/, 'el E41 no lleva tipo de ingresos');
const t43 = X.serializar(X.construirECF({ ...base, tipo: '43', encf: 'E430000000001', comprador: base.comprador }).raiz);
assert.doesNotMatch(t43, /<Comprador>|<TipoPago>|IndicadorMontoGravado/, 'el E43 no lleva comprador, forma de pago ni indicador de monto gravado');
const nota = { ...base, tipo: '34', encf: 'E340000000001', referencia: { ncf: 'E310000000001', fecha: '15-10-2026', codigo: 3, razon: 'Descuento' }, notaCreditoMas30: true };
const t34 = X.serializar(X.construirECF(nota).raiz);
assert.match(t34, /<IndicadorNotaCredito>1<\/IndicadorNotaCredito>/);
assert.match(t34, /<\/DetallesItems><InformacionReferencia><NCFModificado>E310000000001<\/NCFModificado><FechaNCFModificado>15-10-2026<\/FechaNCFModificado><CodigoModificacion>3<\/CodigoModificacion><RazonModificacion>Descuento<\/RazonModificacion><\/InformacionReferencia><FechaHoraFirma>/);
assert.doesNotMatch(t34, /FechaVencimientoSecuencia/);
assert.throws(() => X.construirECF({ ...nota, referencia: null }), /que modifican/);
const t33 = X.serializar(X.construirECF({ ...nota, tipo: '33', encf: 'E330000000001', notaCreditoMas30: false }).raiz);
assert.match(t33, /<FechaVencimientoSecuencia>31-12-2028<\/FechaVencimientoSecuencia>/);
assert.doesNotMatch(t33, /IndicadorNotaCredito/);
for (const tp of ['44', '45']) assert.match(X.serializar(X.construirECF({ ...base, tipo: tp, encf: `E${tp}0000000001` }).raiz), new RegExp(`<TipoeCF>${tp}</TipoeCF>`));
ok('E31, E32, E33, E34, E41, E43, E44 y E45 llevan solo las etiquetas que les corresponden');

// Líneas exentas y descuentos
const mix = X.construirECF({ ...base, lineas: [
  { nombre: 'Bocina', cantidad: 2, precio: 500, descuento: 100 },
  { nombre: 'Servicio exento', cantidad: 1, precio: 300, exento: true, bien: false },
] });
assert.equal(mix.totales.gravado, 900); assert.equal(mix.totales.exento, 300); assert.equal(mix.totales.itbis, 162); assert.equal(mix.totales.total, 1362);
const xm = X.serializar(mix.raiz);
assert.match(xm, /<MontoExento>300\.00<\/MontoExento>/);
assert.match(xm, /<DescuentoMonto>100\.00<\/DescuentoMonto><TablaSubDescuento><SubDescuento><TipoSubDescuento>\$<\/TipoSubDescuento><MontoSubDescuento>100\.00<\/MontoSubDescuento><\/SubDescuento><\/TablaSubDescuento><MontoItem>900\.00<\/MontoItem>/);
assert.match(xm, /<IndicadorFacturacion>4<\/IndicadorFacturacion><NombreItem>Servicio exento<\/NombreItem><IndicadorBienoServicio>2<\/IndicadorBienoServicio>/);
ok('las líneas exentas, los servicios y los descuentos se reflejan en líneas y totales');

// ajustarLineas: las líneas suman exactamente la base de la factura (sin centavos de diferencia)
{
  const l = X.ajustarLineas([{ cantidad: 3, precio: 33.3333, descuento: 0 }, { cantidad: 1, precio: 10.01, descuento: 0 }], 109.99, 0);
  const suma = l.reduce((s, x) => s + (Math.round(x.cantidad * x.precio * 100) / 100 - x.descuento), 0);
  assert.equal(Math.round(suma * 100) / 100, 109.99);
}
assert.equal(X.precioTxt(1000), '1000.00'); assert.equal(X.precioTxt(847.45763), '847.4576'); assert.equal(X.precioTxt(12.5), '12.50'); assert.equal(X.cantidadTxt(2.5), '2.50');
ok('los montos se ajustan al centavo y los precios llevan de 2 a 4 decimales');

// ---------- Firma ----------
const firmado = F.firmarArbol(raiz, cred);
fs.writeFileSync(`${tmp}/doc.xml`, firmado.xml);
fs.writeFileSync(`${tmp}/sinfirma.xml`, firmado.sinFirma);
assert.match(firmado.xml, /^<\?xml version="1\.0" encoding="utf-8"\?><ECF>/);
assert.match(firmado.xml, /<FechaHoraFirma>[^<]+<\/FechaHoraFirma><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#"><SignedInfo>/);
assert.match(firmado.xml, /<Reference URI=""><Transforms><Transform Algorithm="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#enveloped-signature"><\/Transform><\/Transforms><DigestMethod Algorithm="http:\/\/www\.w3\.org\/2001\/04\/xmlenc#sha256">/);
assert.match(firmado.xml, /<SignatureMethod Algorithm="http:\/\/www\.w3\.org\/2001\/04\/xmldsig-more#rsa-sha256">/);
assert.equal(F.verificarFirma(firmado.xml).valido, true);
ok('el documento se firma con XMLDSig enveloped, RSA-SHA256 y el certificado dentro');

// Verificación independiente (xmllint canoniza; openssl verifica) para no depender de nuestro propio código
assert.equal(sh('xmllint', ['--c14n', `${tmp}/sinfirma.xml`]).toString(), firmado.sinFirma, 'la forma canónica del documento coincide con la de xmllint');
assert.equal(sh('xmllint', ['--c14n', `${tmp}/doc.xml`]).toString(), firmado.xml.replace(/^<\?xml[^>]*\?>/, ''), 'el documento firmado ya está en forma canónica');
const si = /<SignedInfo>[\s\S]*<\/SignedInfo>/.exec(firmado.xml)[0].replace('<SignedInfo>', '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">');
fs.writeFileSync(`${tmp}/si.xml`, si);
fs.writeFileSync(`${tmp}/si.c14n`, sh('xmllint', ['--c14n', `${tmp}/si.xml`]));
fs.writeFileSync(`${tmp}/sig.bin`, Buffer.from(/<SignatureValue>([^<]*)</.exec(firmado.xml)[1], 'base64'));
fs.writeFileSync(`${tmp}/pub.pem`, ssl('x509', '-in', `${tmp}/c.pem`, '-pubkey', '-noout'));
assert.match(ssl('dgst', '-sha256', '-verify', `${tmp}/pub.pem`, '-signature', `${tmp}/sig.bin`, `${tmp}/si.c14n`).toString(), /Verified OK/);
const dg = crypto.createHash('sha256').update(sh('xmllint', ['--c14n', `${tmp}/sinfirma.xml`])).digest('base64');
assert.equal(/<DigestValue>([^<]*)</.exec(firmado.xml)[1], dg, 'el digest coincide con el de la forma canónica de xmllint');
ok('la firma se verificó con herramientas externas (xmllint + OpenSSL), no solo con nuestro código');

// Si alguien cambia el documento después de firmado, se detecta
assert.equal(F.verificarFirma(firmado.xml.replace('1180.00', '1.00')).valido, false);
assert.equal(F.verificarFirma(firmado.xml.replace(/<SignatureValue>.{10}/, '<SignatureValue>AAAAAAAAAA')).valido, false);
assert.equal(F.verificarFirma('<ECF></ECF>').valido, false);
assert.equal(F.codigoSeguridad(firmado.firma), firmado.firma.slice(0, 6));
assert.equal(F.codigoSeguridad(firmado.firma).length, 6);
ok('un documento alterado después de firmar no pasa la verificación; el código de seguridad son los 6 primeros caracteres de la firma');

// Caracteres raros y acentos viajan bien
{
  const r = X.construirECF({ ...base, lineas: [{ nombre: 'Amplificador "Ñandú" 500W – 4 canales', cantidad: 1, precio: 100 }] }).raiz;
  const f = F.firmarArbol(r, cred);
  fs.writeFileSync(`${tmp}/acentos.xml`, f.xml);
  assert.equal(sh('xmllint', ['--c14n', `${tmp}/acentos.xml`]).toString(), f.xml.replace(/^<\?xml[^>]*\?>/, ''));
  assert.equal(F.verificarFirma(f.xml).valido, true);
}
ok('acentos, eñes y comillas se firman y se canonizan igual que en xmllint');

// ---------- RFCE, anulación de rangos y QR ----------
const rf = X.serializar(X.construirRFCE({ ...base, tipo: '32', encf: 'E320000000001', comprador: null }, totales, 'AbC123'));
assert.match(rf, /^<RFCE><Encabezado><Version>1\.0<\/Version><IdDoc><TipoeCF>32<\/TipoeCF><eNCF>E320000000001<\/eNCF>/);
assert.match(rf, /<CodigoSeguridadeCF>AbC123<\/CodigoSeguridadeCF><\/Encabezado><\/RFCE>$/);
const an = X.serializar(X.construirANECF({ rnc: '101123456', tipo: 31, desde: 5, hasta: 7, ms: Date.UTC(2026, 9, 16, 1, 5, 9) }));
assert.match(an, /<CantidadeNCFAnulados>3<\/CantidadeNCFAnulados><FechaHoraAnulacioneNCF>15-10-2026 21:05:09<\/FechaHoraAnulacioneNCF>/);
assert.match(an, /<SecuenciaeNCFDesde>E310000000005<\/SecuenciaeNCFDesde><SecuenciaeNCFHasta>E310000000007<\/SecuenciaeNCFHasta>/);
const qr = X.urlQR({ ambiente: 'testecf', rncEmisor: '101123456', rncComprador: '131880657', encf: 'E310000000001', fechaEmision: '15-10-2026', montoTotal: 1180, fechaFirma: '15-10-2026 21:05:09', codigoSeguridad: 'a+b/c=' });
assert.equal(qr, 'https://ecf.dgii.gov.do/TestECF/ConsultaTimbre?RncEmisor=101123456&RncComprador=131880657&ENCF=E310000000001&FechaEmision=15-10-2026&MontoTotal=1180.00&FechaFirma=15-10-2026%2021%3A05%3A09&CodigoSeguridad=a%2Bb%2Fc%3D');
assert.match(X.urlQR({ ambiente: 'ecf', rncEmisor: '101123456', encf: 'E320000000001', montoTotal: 50, codigoSeguridad: 'AbC123', resumen: true, fechaEmision: '' }), /^https:\/\/fc\.dgii\.gov\.do\/ecf\/ConsultaTimbreFC\?RncEmisor=101123456&ENCF=E320000000001&MontoTotal=50\.00&CodigoSeguridad=AbC123$/);
ok('resumen de consumo, anulación de rangos y dirección del código QR');

// ---------- Cliente de la DGII con una DGII simulada ----------
function dgiiFalsa() {
  const f = { llamadas: [], tokens: 0, estados: new Map(), semillaN: 0, falla: null, expira401: false, enviados: [], resumenes: [], anulados: [], verificaciones: [] };
  const json = (cuerpo, estado = 200) => ({ ok: estado < 400, status: estado, text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)) });
  const texto = (opts) => { const t = Buffer.from(opts.body).toString('utf8'); const m = /\r\n\r\n([\s\S]*)\r\n--[^\r\n]+--\r\n$/.exec(t); return m ? m[1] : t; }; // el contenido del archivo subido
  f.fetch = async (url, opts = {}) => {
    const u = new URL(url); f.llamadas.push(`${opts.method || 'GET'} ${u.host}${u.pathname}`);
    if (f.falla) { const x = f.falla; if (x.veces-- > 0) { if (x.red) throw new Error('ECONNRESET'); return json({ title: 'Error' }, x.estado); } f.falla = null; }
    const p = u.pathname.toLowerCase();
    if (p.endsWith('/autenticacion/api/autenticacion/semilla')) return json(`<SemillaModel><valor>semilla-${++f.semillaN}</valor><fecha>2026-10-15T21:00:00</fecha></SemillaModel>`);
    if (p.endsWith('/validarsemilla')) {
      const xml = texto(opts); const v = F.verificarFirma(/<SemillaModel>[\s\S]*<\/SemillaModel>/.exec(xml)[0].replace(/^/, ''));
      f.verificaciones.push(v.valido);
      if (!v.valido) return json({ mensaje: 'firma inválida' }, 400);
      f.tokens++;
      return json({ token: `tok-${f.tokens}`, expira: new Date(Date.now() + 3600000).toISOString(), expedido: new Date().toISOString() });
    }
    const auth = opts.headers?.Authorization;
    if (f.expira401 && auth === 'Bearer tok-1') return json({}, 401);
    if (!auth?.startsWith('Bearer tok-')) return json({}, 401);
    if (p.endsWith('/facturaselectronicas')) {
      const xml = texto(opts); const e = /<eNCF>([^<]+)</.exec(xml)[1];
      const v = F.verificarFirma(/<ECF>[\s\S]*<\/ECF>/.exec(xml)[0]);
      f.enviados.push({ encf: e, xml, firmaValida: v.valido, cab: opts.headers['Content-Type'] });
      const track = `track-${f.enviados.length}`; f.estados.set(track, f.estadoPorDefecto || { codigo: '1', estado: 'Aceptado', mensajes: [{ valor: '', codigo: 0 }] });
      return json({ trackId: track, error: null, mensaje: null });
    }
    if (p.endsWith('/recepcion/ecf')) {
      const xml = texto(opts); f.resumenes.push({ xml, firmaValida: F.verificarFirma(/<RFCE>[\s\S]*<\/RFCE>/.exec(xml)[0]).valido });
      return json({ codigo: '1', estado: 'Aceptado', mensaje: null, encf: /<eNCF>([^<]+)</.exec(xml)[1], secuenciaUtilizada: true });
    }
    if (p.endsWith('/consultas/estado')) return json({ trackId: u.searchParams.get('trackid'), ...(f.estados.get(u.searchParams.get('trackid')) || { codigo: '0', estado: 'No encontrado' }) });
    if (p.endsWith('/anularrango')) { f.anulados.push(texto(opts)); return json({ mensaje: 'Rango anulado' }); }
    return json({}, 404);
  };
  return f;
}
{
  const f = dgiiFalsa(); let t0 = Date.now();
  const c = crearClienteDGII({ ambiente: 'testecf', credenciales: cred, fetchFn: f.fetch, ahora: () => t0 });
  await c.enviarECF(firmado.xml, '101123456E310000000001.xml');
  await c.enviarECF(firmado.xml, '101123456E310000000001.xml');
  assert.equal(f.tokens, 1, 'el token se reutiliza');
  assert.deepEqual(f.verificaciones, [true], 'la semilla se firma con el certificado');
  assert.equal(f.llamadas[0], 'GET ecf.dgii.gov.do/testecf/autenticacion/api/autenticacion/semilla');
  assert.ok(f.llamadas.includes('POST ecf.dgii.gov.do/testecf/recepcion/api/facturaselectronicas'));
  assert.match(f.enviados[0].cab, /^multipart\/form-data; boundary=/);
  assert.equal(f.enviados[0].firmaValida, true, 'la DGII (simulada) recibe el XML con la firma intacta');
  t0 += 2 * 3600000; await c.estado('track-1');
  assert.equal(f.tokens, 2, 'pide otro token cuando el anterior venció');
  f.expira401 = true; const c2 = crearClienteDGII({ ambiente: 'testecf', credenciales: cred, fetchFn: f.fetch, cacheToken: new Map([['testecf', { valor: 'tok-1', vence: Date.now() + 3600000 }]]) });
  f.tokens = 10; await c2.estado('track-1');
  assert.equal(f.tokens, 11, 'si la DGII dice 401, pide un token nuevo y repite');
  const r = await c.estado('track-1'); assert.equal(r.estado, 'aceptado');
  assert.equal((await c.enviarRFCE('<RFCE><eNCF>E320000000009</eNCF></RFCE>', 'x.xml')).estado, 'aceptado');
  assert.ok(f.llamadas.some((l) => l === 'POST fc.dgii.gov.do/testecf/recepcionfc/api/recepcion/ecf'));
  f.falla = { estado: 503, veces: 1 };
  await assert.rejects(c.estado('track-1'), (e) => e instanceof ErrorDGII && e.reintentable === true);
  f.falla = { estado: 400, veces: 1 };
  await assert.rejects(c.estado('track-1'), (e) => e instanceof ErrorDGII && e.reintentable === false);
  f.falla = { red: true, veces: 1 };
  await assert.rejects(c.estado('track-1'), (e) => e.reintentable === true && /comunicar/.test(e.message));
  assert.throws(() => crearClienteDGII({ ambiente: 'otro', credenciales: cred }), /desconocido/);
  assert.equal(normalizarEstado('Aceptado Condicional', 4), 'condicional'); assert.equal(normalizarEstado('Rechazado', 2), 'rechazado');
  assert.equal(normalizarEstado('En Proceso', 3), 'enviado'); assert.equal(normalizarEstado('No encontrado', 0), 'noEncontrado');
}
ok('cliente de la DGII: autentica con la semilla firmada, reutiliza el token, renueva si vence o da 401 y distingue errores que se reintentan');

// ---------- Servidor: todo el recorrido con una DGII simulada ----------
const dgii = dgiiFalsa();
const srvDb = abrirBase(':memory:');
const servidor = crearServidor({ db: srvDb, secreto: 'prueba-secreto-largo-1234567890', aprobacionAutomatica: true, fetchEcf: dgii.fetch, procesoEcf: false });
await new Promise((r) => servidor.listen(0, r));
const BASE = `http://127.0.0.1:${servidor.address().port}`;
const cli = crearCliente({ base: () => BASE, token: () => cli.tk });
const reg = await cli.registro({ negocio: 'Audio Pro', rnc: '101123456', nombre: 'Ana', usuario: 'ana', correo: 'ana@x.com', clave: 'abcd1234', dispositivo: 'dispositivo-prueba-0001' });
cli.tk = reg.token;
const NEG = reg.negocio.uid;
const llamar = (m, ruta, cuerpo) => cli.llamar(m, ruta, cuerpo);
const rechazo = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

// Sin certificado no se puede activar
assert.match(await rechazo(llamar('PUT', '/api/ecf/config', { activo: true })), /certificado/);
assert.match(await rechazo(llamar('POST', '/api/ecf/certificado', { p12: p12.toString('base64'), clave: 'mala' })), /contraseña/);
assert.match(await rechazo(llamar('POST', '/api/ecf/certificado', { p12: 'AAAA', clave: 'x' })), /no es válido/);
const subido = await llamar('POST', '/api/ecf/certificado', { p12: p12.toString('base64'), clave: 'clave-123' });
assert.match(subido.certificado.sujeto, /EMPRESA DE PRUEBA/);
const est0 = await llamar('GET', '/api/ecf');
assert.equal(est0.tieneCertificado, true); assert.equal(est0.activo, false); assert.equal(est0.ambiente, 'testecf');
assert.ok(!JSON.stringify(est0).includes('p12') && !JSON.stringify(est0).includes('clave-123'), 'el certificado y su contraseña no salen del servidor');
const fila = srvDb.prepare('SELECT p12, clave FROM ecf_config WHERE negocio = ?').get(NEG);
assert.ok(!fila.p12.includes(p12.toString('base64').slice(0, 40)) && !fila.clave.includes('clave-123'), 'se guardan cifrados');
assert.equal(ECF.descifrar(fila.clave, 'prueba-secreto-largo-1234567890'), 'clave-123');
assert.throws(() => ECF.descifrar(fila.clave, 'otro-secreto-distinto-123456'));
await llamar('PUT', '/api/ecf/config', { activo: true, ambiente: 'testecf', extra: { municipio: '010100', provincia: '010000', correo: 'info@audiopro.do' } });
assert.equal((await llamar('GET', '/api/ecf')).activo, true);
assert.match(await rechazo(llamar('PUT', '/api/ecf/config', { ambiente: 'produccion' })), /Ambiente/);
const prueba = await llamar('POST', '/api/ecf/probar', {});
assert.equal(prueba.ok, true);
ok('el certificado se valida al subirlo, se guarda cifrado, no sale del servidor y se prueba contra la DGII');

// Secuencias electrónicas
assert.match(await rechazo(llamar('PUT', '/api/ncf/E31', { siguiente: 1, hasta: 100, vence: 'mañana' })), /fecha de vencimiento/);
for (const [tipo, hasta, vence] of [['E31', 100, '2028-12-31'], ['E32', 100, ''], ['E33', 50, '2028-12-31'], ['E34', 50, ''], ['E41', 50, '2028-12-31'], ['E43', 50, '2028-12-31'], ['E44', 10, '2028-12-31'], ['E45', 10, '2028-12-31']]) {
  const r = await llamar('PUT', `/api/ncf/${tipo}`, { siguiente: 1, hasta, vence });
  assert.equal(r.vence, vence);
}
let seq = (await llamar('GET', '/api/ncf')).secuencias;
assert.equal(seq.find((x) => x.tipo === 'E31').vence, '2028-12-31'); assert.equal(seq.find((x) => x.tipo === 'E31').disponibles, 100);
assert.ok(seq.some((x) => x.tipo === 'B01'), 'conviven las secuencias B y E');
const n1 = await llamar('POST', '/api/ncf/siguiente', { candidatos: ['E31'], clave: 'clave-pedido-0001', dispositivo: 'dispositivo-prueba-0001' });
assert.deepEqual({ tipo: n1.tipo, numero: n1.numero }, { tipo: 'E31', numero: 1 });
ok('las secuencias E31…E45 se guardan con su fecha de vencimiento y se reparten como las demás');

// Una venta con comprobante electrónico llega por sincronización: se firma y se envía sola
const ahoraMs = Date.now();
const push = (cambios) => llamar('POST', '/api/sync', { dispositivo: 'dispositivo-prueba-0001', desde: 0, epoca: 0, cambios: cambios.map(([t, uid, d]) => ({ t, uid, d, u: ahoraMs })) });
const itbisCfg = [['config', 'itbis_modo', { valor: 'incluido' }], ['config', 'itbis_tasa', { valor: '18' }], ['config', 'negocio_nombre', { valor: 'Audio Pro SRL' }], ['config', 'negocio_rnc', { valor: '101123456' }], ['config', 'negocio_direccion', { valor: 'Av. Principal 1, Santo Domingo' }]];
await push([
  ...itbisCfg,
  ['productos', 'prod-1', { codigo: 'P-1', nombre: 'Bocina 6x9', precio: 1180, itbis_exento: 0 }],
  ['productos', 'prod-2', { codigo: 'P-2', nombre: 'Cable (exento)', precio: 100, itbis_exento: 1 }],
  ['clientes', 'cli-1', { nombre: 'DISTRIBUIDORA SA', tipo_doc: 'rnc', documento: '131880657', direccion: 'Calle 2 #5' }],
  ['clientes', 'cli-2', { nombre: 'Pedro sin RNC', tipo_doc: null, documento: null }],
  // precios con ITBIS incluido: 2 × 1180 = 2360 (base 2000) + cable exento 100; descuento general 60
  ['ventas', 'v-1', { numero: 'V-000001', fecha: '2026-10-15 21:03:00', subtotal: 2460, descuento: 60, total: 2400, metodo_pago: 'efectivo', estado: 'completada', itbis: 0, ncf: 'E310000000001', cliente_id: 'cli-1' }],
  ['venta_detalle', 'vd-1', { venta_id: 'v-1', producto_id: 'prod-1', cantidad: 2, precio_unitario: 1180, descuento: 0 }],
  ['venta_detalle', 'vd-2', { venta_id: 'v-1', producto_id: 'prod-2', cantidad: 1, precio_unitario: 100, descuento: 0 }],
]);
// el ITBIS que calcula la app para esa venta: gravado 2360 − 60 × (2360/2460) = 2302.44 → ITBIS incluido 351.21; se corrige el dato de la venta
const gravNeto = 2360 - 60 * (2360 / 2460); const itbisV1 = Math.round(gravNeto * 18 / 118 * 100) / 100;
await push([['ventas', 'v-1', { numero: 'V-000001', fecha: '2026-10-15 21:03:00', subtotal: 2460, descuento: 60, total: 2400, metodo_pago: 'efectivo', estado: 'completada', itbis: itbisV1, ncf: 'E310000000001', cliente_id: 'cli-1' }]]);
let env = (await llamar('GET', '/api/ecf/envios')).envios;
assert.equal(env.length, 1); assert.equal(env[0].estado, 'pendiente'); assert.equal(env[0].encf, 'E310000000001');
await llamar('POST', '/api/ecf/procesar', {});
env = (await llamar('GET', '/api/ecf/envios')).envios;
assert.equal(env[0].estado, 'aceptado', env[0].mensaje);
assert.equal(env[0].track_id, 'track-1'); assert.match(env[0].codigo_seguridad, /^.{6}$/);
const e1 = dgii.enviados.find((x) => x.encf === 'E310000000001');
assert.equal(e1.firmaValida, true, 'la DGII recibe el XML con una firma válida');
assert.match(e1.xml, /<RNCEmisor>101123456<\/RNCEmisor><RazonSocialEmisor>Audio Pro SRL<\/RazonSocialEmisor>/);
assert.match(e1.xml, /<DireccionEmisor>Av\. Principal 1, Santo Domingo<\/DireccionEmisor><Municipio>010100<\/Municipio><Provincia>010000<\/Provincia><CorreoEmisor>info@audiopro\.do<\/CorreoEmisor><FechaEmision>15-10-2026<\/FechaEmision>/);
assert.match(e1.xml, /<RNCComprador>131880657<\/RNCComprador><RazonSocialComprador>DISTRIBUIDORA SA<\/RazonSocialComprador><DireccionComprador>Calle 2 #5<\/DireccionComprador>/);
assert.match(e1.xml, /<FechaVencimientoSecuencia>31-12-2028<\/FechaVencimientoSecuencia>/);
const tot = (tag) => Number(new RegExp(`<${tag}>([\\d.]+)</${tag}>`).exec(e1.xml)[1]);
assert.equal(tot('MontoTotal'), 2400, 'el total del XML es el de la factura');
assert.equal(Math.round((tot('MontoGravadoTotal') + tot('MontoExento') + tot('TotalITBIS')) * 100) / 100, 2400, 'gravado + exento + ITBIS = total');
assert.equal(tot('TotalITBIS'), itbisV1, 'el ITBIS del XML es el de la factura');
const sumaItems = [...e1.xml.matchAll(/<MontoItem>([\d.]+)<\/MontoItem>/g)].reduce((s, m) => s + Number(m[1]), 0);
assert.equal(Math.round(sumaItems * 100) / 100, Math.round((tot('MontoGravadoTotal') + tot('MontoExento')) * 100) / 100, 'las líneas suman la base');
assert.equal(tot('MontoExento'), 97.56, 'el exento recibe su parte del descuento general (100 − 2.44)');
assert.match(e1.xml, /<IndicadorFacturacion>4<\/IndicadorFacturacion><NombreItem>Cable \(exento\)<\/NombreItem>/);
ok('una venta con e-NCF que llega por sincronización se arma, firma y envía; los totales del XML cuadran con la factura');

// El estado vuelve a los equipos por la sincronización
const bajada = await llamar('POST', '/api/sync', { dispositivo: 'otro-dispositivo-00000002', desde: 0, epoca: 0, cambios: [] });
const doc = bajada.cambios.find((c) => c.t === 'ecf_documentos');
assert.ok(doc, 'los equipos reciben el estado del comprobante');
assert.equal(doc.d.estado, 'aceptado'); assert.equal(doc.d.venta_id, 'v-1'); assert.equal(doc.d.ncf, 'E310000000001');
assert.match(doc.d.qr_url, /^https:\/\/ecf\.dgii\.gov\.do\/TestECF\/ConsultaTimbre\?RncEmisor=101123456&RncComprador=131880657&ENCF=E310000000001&FechaEmision=15-10-2026&MontoTotal=2400\.00&FechaFirma=/);
assert.ok(doc.d.qr_url.includes(`CodigoSeguridad=${encodeURIComponent(doc.d.codigo_seguridad)}`));
assert.ok(!('xml' in doc.d), 'el XML no viaja a los equipos');
// Un equipo no puede escribir el estado de un comprobante
const forja = await push([['ecf_documentos', doc.uid, { ...doc.d, estado: 'rechazado' }]]);
assert.equal(forja.ignorados, 1);
assert.equal((await llamar('GET', '/api/ecf/envios')).envios[0].estado, 'aceptado');
ok('el estado, el código de seguridad y el QR llegan a los equipos; un equipo no puede alterarlos');

// Factura de consumo menor de 250 mil: resumen (RFCE)
await push([
  ['ventas', 'v-2', { numero: 'V-000002', fecha: '2026-10-15 21:10:00', subtotal: 1180, descuento: 0, total: 1180, metodo_pago: 'tarjeta', estado: 'completada', itbis: 180, ncf: 'E320000000001', cliente_id: 'cli-2' }],
  ['venta_detalle', 'vd-3', { venta_id: 'v-2', producto_id: 'prod-1', cantidad: 1, precio_unitario: 1180, descuento: 0 }],
]);
await llamar('POST', '/api/ecf/procesar', {});
assert.equal(dgii.resumenes.length, 1, 'el E32 menor de RD$250,000 se informa con el resumen');
assert.equal(dgii.resumenes[0].firmaValida, true);
assert.match(dgii.resumenes[0].xml, /<RFCE>.*<eNCF>E320000000001<\/eNCF>.*<RazonSocialComprador>Pedro sin RNC<\/RazonSocialComprador>.*<MontoTotal>1180\.00<\/MontoTotal><\/Totales><CodigoSeguridadeCF>(.{6})<\/CodigoSeguridadeCF>/);
const e2 = (await llamar('GET', '/api/ecf/envios')).envios.find((x) => x.encf === 'E320000000001');
assert.equal(e2.estado, 'aceptado');
assert.ok(!dgii.enviados.some((x) => x.encf === 'E320000000001'), 'el E32 pequeño no se envía completo');
const cs = /<CodigoSeguridadeCF>(.{6})</.exec(dgii.resumenes[0].xml)[1];
assert.equal(e2.codigo_seguridad, cs, 'el código del resumen es el de la firma del e-CF completo');
const d2 = (await llamar('POST', '/api/sync', { dispositivo: 'otro-dispositivo-00000002', desde: 0, epoca: 0, cambios: [] })).cambios.filter((c) => c.t === 'ecf_documentos').find((c) => c.d.ncf === 'E320000000001');
assert.match(d2.d.qr_url, /^https:\/\/fc\.dgii\.gov\.do\/TestECF\/ConsultaTimbreFC\?RncEmisor=101123456&ENCF=E320000000001&MontoTotal=1180\.00&CodigoSeguridad=/);
ok('la factura de consumo menor de RD$250,000 se informa con el resumen firmado y su QR de consulta');

// Falta un dato: queda "incompleto" con el motivo, sin reintentar a ciegas; al corregirlo se reintenta
await push([
  ['ventas', 'v-3', { numero: 'V-000003', fecha: '2026-10-15 21:20:00', subtotal: 1180, descuento: 0, total: 1180, metodo_pago: 'efectivo', estado: 'completada', itbis: 180, ncf: 'E310000000002', cliente_id: 'cli-2' }],
  ['venta_detalle', 'vd-4', { venta_id: 'v-3', producto_id: 'prod-1', cantidad: 1, precio_unitario: 1180, descuento: 0 }],
]);
await llamar('POST', '/api/ecf/procesar', {});
let e3 = (await llamar('GET', '/api/ecf/envios')).envios.find((x) => x.encf === 'E310000000002');
assert.equal(e3.estado, 'incompleto'); assert.match(e3.mensaje, /necesita el RNC del cliente/);
await push([['clientes', 'cli-2', { nombre: 'Pedro SRL', tipo_doc: 'rnc', documento: '130999888', direccion: '' }]]);
await llamar('POST', `/api/ecf/envios/${e3.uid}/reintentar`, { reconstruir: true });
await llamar('POST', '/api/ecf/procesar', {});
e3 = (await llamar('GET', '/api/ecf/envios')).envios.find((x) => x.encf === 'E310000000002');
assert.equal(e3.estado, 'aceptado');
ok('si falta un dato (RNC del cliente) el comprobante queda incompleto con el motivo y se envía al corregirlo');

// La DGII rechaza: queda rechazado con su mensaje; se corrige y se vuelve a enviar con el mismo e-NCF
dgii.estadoPorDefecto = { codigo: '2', estado: 'Rechazado', mensajes: [{ valor: 'El RNC del comprador no existe', codigo: 99 }] };
await push([
  ['ventas', 'v-4', { numero: 'V-000004', fecha: '2026-10-15 21:30:00', subtotal: 1180, descuento: 0, total: 1180, metodo_pago: 'efectivo', estado: 'completada', itbis: 180, ncf: 'E310000000003', cliente_id: 'cli-1' }],
  ['venta_detalle', 'vd-5', { venta_id: 'v-4', producto_id: 'prod-1', cantidad: 1, precio_unitario: 1180, descuento: 0 }],
]);
await llamar('POST', '/api/ecf/procesar', {});
let e4 = (await llamar('GET', '/api/ecf/envios')).envios.find((x) => x.encf === 'E310000000003');
assert.equal(e4.estado, 'rechazado'); assert.match(e4.mensaje, /\[99\] El RNC del comprador no existe/);
dgii.estadoPorDefecto = null;
const antesEnv = dgii.enviados.length;
await llamar('POST', `/api/ecf/envios/${e4.uid}/reintentar`, {});
await llamar('POST', '/api/ecf/procesar', {});
e4 = (await llamar('GET', '/api/ecf/envios')).envios.find((x) => x.encf === 'E310000000003');
assert.equal(e4.estado, 'aceptado'); assert.equal(dgii.enviados.length, antesEnv + 1);
assert.equal((await rechazo(llamar('POST', `/api/ecf/envios/${e4.uid}/reintentar`, {}))).includes('ya fue aceptado'), true);
ok('si la DGII rechaza, se ve su mensaje y se puede corregir y reenviar; lo aceptado ya no se reenvía');

// Fallas pasajeras: reintenta solo con espera, sin duplicar
await push([
  ['ventas', 'v-5', { numero: 'V-000005', fecha: '2026-10-15 21:40:00', subtotal: 1180, descuento: 0, total: 1180, metodo_pago: 'efectivo', estado: 'completada', itbis: 180, ncf: 'E310000000004', cliente_id: 'cli-1' }],
  ['venta_detalle', 'vd-6', { venta_id: 'v-5', producto_id: 'prod-1', cantidad: 1, precio_unitario: 1180, descuento: 0 }],
]);
dgii.falla = { estado: 503, veces: 99 };
await llamar('POST', '/api/ecf/procesar', {});
let e5 = (await llamar('GET', '/api/ecf/envios')).envios.find((x) => x.encf === 'E310000000004');
assert.equal(e5.estado, 'error'); assert.equal(e5.intentos, 1); assert.match(e5.mensaje, /503/);
await llamar('POST', '/api/ecf/procesar', {});
assert.equal((await llamar('GET', '/api/ecf/envios')).envios.find((x) => x.encf === 'E310000000004').intentos, 1, 'respeta la espera entre intentos');
dgii.falla = null;
srvDb.prepare("UPDATE ecf_envios SET proximo = 0 WHERE encf = 'E310000000004'").run();
await llamar('POST', '/api/ecf/procesar', {});
e5 = (await llamar('GET', '/api/ecf/envios')).envios.find((x) => x.encf === 'E310000000004');
assert.equal(e5.estado, 'aceptado');
assert.equal(dgii.enviados.filter((x) => x.encf === 'E310000000004').length, 1, 'no se envía dos veces');
ok('ante una falla de la DGII o de la red reintenta con espera creciente y no duplica el envío');

// El XML firmado se guarda: el reintento reenvía exactamente el mismo documento
const guardado = await llamar('GET', `/api/ecf/envios/${e5.uid}/xml`);
assert.equal(F.verificarFirma(guardado.xml).valido, true);
assert.equal(dgii.enviados.find((x) => x.encf === 'E310000000004').xml, guardado.xml);
ok('el XML firmado queda guardado y es el mismo que recibió la DGII');

// Nota de crédito sobre una factura
await push([
  ['cxc_conceptos', 'con-1', { nombre: 'Devolución', tipo: 'descuento' }],
  ['cxc_docs', 'nc-1', { numero: 'NC-000001', tipo: 'credito', fecha: '2026-10-16 09:00:00', monto: 590, itbis: 90, ncf: 'E340000000001', estado: 'vigente', cliente_id: 'cli-1', venta_id: 'v-1', concepto_id: 'con-1', notas: 'Devolvió una bocina' }],
]);
await llamar('POST', '/api/ecf/procesar', {});
const nc = (await llamar('GET', '/api/ecf/envios')).envios.find((x) => x.encf === 'E340000000001');
assert.equal(nc.estado, 'aceptado', nc.mensaje);
const xn = dgii.enviados.find((x) => x.encf === 'E340000000001').xml;
assert.match(xn, /<InformacionReferencia><NCFModificado>E310000000001<\/NCFModificado><FechaNCFModificado>15-10-2026<\/FechaNCFModificado><CodigoModificacion>3<\/CodigoModificacion><RazonModificacion>Devolvió una bocina<\/RazonModificacion>/);
assert.match(xn, /<IndicadorNotaCredito>0<\/IndicadorNotaCredito>/);
assert.match(xn, /<NombreItem>Devolución<\/NombreItem>/);
assert.equal(Number(/<MontoTotal>([\d.]+)</.exec(xn)[1]), 590);
assert.equal(Number(/<TotalITBIS>([\d.]+)</.exec(xn)[1]), 90);
ok('una nota de crédito electrónica (E34) referencia la factura que modifica y sus montos cuadran');

// Compra a un informal (E41) y gasto menor (E43) emitidos a mano
const emitir = (cuerpo) => llamar('POST', '/api/ecf/emitir', cuerpo);
assert.match(await rechazo(emitir({ tipo: 'E31', clave: 'clave-manual-0001', lineas: [{ nombre: 'x', cantidad: 1, precio: 1 }] })), /solo se emiten a mano/i);
assert.match(await rechazo(emitir({ tipo: 'E41', clave: 'clave-manual-0001', lineas: [], comprador: { razon: 'X' } })), /línea necesita/);
assert.match(await rechazo(emitir({ tipo: 'E41', clave: 'clave-manual-0001', lineas: [{ nombre: 'Comisión', cantidad: 1, precio: 1000 }] })), /nombre de quien te vende/);
const m41 = await emitir({ tipo: 'E41', clave: 'clave-manual-0001', comprador: { rnc: '00112345678', razon: 'JUAN PEREZ' }, lineas: [{ nombre: 'Compra de repuestos usados', cantidad: 2, precio: 500, exento: true }], isrRetenido: 0 });
assert.equal(m41.encf, 'E410000000001'); assert.equal(m41.envio.estado, 'aceptado', m41.envio.mensaje);
const x41 = dgii.enviados.find((x) => x.encf === 'E410000000001').xml;
assert.match(x41, /<RNCComprador>00112345678<\/RNCComprador><RazonSocialComprador>JUAN PEREZ<\/RazonSocialComprador>/);
assert.match(x41, /<MontoExento>1000\.00<\/MontoExento><MontoTotal>1000\.00<\/MontoTotal>/);
const repetido = await emitir({ tipo: 'E41', clave: 'clave-manual-0001', comprador: { razon: 'JUAN PEREZ' }, lineas: [{ nombre: 'Compra de repuestos usados', cantidad: 2, precio: 500, exento: true }] });
assert.equal(repetido.encf, 'E410000000001', 'repetir el pedido no gasta otro número');
const m43 = await emitir({ tipo: 'E43', clave: 'clave-manual-0002', lineas: [{ nombre: 'Taxi a entrega', cantidad: 1, precio: 350, exento: true, bien: false }] });
assert.equal(m43.encf, 'E430000000001'); assert.equal(m43.envio.estado, 'aceptado');
assert.doesNotMatch(dgii.enviados.find((x) => x.encf === 'E430000000001').xml, /<Comprador>/);
ok('las compras a informales (E41) y los gastos menores (E43) se emiten desde el sistema con su propio número');

// Anular un número que no se usó: se informa a la DGII como rango anulado
const n2 = await llamar('POST', '/api/ncf/siguiente', { candidatos: ['E31'], clave: 'clave-pedido-0009', dispositivo: 'dispositivo-prueba-0001' });
const num2 = n2.numero;
await llamar('POST', '/api/ncf/anular', { clave: 'clave-pedido-0009', motivo: 'La factura no se guardó' });
await llamar('POST', '/api/ecf/procesar', {});
assert.equal(dgii.anulados.length, 1);
assert.match(dgii.anulados[0], new RegExp(`<SecuenciaeNCFDesde>E31${String(num2).padStart(10, '0')}</SecuenciaeNCFDesde>`));
assert.equal(F.verificarFirma(/<ANECF>[\s\S]*<\/ANECF>/.exec(dgii.anulados[0])[0]).valido, true);
ok('un e-NCF reservado que no se usó se anula en la DGII como rango anulado');

// Sin la facturación electrónica activada no se encola nada y los permisos se respetan
await llamar('PUT', '/api/ecf/config', { activo: false });
const antes = (await llamar('GET', '/api/ecf/envios')).envios.length;
await push([['ventas', 'v-9', { numero: 'V-000009', fecha: '2026-10-16 10:00:00', total: 100, itbis: 0, ncf: 'E310000000099', estado: 'completada' }]]);
assert.equal((await llamar('GET', '/api/ecf/envios')).envios.length, antes);
await llamar('PUT', '/api/ecf/config', { activo: true });
const sinAdmin = crearCliente({ base: () => BASE, token: () => null });
assert.ok(await rechazo(sinAdmin.llamar('GET', '/api/ecf')), 'sin sesión no se accede');
ok('apagada la facturación electrónica no se encola nada; sin sesión no se accede');

// Eliminar el negocio borra también su certificado y sus comprobantes
const n_ecf = srvDb.prepare('SELECT COUNT(*) c FROM ecf_envios WHERE negocio = ?').get(NEG).c;
assert.ok(n_ecf > 5);
console.log(`\n${n} pruebas de facturación electrónica correctas.`);
servidor.close();
fs.rmSync(tmp, { recursive: true, force: true });
