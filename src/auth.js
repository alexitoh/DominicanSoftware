// auth.js - usuarios, sesión, roles y permisos.
// Los usuarios viven en la base del dispositivo. Si el dispositivo está conectado a la nube, la nube es la dueña de las
// cuentas: aquí se hace el login contra el servidor y se guarda una copia para poder entrar también sin internet.
import { consultar, ejecutar, transaccion, setUsuarioActual } from './database.js';
import {
  vinculado, nube, ErrorNube, sesionNube, haySesionNube, aplicarMiembros, guardarVerificador, adoptarRespuesta,
  conectarDispositivo, dispositivo, negocioParaAcceso, subirSecuenciasLocales,
} from './nube-app.js';
import {
  hashClave, verificarClave, generarCodigoRecuperacion, normalizarCodigo, normalizarUsuario,
  errorUsuario, errorCorreo, errorClave, generarClaveTemporal, normalizarRnc, errorRnc,
} from './seguridad.js';

// ---------- Roles y permisos ----------
// Cada permiso es un módulo, más "anular" (anular ventas y compras). "usuarios" es solo del Administrador.
export const PERMISOS = [
  ['ventas', 'Ventas y cotizaciones'], ['productos', 'Productos'], ['inventario', 'Inventario'], ['compras', 'Compras'],
  ['caja', 'Caja'], ['clientes', 'Clientes'], ['proveedores', 'Proveedores'],
  ['garantias', 'Garantías'], ['reportes', 'Reportes'], ['contabilidad', 'Contabilidad'], ['finanzas', 'Finanzas'], ['ecf', 'Facturación electrónica'], ['ajustes', 'Ajustes y respaldo'],
  ['anular', 'Anular ventas y compras'], ['autorizar_compras', 'Autorizar órdenes de compra'], ['autorizar_pagos', 'Aprobar solicitudes de pago'],
];
const TODOS = PERMISOS.map(([id]) => id);

export const ROLES = {
  admin: { nombre: 'Administrador', permisos: [...TODOS, 'usuarios'] },
  gerente: { nombre: 'Gerente', permisos: TODOS.filter((p) => p !== 'ajustes') },
  vendedor: { nombre: 'Vendedor', permisos: ['ventas', 'clientes', 'garantias'] },
  cajero: { nombre: 'Cajero', permisos: ['ventas', 'caja', 'clientes', 'garantias'] },
  almacen: { nombre: 'Almacén', permisos: ['productos', 'inventario', 'compras', 'proveedores'] },
};

let actual = null; // usuario con la sesión abierta

export const usuarioActual = () => actual;

export function tienePermiso(id) {
  if (!actual) return false;
  if (id === 'inicio') return true;
  if (actual.rol === 'admin') return true;
  if (id === 'usuarios') return false;
  return actual.lista.includes(id);
}

function armarUsuario(u) {
  let lista;
  try { lista = JSON.parse(u.permisos || 'null'); } catch { lista = null; }
  if (!Array.isArray(lista)) lista = ROLES[u.rol]?.permisos || [];
  return {
    id: u.id, uid: u.uid, nombre: u.nombre, usuario: u.usuario, correo: u.correo, rol: u.rol,
    debeCambiar: !!u.debe_cambiar, lista,
  };
}

// ---------- Bitácora ----------
export async function registrarBitacora(accion, detalle = '') {
  try {
    await ejecutar('INSERT INTO bitacora (usuario_id, usuario, accion, detalle) VALUES (?, ?, ?, ?)',
      [actual?.id ?? null, actual?.usuario ?? null, accion, detalle]);
  } catch { /* la bitácora nunca debe impedir trabajar */ }
}

