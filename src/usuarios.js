// usuarios.js - gestión de usuarios (solo administrador), actividad y "Mi cuenta"
import { h, hoja, toast, confirmar } from './ui.js';
import {
  ROLES, PERMISOS, usuarioActual, listarUsuarios, crearUsuario, actualizarUsuario, restablecerClave,
  listarBitacora, cambiarClave, cerrarSesion,
} from './auth.js';
import { generarClaveTemporal } from './seguridad.js';

const fechaHora = (f) => {
  if (!f) return 'Nunca';
  const [d, hora] = String(f).split(' ');
  return `${d.split('-').reverse().join('/')} ${hora?.slice(0, 5) || ''}`.trim();
};
const iniciales = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase();

// Casillas de permisos; devuelve { el, valores(), poner(lista), bloquear(b) }
function selectorPermisos() {
  const cajas = PERMISOS.map(([id, texto]) => {
    const c = h('input', { type: 'checkbox', 'data-permiso': id });
    return { id, c, el: h('label', { class: 'casilla' }, c, texto) };
  });
  return {
    el: h('div', { class: 'permisos' }, cajas.map((x) => x.el)),
    valores: () => cajas.filter((x) => x.c.checked).map((x) => x.id),
    poner: (lista) => cajas.forEach((x) => { x.c.checked = lista.includes(x.id); }),
    bloquear: (b) => cajas.forEach((x) => { x.c.disabled = b; if (b) x.c.checked = true; }),
  };
}

function selectorRol(valor) {
  return h('select', { class: 'campo', 'aria-label': 'Rol' },
    Object.entries(ROLES).map(([id, r]) => h('option', { value: id, selected: id === valor }, r.nombre)));
}

// ---------- Formulario de usuario (nuevo / editar) ----------
function formularioUsuario(u, alGuardar) {
  const editar = !!u;
  const yo = usuarioActual();
  const error = h('p', { class: 'error', role: 'alert' });
  const nombre = h('input', { class: 'campo', value: u?.nombre || '', autocomplete: 'off', 'aria-label': 'Nombre' });
  const usuario = h('input', {
    class: 'campo', value: u?.usuario || '', autocapitalize: 'none', autocomplete: 'off', disabled: editar,
    placeholder: 'ej. maria.lopez', 'aria-label': 'Usuario',
  });
  const correo = h('input', { class: 'campo', type: 'email', value: u?.correo || '', autocomplete: 'off', 'aria-label': 'Correo' });
  const rol = selectorRol(u?.rol || 'vendedor');
  const permisos = selectorPermisos();
  const activo = h('input', { type: 'checkbox', checked: u ? !!u.activo : true });
  const clave = h('input', { class: 'campo', value: editar ? '' : generarClaveTemporal(), autocomplete: 'off', 'aria-label': 'Contraseña temporal' });

  const aplicarRol = (conservar) => {
    const esAdmin = rol.value === 'admin';
    if (!conservar) permisos.poner(ROLES[rol.value].permisos);
    permisos.bloquear(esAdmin);
  };
  let lista = ROLES[u?.rol || 'vendedor'].permisos;
  if (u?.permisos) { try { const x = JSON.parse(u.permisos); if (Array.isArray(x)) lista = x; } catch { /* usa el rol */ } }
  permisos.poner(lista);
  permisos.bloquear(rol.value === 'admin');
  rol.addEventListener('change', () => aplicarRol(false));

  async function guardar() {
    error.textContent = '';
    boton.disabled = true;
    try {
      if (editar) {
        await actualizarUsuario(u.id, {
          nombre: nombre.value, correo: correo.value, rol: rol.value, permisos: permisos.valores(), activo: activo.checked,
        });
      } else {
        await crearUsuario({
          nombre: nombre.value, usuario: usuario.value, correo: correo.value, rol: rol.value,
          permisos: permisos.valores(), clave: clave.value,
        });
      }
      cerrar();
      toast(editar ? 'Usuario actualizado' : 'Usuario creado');
      alGuardar();
    } catch (e) {
      error.textContent = e.message || String(e);
      boton.disabled = false;
    }
  }

  async function reiniciar() {
    const temporal = generarClaveTemporal();
    const ok = await confirmar('Restablecer contraseña',
      `Se asignará una contraseña temporal a ${u.nombre}. Deberá cambiarla al entrar. Temporal: ${temporal}`, 'Restablecer');
    if (!ok) return;
    try {
      await restablecerClave(u.id, temporal);
      toast(`Contraseña temporal: ${temporal}`);
      alGuardar();
    } catch (e) { toast(e.message || 'No se pudo restablecer', 'error'); }
  }

  const boton = h('button', { class: 'btn primario', onClick: guardar }, editar ? 'Guardar cambios' : 'Crear usuario');
  const cerrar = hoja(editar ? `Usuario: ${u.nombre}` : 'Nuevo usuario',
    h('div', { class: 'cuerpo' },
      h('label', { class: 'etiqueta' }, 'Nombre', nombre),
      h('label', { class: 'etiqueta' }, 'Usuario', usuario),
      h('label', { class: 'etiqueta' }, 'Correo', correo),
      h('label', { class: 'etiqueta' }, 'Rol', rol),
      h('h3', {}, 'A qué puede entrar'),
      permisos.el,
      editar
        ? h('label', { class: 'casilla' }, activo, 'Cuenta activa (si la desactivas, no podrá entrar)')
        : h('div', {},
            h('label', { class: 'etiqueta' }, 'Contraseña temporal', clave),
            h('p', { class: 'ayuda' }, 'Entrégasela a la persona. Al entrar por primera vez deberá elegir su propia contraseña.')),
      error,
      h('div', { class: 'acciones' },
        editar && u.id !== yo.id ? h('button', { class: 'btn', onClick: reiniciar }, 'Restablecer contraseña') : null,
        boton)));
}

