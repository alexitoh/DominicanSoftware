// nube-ui.js - indicador de sincronización en la barra y la sección "Nube" de Ajustes
import { h, hoja, toast, confirmar } from './ui.js';
import {
  estadoNube, alCambiarEstadoNube, vinculado, datosVinculo, sincronizarAhora, hayDatosLocales, desconectarDispositivo,
  cargarVinculo, urlServidor, sincronizacionLista, adoptarRespuesta, conectarDispositivo, desactivarUsuariosFueraDeNube,
  nube, dispositivo,
} from './nube-app.js';
import { usuarioActual, registrarNegocioNube, subirUsuariosLocales, registrarBitacora } from './auth.js';
import { guardarServidor } from './nube.js';
import { consultar } from './database.js';
import { normalizarUsuario } from './seguridad.js';

const NUBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5H7z"/></svg>';

const TEXTOS = {
  ok: 'Todo sincronizado',
  sincronizando: 'Sincronizando…',
  'sin-conexion': 'Sin conexión',
  error: 'Hubo un problema al sincronizar',
  sesion: 'Hay que volver a entrar',
  local: 'Solo en este dispositivo',
};

const hora = (d) => (d ? new Date(d).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' }) : 'todavía no');

// ---------- Botón de la barra superior ----------
export function indicadorNube() {
  const boton = h('button', { class: 'nav-nube', title: 'Sincronización', 'aria-label': 'Sincronización', onClick: abrirEstadoNube });
  const pintar = (e) => {
    boton.dataset.fase = e.fase;
    boton.style.display = vinculado() ? '' : 'none';
    boton.innerHTML = NUBE + (e.pendientes > 0 ? `<span class="nube-n">${e.pendientes > 99 ? '99+' : e.pendientes}</span>` : '');
    boton.title = TEXTOS[e.fase] || 'Sincronización';
  };
  pintar(estadoNube());
  alCambiarEstadoNube(pintar);
  return boton;
}

// ---------- Estado (para todos los usuarios) ----------
export function abrirEstadoNube() {
  const caja = h('div', { class: 'cuerpo' });
  let quitar = () => {};
  let montado = false;
  const pintar = () => {
    if (montado && !caja.isConnected) { quitar(); return; } // la hoja ya se cerró
    const e = estadoNube();
    const v = datosVinculo();
    const filas = [h('p', { class: `sync-estado ${e.fase}` }, TEXTOS[e.fase] || '')];
    if (e.mensaje) filas.push(h('p', { class: e.fase === 'error' ? 'error' : 'ayuda' }, e.mensaje));
    if (v) {
      filas.push(h('p', { class: 'ayuda' }, `Negocio: ${v.negocio_nombre || '—'} · Dispositivo ${v.codigo || '—'}`));
      filas.push(h('p', { class: 'ayuda' }, `Última sincronización: ${hora(e.ultimo)}${e.pendientes ? ` · ${e.pendientes} cambios por subir` : ''}`));
      filas.push(h('div', { class: 'acciones' },
        h('button', { class: 'btn primario', disabled: e.fase === 'sincronizando', onClick: async () => {
          const r = await sincronizarAhora();
          if (r) toast(r.subidos || r.bajados ? `Sincronizado (↑${r.subidos} ↓${r.bajados})` : 'Todo estaba al día');
        } }, 'Sincronizar ahora')));
    } else {
      filas.push(h('p', { class: 'ayuda' }, 'Este dispositivo guarda todo solo aquí. El administrador puede conectarlo a la nube desde Ajustes.'));
    }
    caja.replaceChildren(...filas);
  };
  pintar();
  quitar = alCambiarEstadoNube(pintar);
  const cerrar = hoja('Sincronización', caja);
  montado = true;
  return cerrar;
}

// ---------- Sección de Ajustes (administrador) ----------
export function seccionNube() {
  const raiz = h('section', { class: 'seccion' });

  async function pintar() {
    await cargarVinculo();
    const v = datosVinculo();
    if (!sincronizacionLista()) {
      raiz.replaceChildren(h('h2', {}, 'Nube y sincronización'),
        h('p', { class: 'error' }, 'Este dispositivo no permite la sincronización (no se pudo preparar la base de datos). La app sigue funcionando en local.'));
      return;
    }
    if (v) {
      const e = estadoNube();
      raiz.replaceChildren(
        h('h2', {}, 'Nube y sincronización'),
        h('p', { class: `sync-estado ${e.fase}` }, `Conectado: ${v.negocio_nombre || 'tu negocio'}`),
        h('p', { class: 'ayuda' }, `${TEXTOS[e.fase] || ''}. Última sincronización: ${hora(e.ultimo)}. Dispositivo ${v.codigo || '—'}.`),
        h('p', { class: 'ayuda' }, `Servidor: ${urlServidor() || 'esta misma dirección'}`),
        h('div', { class: 'acciones' },
          h('button', { class: 'btn peligro', onClick: desconectar }, 'Desconectar este dispositivo'),
          h('button', { class: 'btn primario', onClick: async () => { await sincronizarAhora(); pintar(); } }, 'Sincronizar ahora')));
    } else {
      raiz.replaceChildren(
        h('h2', {}, 'Nube y sincronización'),
        h('p', { class: 'ayuda' }, 'Conecta el negocio a la nube para entrar con tu usuario o correo desde la web y desde cualquier teléfono, viendo la misma información. Sigue funcionando sin internet y se sincroniza solo al volver la conexión.'),
        h('div', { class: 'acciones' },
          h('button', { class: 'btn', onClick: () => formularioCuentaExistente(pintar) }, 'Conectar con una cuenta existente'),
          h('button', { class: 'btn primario', onClick: () => formularioNuevoNegocio(pintar) }, 'Crear mi negocio en la nube')));
    }
  }

  async function desconectar() {
    const ok = await confirmar('Desconectar de la nube',
      'Este dispositivo dejará de sincronizar y seguirá con los datos que tiene ahora. Los cambios que aún no se hayan subido no llegarán a la nube. Los usuarios que nunca hayan entrado aquí no podrán entrar.',
      'Desconectar');
    if (!ok) return;
    await registrarBitacora('Dispositivo desconectado de la nube');
    await desconectarDispositivo();
    toast('Dispositivo desconectado');
    location.reload();
  }

  alCambiarEstadoNube(() => { if (raiz.isConnected) pintar(); });
  pintar();
  return raiz;
}

// ---------- Formularios ----------
function campo(etiqueta, atributos) {
  const input = h('input', { class: 'campo', autocomplete: 'off', ...atributos });
  return { input, el: h('label', { class: 'etiqueta' }, etiqueta, input) };
}

function campoServidor() {
  return campo('Dirección del servidor', {
    type: 'url', inputmode: 'url', autocapitalize: 'none', placeholder: 'https://mi-servidor.up.railway.app', value: urlServidor(),
  });
}

async function formularioNuevoNegocio(alTerminar) {
  const yo = usuarioActual();
  const [cfg] = await consultar("SELECT valor FROM config WHERE clave = 'negocio_nombre'");
  const [fila] = await consultar('SELECT correo FROM usuarios WHERE id = ?', [yo.id]);
  const servidor = campoServidor();
  const negocio = campo('Nombre del negocio', { value: cfg?.valor || '' });
  const usuario = campo('Tu usuario', { value: yo.usuario, disabled: true });
  const correo = campo('Correo', { type: 'email', value: fila?.correo || '' });
  const clave = campo('Contraseña para la nube', { type: 'password', autocomplete: 'new-password' });
  const error = h('p', { class: 'error', role: 'alert' });

  async function crear() {
    error.textContent = '';
    boton.disabled = true;
    try {
      guardarServidor(servidor.input.value);
      const { codigo } = await registrarNegocioNube({
        negocio: negocio.input.value, nombre: yo.nombre, usuario: yo.usuario, correo: correo.input.value, clave: clave.input.value,
      }, (p) => { boton.textContent = `Subiendo datos… ${p.subidos}`; });
      const entregadas = await subirUsuariosLocales();
      await registrarBitacora('Negocio conectado a la nube');
      cerrar();
      mostrarResultado(codigo, entregadas);
    } catch (e) {
      error.textContent = `${e.message || e}${/ya existe/i.test(e.message || '') ? ' Si ese usuario ya está en la nube, usa "Conectar con una cuenta existente".' : ''}`;
      boton.disabled = false;
      boton.textContent = 'Crear y subir mis datos';
    }
  }
  const boton = h('button', { class: 'btn primario', onClick: crear }, 'Crear y subir mis datos');
  const cerrar = hoja('Crear mi negocio en la nube',
    h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, 'Se sube todo lo que hay en este dispositivo (productos, ventas, clientes…). Tu usuario será el administrador de la nube. Los demás usuarios de este dispositivo se crearán con una contraseña temporal.'),
      servidor.el, negocio.el, usuario.el, correo.el, clave.el,
      h('p', { class: 'ayuda' }, 'Mínimo 8 caracteres, con letras y números.'),
      error, boton));

  function mostrarResultado(codigo, entregadas) {
    const salir = () => { cerrar2(); alTerminar?.(); location.reload(); };
    const cerrar2 = hoja('Tu negocio ya está en la nube',
      h('div', { class: 'cuerpo' },
        h('p', {}, 'Código de recuperación de tu cuenta (guárdalo, no se vuelve a mostrar):'),
        h('div', { class: 'codigo' }, codigo),
        entregadas.length
          ? h('div', {},
            h('p', {}, 'Contraseñas temporales de los demás usuarios (deberán cambiarla al entrar):'),
            h('ul', { class: 'historial' }, entregadas.map((u) => h('li', {}, h('span', {}, `${u.nombre} (@${u.usuario})`), h('strong', {}, u.clave)))))
          : null,
        h('button', { class: 'btn primario', onClick: salir }, 'Ya lo guardé')));
  }
}