// ---------- Sesión guardada en el dispositivo ----------
const CLAVE_SESION = 'caraudio_sesion';
const DIAS_SESION = 30;
const leerSesion = () => { try { return JSON.parse(localStorage.getItem(CLAVE_SESION) || 'null'); } catch { return null; } };
const guardarSesion = (s) => { try { localStorage.setItem(CLAVE_SESION, JSON.stringify(s)); } catch { /* sin almacenamiento */ } };
const borrarSesion = () => { try { localStorage.removeItem(CLAVE_SESION); } catch { /* nada */ } };

// ---------- Consultas ----------
export async function existenUsuarios() {
  const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM usuarios');
  return n > 0;
}

async function buscarPorIdentificador(texto) {
  const id = normalizarUsuario(texto);
  const [u] = await consultar('SELECT * FROM usuarios WHERE usuario = ? OR lower(correo) = ?', [id, id]);
  return u || null;
}

// ---------- Registro del propietario (primera cuenta) ----------
export async function registrarPropietario({ negocio, nombre, usuario, correo, clave }) {
  if (await existenUsuarios()) throw new Error('Ya existe una cuenta. Inicia sesión.');
  const u = normalizarUsuario(usuario);
  const err = errorUsuario(u) || errorCorreo(correo) || errorClave(clave);
  if (!String(nombre || '').trim()) throw new Error('Escribe tu nombre.');
  if (err) throw new Error(err);

  const codigo = generarCodigoRecuperacion();
  const c = await hashClave(clave);
  const r = await hashClave(normalizarCodigo(codigo));
  const set = [{
    statement: `INSERT INTO usuarios (nombre, usuario, correo, rol, permisos, salt, hash, iter, recup_salt, recup_hash)
                VALUES (?, ?, ?, 'admin', NULL, ?, ?, ?, ?, ?)`,
    values: [nombre.trim(), u, correo.trim(), c.salt, c.hash, c.iter, r.salt, r.hash],
  }];
  if (String(negocio || '').trim()) {
    set.push({ statement: "INSERT OR REPLACE INTO config (clave, valor) VALUES ('negocio_nombre', ?)", values: [negocio.trim()] });
  }
  await transaccion(set);
  return { codigo };
}

// ---------- Inicio de sesión ----------
const CLAVE_INTENTOS = 'caraudio_intentos';
const MAX_INTENTOS = 5;
const ESPERA_MS = 60000;
const leerIntentos = () => { try { return JSON.parse(localStorage.getItem(CLAVE_INTENTOS) || '{}'); } catch { return {}; } };
const guardarIntentos = (x) => { try { localStorage.setItem(CLAVE_INTENTOS, JSON.stringify(x)); } catch { /* nada */ } };

export async function iniciarSesion(identificador, clave, recordar = true) {
  const ahora = Date.now();
  const bloqueo = leerIntentos();
  if (bloqueo.hasta && bloqueo.hasta > ahora) {
    throw new Error(`Demasiados intentos. Espera ${Math.ceil((bloqueo.hasta - ahora) / 1000)} segundos.`);
  }
  // Conectado a la nube: manda el servidor. Solo si no hay internet se usa la copia guardada en el dispositivo.
  if (vinculado()) {
    try {
      const r = await nube.login({ identificador: normalizarUsuario(identificador), clave, ...negocioParaAcceso(), dispositivo: dispositivo() });
      await adoptarRespuesta(r, clave);
      const [u] = await consultar('SELECT * FROM usuarios WHERE uid = ?', [r.cuenta.uid]);
      if (!u) throw new Error('No se pudo guardar tu cuenta en este dispositivo.');
      guardarIntentos({});
      await entrar(u, recordar);
      return actual;
    } catch (e) {
      if (!(e instanceof ErrorNube && e.sinConexion)) throw e;
    }
  }
  const u = await buscarPorIdentificador(identificador);
  if (u && u.activo && !u.hash && vinculado()) {
    throw new Error('Sin internet no se puede entrar: esta cuenta todavía no ha iniciado sesión en este dispositivo.');
  }
  const ok = u && u.activo && await verificarClave(clave, u.salt, u.hash, u.iter);
  if (!ok) {
    const n = (bloqueo.hasta && bloqueo.hasta <= ahora ? 0 : bloqueo.n || 0) + 1;
    guardarIntentos(n >= MAX_INTENTOS ? { n: 0, hasta: ahora + ESPERA_MS } : { n });
    if (u && !u.activo) throw new Error('Esta cuenta está desactivada. Habla con el administrador.');
    throw new Error('Usuario o contraseña incorrectos.');
  }
  guardarIntentos({});
  await entrar(u, recordar);
  return actual;
}

