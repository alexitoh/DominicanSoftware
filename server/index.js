// Servidor de Dominican Software: cuentas por negocio y sincronización de datos. Sin dependencias externas.
// Requiere Node 22.13 o más nuevo (usa node:sqlite).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  hashClave, verificarClave, firmar, verificar, uid, codigoRecuperacion, normalizarCodigo, normalizarUsuario,
  errorUsuario, errorCorreo, errorClave, codigoDispositivo,
} from './seguridad.js';
import { abrirBase, transaccion, siguienteVersion, TABLAS_SYNC } from './db.js';

const ROLES = ['admin', 'gerente', 'vendedor', 'cajero', 'almacen'];
const PERMISOS = ['ventas', 'productos', 'inventario', 'compras', 'caja', 'cuentas', 'clientes', 'proveedores', 'garantias', 'reportes', 'ajustes', 'anular'];
const MAX_CUERPO = 12 * 1024 * 1024;
const LIMITE_PAGINA = 500;

class ErrorHttp extends Error {
  constructor(estado, mensaje) { super(mensaje); this.estado = estado; }
}
const falla = (estado, mensaje) => { throw new ErrorHttp(estado, mensaje); };

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// Entrega la app web (la carpeta "dist" que genera npm run build) desde el mismo servidor
function servirEstatico(carpeta, req, res) {
  const limpio = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let archivo = path.normalize(path.join(carpeta, limpio));
  if (archivo !== carpeta && !archivo.startsWith(carpeta + path.sep)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) archivo = path.join(carpeta, 'index.html'); // la app es de una sola página
  if (!fs.existsSync(archivo)) { res.writeHead(404); res.end('No encontrado'); return; }
  const ext = path.extname(archivo).toLowerCase();
  res.writeHead(200, {
    'Content-Type': TIPOS[ext] || 'application/octet-stream',
    'Cache-Control': archivo.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(archivo).pipe(res);
}

export function crearServidor({ db, secreto, origenes = '*', estaticos = null, clavePropietario = '', aprobacionAutomatica = false }) {
  if (!secreto || secreto.length < 16) throw new Error('Falta JWT_SECRET (mínimo 16 caracteres).');
  const intentos = new Map(); // límite de intentos de acceso por IP + usuario

  // ---------- Utilidades ----------
  const miembro = (c) => ({
    uid: c.uid, nombre: c.nombre, usuario: c.usuario, correo: c.correo, rol: c.rol,
    permisos: c.permisos ? JSON.parse(c.permisos) : null, activo: !!c.activo, debeCambiar: !!c.debe_cambiar,
    ultimoAcceso: c.ultimo_acceso,
  });
  const miembros = (negocio) => db.prepare('SELECT * FROM cuentas WHERE negocio = ? ORDER BY activo DESC, nombre').all(negocio).map(miembro);
  const negocioDe = (uidNegocio) => db.prepare('SELECT uid, nombre, activo, plan, vence FROM negocios WHERE uid = ?').get(uidNegocio);

  // null si el negocio puede usar el servicio; si no, el motivo
  function motivoBloqueo(n) {
    if (!n) return 'El negocio no existe.';
    if (n.plan === 'pendiente') return 'Tu registro está pendiente de aprobación. Te avisaremos cuando esté activo.';
    if (!n.activo) return 'El servicio de este negocio está suspendido. Contacta al proveedor.';
    if (n.vence && n.vence < new Date().toISOString().slice(0, 10)) return 'La suscripción de este negocio venció. Contacta al proveedor para renovarla.';
    return null;
  }

  function limitar(clave) {
    const ahora = Date.now();
    const x = intentos.get(clave);
    if (x?.hasta > ahora) falla(429, `Demasiados intentos. Espera ${Math.ceil((x.hasta - ahora) / 1000)} segundos.`);
  }
  function falloAcceso(clave) {
    const x = intentos.get(clave) || { n: 0 };
    x.n += 1;
    if (x.n >= 5) { x.n = 0; x.hasta = Date.now() + 60000; }
    intentos.set(clave, x);
    if (intentos.size > 5000) intentos.clear();
  }

  function asignarDispositivo(negocio, dispositivoUid) {
    if (!dispositivoUid || typeof dispositivoUid !== 'string' || dispositivoUid.length < 8 || dispositivoUid.length > 64) return null;
    const ya = db.prepare('SELECT codigo FROM dispositivos WHERE negocio = ? AND uid = ?').get(negocio, dispositivoUid);
    if (ya) {
      db.prepare("UPDATE dispositivos SET ultimo = datetime('now') WHERE negocio = ? AND uid = ?").run(negocio, dispositivoUid);
      return ya.codigo;
    }
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM dispositivos WHERE negocio = ?').get(negocio);
    const codigo = codigoDispositivo(n);
    db.prepare('INSERT INTO dispositivos (negocio, uid, codigo) VALUES (?, ?, ?)').run(negocio, dispositivoUid, codigo);
    return codigo;
  }

  const contarDatos = (negocio) => db.prepare(
    "SELECT COUNT(*) AS n FROM registros WHERE negocio = ? AND borrado = 0 AND tabla IN ('productos','ventas','clientes','compras')").get(negocio).n;

  function sesion(cuenta, dispositivoUid, extra = {}) {
    const negocio = negocioDe(cuenta.negocio);
    return {
      token: firmar({ c: cuenta.uid, n: cuenta.negocio }, secreto),
      cuenta: miembro(cuenta),
      negocio: { uid: negocio.uid, nombre: negocio.nombre },
      dispositivo: { codigo: asignarDispositivo(cuenta.negocio, dispositivoUid) },
      miembros: miembros(cuenta.negocio),
      registros: contarDatos(cuenta.negocio),
      ...extra,
    };
  }

  function autenticar(req) {
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const p = verificar(t, secreto);
    if (!p) falla(401, 'Tu sesión expiró. Inicia sesión de nuevo.');
    const cuenta = db.prepare('SELECT * FROM cuentas WHERE uid = ?').get(p.c);
    if (!cuenta || !cuenta.activo) falla(401, 'Tu cuenta no está activa.');
    const negocio = negocioDe(cuenta.negocio);
    const bloqueo = motivoBloqueo(negocio);
    if (bloqueo) falla(402, bloqueo);
    return { cuenta, negocio };
  }
  const auditar = (accion, negocio, detalle = null) =>
    db.prepare('INSERT INTO auditoria (accion, negocio_nombre, detalle) VALUES (?, ?, ?)').run(accion, negocio, detalle);
  function autenticarPropietario(req) {
    const p = verificar((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), secreto);
    if (!p?.propietario) falla(401, 'Entra de nuevo al panel.');
  }
  const exigirAdmin = (ctx) => { if (ctx.cuenta.rol !== 'admin') falla(403, 'Solo el administrador puede hacer esto.'); };

  function limpiarPermisos(rol, permisos) {
    if (rol === 'admin') return null;
    return JSON.stringify((Array.isArray(permisos) ? permisos : []).filter((p) => PERMISOS.includes(p)));
  }

  // ---------- Rutas ----------
  const rutas = {
    'GET /api/salud': () => ({ ok: true, hora: new Date().toISOString() }),

    'POST /api/registro': (req, b) => {
      const usuario = normalizarUsuario(b.usuario);
      const correo = String(b.correo || '').trim().toLowerCase();
      const err = errorUsuario(usuario) || errorCorreo(correo) || errorClave(b.clave);
      if (!String(b.nombre || '').trim()) falla(400, 'Escribe tu nombre.');
      if (!String(b.negocio || '').trim()) falla(400, 'Escribe el nombre del negocio.');
      if (err) falla(400, err);
      if (db.prepare('SELECT 1 FROM cuentas WHERE usuario = ?').get(usuario)) falla(409, 'Ese usuario ya existe. Prueba con otro.');
      if (db.prepare('SELECT 1 FROM cuentas WHERE correo = ?').get(correo)) falla(409, 'Ya existe una cuenta con ese correo. Inicia sesión.');
      const codigo = codigoRecuperacion();
      const negocio = uid();
      const cuenta = uid();
      transaccion(db, () => {
        db.prepare('INSERT INTO negocios (uid, nombre, activo, plan) VALUES (?, ?, ?, ?)')
          .run(negocio, String(b.negocio).trim(), aprobacionAutomatica ? 1 : 0, aprobacionAutomatica ? 'prueba' : 'pendiente');
        db.prepare(`INSERT INTO cuentas (uid, negocio, nombre, usuario, correo, rol, hash, recup_hash)
                    VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)`)
          .run(cuenta, negocio, String(b.nombre).trim(), usuario, correo, hashClave(b.clave), hashClave(normalizarCodigo(codigo)));
      });
      // Hasta que el propietario lo apruebe no hay sesión: solo se entrega el código de recuperación
      if (!aprobacionAutomatica) return { pendiente: true, codigoRecuperacion: codigo, negocio: { nombre: String(b.negocio).trim() } };
      return sesion(db.prepare('SELECT * FROM cuentas WHERE uid = ?').get(cuenta), b.dispositivo, { codigoRecuperacion: codigo });
    },

    'POST /api/login': (req, b) => {
      const id = normalizarUsuario(b.identificador);
      const clave = `${req.socket.remoteAddress}|${id}`;
      limitar(clave);
      const c = db.prepare('SELECT * FROM cuentas WHERE usuario = ? OR correo = ?').get(id, id);
      if (!c || !verificarClave(String(b.clave || ''), c.hash)) { falloAcceso(clave); falla(401, 'Usuario o contraseña incorrectos.'); }
      if (!c.activo) falla(403, 'Esta cuenta está desactivada. Habla con el administrador.');
      const bloqueo = motivoBloqueo(negocioDe(c.negocio));
      if (bloqueo) falla(402, bloqueo);
      db.prepare("UPDATE cuentas SET ultimo_acceso = datetime('now') WHERE uid = ?").run(c.uid);
      return sesion(c, b.dispositivo);
    },

    'POST /api/recuperar': (req, b) => {
      const id = normalizarUsuario(b.identificador);
      const clave = `${req.socket.remoteAddress}|rec|${id}`;
      limitar(clave);
      const err = errorClave(b.clave);
      if (err) falla(400, err);
      const c = db.prepare('SELECT * FROM cuentas WHERE usuario = ? OR correo = ?').get(id, id);
      if (!c || !c.activo || !verificarClave(normalizarCodigo(b.codigo), c.recup_hash)) {
        falloAcceso(clave);
        falla(401, 'El usuario o el código de recuperación no son correctos.');
      }
      const nuevo = codigoRecuperacion();
      db.prepare('UPDATE cuentas SET hash = ?, recup_hash = ?, debe_cambiar = 0 WHERE uid = ?')
        .run(hashClave(b.clave), hashClave(normalizarCodigo(nuevo)), c.uid);
      return { ok: true, codigoRecuperacion: nuevo };
    },

    'GET /api/yo': (req) => {
      const ctx = autenticar(req);
      return { cuenta: miembro(ctx.cuenta), negocio: { uid: ctx.negocio.uid, nombre: ctx.negocio.nombre }, miembros: miembros(ctx.negocio.uid) };
    },

    'POST /api/clave': (req, b) => {
      const ctx = autenticar(req);
      if (!verificarClave(String(b.actual || ''), ctx.cuenta.hash)) falla(400, 'La contraseña actual no es correcta.');
      const err = errorClave(b.nueva);
      if (err) falla(400, err);
      if (b.actual === b.nueva) falla(400, 'La contraseña nueva debe ser distinta de la actual.');
      db.prepare('UPDATE cuentas SET hash = ?, debe_cambiar = 0 WHERE uid = ?').run(hashClave(b.nueva), ctx.cuenta.uid);
      return { ok: true };
    },

    // Cambio obligatorio después de una contraseña temporal
    'POST /api/clave-temporal': (req, b) => {
      const ctx = autenticar(req);
      if (!ctx.cuenta.debe_cambiar) falla(400, 'Tu contraseña no es temporal.');
      const err = errorClave(b.nueva);
      if (err) falla(400, err);
      db.prepare('UPDATE cuentas SET hash = ?, debe_cambiar = 0 WHERE uid = ?').run(hashClave(b.nueva), ctx.cuenta.uid);
      return { ok: true };
    },

    'GET /api/miembros': (req) => ({ miembros: miembros(autenticar(req).negocio.uid) }),

    'POST /api/miembros': (req, b) => {
      const ctx = autenticar(req);
      exigirAdmin(ctx);
      const usuario = normalizarUsuario(b.usuario);
      const correo = String(b.correo || '').trim().toLowerCase() || null;
      const err = errorUsuario(usuario) || (correo ? errorCorreo(correo) : '') || errorClave(b.clave);
      if (!String(b.nombre || '').trim()) falla(400, 'Escribe el nombre.');
      if (!ROLES.includes(b.rol)) falla(400, 'Elige un rol.');
      if (err) falla(400, err);
      if (db.prepare('SELECT 1 FROM cuentas WHERE usuario = ?').get(usuario)) falla(409, 'Ese usuario ya existe. Prueba con otro.');
      if (correo && db.prepare('SELECT 1 FROM cuentas WHERE correo = ?').get(correo)) falla(409, 'Ya existe una cuenta con ese correo.');
      const nuevo = uid();
      db.prepare(`INSERT INTO cuentas (uid, negocio, nombre, usuario, correo, rol, permisos, hash, debe_cambiar)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(nuevo, ctx.negocio.uid, String(b.nombre).trim(), usuario, correo, b.rol, limpiarPermisos(b.rol, b.permisos), hashClave(b.clave));
      return { uid: nuevo, miembros: miembros(ctx.negocio.uid) };
    },

    'PATCH /api/miembros/:uid': (req, b, p) => {
      const ctx = autenticar(req);
      exigirAdmin(ctx);
      const c = db.prepare('SELECT * FROM cuentas WHERE uid = ? AND negocio = ?').get(p.uid, ctx.negocio.uid);
      if (!c) falla(404, 'El usuario no existe.');
      if (!String(b.nombre || '').trim()) falla(400, 'Escribe el nombre.');
      const correo = String(b.correo || '').trim().toLowerCase() || null;
      if (correo && errorCorreo(correo)) falla(400, errorCorreo(correo));
      if (!ROLES.includes(b.rol)) falla(400, 'Elige un rol.');
      const activo = b.activo ? 1 : 0;
      if (c.uid === ctx.cuenta.uid && !activo) falla(400, 'No puedes desactivar tu propia cuenta.');
      if (c.rol === 'admin' && !(b.rol === 'admin' && activo)) {
        const otros = db.prepare("SELECT COUNT(*) AS n FROM cuentas WHERE negocio = ? AND rol = 'admin' AND activo = 1 AND uid != ?").get(ctx.negocio.uid, c.uid).n;
        if (otros === 0) falla(400, 'Debe quedar al menos un administrador activo.');
      }
      if (correo && db.prepare('SELECT 1 FROM cuentas WHERE correo = ? AND uid != ?').get(correo, c.uid)) falla(409, 'Ya existe otro usuario con ese correo.');
      db.prepare('UPDATE cuentas SET nombre = ?, correo = ?, rol = ?, permisos = ?, activo = ? WHERE uid = ?')
        .run(String(b.nombre).trim(), correo, b.rol, limpiarPermisos(b.rol, b.permisos), activo, c.uid);
      return { miembros: miembros(ctx.negocio.uid) };
    },

    'POST /api/miembros/:uid/clave': (req, b, p) => {
      const ctx = autenticar(req);
      exigirAdmin(ctx);
      const c = db.prepare('SELECT uid FROM cuentas WHERE uid = ? AND negocio = ?').get(p.uid, ctx.negocio.uid);
      if (!c) falla(404, 'El usuario no existe.');
      const err = errorClave(b.clave);
      if (err) falla(400, err);
      db.prepare('UPDATE cuentas SET hash = ?, debe_cambiar = 1 WHERE uid = ?').run(hashClave(b.clave), c.uid);
      return { ok: true };
    },

    // ---------- Panel del propietario ----------
    'POST /api/propietario/login': (req, b) => {
      if (!clavePropietario) falla(404, 'El panel del propietario no está activado en este servidor.');
      const clave = `${req.socket.remoteAddress}|propietario`;
      limitar(clave);
      const a = Buffer.from(String(b.clave || ''));
      const e = Buffer.from(clavePropietario);
      if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) { falloAcceso(clave); falla(401, 'Clave incorrecta.'); }
      return { token: firmar({ propietario: 1 }, secreto, 12 * 3600) };
    },

    'GET /api/propietario/negocios': (req) => {
      autenticarPropietario(req);
      const hoy = new Date().toISOString().slice(0, 10);
      const filas = db.prepare('SELECT * FROM negocios ORDER BY creado DESC').all().map((n) => {
        const admin = db.prepare("SELECT nombre, usuario, correo FROM cuentas WHERE negocio = ? AND rol = 'admin' ORDER BY creado LIMIT 1").get(n.uid);
        const c = db.prepare('SELECT COUNT(*) AS n, MAX(ultimo_acceso) AS ultimo FROM cuentas WHERE negocio = ?').get(n.uid);
        const d = db.prepare('SELECT COUNT(*) AS n FROM dispositivos WHERE negocio = ?').get(n.uid).n;
        const bytes = db.prepare('SELECT COALESCE(SUM(LENGTH(datos)), 0) AS b FROM registros WHERE negocio = ?').get(n.uid).b;
        const vencido = !!(n.vence && n.vence < hoy);
        const estado = n.plan === 'pendiente' ? 'pendiente' : !n.activo ? 'suspendido' : (vencido ? 'vencido' : 'activo');
        const diasParaVencer = n.vence ? Math.round((Date.parse(n.vence) - Date.parse(hoy)) / 86400000) : null;
        return {
          uid: n.uid, nombre: n.nombre, estado, plan: n.plan, vence: n.vence, precio: n.precio, creado: n.creado, aprobado: n.aprobado, notas: n.notas,
          admin, usuarios: c.n, ultimoAcceso: c.ultimo, dispositivos: d, registros: contarDatos(n.uid), bytes, diasParaVencer,
        };
      });
      const pagina = db.prepare('PRAGMA page_size').get().page_size;
      const paginas = db.prepare('PRAGMA page_count').get().page_count;
      const libres = db.prepare('PRAGMA freelist_count').get().freelist_count;
      const mes = hoy.slice(0, 7);
      return {
        negocios: filas, hoy,
        resumen: {
          dbBytes: pagina * paginas, libreBytes: pagina * libres,
          ingresoMensual: filas.filter((x) => x.estado === 'activo' || x.estado === 'vencido').reduce((t, x) => t + (x.precio || 0), 0),
          cobradoMes: db.prepare("SELECT COALESCE(SUM(monto), 0) AS t FROM pagos_lic WHERE substr(fecha, 1, 7) = ?").get(mes).t,
        },
      };
    },

    'GET /api/propietario/negocios/:uid': (req, b, p) => {
      autenticarPropietario(req);
      const n = db.prepare('SELECT uid FROM negocios WHERE uid = ?').get(p.uid);
      if (!n) falla(404, 'El negocio no existe.');
      return {
        usuarios: db.prepare('SELECT uid, nombre, usuario, correo, rol, activo, ultimo_acceso AS ultimo, creado FROM cuentas WHERE negocio = ? ORDER BY activo DESC, nombre').all(p.uid),
        pagos: db.prepare('SELECT id, fecha, monto, meses, nota FROM pagos_lic WHERE negocio = ? ORDER BY id DESC').all(p.uid),
        dispositivos: db.prepare('SELECT codigo, creado, ultimo FROM dispositivos WHERE negocio = ? ORDER BY codigo').all(p.uid),
        tablas: db.prepare('SELECT tabla, COUNT(*) AS n FROM registros WHERE negocio = ? AND borrado = 0 GROUP BY tabla ORDER BY n DESC').all(p.uid),
      };
    },

    'PATCH /api/propietario/negocios/:uid': (req, b, p) => {
      autenticarPropietario(req);
      const n = db.prepare('SELECT * FROM negocios WHERE uid = ?').get(p.uid);
      if (!n) falla(404, 'El negocio no existe.');
      const accion = b.accion;
      const vence = b.vence ? String(b.vence).slice(0, 10) : null;
      if (vence && !/^\d{4}-\d{2}-\d{2}$/.test(vence)) falla(400, 'La fecha debe ser AAAA-MM-DD.');
      const plan = String(b.plan || '').trim().slice(0, 40);
      const precio = b.precio === '' || b.precio == null ? null : Number(b.precio);
      if (precio != null && !(precio >= 0)) falla(400, 'El precio no es válido.');
      if (accion === 'aprobar') {
        db.prepare("UPDATE negocios SET activo = 1, plan = ?, vence = ?, precio = ?, aprobado = datetime('now') WHERE uid = ?").run(plan || 'mensual', vence, precio, n.uid);
        auditar('Aprobó', n.nombre, `${plan || 'mensual'}${vence ? ` hasta ${vence}` : ''}`);
      } else if (accion === 'suspender') {
        db.prepare('UPDATE negocios SET activo = 0 WHERE uid = ?').run(n.uid);
        auditar('Suspendió', n.nombre);
      } else if (accion === 'reactivar') {
        db.prepare("UPDATE negocios SET activo = 1, plan = CASE WHEN plan = 'pendiente' THEN 'mensual' ELSE plan END WHERE uid = ?").run(n.uid);
        auditar('Reactivó', n.nombre);
      } else if (accion === 'editar') {
        db.prepare("UPDATE negocios SET plan = COALESCE(NULLIF(?, ''), plan), vence = ?, precio = ?, notas = ? WHERE uid = ?")
          .run(plan, vence, precio, String(b.notas || '').slice(0, 500) || null, n.uid);
        auditar('Editó', n.nombre, `${plan}${vence ? ` hasta ${vence}` : ''}`);
      } else falla(400, 'Acción no válida.');
      return { ok: true };
    },

    // Registra un pago y alarga el vencimiento: parte de hoy o de la fecha actual de vencimiento, lo que sea más tarde
    'POST /api/propietario/negocios/:uid/pagos': (req, b, p) => {
      autenticarPropietario(req);
      const n = db.prepare('SELECT * FROM negocios WHERE uid = ?').get(p.uid);
      if (!n) falla(404, 'El negocio no existe.');
      const monto = Number(b.monto);
      const meses = Math.round(Number(b.meses) || 0);
      if (!(monto >= 0)) falla(400, 'El monto no es válido.');
      if (meses < 0 || meses > 60) falla(400, 'Los meses deben estar entre 0 y 60.');
      transaccion(db, () => {
        db.prepare('INSERT INTO pagos_lic (negocio, negocio_nombre, monto, meses, nota) VALUES (?, ?, ?, ?, ?)')
          .run(n.uid, n.nombre, monto, meses, String(b.nota || '').slice(0, 200) || null);
        if (meses > 0) {
          const hoy = new Date().toISOString().slice(0, 10);
          const base = n.vence && n.vence > hoy ? n.vence : hoy;
          const d = new Date(`${base}T00:00:00Z`);
          d.setUTCMonth(d.getUTCMonth() + meses);
          const nuevo = d.toISOString().slice(0, 10);
          // Un pago a un negocio suspendido o vencido lo deja activo de nuevo
          db.prepare("UPDATE negocios SET vence = ?, activo = 1, plan = CASE WHEN plan = 'pendiente' THEN 'mensual' ELSE plan END WHERE uid = ?").run(nuevo, n.uid);
        }
      });
      auditar('Registró pago', n.nombre, `${monto} por ${meses} mes(es)`);
      return { ok: true, vence: db.prepare('SELECT vence FROM negocios WHERE uid = ?').get(n.uid).vence };
    },

    'DELETE /api/propietario/pagos/:id': (req, b, p) => {
      autenticarPropietario(req);
      const x = db.prepare('SELECT * FROM pagos_lic WHERE id = ?').get(Number(p.id));
      if (!x) falla(404, 'El pago no existe.');
      db.prepare('DELETE FROM pagos_lic WHERE id = ?').run(x.id);
      auditar('Borró un pago', x.negocio_nombre, `${x.monto}`);
      return { ok: true };
    },

    // Copia completa de los datos de un negocio (para guardarla antes de eliminarlo)
    'GET /api/propietario/negocios/:uid/respaldo': (req, b, p) => {
      autenticarPropietario(req);
      const n = db.prepare('SELECT * FROM negocios WHERE uid = ?').get(p.uid);
      if (!n) falla(404, 'El negocio no existe.');
      auditar('Descargó respaldo', n.nombre);
      return {
        generado: new Date().toISOString(), negocio: n,
        cuentas: db.prepare('SELECT uid, nombre, usuario, correo, rol, permisos, activo, creado FROM cuentas WHERE negocio = ?').all(p.uid),
        pagos: db.prepare('SELECT fecha, monto, meses, nota FROM pagos_lic WHERE negocio = ?').all(p.uid),
        registros: db.prepare('SELECT tabla, uid, datos, borrado, actualizado FROM registros WHERE negocio = ?').all(p.uid)
          .map((r) => ({ ...r, datos: r.datos ? JSON.parse(r.datos) : null })),
      };
    },

    // Elimina el negocio y todo lo suyo, y devuelve el espacio al disco
    'DELETE /api/propietario/negocios/:uid': (req, b, p) => {
      autenticarPropietario(req);
      const n = db.prepare('SELECT * FROM negocios WHERE uid = ?').get(p.uid);
      if (!n) falla(404, 'El negocio no existe.');
      if (String(b.confirmar || '').trim() !== n.nombre) falla(400, 'Para eliminar escribe el nombre exacto del negocio.');
      const antes = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
      const borrados = db.prepare('SELECT COUNT(*) AS c FROM registros WHERE negocio = ?').get(n.uid).c;
      transaccion(db, () => {
        db.prepare('DELETE FROM registros WHERE negocio = ?').run(n.uid);
        db.prepare('DELETE FROM dispositivos WHERE negocio = ?').run(n.uid);
        db.prepare('DELETE FROM avisos_leidos WHERE cuenta IN (SELECT uid FROM cuentas WHERE negocio = ?)').run(n.uid);
        db.prepare('DELETE FROM avisos WHERE negocio = ?').run(n.uid);
        db.prepare('DELETE FROM cuentas WHERE negocio = ?').run(n.uid);
        db.prepare('DELETE FROM negocios WHERE uid = ?').run(n.uid);
      });
      auditar('Eliminó negocio', n.nombre, `${borrados} registros`);
      try { db.exec('VACUUM'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* si no se puede compactar ahora, el espacio queda libre para reutilizarse */ }
      const despues = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
      return { ok: true, liberado: Math.max(0, antes - despues), registros: borrados };
    },

    'PATCH /api/propietario/cuentas/:uid': (req, b, p) => {
      autenticarPropietario(req);
      const c = db.prepare('SELECT c.*, n.nombre AS neg FROM cuentas c JOIN negocios n ON n.uid = c.negocio WHERE c.uid = ?').get(p.uid);
      if (!c) falla(404, 'La cuenta no existe.');
      db.prepare('UPDATE cuentas SET activo = ? WHERE uid = ?').run(b.activo ? 1 : 0, c.uid);
      auditar(b.activo ? 'Activó usuario' : 'Desactivó usuario', c.neg, c.usuario);
      return { ok: true };
    },

    'POST /api/propietario/cuentas/:uid/clave': (req, b, p) => {
      autenticarPropietario(req);
      const c = db.prepare('SELECT c.*, n.nombre AS neg FROM cuentas c JOIN negocios n ON n.uid = c.negocio WHERE c.uid = ?').get(p.uid);
      if (!c) falla(404, 'La cuenta no existe.');
      const err = errorClave(b.clave);
      if (err) falla(400, err);
      db.prepare('UPDATE cuentas SET hash = ?, debe_cambiar = 1 WHERE uid = ?').run(hashClave(b.clave), c.uid);
      auditar('Nueva clave temporal', c.neg, c.usuario);
      return { ok: true };
    },


    // ---------- Mensajes del propietario a sus clientes ----------
    'POST /api/propietario/avisos': (req, b) => {
      autenticarPropietario(req);
      const titulo = String(b.titulo || '').trim().slice(0, 80);
      const mensaje = String(b.mensaje || '').trim().slice(0, 1000);
      const nivel = b.nivel === 'importante' ? 'importante' : 'info';
      if (!titulo) falla(400, 'Escribe un título.');
      if (!mensaje) falla(400, 'Escribe el mensaje.');
      const dias = Math.min(365, Math.max(1, Math.round(Number(b.dias) || 30)));
      const d = new Date(); d.setUTCDate(d.getUTCDate() + dias);
      const caduca = d.toISOString().slice(0, 10);
      const ins = db.prepare('INSERT INTO avisos (negocio, titulo, mensaje, nivel, caduca) VALUES (?, ?, ?, ?, ?)');
      let enviados = 0;
      if (b.destino === 'todos') {
        ins.run(null, titulo, mensaje, nivel, caduca); enviados = db.prepare("SELECT COUNT(*) AS c FROM negocios WHERE plan <> 'pendiente'").get().c;
        auditar('Mensaje masivo', 'Todos los clientes', titulo);
      } else {
        const uids = [...new Set(Array.isArray(b.negocios) ? b.negocios.map(String) : [])];
        if (!uids.length) falla(400, 'Elige al menos un cliente.');
        transaccion(db, () => {
          for (const u of uids) {
            const n = db.prepare('SELECT uid, nombre FROM negocios WHERE uid = ?').get(u);
            if (!n) continue;
            ins.run(n.uid, titulo, mensaje, nivel, caduca); enviados++;
            auditar('Mensaje', n.nombre, titulo);
          }
        });
        if (!enviados) falla(404, 'Los clientes elegidos no existen.');
      }
      return { ok: true, enviados };
    },

    'GET /api/propietario/avisos': (req) => {
      autenticarPropietario(req);
      const hoy = new Date().toISOString().slice(0, 10);
      return {
        avisos: db.prepare(`SELECT a.id, a.titulo, a.mensaje, a.nivel, a.creado, a.caduca, a.negocio, n.nombre AS negocio_nombre FROM avisos a
          LEFT JOIN negocios n ON n.uid = a.negocio ORDER BY a.id DESC LIMIT 100`).all().map((a) => {
          const total = a.negocio
            ? db.prepare('SELECT COUNT(*) AS c FROM cuentas WHERE negocio = ? AND activo = 1').get(a.negocio).c
            : db.prepare("SELECT COUNT(*) AS c FROM cuentas c JOIN negocios n ON n.uid = c.negocio WHERE c.activo = 1 AND n.plan <> 'pendiente'").get().c;
          const leidos = db.prepare('SELECT COUNT(*) AS c FROM avisos_leidos WHERE aviso = ?').get(`m${a.id}`).c;
          return { ...a, destino: a.negocio ? a.negocio_nombre || '(eliminado)' : 'Todos los clientes', vigente: !a.caduca || a.caduca >= hoy, leidos, total };
        }),
      };
    },

    'DELETE /api/propietario/avisos/:id': (req, b, p) => {
      autenticarPropietario(req);
      const a = db.prepare('SELECT id FROM avisos WHERE id = ?').get(Number(p.id));
      if (!a) falla(404, 'El mensaje no existe.');
      db.prepare('DELETE FROM avisos WHERE id = ?').run(a.id);
      db.prepare('DELETE FROM avisos_leidos WHERE aviso = ?').run(`m${a.id}`);
      return { ok: true };
    },

    'GET /api/propietario/historial': (req) => {
      autenticarPropietario(req);
      return {
        acciones: db.prepare('SELECT fecha, accion, negocio_nombre AS negocio, detalle FROM auditoria ORDER BY id DESC LIMIT 200').all(),
        pagos: db.prepare('SELECT fecha, negocio_nombre AS negocio, monto, meses, nota FROM pagos_lic ORDER BY id DESC LIMIT 200').all(),
      };
    },


    // ---------- Avisos para los usuarios del negocio ----------
    // Mensajes del propietario (para este negocio o para todos) y recordatorio automático de pago para el administrador
    'GET /api/avisos': (req) => {
      const ctx = autenticar(req);
      const hoy = new Date().toISOString().slice(0, 10);
      const leidos = new Set(db.prepare('SELECT aviso FROM avisos_leidos WHERE cuenta = ?').all(ctx.cuenta.uid).map((x) => x.aviso));
      const lista = db.prepare(`SELECT id, titulo, mensaje, nivel, creado FROM avisos
        WHERE (negocio IS NULL OR negocio = ?) AND (caduca IS NULL OR caduca >= ?) ORDER BY id DESC LIMIT 50`)
        .all(ctx.negocio.uid, hoy)
        .map((a) => ({ id: `m${a.id}`, tipo: 'mensaje', titulo: a.titulo, mensaje: a.mensaje, nivel: a.nivel, fecha: a.creado, leido: leidos.has(`m${a.id}`) }));
      if (ctx.cuenta.rol === 'admin' && ctx.negocio.vence) {
        const dias = Math.round((Date.parse(ctx.negocio.vence) - Date.parse(hoy)) / 86400000);
        if (dias <= 7) {
          const tramo = dias <= 1 ? 1 : dias <= 3 ? 3 : 7; // vuelve a aparecer como nuevo a los 7, 3 y 1 días
          const id = `pago-${ctx.negocio.vence}-${tramo}`;
          const cuando = dias === 0 ? 'vence hoy' : dias === 1 ? 'vence mañana' : `vence en ${dias} días`;
          lista.unshift({
            id, tipo: 'pago', nivel: 'importante', fecha: hoy, leido: leidos.has(id), dias,
            titulo: 'Se acerca tu fecha de pago',
            mensaje: `Tu suscripción ${cuando} (${ctx.negocio.vence}). Para renovar y no perder el acceso, contacta a Ing. David Vargas al 1-809-230-9980.`,
          });
        }
      }
      return { avisos: lista, sinLeer: lista.filter((a) => !a.leido).length };
    },

    'POST /api/avisos/leidos': (req, b) => {
      const ctx = autenticar(req);
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => x.length <= 80).slice(0, 100);
      const ins = db.prepare('INSERT OR IGNORE INTO avisos_leidos (aviso, cuenta) VALUES (?, ?)');
      for (const id of ids) ins.run(id, ctx.cuenta.uid);
      return { ok: true };
    },

    // ---------- Sincronización ----------
    'POST /api/sync': (req, b) => {
      const ctx = autenticar(req);
      const negocio = ctx.negocio.uid;
      const origen = String(b.dispositivo || '').slice(0, 64);
      const desde = Number.isFinite(b.desde) ? Math.max(0, Math.floor(b.desde)) : 0;
      const limite = Math.min(Math.max(parseInt(b.limite, 10) || LIMITE_PAGINA, 1), LIMITE_PAGINA);
      const cambios = Array.isArray(b.cambios) ? b.cambios : [];
      if (cambios.length > 2000) falla(413, 'Demasiados cambios en una sola petición.');

      let aceptados = 0;
      let ignorados = 0;
      if (cambios.length) {
        const ahora = Date.now() + 60000; // un reloj adelantado no puede ganarle a todos
        const leer = db.prepare('SELECT actualizado FROM registros WHERE negocio = ? AND tabla = ? AND uid = ?');
        const guardar = db.prepare(`
          INSERT INTO registros (negocio, tabla, uid, datos, borrado, actualizado, version, origen)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(negocio, tabla, uid) DO UPDATE SET
            datos = excluded.datos, borrado = excluded.borrado, actualizado = excluded.actualizado,
            version = excluded.version, origen = excluded.origen`);
        transaccion(db, () => {
          for (const c of cambios) {
            if (!TABLAS_SYNC.includes(c?.t) || typeof c.uid !== 'string' || c.uid.length > 80 || !Number.isFinite(c.u)) { ignorados++; continue; }
            const u = Math.min(Math.floor(c.u), ahora);
            const previo = leer.get(negocio, c.t, c.uid);
            if (previo && previo.actualizado > u) { ignorados++; continue; }
            guardar.run(negocio, c.t, c.uid, c.x ? null : JSON.stringify(c.d ?? {}), c.x ? 1 : 0, u, siguienteVersion(db), origen);
            aceptados++;
          }
        });
      }

      const filas = db.prepare(`
        SELECT tabla, uid, datos, borrado, actualizado, version FROM registros
         WHERE negocio = ? AND version > ? AND (origen != ? OR ? = 0)
         ORDER BY version LIMIT ?`).all(negocio, desde, origen, desde, limite);
      const maxVersion = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM registros WHERE negocio = ?').get(negocio).v;
      const hayMas = filas.length === limite;
      return {
        aceptados, ignorados,
        cambios: filas.map((f) => ({ t: f.tabla, uid: f.uid, d: f.datos ? JSON.parse(f.datos) : null, x: !!f.borrado, u: f.actualizado, v: f.version })),
        hasta: hayMas ? filas[filas.length - 1].version : Math.max(maxVersion, desde),
        hayMas,
        miembros: miembros(negocio),
      };
    },
  };

  // Convierte "/api/miembros/abc/clave" en la ruta con parámetros
  function buscarRuta(metodo, url) {
    for (const clave of Object.keys(rutas)) {
      const [m, patron] = clave.split(' ');
      if (m !== metodo) continue;
      const a = patron.split('/');
      const b = url.split('/');
      if (a.length !== b.length) continue;
      const params = {};
      if (a.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(b[i])), true) : seg === b[i]))) {
        return { fn: rutas[clave], params };
      }
    }
    return null;
  }

  const leerCuerpo = (req) => new Promise((resolver, rechazar) => {
    const partes = [];
    let total = 0;
    req.on('data', (d) => {
      total += d.length;
      if (total > MAX_CUERPO) { rechazar(new ErrorHttp(413, 'La petición es demasiado grande.')); req.destroy(); return; }
      partes.push(d);
    });
    req.on('end', () => {
      try { resolver(partes.length ? JSON.parse(Buffer.concat(partes).toString()) : {}); } catch { rechazar(new ErrorHttp(400, 'JSON no válido.')); }
    });
    req.on('error', rechazar);
  });

  return http.createServer(async (req, res) => {
    const ruta0 = new URL(req.url, 'http://x').pathname;
    if (ruta0 === '/propietario' && req.method === 'GET') {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
        res.end(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'propietario.html')));
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    if (estaticos && !ruta0.startsWith('/api/') && (req.method === 'GET' || req.method === 'HEAD')) {
      try { servirEstatico(estaticos, req, res); } catch { res.writeHead(500); res.end(); }
      return;
    }
    const cabeceras = {
      'Access-Control-Allow-Origin': origenes,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    const responder = (estado, cuerpo) => { res.writeHead(estado, cabeceras); res.end(JSON.stringify(cuerpo)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cabeceras); res.end(); return; }
    try {
      const url = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
      const ruta = buscarRuta(req.method, url);
      if (!ruta) falla(404, 'No existe esa dirección.');
      const cuerpo = req.method === 'GET' ? {} : await leerCuerpo(req);
      responder(200, await ruta.fn(req, cuerpo, ruta.params));
    } catch (e) {
      if (e instanceof ErrorHttp) responder(e.estado, { error: e.message });
      else { console.error(e); responder(500, { error: 'Error interno del servidor.' }); }
    }
  });
}

// Arranque cuando se ejecuta con "node index.js"
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const carpeta = path.resolve(process.env.DATA_DIR || path.join(aqui, 'datos'));
  fs.mkdirSync(carpeta, { recursive: true });
  // Si no se definió JWT_SECRET, se crea una vez y se guarda junto a los datos
  let secreto = process.env.JWT_SECRET;
  if (!secreto) {
    const archivoSecreto = path.join(carpeta, 'secreto.txt');
    if (!fs.existsSync(archivoSecreto)) fs.writeFileSync(archivoSecreto, uid() + uid(), { mode: 0o600 });
    secreto = fs.readFileSync(archivoSecreto, 'utf8').trim();
  }
  const db = abrirBase(path.join(carpeta, 'caraudio.db'));
  const dist = path.resolve(process.env.STATIC_DIR || path.join(aqui, '..', 'dist'));
  const estaticos = fs.existsSync(path.join(dist, 'index.html')) ? dist : null;
  const puerto = Number(process.env.PORT) || 3000;
  crearServidor({
    db, secreto, origenes: process.env.ALLOWED_ORIGINS || '*', estaticos,
    clavePropietario: process.env.OWNER_PASSWORD || '', aprobacionAutomatica: process.env.APROBACION_AUTOMATICA === '1',
  })
    .listen(puerto, '0.0.0.0', () => console.log(`Servidor Dominican Software listo en el puerto ${puerto}. Datos en ${carpeta}${estaticos ? `. Web: ${estaticos}` : '. (sin web: falta la carpeta dist)'}`));
}
