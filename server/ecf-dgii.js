// ecf-dgii.js (servidor) - cliente de los servicios de la DGII para facturación electrónica.
// Los tres ambientes tienen la misma estructura: TesteCF (pruebas), CerteCF (certificación) y eCF (producción).
// Recibe `fetchFn` para poder probarlo sin salir a internet.
import { el, t, conDeclaracion, serializar } from './ecf-xml.js';
import { firmarArbol } from './ecf-firma.js';

export const AMBIENTES = { testecf: 'Pruebas (TesteCF)', certecf: 'Certificación (CerteCF)', ecf: 'Producción (eCF)' };
export const HOST_ECF = 'https://ecf.dgii.gov.do';
export const HOST_FC = 'https://fc.dgii.gov.do';

export class ErrorDGII extends Error {
  constructor(mensaje, { estado = 0, cuerpo = null, reintentable = false } = {}) {
    super(mensaje);
    this.estado = estado; this.cuerpo = cuerpo; this.reintentable = reintentable;
  }
}

// Estado que devuelve la DGII → el que usa el sistema
export function normalizarEstado(texto, codigo) {
  const s = String(texto || '').toLowerCase();
  if (s.includes('condicional') || String(codigo) === '4') return 'condicional';
  if (s.includes('rechaz') || String(codigo) === '2') return 'rechazado';
  if (s.includes('aceptad') || String(codigo) === '1') return 'aceptado';
  if (s.includes('proceso') || String(codigo) === '3') return 'enviado';
  if (s.includes('no encontrado') || String(codigo) === '0') return 'noEncontrado';
  return 'enviado';
}

// Mensajes de la respuesta de la DGII → texto corto
export function textoMensajes(r) {
  const m = r?.mensajes ?? r?.mensaje;
  if (!m) return '';
  if (typeof m === 'string') return m;
  return (Array.isArray(m) ? m : [m]).map((x) => (typeof x === 'string' ? x : [x.codigo ? `[${x.codigo}]` : '', x.valor || x.mensaje || ''].filter(Boolean).join(' '))).filter(Boolean).join(' · ').slice(0, 600);
}

