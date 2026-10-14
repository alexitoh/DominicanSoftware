// seguridad.js - contraseñas con hash (PBKDF2), códigos de recuperación y validaciones.
// No importa nada de la app para poder probarse sola y reutilizarse cuando la autenticación pase a la nube.

const ITERACIONES = 150000;
const enc = new TextEncoder();

const aBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const deBase64 = (txt) => Uint8Array.from(atob(txt), (c) => c.charCodeAt(0));

export function criptoDisponible() {
  return !!(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues);
}

async function derivar(clave, sal, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(clave), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iter }, base, 256);
}

// Devuelve { salt, hash, iter } listos para guardar. La contraseña nunca se guarda.
export async function hashClave(clave) {
  if (!criptoDisponible()) throw new Error('Este navegador no permite crear cuentas seguras. Abre la app desde HTTPS o desde localhost.');
  const sal = crypto.getRandomValues(new Uint8Array(16));
  return { salt: aBase64(sal), hash: aBase64(await derivar(clave, sal, ITERACIONES)), iter: ITERACIONES };
}

export async function verificarClave(clave, salt, hash, iter = ITERACIONES) {
  if (!criptoDisponible() || !salt || !hash) return false;
  const calculado = new Uint8Array(await derivar(clave, deBase64(salt), iter));
  const esperado = deBase64(hash);
  if (calculado.length !== esperado.length) return false;
  let dif = 0; // comparación de tiempo constante
  for (let i = 0; i < calculado.length; i++) dif |= calculado[i] ^ esperado[i];
  return dif === 0;
}

// Código para recuperar la cuenta si se olvida la contraseña (sin letras confusas: 0/O, 1/I)
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generarCodigoRecuperacion() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const letras = [...b].map((x) => ALFABETO[x % ALFABETO.length]).join('');
  return `${letras.slice(0, 4)}-${letras.slice(4, 8)}-${letras.slice(8, 12)}`;
}
export const normalizarCodigo = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Contraseña temporal legible para entregar a un empleado
export function generarClaveTemporal() {
  const letras = 'abcdefghjkmnpqrstuvwxyz';
  const numeros = '23456789';
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = [...b.slice(0, 6)].map((x) => letras[x % letras.length]).join('');
  s += [...b.slice(6)].map((x) => numeros[x % numeros.length]).join('');
  return s;
}

// Identificador del negocio: el RNC (9 dígitos) o la cédula (11), sin guiones. Sin RNC, el servidor asigna un número de 9 dígitos.
export const normalizarRnc = (x) => String(x || '').replace(/[\s-]/g, '');
export const errorRnc = (x) => (/^(\d{9}|\d{11})$/.test(x) ? '' : 'El RNC debe tener 9 números (o la cédula 11), sin guiones.');

export function normalizarUsuario(u) {
  return String(u || '').trim().toLowerCase();
}

// Devuelve un texto de error, o '' si todo está bien
export function errorUsuario(u) {
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) return 'El usuario debe tener de 3 a 30 caracteres: letras, números, punto, guion o guion bajo.';
  return '';
}
export function errorCorreo(c) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(c || '').trim()) ? '' : 'Escribe un correo válido.';
}
export function errorClave(c) {
  const t = String(c || '');
  if (t.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[A-Za-z]/.test(t) || !/[0-9]/.test(t)) return 'La contraseña debe combinar letras y números.';
  return '';
}