// ---------- Cuentas en la nube ----------
// Crea el negocio en el servidor y sube a la nube lo que ya hay en este dispositivo
export async function registrarNegocioNube({ negocio, nombre, usuario, correo, clave, rnc = '' }, alProgreso) {
  const u = normalizarUsuario(usuario);
  const err = errorUsuario(u) || errorCorreo(correo) || errorClave(clave);
  if (!String(nombre || '').trim()) throw new Error('Escribe tu nombre.');
  if (!String(negocio || '').trim()) throw new Error('Escribe el nombre del negocio.');
  const id = normalizarRnc(rnc);
  if (id && errorRnc(id)) throw new Error(errorRnc(id));
  // Con RNC se identifica con él; sin RNC el servidor le asigna un número que debe aprenderse
  const r = await nube.registro({ negocio: negocio.trim(), nombre: nombre.trim(), usuario: u, correo: correo.trim(), clave, rnc: id, dispositivo: dispositivo() });
  const datosId = { identificador: r.negocio?.identificador, asignado: r.negocio?.idTipo === 'asignado' };
  // El propietario del sistema debe aprobar el registro: todavía no hay sesión ni se sube nada
  if (r.pendiente) return { codigo: r.codigoRecuperacion, pendiente: true, ...datosId };
  await adoptarRespuesta(r, clave);
  await conectarDispositivo(r, 'subir', alProgreso);
  await subirSecuenciasLocales(); // las secuencias de NCF de este equipo pasan a ser del negocio
  return { codigo: r.codigoRecuperacion, pendiente: false, ...datosId };
}

// Al pasar de local a la nube: los demás usuarios de este dispositivo se crean en el servidor con una contraseña temporal
export async function subirUsuariosLocales() {
  const miembros = (await nube.miembros()).miembros;
  const locales = (await consultar('SELECT * FROM usuarios WHERE activo = 1')).filter((u) => !miembros.some((m) => m.usuario === u.usuario));
  const entregadas = [];
  for (const u of locales) {
    const clave = generarClaveTemporal();
    let permisos = null;
    try { permisos = JSON.parse(u.permisos || 'null'); } catch { /* usa el rol */ }
    const r = await nube.crearMiembro({
      nombre: u.nombre, usuario: u.usuario, correo: u.correo || null, rol: u.rol,
      permisos: u.rol === 'admin' ? null : (Array.isArray(permisos) ? permisos.filter((p) => TODOS.includes(p)) : ROLES[u.rol]?.permisos.filter((p) => TODOS.includes(p)) || []),
      clave,
    });
    await aplicarMiembros(r.miembros);
    await ejecutar("UPDATE usuarios SET salt = '', hash = '' WHERE usuario = ?", [u.usuario]); // la contraseña vieja ya no vale
    entregadas.push({ nombre: u.nombre, usuario: u.usuario, clave });
  }
  await aplicarMiembros((await nube.miembros()).miembros);
  if (actual) {
    const [yo] = await consultar('SELECT uid FROM usuarios WHERE id = ?', [actual.id]);
    if (yo) actual.uid = yo.uid;
  }
  return entregadas;
}

