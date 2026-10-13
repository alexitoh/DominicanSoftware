// nube.js - cliente del servidor (cuentas y sincronización). Funciona con internet; sin él, la app sigue en modo local.

export class ErrorNube extends Error {
  constructor(mensaje, estado = 0, sinConexion = false) {
    super(mensaje);
    this.estado = estado;
    this.sinConexion = sinConexion;
  }
}

// Fábrica para poder probarlo en Node con otro "fetch" y otra dirección
export function crearCliente({ base = () => '', token = () => null, fetchFn = (...a) => fetch(...a), espera = 25000 } = {}) {
  async function llamar(metodo, ruta, cuerpo, { conToken = true, tiempo = espera } = {}) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), tiempo);
    let r;
    try {
      r = await fetchFn(`${base()}${ruta}`, {
        method: metodo,
        headers: {
          ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(conToken && token() ? { Authorization: `Bearer ${token()}` } : {}),
        },
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
        signal: control.signal,
      });
    } catch (e) {
      throw new ErrorNube('No hay conexión con el servidor. Revisa tu internet.', 0, true);
    } finally {
      clearTimeout(reloj);
    }
    let datos = {};
    try { datos = await r.json(); } catch { /* respuesta sin cuerpo */ }
    if (!r.ok) throw new ErrorNube(datos.error || `Error del servidor (${r.status}).`, r.status);
    return datos;
  }
  return {
    llamar,
    salud: () => llamar('GET', '/api/salud', undefined, { conToken: false, tiempo: 7000 }),
    registro: (b) => llamar('POST', '/api/registro', b, { conToken: false }),
    login: (b) => llamar('POST', '/api/login', b, { conToken: false }),
    recuperar: (b) => llamar('POST', '/api/recuperar', b, { conToken: false }),
    yo: () => llamar('GET', '/api/yo'),
    cambiarClave: (actual, nueva) => llamar('POST', '/api/clave', { actual, nueva }),
    claveTemporal: (nueva) => llamar('POST', '/api/clave-temporal', { nueva }),
    miembros: () => llamar('GET', '/api/miembros'),
    crearMiembro: (b) => llamar('POST', '/api/miembros', b),
    editarMiembro: (uid, b) => llamar('PATCH', `/api/miembros/${encodeURIComponent(uid)}`, b),
    claveMiembro: (uid, clave) => llamar('POST', `/api/miembros/${encodeURIComponent(uid)}/clave`, { clave }),
    avisos: () => llamar('GET', '/api/avisos'),
    avisosLeidos: (ids) => llamar('POST', '/api/avisos/leidos', { ids }),
    sync: (b) => llamar('POST', '/api/sync', b, { tiempo: 60000 }),
  };
}

// ---------- Ajustes guardados en este dispositivo ----------
const K_SERVIDOR = 'caraudio_servidor';
const K_SESION = 'caraudio_nube';
const K_DISPOSITIVO = 'caraudio_dispositivo';
const leer = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const escribir = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

// Dirección del servidor: la que el usuario escribió, o la de compilación (VITE_API_URL), o la misma de la página (web publicada)
export const urlServidor = () => (leer(K_SERVIDOR) || import.meta.env?.VITE_API_URL || '').trim().replace(/\/+$/, '');
export function guardarServidor(url) {
  const limpio = String(url || '').trim().replace(/\/+$/, '');
  if (limpio && !/^https?:\/\//i.test(limpio)) throw new Error('La dirección debe empezar con https://');
  escribir(K_SERVIDOR, limpio || null);
}

export const sesionNube = () => { try { return JSON.parse(leer(K_SESION) || 'null'); } catch { return null; } };
export const guardarSesionNube = (s) => escribir(K_SESION, s ? JSON.stringify(s) : null);

export function idDispositivo() {
  let id = leer(K_DISPOSITIVO);
  if (!id) {
    const b = crypto.getRandomValues(new Uint8Array(12));
    id = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    escribir(K_DISPOSITIVO, id);
  }
  return id;
}

export const nube = crearCliente({ base: urlServidor, token: () => sesionNube()?.token || null });

// ¿Hay servidor al que conectarse? (la web publicada por el propio servidor responde en su misma dirección)
export async function servidorDisponible() {
  try { return (await nube.salud()).ok === true; } catch { return false; }
}