// ---------- Módulo Usuarios ----------
export async function vistaUsuarios(raiz) {
  const yo = usuarioActual();
  if (yo?.rol !== 'admin') {
    raiz.replaceChildren(h('p', { class: 'error vacio' }, 'Solo el administrador puede gestionar usuarios.'));
    return;
  }
  const estado = { modo: 'usuarios' };
  const pestanas = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Sección' });
  const cuerpo = h('div');

  async function pintar() {
    pestanas.replaceChildren(...[['usuarios', 'Usuarios'], ['actividad', 'Actividad']].map(([id, t]) =>
      h('button', { 'aria-pressed': String(estado.modo === id), onClick: () => { estado.modo = id; pintar(); } }, t)));

    if (estado.modo === 'actividad') {
      const filas = await listarBitacora();
      cuerpo.replaceChildren(filas.length
        ? h('ul', { class: 'historial bitacora' }, filas.map((f) => h('li', {},
            h('span', {}, h('strong', {}, f.accion), f.detalle ? ` · ${f.detalle}` : ''),
            h('small', {}, `${f.usuario || 'sistema'} · ${fechaHora(f.fecha)}`))))
        : h('p', { class: 'vacio' }, 'Todavía no hay actividad.'));
      return;
    }
    const us = await listarUsuarios();
    cuerpo.replaceChildren(h('div', { class: 'lista' }, us.map((u) => h('button', { class: 'fila inventario', onClick: () => formularioUsuario(u, pintar) },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, iniciales(u.nombre)),
      h('span', { class: 'datos' },
        h('strong', {}, u.nombre, u.id === yo.id ? h('span', { class: 'ayuda' }, ' (tú)') : null),
        h('small', {}, `@${u.usuario} · ${ROLES[u.rol]?.nombre || u.rol}`),
        h('small', { class: u.activo ? '' : 'deuda' }, u.activo ? `Último acceso: ${fechaHora(u.ultimo_acceso)}` : 'Cuenta desactivada'),
        u.debe_cambiar ? h('small', {}, 'Tiene contraseña temporal pendiente de cambiar') : null)))));
  }

  raiz.replaceChildren(
    h('header', { class: 'barra' },
      h('h1', {}, 'Usuarios'),
      h('button', { class: 'btn claro', onClick: () => formularioUsuario(null, pintar) }, 'Nuevo usuario')),
    h('div', { class: 'filtros' }, pestanas),
    cuerpo);
  await pintar();
}

// ---------- Mi cuenta (para todos) ----------
export function abrirMiCuenta(alCerrarSesion) {
  const u = usuarioActual();
  const error = h('p', { class: 'error', role: 'alert' });
  const actual = h('input', { class: 'campo', type: 'password', autocomplete: 'current-password', 'aria-label': 'Contraseña actual' });
  const nueva = h('input', { class: 'campo', type: 'password', autocomplete: 'new-password', 'aria-label': 'Contraseña nueva' });
  const repite = h('input', { class: 'campo', type: 'password', autocomplete: 'new-password', 'aria-label': 'Repite la contraseña nueva' });

  async function cambiar() {
    error.textContent = '';
    if (nueva.value !== repite.value) { error.textContent = 'Las contraseñas no coinciden.'; return; }
    try {
      await cambiarClave(u.id, actual.value, nueva.value);
      actual.value = nueva.value = repite.value = '';
      toast('Contraseña actualizada');
    } catch (e) { error.textContent = e.message || String(e); }
  }
  async function salir() {
    const ok = await confirmar('Cerrar sesión', '¿Quieres cerrar la sesión en este dispositivo?', 'Cerrar sesión');
    if (!ok) return;
    cerrar();
    await cerrarSesion();
    alCerrarSesion();
  }

  const cerrar = hoja('Mi cuenta',
    h('div', { class: 'cuerpo' },
      h('div', { class: 'portada-usuario' },
        h('span', { class: 'avatar grande', 'aria-hidden': 'true' }, iniciales(u.nombre)),
        h('div', {}, h('strong', {}, u.nombre),
          h('p', { class: 'ayuda' }, `@${u.usuario} · ${ROLES[u.rol]?.nombre || u.rol}${u.correo ? ` · ${u.correo}` : ''}`))),
      h('h3', {}, 'Cambiar contraseña'),
      h('label', { class: 'etiqueta' }, 'Contraseña actual', actual),
      h('label', { class: 'etiqueta' }, 'Contraseña nueva', nueva),
      h('label', { class: 'etiqueta' }, 'Repite la contraseña nueva', repite),
      error,
      h('div', { class: 'acciones' },
        h('button', { class: 'btn peligro', onClick: salir }, 'Cerrar sesión'),
        h('button', { class: 'btn primario', onClick: cambiar }, 'Cambiar contraseña'))));
}
