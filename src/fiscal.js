// fiscal.js - identificación fiscal de clientes: RNC, cédula o DNI (documento de otro país)
// Sin dependencias para poder probarlo solo.

export const TIPOS_DOC = [
  { id: 'rnc', nombre: 'RNC' },
  { id: 'cedula', nombre: 'Cédula' },
  { id: 'dni', nombre: 'DNI / otro' },
];

// Deja solo letras y números, en mayúsculas
export const limpiarDocumento = (t) => String(t || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

// Devuelve { tipo, numero } listos para guardar, o { error }. Sin número, el tipo se descarta.
export function validarDocumento(tipo, texto) {
  const numero = limpiarDocumento(texto);
  if (!numero) return { tipo: null, numero: null };
  if (!TIPOS_DOC.some((t) => t.id === tipo)) return { error: 'Elige el tipo de documento.' };
  if (tipo === 'rnc' && !/^\d{9}$/.test(numero)) return { error: 'El RNC debe tener 9 números.' };
  if (tipo === 'cedula' && !/^\d{11}$/.test(numero)) return { error: 'La cédula debe tener 11 números.' };
  if (tipo === 'dni' && !/^[0-9A-Z]{5,20}$/.test(numero)) return { error: 'El DNI debe tener entre 5 y 20 letras o números.' };
  return { tipo, numero };
}

// 101123456 -> 101-12345-6 (RNC); 00112345678 -> 001-1234567-8 (cédula)
export function formatearDocumento(tipo, numero) {
  const n = limpiarDocumento(numero);
  if (tipo === 'rnc' && n.length === 9) return `${n.slice(0, 3)}-${n.slice(3, 8)}-${n.slice(8)}`;
  if (tipo === 'cedula' && n.length === 11) return `${n.slice(0, 3)}-${n.slice(3, 10)}-${n.slice(10)}`;
  return n;
}

// "RNC 101-12345-6", "Cédula 001-1234567-8"… o "" si no hay documento
export function textoDocumento(tipo, numero) {
  if (!numero) return '';
  const nombre = TIPOS_DOC.find((t) => t.id === tipo)?.nombre || 'Doc.';
  return `${nombre} ${formatearDocumento(tipo, numero)}`;
}
