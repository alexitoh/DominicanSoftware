// nube-app.js - une la app con la nube: vínculo del dispositivo, usuarios espejo y sincronización automática.
import {
  consultar, lote, onEscritura, sincronizacionLista, configurarReservaNCF, configurarReclamoCobro, registrarNcfAnulado, leerSecuenciasNCF, limpiarSecuenciaLocalNCF,
} from './database.js';
import { nube, ErrorNube, sesionNube, guardarSesionNube, idDispositivo, urlServidor, servidorDisponible } from './nube.js';
import { crearMotor } from './sync-nucleo.js';
import { toast } from './ui.js';
import { hashClave } from './seguridad.js';
import { formatearNCF } from './itbis.js';

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
// Quién es el negocio en las llamadas de acceso: un equipo ya vinculado manda su uid (no se vuelve a pedir el RNC);
// uno nuevo manda el RNC que escribió la persona.
export const negocioParaAcceso = (rnc = '') => (vinculo ? { negocioUid: vinculo.negocio } : { negocioId: rnc });
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
  // Si el propietario cambió el identificador del negocio, este equipo guarda el nuevo (él sigue entrando por el uid)
  if (vinculo && r.negocio.identificador && vinculo.negocio_id !== r.negocio.identificador) {
    await motor.recordarIdentificador(r.negocio.identificador);
    await cargarVinculo();
  }
  await aplicarMiembros(r.miembros);
  if (clave) await guardarVerificador(r.cuenta.uid, clave, r.cuenta.debeCambiar);
  return { nuevoVinculo: !vinculo };
}

// Las secuencias de NCF autorizadas (ncf_<tipo>_sig / _hasta) son de cada negocio y viven en este dispositivo.
// Al cambiar de negocio se guardan aparte (por negocio) y se devuelven si el equipo vuelve a ese negocio: así un negocio nuevo
// no hereda los números del anterior ni se repiten comprobantes al regresar.
const BORRAR_NCF = "DELETE FROM config WHERE clave GLOB 'ncf_*_sig' OR clave GLOB 'ncf_*_hasta'";
async function guardarSecuenciasDe(uidNegocio) {
  const filas = await consultar("SELECT clave, valor FROM config WHERE clave GLOB 'ncf_*_sig' OR clave GLOB 'ncf_*_hasta'");
  const sets = [];
  if (uidNegocio && filas.length) {
    sets.push({
      statement: 'INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)',
      values: [`respaldo_ncf_${uidNegocio}`, JSON.stringify(Object.fromEntries(filas.map((f) => [f.clave, f.valor])))],
    });
  }
  sets.push({ statement: BORRAR_NCF, values: [] });
  await lote(sets);
}
async function restaurarSecuenciasDe(uidNegocio) {
  const [f] = await consultar('SELECT valor FROM config WHERE clave = ?', [`respaldo_ncf_${uidNegocio}`]);
  if (!f) return;
  let datos = {};
  try { datos = JSON.parse(f.valor) || {}; } catch { /* respaldo dañado: se ignora */ }
  await lote([
    { statement: BORRAR_NCF, values: [] },
    ...Object.entries(datos).filter(([k]) => /^ncf_.+_(sig|hasta)$/.test(k)).map(([k, v]) => ({ statement: 'INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)', values: [k, String(v)] })),
    { statement: 'DELETE FROM config WHERE clave = ?', values: [`respaldo_ncf_${uidNegocio}`] },
  ]);
}

// modo: 'subir' (los datos de este dispositivo pasan a la nube) | 'combinar' | 'reemplazar' (se queda con lo de la nube)
export async function conectarDispositivo(r, modo, alProgreso) {
  await motor.vincular({
    dispositivo: idDispositivo(), codigo: r.dispositivo?.codigo || '', negocio: r.negocio.uid, negocioNombre: r.negocio.nombre, epoca: r.negocio.epoca || 0, negocioId: r.negocio.identificador || null,
  });
  await restaurarSecuenciasDe(r.negocio.uid); // si este equipo ya había trabajado con ese negocio, recupera sus secuencias
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
  const negocioAnterior = vinculo?.negocio || null;
  await motor.desvincular();
  guardarSesionNube(null);
  vinculo = null;
  await motor.reemplazarLocal();
  await guardarSecuenciasDe(negocioAnterior);
  await lote([{ statement: 'DELETE FROM usuarios', values: [] }]);
  avisar({ fase: 'local', pendientes: 0, ultimo: null });
}

