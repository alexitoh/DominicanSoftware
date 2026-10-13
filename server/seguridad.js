// seguridad.js (servidor) - contraseñas con scrypt y tokens firmados (HS256), sin dependencias
import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

export function hashClave(clave) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(clave, salt, 32, { N: 16384, r: 8, p: 1 });
  return `${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verificarClave(clave, guardado) {
  if (!guardado || !guardado.includes(':')) return false;
  const [s, h] = guardado.split(':');
  const esperado = Buffer.from(h, 'base64');
  const calculado = crypto.scryptSync(clave, Buffer.from(s, 'base64'), esperado.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(calculado, esperado);
}

export function firmar(payload, secreto, segundos = 30 * 86400) {
  const cuerpo = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + segundos }));
  const cab = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const firma = crypto.createHmac('sha256', secreto).update(`${cab}.${cuerpo}`).digest('base64url');
  return `${cab}.${cuerpo}.${firma}`;
}

export function verificar(token, secreto) {
  const partes = String(token || '').split('.');
  if (partes.length !== 3) return null;
  const esperada = crypto.createHmac('sha256', secreto).update(`${partes[0]}.${partes[1]}`).digest();
  const dada = Buffer.from(partes[2], 'base64url');
  if (dada.length !== esperada.length || !crypto.timingSafeEqual(dada, esperada)) return null;
  try {
    const p = JSON.parse(Buffer.from(partes[1], 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}

export const uid = () => crypto.randomBytes(16).toString('hex');

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function codigoRecuperacion() {
  const b = crypto.randomBytes(12);
  const t = [...b].map((x) => ALFABETO[x % ALFABETO.length]).join('');
  return `${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8, 12)}`;
}
export const normalizarCodigo = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const normalizarUsuario = (u) => String(u || '').trim().toLowerCase();
export const errorUsuario = (u) => (/^[a-z0-9._-]{3,30}$/.test(u) ? '' : 'El usuario debe tener de 3 a 30 caracteres: letras, números, punto, guion o guion bajo.');
export const errorCorreo = (c) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(c || '').trim()) ? '' : 'Escribe un correo válido.');
export function errorClave(c) {
  const t = String(c || '');
  if (t.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[A-Za-z]/.test(t) || !/[0-9]/.test(t)) return 'La contraseña debe combinar letras y números.';
  return '';
}

// A, B, ... Z, AA, AB ... para numerar los dispositivos de un negocio
export function codigoDispositivo(n) {
  let s = '';
  let i = n;
  do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
  return s;
}