// Entra con una cuenta que ya existe en la nube. modo: 'reemplazar' (dispositivo nuevo) | 'combinar'
export async function entrarConCuentaNube(identificador, clave, modo = 'reemplazar', alProgreso, rnc = '') {
  const id = normalizarRnc(rnc);
  if (!vinculado()) {
    if (!id) throw new Error('Escribe el RNC del negocio, sin guiones. Si no tiene RNC, escribe el número que se le asignó al registrarse.');
    if (errorRnc(id)) throw new Error(errorRnc(id));
  }
  const r = await nube.login({ identificador: normalizarUsuario(identificador), clave, ...negocioParaAcceso(id), dispositivo: dispositivo() });
  const { nuevoVinculo } = await adoptarRespuesta(r, clave);
  if (nuevoVinculo) await conectarDispositivo(r, modo, alProgreso);
  const [u] = await consultar('SELECT * FROM usuarios WHERE uid = ?', [r.cuenta.uid]);
  await entrar(u, true);
  return actual;
}

async function entrar(u, recordar = true) {
  actual = armarUsuario(u);
  setUsuarioActual(actual.id);
  await ejecutar("UPDATE usuarios SET ultimo_acceso = datetime('now','localtime') WHERE id = ?", [u.id]);
  if (recordar) guardarSesion({ uid: u.id, hasta: Date.now() + DIAS_SESION * 86400000 });
  else borrarSesion();
  await registrarBitacora('Inicio de sesión');
}

// Recupera la sesión guardada, si sigue siendo válida
export async function restaurarSesion() {
  const s = leerSesion();
  if (!s || !s.uid || s.hasta < Date.now()) { borrarSesion(); return null; }
  const [u] = await consultar('SELECT * FROM usuarios WHERE id = ? AND activo = 1', [s.uid]);
  if (!u) { borrarSesion(); return null; }
  actual = armarUsuario(u);
  setUsuarioActual(actual.id);
  return actual;
}

export async function cerrarSesion() {
  await registrarBitacora('Cierre de sesión');
  actual = null;
  setUsuarioActual(null);
  borrarSesion();
}

// ---------- Contraseñas ----------
// En la nube, la contraseña se cambia en el servidor y solo con la sesión de esa misma persona
function tokenDe(uid) {
  if (!haySesionNube() || sesionNube()?.cuentaUid !== uid) {
    throw new Error('Para esto necesitas haber iniciado sesión con internet. Cierra sesión y entra de nuevo.');
  }
}

export async function cambiarClave(id, claveActual, claveNueva) {
  const [u] = await consultar('SELECT * FROM usuarios WHERE id = ?', [id]);
  const err = errorClave(claveNueva);
  if (vinculado()) {
    if (!u) throw new Error('El usuario no existe.');
    if (err) throw new Error(err);
    tokenDe(u.uid);
    await nube.cambiarClave(claveActual, claveNueva);
    await guardarVerificador(u.uid, claveNueva);
    await registrarBitacora('Cambió su contraseña');
    return;
  }
  if (!u || !(await verificarClave(claveActual, u.salt, u.hash, u.iter))) throw new Error('La contraseña actual no es correcta.');
  if (err) throw new Error(err);
  if (claveActual === claveNueva) throw new Error('La contraseña nueva debe ser distinta de la actual.');
  const c = await hashClave(claveNueva);
  await ejecutar('UPDATE usuarios SET salt = ?, hash = ?, iter = ?, debe_cambiar = 0 WHERE id = ?', [c.salt, c.hash, c.iter, id]);
  if (actual?.id === id) actual.debeCambiar = false;
  await registrarBitacora('Cambió su contraseña');
}

// Cambio obligatorio tras una contraseña temporal (ya se verificó con el inicio de sesión)
export async function cambiarClaveTemporal(id, claveNueva) {
  const err = errorClave(claveNueva);
  if (err) throw new Error(err);
  if (vinculado()) {
    const [u] = await consultar('SELECT uid FROM usuarios WHERE id = ?', [id]);
    tokenDe(u?.uid);
    await nube.claveTemporal(claveNueva);
    await guardarVerificador(u.uid, claveNueva, false);
    if (actual?.id === id) actual.debeCambiar = false;
    await registrarBitacora('Cambió su contraseña temporal');
    return;
  }
  const c = await hashClave(claveNueva);
  await ejecutar('UPDATE usuarios SET salt = ?, hash = ?, iter = ?, debe_cambiar = 0 WHERE id = ?', [c.salt, c.hash, c.iter, id]);
  if (actual?.id === id) actual.debeCambiar = false;
  await registrarBitacora('Cambió su contraseña temporal');
}