async function formularioCuentaExistente(alTerminar) {
  const local = await hayDatosLocales();
  const servidor = campoServidor();
  const usuario = campo('Usuario o correo', { autocapitalize: 'none' });
  const clave = campo('Contraseña', { type: 'password', autocomplete: 'current-password' });
  const modo = h('select', { class: 'campo', 'aria-label': 'Qué hacer con los datos de este dispositivo' },
    h('option', { value: 'reemplazar' }, 'Reemplazar los datos de este dispositivo por los de la nube'),
    h('option', { value: 'combinar' }, 'Combinar: subir lo de aquí y bajar lo de la nube'));
  const error = h('p', { class: 'error', role: 'alert' });

  async function conectar() {
    error.textContent = '';
    boton.disabled = true;
    try {
      if (local) {
        const ok = await confirmar('Conectar con la cuenta',
          modo.value === 'reemplazar'
            ? 'Se borrarán los productos, ventas y demás datos de este dispositivo y se descargarán los de la nube. Los usuarios de este dispositivo que no existan en la nube se desactivarán.'
            : 'Los datos de este dispositivo se subirán a la nube junto a los que ya hay. Si hay productos repetidos quedarán duplicados. Los usuarios de este dispositivo que no existan en la nube se desactivarán.',
          'Conectar');
        if (!ok) { boton.disabled = false; return; }
      }
      guardarServidor(servidor.input.value);
      const r = await nube.login({ identificador: normalizarUsuario(usuario.input.value), clave: clave.input.value, dispositivo: dispositivo() });
      const { nuevoVinculo } = await adoptarRespuesta(r, clave.input.value);
      if (!nuevoVinculo) throw new Error('Este dispositivo ya está conectado.');
      await conectarDispositivo(r, modo.value, (p) => { boton.textContent = `Sincronizando… ↑${p.subidos} ↓${p.bajados}`; });
      await desactivarUsuariosFueraDeNube(r.miembros);
      cerrar();
      toast('Conectado a la nube');
      alTerminar?.();
      setTimeout(() => location.reload(), 800); // vuelve a pedir el acceso con la cuenta de la nube
    } catch (e) {
      error.textContent = e.message || String(e);
      boton.disabled = false;
      boton.textContent = 'Conectar';
    }
  }
  const boton = h('button', { class: 'btn primario', onClick: conectar }, 'Conectar');
  const cerrar = hoja('Conectar con una cuenta existente',
    h('div', { class: 'cuerpo' },
      servidor.el, usuario.el, clave.el,
      local ? h('label', { class: 'etiqueta' }, 'Datos de este dispositivo', modo) : null,
      error, boton));
}
