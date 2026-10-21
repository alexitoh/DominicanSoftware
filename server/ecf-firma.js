// ecf-firma.js (servidor) - lee el certificado digital (.p12) del negocio y firma los XML de la DGII (XMLDSig enveloped, RSA-SHA256).
// El certificado se lee con "openssl" (viene en la imagen del servidor) porque Node no entiende el formato PKCS#12.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { el, serializar, conDeclaracion } from './ecf-xml.js';

export const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';
export const ALG_C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
export const ALG_RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
export const ALG_SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
export const ALG_ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

// ---------- Certificado ----------
// Devuelve { clavePem, certPem, info } desde el archivo .p12 y su contraseña. Lanza un error claro si no se puede leer.
export function leerP12(p12, clave) {
  const intentos = [[], ['-legacy']]; // los .p12 antiguos (RC2/3DES) necesitan el modo "legacy" de OpenSSL 3
  let salida = null; let ultimo = '';
  for (const extra of intentos) {
    try {
      salida = execFileSync('openssl', ['pkcs12', '-nodes', '-passin', 'env:ECF_P12_CLAVE', ...extra], {
        input: p12, env: { ...process.env, ECF_P12_CLAVE: String(clave ?? '') }, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024,
      }).toString('utf8');
      break;
    } catch (e) { ultimo = String(e.stderr || e.message || ''); if (e.code === 'ENOENT') throw new Error('El servidor no tiene OpenSSL instalado, no puede leer el certificado.'); }
  }
  if (salida == null) {
    if (/mac verify|invalid password|maybe wrong password/i.test(ultimo)) throw new Error('La contraseña del certificado no es correcta.');
    throw new Error('No se pudo leer el certificado: revisa que sea un archivo .p12 (o .pfx) válido.');
  }
  const bloques = (tipo) => [...salida.matchAll(new RegExp(`-----BEGIN ${tipo}-----[\\s\\S]*?-----END ${tipo}-----`, 'g'))].map((m) => m[0]);
  const claves = [...bloques('PRIVATE KEY'), ...bloques('RSA PRIVATE KEY'), ...bloques('ENCRYPTED PRIVATE KEY')];
  const certs = bloques('CERTIFICATE');
  if (!claves.length || !certs.length) throw new Error('El archivo no trae la llave privada y el certificado.');
  const clavePem = claves[0];
  let privada;
  try { privada = crypto.createPrivateKey(clavePem); } catch { throw new Error('No se pudo leer la llave privada del certificado.'); }
  if (privada.asymmetricKeyType !== 'rsa') throw new Error('La DGII exige certificados con llave RSA.');
  // El certificado propio es el que corresponde a la llave privada (el archivo puede traer también los de la cadena)
  const publica = crypto.createPublicKey(privada).export({ type: 'spki', format: 'der' }).toString('base64');
  const propio = certs.find((c) => { try { return new crypto.X509Certificate(c).publicKey.export({ type: 'spki', format: 'der' }).toString('base64') === publica; } catch { return false; } });
  if (!propio) throw new Error('El certificado no corresponde a la llave privada.');
  const x = new crypto.X509Certificate(propio);
  const info = {
    sujeto: x.subject.replace(/\n/g, ', '), emisor: x.issuer.replace(/\n/g, ', '), desde: x.validFrom, hasta: x.validTo,
    serie: x.serialNumber, vence: new Date(x.validTo).toISOString().slice(0, 10), vencido: new Date(x.validTo).getTime() < Date.now(),
  };
  return { clavePem, certPem: propio, info };
}

const cuerpoCert = (pem) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

// ---------- Firma ----------
// Firma el árbol `raiz` (sin firma todavía) y devuelve { xml, firma (SignatureValue), certPem... }. El documento queda así:
// <ECF>…<Signature>…</Signature></ECF>
export function firmarArbol(raiz, { clavePem, certPem }) {
  if (!raiz || !Array.isArray(raiz.contenido)) throw new Error('No hay documento que firmar.');
  const sinFirma = serializar(raiz); // forma canónica (sin la firma): lo que la DGII calcula al aplicar la transformación "enveloped"
  const digest = crypto.createHash('sha256').update(sinFirma, 'utf8').digest('base64');
  const signedInfo = el('SignedInfo', [
    el('CanonicalizationMethod', '', { Algorithm: ALG_C14N }),
    el('SignatureMethod', '', { Algorithm: ALG_RSA_SHA256 }),
    el('Reference', [
      el('Transforms', [el('Transform', '', { Algorithm: ALG_ENVELOPED })]),
      el('DigestMethod', '', { Algorithm: ALG_SHA256 }),
      el('DigestValue', digest),
    ], { URI: '' }),
  ]);
  // El SignedInfo se canoniza con el espacio de nombres de la firma declarado en él (así lo hereda del elemento Signature)
  const canonSignedInfo = serializar({ ...signedInfo, attrs: { xmlns: NS_DSIG } });
  const valor = crypto.sign('sha256', Buffer.from(canonSignedInfo, 'utf8'), crypto.createPrivateKey(clavePem)).toString('base64');
  const firma = el('Signature', [
    signedInfo,
    el('SignatureValue', valor),
    el('KeyInfo', [el('X509Data', [el('X509Certificate', cuerpoCert(certPem))])]),
  ], { xmlns: NS_DSIG });
  const firmado = { ...raiz, contenido: [...raiz.contenido, firma] };
  return { xml: conDeclaracion(serializar(firmado)), firma: valor, digest, canonSignedInfo, sinFirma };
}

// Los 6 primeros caracteres de la firma: es el "código de seguridad" que va en el QR y en la factura impresa
export const codigoSeguridad = (firma) => String(firma).slice(0, 6);

// ---------- Verificación (para pruebas y para revisar lo recibido) ----------
// Recalcula con la misma regla de la DGII: quita <Signature>, canoniza y compara el digest; luego verifica la firma del SignedInfo.
export function verificarFirma(xml) {
  const m = /<Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">([\s\S]*)<\/Signature>/.exec(xml);
  if (!m) return { valido: false, motivo: 'No tiene firma.' };
  const sinFirma = xml.replace(/^<\?xml[^>]*\?>/, '').replace(m[0], '');
  const signedInfo = /<SignedInfo>[\s\S]*<\/SignedInfo>/.exec(m[1])?.[0];
  const digestDoc = /<DigestValue>([^<]*)<\/DigestValue>/.exec(m[1])?.[1];
  const valor = /<SignatureValue>([^<]*)<\/SignatureValue>/.exec(m[1])?.[1];
  const cert = /<X509Certificate>([^<]*)<\/X509Certificate>/.exec(m[1])?.[1];
  if (!signedInfo || !digestDoc || !valor || !cert) return { valido: false, motivo: 'La firma está incompleta.' };
  if (crypto.createHash('sha256').update(sinFirma, 'utf8').digest('base64') !== digestDoc) return { valido: false, motivo: 'El documento cambió después de firmarse.' };
  const x = new crypto.X509Certificate(`-----BEGIN CERTIFICATE-----\n${cert}\n-----END CERTIFICATE-----`);
  const canon = signedInfo.replace('<SignedInfo>', `<SignedInfo xmlns="${NS_DSIG}">`);
  const ok = crypto.verify('sha256', Buffer.from(canon, 'utf8'), x.publicKey, Buffer.from(valor, 'base64'));
  return { valido: ok, motivo: ok ? '' : 'La firma no coincide.', firma: valor, sujeto: x.subject };
}
