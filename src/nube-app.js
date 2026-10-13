// nube-app.js - une la app con la nube: vínculo del dispositivo, usuarios espejo y sincronización automática.
import { consultar, lote, onEscritura, sincronizacionLista } from './database.js';
import { nube, ErrorNube, sesionNube, guardarSesionNube, idDispositivo, urlServidor, servidorDisponible } from './nube.js';
import { crearMotor } from './sync-nucleo.js';
import { hashClave } from './seguridad.js';

export { ErrorNube, urlServidor, servidorDisponible, sincronizacionLista };

// ---------- Usuarios espejo ----------
// La nube es la dueña de las cuentas. Aquí se guarda una copia para poder entrar sin internet.
export async function aplicarMiembros(miembros) {
  if (!Array.isArray(miembros) || !miembros.length) return;
  const sets = [];
  for (const m of miembros) {
    // Si ya había un usuario local con ese mismo nombre de usuario, pasa a ser esa cuenta
    sets.push({
      statement: 'UPDATE usuarios SET uid = ? WHERE usuario = ? AND (uid IS NULL OR uid <> ?) AND NOT EXISTS (SELECT 1 FROM usuarios WHERE uid = ?)',
      values: [m.uid, m.usuario, m.uid, m.uid],
    });
    sets.push({
      statement: `INSERT INTO usuarios (uid, nombre, usuario, correo, rol, permisos, activo, debe_cambiar, salt, hash)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '')
                  ON CONFLICT(uid) DO UPDATE SET nombre = excluded.nombre, usuario = excluded.usuario, correo = excluded.correo,
                    rol = excluded.rol, permisos = excluded.permisos, activo = excluded.activo, debe_cambiar = excluded.debe_cambiar`,
      values: [m.uid, m.nombre, m.usuario, m.correo || null, m.rol, m.permisos ? JSON.stringify(m.permisos) : null, m.activo ? 1 : 0, m.debeCambiar ? 1 : 0],
    });
  }
  await lote(sets);
}

// Al unirse a una cuenta existente: los usuarios locales que no son de esa cuenta dejan de poder entrar
export async function desactivarUsuariosFueraDeNube(miembros) {
  const ids = miembros.map((m) => m.uid);
  if (!ids.length) return;
  await lote([{ statement: `UPDATE usuarios SET activo = 0 WHERE uid NOT IN (${ids.map(() => '?').join(',')})`, values: ids }]);
}

// Guarda en este dispositivo la verificación de la contraseña, para poder entrar sin internet
export async function guardarVerificador(uidCuenta, clave, debeCambiar = false) {
  const c = await hashClave(clave);
  await lote([{
    statement: 'UPDATE usuarios SET salt = ?, hash = ?, iter = ?, debe_cambiar = ? WHERE uid = ?',
    values: [c.salt, c.hash, c.iter, debeCambiar ? 1 : 0, uidCuenta],
  }]);
}

// ---------- Vínculo del dispositivo ----------
export const motor = crearMotor({ consultar, lote, nube, alMiembros: aplicarMiembros });

let vinculo = null;
export async function cargarVinculo() {
  const c = await motor.ctl();
  vinculo = c.negocio ? c : null;
  return vinculo;
}
export const vinculado = () => !!vinculo;
export const datosVinculo = () => vinculo;
export const haySesionNube = () => !!sesionNube()?.token;

export async function hayDatosLocales() {
  const [r] = await consultar(
    `SELECT (SELECT COUNT(*) FROM productos) + (SELECT COUNT(*) FROM clientes) + (SELECT COUNT(*) FROM ventas) +
            (SELECT COUNT(*) FROM compras) AS n`);
  return r.n > 0;
}

function recordarSesion(r) {
  guardarSesionNube({ token: r.token, cuentaUid: r.cuenta.uid, negocioUid: r.negocio.uid });
}

// Respuesta de login o registro: guarda la sesión de la nube y copia los usuarios.
// Si el dispositivo aún no estaba conectado, devuelve nuevoVinculo = true y falta decidir qué hacer con los datos.
export async function adoptarRespuesta(r, clave) {
  await cargarVinculo();
  if (vinculo && vinculo.negocio !== r.negocio.uid) {
    throw new Error('Este dispositivo ya está conectado a otro negocio. Desconéctalo en Ajustes antes de entrar con esta cuenta.');
  }
  recordarSesion(r);
  await aplicarMiembros(r.miembros);
  if (clave) await guardarVerificador(r.cuenta.uid, clave, r.cuenta.debeCambiar);
  return { nuevoVinculo: !vinculo };
}

// modo: 'subir' (los datos de este dispositivo pasan a la nube) | 'combinar' | 'reemplazar' (se queda con lo de la nube)
export async function conectarDispositivo(r, modo, alProgreso) {
  await motor.vincular({
    dispositivo: idDispositivo(), codigo: r.dispositivo?.codigo || '', negocio: r.negocio.uid, negocioNombre: r.negocio.nombre,
  });
  if (modo === 'reemplazar') await motor.reemplazarLocal();
  else await motor.marcarTodo();
  await cargarVinculo();
  const res = await motor.sincronizar(alProgreso);
  avisar({ fase: 'ok', ultimo: new Date(), pendientes: 0 });
  return res;
}

export async function desconectarDispositivo() {
  await motor.desvincular();
  guardarSesionNube(null);
  vinculo = null;
  avisar({ fase: 'local' });
}