// ---------- Secuencias de NCF del negocio ----------
// Son del negocio y viven en el servidor: cada factura con comprobante le pide el siguiente número en ese momento (hace falta internet).
// Así dos equipos nunca repiten un número y no se reservan números que luego se pierdan.
const SIN_INTERNET_FACTURA = 'Por falta de conexión a internet el sistema no pudo realizar esta factura. Conéctate e intenta de nuevo.';
const K_NCF_PENDIENTES = 'caraudio_ncf_por_anular';
const leerPendientesNCF = () => { try { const v = JSON.parse(localStorage.getItem(K_NCF_PENDIENTES) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const guardarPendientesNCF = (v) => { try { localStorage.setItem(K_NCF_PENDIENTES, JSON.stringify(v.slice(-200))); } catch { /* sin almacenamiento: se pierde el aviso, no la venta */ } };
const pausaCorta = (ms) => new Promise((r) => setTimeout(r, ms));
const sinConexion = (e) => e instanceof ErrorNube && e.sinConexion;

// Pedidos de número que se cortaron sin saber si el servidor llegó a entregarlo, o facturas que no se guardaron: se anulan en cuanto hay internet.
async function anularPendientesNCF() {
  const lista = leerPendientesNCF();
  if (!lista.length) return;
  const quedan = [];
  for (const p of lista) {
    try {
      const r = await nube.anularNcf({ clave: p.clave, motivo: p.motivo });
      if (r?.anulado) await registrarNcfAnulado({ ncf: formatearNCF(r.tipo, r.numero), motivo: p.motivo }); // consta en el 608 y en la bitácora
    } catch (e) { if (sinConexion(e)) quedan.push(p); }
  }
  guardarPendientesNCF(quedan);
}
const marcarParaAnular = (clave, motivo) => guardarPendientesNCF([...leerPendientesNCF(), { clave, motivo }]);

// ¿El negocio factura electrónicamente? Lo decide el servidor; aquí se guarda lo último que dijo (también offline, para saber qué mostrar)
const K_ECF = 'caraudio_ecf_activo';
let ecfActivo = (() => { try { return localStorage.getItem(K_ECF) === '1'; } catch { return false; } })();
export const facturaElectronica = () => ecfActivo;
export function fijarElectronico(v) {
  ecfActivo = !!v;
  try { localStorage.setItem(K_ECF, ecfActivo ? '1' : '0'); } catch { /* sin almacenamiento */ }
}
export async function refrescarElectronico() {
  try { const r = await nube.ecf(); fijarElectronico(r.activo); return r; } catch { return null; }
}

configurarReservaNCF({
  activo: () => vinculado() && haySesionNube(),
  electronico: () => ecfActivo,
  // Sin internet un equipo conectado a la nube no emite ninguna factura (solo consulta): se comprueba antes de empezar
  exigirConexion: async () => {
    try { await nube.salud(); } catch { throw new Error(SIN_INTERNET_FACTURA); }
    await refrescarElectronico(); // el modo (B o E) lo decide el servidor justo antes de facturar
    await anularPendientesNCF().catch(() => {});
  },
  pedir: async (candidatos, clave) => {
    let ultimo;
    for (let i = 0; i < 3; i++) { // con la misma clave el servidor devuelve el mismo número si el primer intento sí llegó
      try { return await nube.siguienteNcf({ candidatos, clave, dispositivo: idDispositivo() }); } catch (e) {
        if (!sinConexion(e)) throw e;
        ultimo = e; await pausaCorta(300);
      }
    }
    // No sabemos si el servidor llegó a entregar un número: si lo hizo, se anula cuando vuelva el internet
    marcarParaAnular(clave, 'Se cortó la conexión antes de guardar la factura');
    throw new Error(SIN_INTERNET_FACTURA, { cause: ultimo });
  },
  anular: async (clave, motivo) => {
    try { await nube.anularNcf({ clave, motivo }); } catch { marcarParaAnular(clave, motivo); }
  },
});

// Antes de imprimir un comprobante electrónico: sincroniza y espera (hasta ~20 s) la respuesta de la DGII
export async function esperarRespuestaEcf(listo) {
  if (!vinculado() || !haySesionNube() || await listo()) return;
  for (let i = 0; i < 7; i++) {
    await sincronizarAhora();
    if (await listo()) return;
    await pausaCorta(3000);
  }
}

// Cola de caja: el servidor reparte el derecho a cobrar cada venta, para que dos cajeros no la cobren a la vez
configurarReclamoCobro({
  activo: () => vinculado() && haySesionNube(),
  reclamar: async (clave) => {
    try { return await nube.reclamarCobro({ clave, dispositivo: idDispositivo() }); } catch (e) {
      if (sinConexion(e)) throw new Error(SIN_INTERNET_FACTURA, { cause: e });
      throw e;
    }
  },
  cerrar: (clave) => nube.reclamarCobro({ clave, dispositivo: idDispositivo(), cerrar: true }),
});

// Las secuencias que este equipo tenía solo para sí pasan a ser del negocio. Devuelve los tipos migrados.
export async function subirSecuenciasLocales() {
  const migrados = [];
  let servidor;
  try { servidor = (await nube.ncf()).secuencias; } catch { return migrados; }
  for (const s of await leerSecuenciasNCF()) {
    if (!(s.sig > 0 && s.hasta >= s.sig)) continue;
    if (servidor.find((x) => x.tipo === s.tipo)?.hasta > 0) continue; // el negocio ya tiene la suya: lo de este equipo queda como su bloque
    try { await nube.guardarNcf(s.tipo, { siguiente: s.sig, hasta: s.hasta }); await limpiarSecuenciaLocalNCF(s.tipo); migrados.push(s.tipo); } catch { /* sin permiso o sin internet: se queda como estaba */ }
  }
  return migrados;
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
    refrescarElectronico().catch(() => {});
    anularPendientesNCF().catch(() => {}); // comprobantes que quedaron en duda por un corte de internet
    if (r.reiniciado) {
      // Los datos del negocio fueron limpiados desde el panel del propietario: se recarga para volver a empezar limpio
      try { toast('Los datos del negocio fueron limpiados. Reiniciando…'); } catch { /* sin pantalla */ }
      setTimeout(() => { try { location.reload(); } catch { /* sin navegador */ } }, 1200);
    }
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