// Olvidó la contraseña: con el código de recuperación que recibió al crear la cuenta
export async function recuperarConCodigo(identificador, codigo, claveNueva, usarNube = false, rnc = '') {
  const err = errorClave(claveNueva);
  if (err) throw new Error(err);
  if (vinculado() || usarNube) {
    const r = await nube.recuperar({ identificador: normalizarUsuario(identificador), codigo, clave: claveNueva, ...negocioParaAcceso(normalizarRnc(rnc)) });
    return { codigo: r.codigoRecuperacion };
  }
  const u = await buscarPorIdentificador(identificador);
  const ok = u && u.activo && u.recup_hash && await verificarClave(normalizarCodigo(codigo), u.recup_salt, u.recup_hash, u.iter);
  if (!ok) throw new Error('El usuario o el código de recuperación no son correctos.');
  const c = await hashClave(claveNueva);
  const nuevo = generarCodigoRecuperacion();
  const r = await hashClave(normalizarCodigo(nuevo));
  await ejecutar(
    'UPDATE usuarios SET salt = ?, hash = ?, iter = ?, recup_salt = ?, recup_hash = ?, debe_cambiar = 0 WHERE id = ?',
    [c.salt, c.hash, c.iter, r.salt, r.hash, u.id]);
  await ejecutar('INSERT INTO bitacora (usuario_id, usuario, accion, detalle) VALUES (?, ?, ?, ?)',
    [u.id, u.usuario, 'Contraseña recuperada con código', '']);
  return { codigo: nuevo };
}

// ---------- Gestión de usuarios (solo Administrador) ----------
function exigirAdmin() {
  if (actual?.rol !== 'admin') throw new Error('Solo el administrador puede hacer esto.');
}

export async function listarUsuarios() {
  return consultar('SELECT id, nombre, usuario, correo, rol, permisos, activo, debe_cambiar, creado, ultimo_acceso FROM usuarios ORDER BY activo DESC, nombre');
}