// Deja este dispositivo como nuevo (sin negocio, usuarios ni datos) para crear otro negocio o entrar con otra cuenta
export async function vaciarDispositivo() {
  await motor.desvincular();
  guardarSesionNube(null);
  vinculo = null;
  await motor.reemplazarLocal();
  await lote([{ statement: 'DELETE FROM usuarios', values: [] }]);
  avisar({ fase: 'local', pendientes: 0, ultimo: null });
}

// ---------- Estado visible ----------
let estado = { fase: 'local', pendientes: 0, ultimo: null, mensaje: '' };
const oyentes = new Set();
export const estadoNube = () => estado;
export const alCambiarEstadoNube = (fn) => { oyentes.add(fn); return () => oyentes.delete(fn); };
function avisar(parcial) {
  estado = { ...estado, ...parcial };
  oyentes.forEach((f) => { try { f(estado); } catch { /* un oyente roto no frena a los demás */ } });
}

// ---------- Sincronización automática ----------
export async function sincronizarAhora() {
  if (!vinculado() || !sincronizacionLista()) return null;
  if (!haySesionNube()) {
    avisar({ fase: 'sesion', mensaje: 'Cierra sesión y vuelve a entrar con internet para seguir sincronizando.' });
    return null;
  }
  avisar({ fase: 'sincronizando', mensaje: '' });
  try {
    const r = await motor.sincronizar();
    avisar({ fase: 'ok', ultimo: new Date(), pendientes: await motor.pendientes(), mensaje: '' });
    if (r.bajados > 0) window.dispatchEvent(new CustomEvent('caraudio:datos-nuevos', { detail: r }));
    return r;
  } catch (e) {
    const pendientes = await motor.pendientes().catch(() => 0);
    if (e instanceof ErrorNube && e.sinConexion) avisar({ fase: 'sin-conexion', pendientes, mensaje: 'Sin conexión: los cambios se subirán cuando vuelva el internet.' });
    else if (e instanceof ErrorNube && e.estado === 401) {
      guardarSesionNube(null);
      avisar({ fase: 'sesion', pendientes, mensaje: 'Tu sesión en la nube venció. Cierra sesión y entra de nuevo con internet.' });
    } else avisar({ fase: 'error', pendientes, mensaje: e.message || String(e) });
    return null;
  }
}

let reloj = null;
let pendienteDebounce = null;
export function iniciarSincronizacionAutomatica() {
  if (reloj) return;
  let ultimaCargaAvisos = 0;
  const intentar = () => {
    if (navigator.onLine === false || document.visibilityState === 'hidden') return;
    sincronizarAhora();
    if (Date.now() - ultimaCargaAvisos > 300000) { ultimaCargaAvisos = Date.now(); cargarAvisos(); }
  };
  reloj = setInterval(intentar, 45000);
  window.addEventListener('online', intentar);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') intentar(); });
  onEscritura(() => {
    if (!vinculado()) return;
    motor.pendientes().then((n) => avisar({ pendientes: n })).catch(() => {});
    clearTimeout(pendienteDebounce);
    pendienteDebounce = setTimeout(intentar, 4000);
  });
  cargarAvisosGuardados();
  if (vinculado()) intentar();
}

// ---------- Avisos (mensajes del proveedor y recordatorio de pago) ----------
// Se guardan en este dispositivo para poder verlos también sin internet
const K_AVISOS = 'caraudio_avisos';
let avisosEstado = { avisos: [], sinLeer: 0 };
const oyentesAvisos = new Set();
const guardarAvisos = (cuenta) => { try { localStorage.setItem(K_AVISOS, JSON.stringify({ cuenta, ...avisosEstado })); } catch { /* sin almacenamiento */ } };
const avisarAvisos = () => oyentesAvisos.forEach((f) => { try { f(avisosEstado); } catch { /* un oyente roto no frena a los demás */ } });
export const estadoAvisos = () => avisosEstado;
export const alCambiarAvisos = (fn) => { oyentesAvisos.add(fn); return () => oyentesAvisos.delete(fn); };

export function cargarAvisosGuardados() {
  try {
    const g = JSON.parse(localStorage.getItem(K_AVISOS) || 'null');
    if (g && g.cuenta === sesionNube()?.cuentaUid) { avisosEstado = { avisos: g.avisos || [], sinLeer: g.sinLeer || 0 }; avisarAvisos(); }
  } catch { /* datos dañados: se ignoran */ }
}

export async function cargarAvisos() {
  if (!vinculado() || !haySesionNube()) return avisosEstado;
  try {
    const r = await nube.avisos();
    avisosEstado = { avisos: r.avisos || [], sinLeer: r.sinLeer || 0 };
    guardarAvisos(sesionNube()?.cuentaUid);
    avisarAvisos();
  } catch { /* sin internet: se quedan los últimos avisos guardados */ }
  return avisosEstado;
}

export async function marcarAvisosLeidos() {
  const ids = avisosEstado.avisos.filter((x) => !x.leido).map((x) => x.id);
  if (!ids.length) return;
  avisosEstado = { avisos: avisosEstado.avisos.map((x) => ({ ...x, leido: true })), sinLeer: 0 };
  guardarAvisos(sesionNube()?.cuentaUid);
  avisarAvisos();
  try { await nube.avisosLeidos(ids); } catch { /* se reintenta en la próxima carga: seguirá como no leído */ }
}

// ---------- Cuentas en la nube (para auth.js) ----------
export const dispositivo = () => idDispositivo();
export { nube, sesionNube };
