// dgii.js - consulta de RNC en el padrón de la DGII (a través del servidor) y mensajes de estatus.
import { nube, sesionNube, urlServidor } from './nube.js';
import { limpiarDocumento } from './fiscal.js';

// Devuelve { resultado, mensaje, datos }
// resultado: 'activo' | 'inactivo' | 'noEncontrado' | 'sinNube' | 'sinConexion' | 'padronVacio' | 'invalido'
export async function buscarRNC(texto, { cliente = nube, hay = () => !!sesionNube() } = {}) {
  const n = limpiarDocumento(texto);
  if (!/^\d{9}$|^\d{11}$/.test(n)) return { resultado: 'invalido', mensaje: 'Escribe un RNC de 9 números o una cédula de 11.' };
  if (!hay()) return { resultado: 'sinNube', mensaje: 'Para consultar la DGII, este dispositivo debe estar conectado a la nube (Ajustes → Nube).' };
  let r;
  try { r = await cliente.consultarRNC(n); } catch (e) {
    return { resultado: 'sinConexion', mensaje: e.sinConexion || e.estado === 0 ? 'Sin internet: no se pudo consultar la DGII. Puedes escribir los datos a mano.' : (e.message || 'No se pudo consultar la DGII.') };
  }
  if (r.error) return { resultado: 'invalido', mensaje: r.error };
  if (r.padronVacio) return { resultado: 'padronVacio', mensaje: 'El listado de la DGII aún no está cargado en el servidor. Pídele al administrador que lo actualice en Ajustes.' };
  if (!r.encontrado) return { resultado: 'noEncontrado', mensaje: `El RNC ${n} no aparece en el listado de la DGII.` };
  if (!r.activo) return { resultado: 'inactivo', datos: r, mensaje: `${r.nombre}: su estatus en la DGII es ${r.estado}. No se puede usar para facturar.` };
  return { resultado: 'activo', datos: r, mensaje: `${r.nombre} · ACTIVO en la DGII` };
}

// Mismos datos que guarda el cliente: nombre = nombre comercial si existe, si no la razón social
export const datosParaCliente = (d) => ({ nombre: d.nombre, tipo_doc: d.rnc.length === 9 ? 'rnc' : 'cedula', documento: d.rnc });

// Estado del padrón y subida manual del archivo (solo administrador)
export const estadoPadron = () => nube.estadoPadron();
export const actualizarPadron = () => nube.actualizarPadron();
export async function subirPadron(archivo) {
  const r = await fetch(`${urlServidor()}/api/rnc-importar`, { method: 'POST', headers: { Authorization: `Bearer ${sesionNube()?.token}` }, body: archivo });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Error del servidor (${r.status}).`);
  return d.cantidad;
}