export function crearClienteDGII({ ambiente = 'testecf', credenciales, fetchFn = (...a) => fetch(...a), ahora = () => Date.now(), tiempo = 30000, cacheToken = new Map() } = {}) {
  if (!AMBIENTES[ambiente]) throw new Error('Ambiente de la DGII desconocido.');
  const clave = `${ambiente}`;

  async function llamar(url, opciones = {}) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), tiempo);
    let r;
    try { r = await fetchFn(url, { ...opciones, signal: control.signal }); } catch (e) {
      throw new ErrorDGII(`No se pudo comunicar con la DGII (${e.name === 'AbortError' ? 'tardó demasiado' : e.message}).`, { reintentable: true });
    } finally { clearTimeout(reloj); }
    const texto = await r.text();
    let cuerpo = null;
    try { cuerpo = texto ? JSON.parse(texto) : null; } catch { cuerpo = texto; }
    if (!r.ok) {
      const msg = typeof cuerpo === 'object' && cuerpo ? (textoMensajes(cuerpo) || cuerpo.title || cuerpo.error || '') : String(cuerpo || '').slice(0, 300);
      throw new ErrorDGII(`La DGII respondió ${r.status}${msg ? `: ${msg}` : ''}.`, { estado: r.status, cuerpo, reintentable: r.status >= 500 || r.status === 429 || r.status === 408 });
    }
    return { estado: r.status, cuerpo, texto };
  }

  const multipart = (nombreArchivo, xml) => {
    const frontera = `----ecf${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const cuerpo = Buffer.concat([
      Buffer.from(`--${frontera}\r\nContent-Disposition: form-data; name="xml"; filename="${nombreArchivo}"\r\nContent-Type: text/xml\r\n\r\n`),
      Buffer.from(xml, 'utf8'),
      Buffer.from(`\r\n--${frontera}--\r\n`),
    ]);
    return { cuerpo, tipo: `multipart/form-data; boundary=${frontera}` };
  };

  // 1) pide la semilla, 2) la firma con el certificado, 3) la devuelve y recibe un token (dura una hora aproximadamente)
  async function token(forzar = false) {
    const guardado = cacheToken.get(clave);
    if (!forzar && guardado && guardado.vence > ahora() + 60000) return guardado.valor;
    const s = await llamar(`${HOST_ECF}/${ambiente}/autenticacion/api/autenticacion/semilla`, { method: 'GET', headers: { Accept: 'application/xml' } });
    const valor = /<valor>([^<]+)<\/valor>/.exec(s.texto)?.[1];
    if (!valor) throw new ErrorDGII('La DGII no entregó la semilla de autenticación.');
    const fechaSemilla = /<fecha>([^<]+)<\/fecha>/.exec(s.texto)?.[1];
    const firmada = firmarArbol(el('SemillaModel', [t('valor', valor), t('fecha', fechaSemilla)].filter(Boolean)), credenciales).xml;
    const mp = multipart('semilla.xml', firmada);
    const v = await llamar(`${HOST_ECF}/${ambiente}/autenticacion/api/autenticacion/validarsemilla`, { method: 'POST', headers: { 'Content-Type': mp.tipo }, body: mp.cuerpo });
    const tk = v.cuerpo?.token;
    if (!tk) throw new ErrorDGII('La DGII no entregó el token de acceso. Revisa que el certificado sea el del emisor.', { cuerpo: v.cuerpo });
    const expira = Date.parse(v.cuerpo.expira) || ahora() + 50 * 60000;
    cacheToken.set(clave, { valor: tk, vence: expira });
    return tk;
  }

  // Hace la llamada con token; si la DGII dice que expiró (401) pide otro y repite una vez
  async function conToken(fn) {
    try { return await fn(await token()); } catch (e) {
      if (e instanceof ErrorDGII && e.estado === 401) return fn(await token(true));
      throw e;
    }
  }

  return {
    ambiente, token,
    // e-CF completo (asíncrono: devuelve un trackId que luego se consulta)
    enviarECF: (xml, nombreArchivo) => conToken(async (tk) => {
      const mp = multipart(nombreArchivo, xml);
      const r = await llamar(`${HOST_ECF}/${ambiente}/recepcion/api/facturaselectronicas`, { method: 'POST', headers: { 'Content-Type': mp.tipo, Authorization: `Bearer ${tk}` }, body: mp.cuerpo });
      const trackId = r.cuerpo?.trackId;
      if (!trackId) throw new ErrorDGII(`La DGII no aceptó el envío${r.cuerpo?.mensaje ? `: ${textoMensajes(r.cuerpo)}` : ''}.`, { cuerpo: r.cuerpo });
      return { trackId, respuesta: r.cuerpo };
    }),
    // Resumen de factura de consumo (síncrono: responde el resultado en el momento)
    enviarRFCE: (xml, nombreArchivo) => conToken(async (tk) => {
      const mp = multipart(nombreArchivo, xml);
      const r = await llamar(`${HOST_FC}/${ambiente}/recepcionfc/api/recepcion/ecf`, { method: 'POST', headers: { 'Content-Type': mp.tipo, Authorization: `Bearer ${tk}` }, body: mp.cuerpo });
      const c = r.cuerpo || {};
      return { estado: normalizarEstado(c.estado, c.codigo), mensaje: textoMensajes(c), secuenciaUtilizada: c.secuenciaUtilizada, respuesta: c };
    }),
    // Resultado de un envío
    estado: (trackId) => conToken(async (tk) => {
      const r = await llamar(`${HOST_ECF}/${ambiente}/consultaresultado/api/consultas/estado?trackid=${encodeURIComponent(trackId)}`, { method: 'GET', headers: { Authorization: `Bearer ${tk}`, Accept: 'application/json' } });
      const c = r.cuerpo || {};
      return { estado: normalizarEstado(c.estado, c.codigo), mensaje: textoMensajes(c), secuenciaUtilizada: c.secuenciaUtilizada, respuesta: c };
    }),
    // Anulación de un rango de e-NCF que no se usó
    anularRango: (xml, nombreArchivo) => conToken(async (tk) => {
      const mp = multipart(nombreArchivo, xml);
      const r = await llamar(`${HOST_ECF}/${ambiente}/anulacionrangos/api/operaciones/anularrango`, { method: 'POST', headers: { 'Content-Type': mp.tipo, Authorization: `Bearer ${tk}` }, body: mp.cuerpo });
      return { respuesta: r.cuerpo, mensaje: textoMensajes(r.cuerpo) };
    }),
  };
}

export { conDeclaracion, serializar };