export async function crearUsuario({ nombre, usuario, correo, rol, permisos, clave }) {
  exigirAdmin();
  const u = normalizarUsuario(usuario);
  if (!String(nombre || '').trim()) throw new Error('Escribe el nombre.');
  const err = errorUsuario(u) || (correo ? errorCorreo(correo) : '') || errorClave(clave);
  if (err) throw new Error(err);
  if (!ROLES[rol]) throw new Error('Elige un rol.');
  const [dup] = await consultar('SELECT id FROM usuarios WHERE usuario = ? OR (? != \'\' AND lower(correo) = ?)', [u, (correo || '').trim().toLowerCase(), (correo || '').trim().toLowerCase()]);
  if (dup) throw new Error('Ya existe un usuario con ese nombre de usuario o correo.');
  if (vinculado()) {
    tokenDe(actual.uid);
    const r = await nube.crearMiembro({
      nombre: nombre.trim(), usuario: u, correo: (correo || '').trim() || null, rol,
      permisos: rol === 'admin' ? null : (permisos || []).filter((p) => TODOS.includes(p)), clave,
    });
    await aplicarMiembros(r.miembros);
    await registrarBitacora('Usuario creado', `${u} (${ROLES[rol].nombre})`);
    return;
  }
  const c = await hashClave(clave);
  const lista = rol === 'admin' ? null : JSON.stringify((permisos || []).filter((p) => TODOS.includes(p)));
  await ejecutar(
    `INSERT INTO usuarios (nombre, usuario, correo, rol, permisos, salt, hash, iter, debe_cambiar)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [nombre.trim(), u, (correo || '').trim() || null, rol, lista, c.salt, c.hash, c.iter]);
  await registrarBitacora('Usuario creado', `${u} (${ROLES[rol].nombre})`);
}

async function adminsActivos(exceptoId) {
  const [{ n }] = await consultar("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin' AND activo = 1 AND id != ?", [exceptoId]);
  return n;
}

export async function actualizarUsuario(id, { nombre, correo, rol, permisos, activo }) {
  exigirAdmin();
  const [u] = await consultar('SELECT * FROM usuarios WHERE id = ?', [id]);
  if (!u) throw new Error('El usuario no existe.');
  if (!String(nombre || '').trim()) throw new Error('Escribe el nombre.');
  if (correo && errorCorreo(correo)) throw new Error(errorCorreo(correo));
  if (!ROLES[rol]) throw new Error('Elige un rol.');
  const sigueAdmin = rol === 'admin' && activo;
  if (u.rol === 'admin' && !sigueAdmin && (await adminsActivos(id)) === 0) {
    throw new Error('Debe quedar al menos un administrador activo.');
  }
  if (id === actual.id && !activo) throw new Error('No puedes desactivar tu propia cuenta.');
  if (correo) {
    const [dup] = await consultar('SELECT id FROM usuarios WHERE lower(correo) = ? AND id != ?', [correo.trim().toLowerCase(), id]);
    if (dup) throw new Error('Ya existe otro usuario con ese correo.');
  }
  if (vinculado()) {
    tokenDe(actual.uid);
    const r = await nube.editarMiembro(u.uid, {
      nombre: nombre.trim(), correo: (correo || '').trim() || null, rol,
      permisos: rol === 'admin' ? null : (permisos || []).filter((p) => TODOS.includes(p)), activo: !!activo,
    });
    await aplicarMiembros(r.miembros);
  } else {
    const lista = rol === 'admin' ? null : JSON.stringify((permisos || []).filter((p) => TODOS.includes(p)));
    await ejecutar(
      'UPDATE usuarios SET nombre = ?, correo = ?, rol = ?, permisos = ?, activo = ? WHERE id = ?',
      [nombre.trim(), (correo || '').trim() || null, rol, lista, activo ? 1 : 0, id]);
  }
  if (id === actual.id) { // si cambió su propio rol o nombre, se actualiza la sesión
    const [nuevo] = await consultar('SELECT * FROM usuarios WHERE id = ?', [id]);
    actual = armarUsuario(nuevo);
  }
  await registrarBitacora(activo ? 'Usuario modificado' : 'Usuario desactivado', `${u.usuario} (${ROLES[rol].nombre})`);
}

// El administrador entrega una contraseña temporal; la persona deberá cambiarla al entrar
export async function restablecerClave(id, claveTemporal) {
  exigirAdmin();
  const err = errorClave(claveTemporal);
  if (err) throw new Error(err);
  const [u] = await consultar('SELECT usuario, uid FROM usuarios WHERE id = ?', [id]);
  if (!u) throw new Error('El usuario no existe.');
  if (vinculado()) {
    tokenDe(actual.uid);
    await nube.claveMiembro(u.uid, claveTemporal);
    await aplicarMiembros((await nube.miembros()).miembros);
    await registrarBitacora('Contraseña restablecida', u.usuario);
    return;
  }
  const c = await hashClave(claveTemporal);
  await ejecutar('UPDATE usuarios SET salt = ?, hash = ?, iter = ?, debe_cambiar = 1 WHERE id = ?', [c.salt, c.hash, c.iter, id]);
  await registrarBitacora('Contraseña restablecida', u.usuario);
}

export async function listarBitacora(limite = 150) {
  return consultar('SELECT * FROM bitacora ORDER BY id DESC LIMIT ?', [limite]);
}
