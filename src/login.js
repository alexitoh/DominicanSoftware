// login.js - pantalla de acceso: crear cuenta (primera vez), iniciar sesión, recuperar contraseña
import { consultar, esWeb } from './database.js';
import { h, toast } from './ui.js';
import {
  existenUsuarios, registrarPropietario, iniciarSesion, restaurarSesion, recuperarConCodigo, cambiarClaveTemporal,
  registrarNegocioNube, entrarConCuentaNube,
} from './auth.js';
import { urlServidor, guardarServidor } from './nube.js';
import { criptoDisponible } from './seguridad.js';

// Devuelve una promesa que se resuelve con el usuario cuando ya está dentro.
export async function asegurarSesion() {
  const u = await restaurarSesion();
  if (u && !u.debeCambiar) return u;
  return new Promise((resolver) => pantallaAcceso(resolver, u));
}

async function datosNegocio() {
  const cfg = Object.fromEntries((await consultar(
    "SELECT clave, valor FROM config WHERE clave IN ('negocio_nombre','negocio_logo')")).map((r) => [r.clave, r.valor]));
  return cfg;
}

async function pantallaAcceso(terminar, sesionPendiente) {
  const cfg = await datosNegocio();
  document.getElementById('app')?.setAttribute('hidden', '');
  const raiz = h('div', { id: 'acceso', role: 'main' });
  document.body.append(raiz);

  const salir = (usuario) => {
    raiz.remove();
    document.getElementById('app')?.removeAttribute('hidden');
    terminar(usuario);
  };

  const aviso = h('p', { class: 'error', role: 'alert' });
  const marco = (...hijos) => { aviso.textContent = ''; raiz.replaceChildren(
    h('div', { class: 'acceso-caja' },
      cfg.negocio_logo ? h('img', { class: 'acceso-logo', src: cfg.negocio_logo, alt: '' }) : null,
      h('strong', { class: 'acceso-negocio' }, cfg.negocio_nombre || 'Car Audio'),
      ...hijos)); };

  const campo = (etiqueta, atributos) => {
    const input = h('input', { class: 'campo', autocomplete: 'off', ...atributos });
    return { input, el: h('label', { class: 'etiqueta' }, etiqueta, input) };
  };
  const ojito = (input) => h('button', {
    type: 'button', class: 'btn chico', 'aria-label': 'Mostrar u ocultar contraseña',
    onClick: () => { input.type = input.type === 'password' ? 'text' : 'password'; },
  }, 'Ver');
  const claveCampo = (etiqueta, atributos = {}) => {
    const c = campo(etiqueta, { type: 'password', autocomplete: 'current-password', ...atributos });
    return { input: c.input, el: h('div', { class: 'cliente-fila' }, c.el, ojito(c.input)) };
  };
  const aviso2 = () => { aviso.textContent = ''; return aviso; };

  // Dirección del servidor (solo hace falta escribirla en la app del celular, o si usas otro servidor)
  const servidorCampo = () => {
    const c = campo('Dirección del servidor', {
      type: 'url', inputmode: 'url', autocapitalize: 'none', placeholder: 'https://mi-servidor.up.railway.app', value: urlServidor(),
    });
    const abierto = !esWeb && !urlServidor();
    return {
      input: c.input,
      el: h('details', { class: 'avanzado', open: abierto },
        h('summary', {}, 'Servidor'),
        c.el,
        h('p', { class: 'ayuda' }, 'Es la dirección que te dio quien administra el sistema. En la versión web normalmente no hay que escribirla.')),
    };
  };
  const progreso = (boton) => (p) => {
    boton.textContent = p.subidos || p.bajados ? `Sincronizando… ↑${p.subidos} ↓${p.bajados}` : 'Conectando…';
  };

  const sinCripto = !criptoDisponible()
    ? h('p', { class: 'error' }, 'Este navegador no permite cuentas seguras en esta dirección. Abre la app desde HTTPS o desde localhost.')
    : null;

  // ---------- Entrar ----------
  function pantallaEntrar() {
    const usuario = campo('Usuario o correo', { autocapitalize: 'none', autocomplete: 'username', 'aria-label': 'Usuario o correo' });
    const clave = claveCampo('Contraseña');
    const recordar = h('input', { type: 'checkbox', checked: true, id: 'recordar' });
    const entrar = async () => {
      aviso2();
      boton.disabled = true;
      try {
        const u = await iniciarSesion(usuario.input.value, clave.input.value, recordar.checked);
        if (u.debeCambiar) pantallaCambioTemporal(u); else salir(u);
      } catch (e) {
        aviso.textContent = e.message || String(e);
        boton.disabled = false;
      }
    };
    const boton = h('button', { class: 'btn primario', onClick: entrar }, 'Entrar');
    for (const i of [usuario.input, clave.input]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); });
    marco(
      h('h1', {}, 'Iniciar sesión'),
      sinCripto, usuario.el, clave.el,
      h('label', { class: 'casilla' }, recordar, 'Mantener la sesión iniciada'),
      aviso, boton,
      h('button', { class: 'enlace', onClick: () => pantallaRecuperar() }, '¿Olvidaste tu contraseña?'));
    usuario.input.focus();
  }

  // ---------- Cambio obligatorio de la contraseña temporal ----------
  function pantallaCambioTemporal(u) {
    const n1 = claveCampo('Contraseña nueva', { autocomplete: 'new-password' });
    const n2 = claveCampo('Repite la contraseña nueva', { autocomplete: 'new-password' });
    const guardar = async () => {
      aviso2();
      if (n1.input.value !== n2.input.value) { aviso.textContent = 'Las contraseñas no coinciden.'; return; }
      try {
        await cambiarClaveTemporal(u.id, n1.input.value);
        salir(u);
      } catch (e) { aviso.textContent = e.message || String(e); }
    };
    marco(
      h('h1', {}, 'Elige tu contraseña'),
      h('p', { class: 'ayuda' }, `Hola, ${u.nombre}. Entraste con una contraseña temporal; crea una propia para continuar.`),
      n1.el, n2.el, aviso,
      h('button', { class: 'btn primario', onClick: guardar }, 'Guardar y entrar'));
  }

  // ---------- Recuperar ----------
  function pantallaRecuperar(usarNube = false, volver = pantallaEntrar) {
    const usuario = campo('Usuario o correo', { autocapitalize: 'none', 'aria-label': 'Usuario o correo' });
    const codigo = campo('Código de recuperación', { placeholder: 'XXXX-XXXX-XXXX', autocapitalize: 'characters', 'aria-label': 'Código de recuperación' });
    const n1 = claveCampo('Contraseña nueva', { autocomplete: 'new-password' });
    const hacer = async () => {
      aviso2();
      try {
        const { codigo: nuevo } = await recuperarConCodigo(usuario.input.value, codigo.input.value, n1.input.value, usarNube);
        pantallaCodigo(nuevo, 'Contraseña actualizada', volver);
      } catch (e) { aviso.textContent = e.message || String(e); }
    };
    marco(
      h('h1', {}, 'Recuperar contraseña'),
      h('p', { class: 'ayuda' }, 'Escribe el código de recuperación que recibiste al crear la cuenta de administrador. Si eres un empleado, pídele al administrador que restablezca tu contraseña.'),
      usuario.el, codigo.el, n1.el, aviso,
      h('button', { class: 'btn primario', onClick: hacer }, 'Cambiar contraseña'),
      h('button', { class: 'enlace', onClick: volver }, 'Volver'));
  }

  // ---------- Código de recuperación (se muestra una sola vez) ----------
  function pantallaCodigo(codigo, titulo, continuar) {
    const visto = h('input', { type: 'checkbox', id: 'visto' });
    const seguir = h('button', { class: 'btn primario', disabled: true, onClick: continuar }, 'Continuar');
    visto.addEventListener('change', () => { seguir.disabled = !visto.checked; });
    marco(
      h('h1', {}, titulo),
      h('p', {}, 'Este es tu código de recuperación. Es la única forma de recuperar tu cuenta si olvidas la contraseña.'),
      h('div', { class: 'codigo', 'aria-label': 'Código de recuperación' }, codigo),
      h('button', {
        class: 'btn',
        onClick: async () => {
          try { await navigator.clipboard.writeText(codigo); toast('Código copiado'); } catch { toast('No se pudo copiar; anótalo', 'error'); }
        },
      }, 'Copiar código'),
      h('p', { class: 'ayuda' }, 'Guárdalo en un lugar seguro (papel, gestor de contraseñas). No se volverá a mostrar.'),
      h('label', { class: 'casilla' }, visto, 'Ya lo guardé'),
      seguir);
  }

  // ---------- Crear cuenta (primera vez) ----------
  function pantallaRegistro(enNube = false) {
    const servidor = enNube ? servidorCampo() : null;
    const negocio = campo('Nombre del negocio', { value: cfg.negocio_nombre && cfg.negocio_nombre !== 'Mi Car Audio' ? cfg.negocio_nombre : '', autocomplete: 'organization' });
    const nombre = campo('Tu nombre', { autocomplete: 'name' });
    const usuario = campo('Usuario', { autocapitalize: 'none', autocomplete: 'username', placeholder: 'ej. juan.perez' });
    const correo = campo('Correo', { type: 'email', autocomplete: 'email', inputmode: 'email' });
    const n1 = claveCampo('Contraseña', { autocomplete: 'new-password' });
    const n2 = claveCampo('Repite la contraseña', { autocomplete: 'new-password' });
    const crear = async () => {
      aviso2();
      if (n1.input.value !== n2.input.value) { aviso.textContent = 'Las contraseñas no coinciden.'; return; }
      boton.disabled = true;
      try {
        const datos = {
          negocio: negocio.input.value, nombre: nombre.input.value, usuario: usuario.input.value,
          correo: correo.input.value, clave: n1.input.value,
        };
        let codigo;
        if (enNube) {
          guardarServidor(servidor.input.value);
          const r = await registrarNegocioNube(datos, progreso(boton));
          if (r.pendiente) { pantallaCodigo(r.codigo, 'Registro recibido', pantallaPendiente); return; }
          codigo = r.codigo;
        } else {
          ({ codigo } = await registrarPropietario(datos));
        }
        const u = await iniciarSesion(usuario.input.value, n1.input.value, true);
        cfg.negocio_nombre = negocio.input.value.trim() || cfg.negocio_nombre;
        pantallaCodigo(codigo, enNube ? 'Negocio creado en la nube' : 'Cuenta creada', () => salir(u));
      } catch (e) {
        aviso.textContent = e.message || String(e);
        boton.disabled = false;
      }
    };
    const boton = h('button', { class: 'btn primario', onClick: crear }, enNube ? 'Crear mi negocio' : 'Crear cuenta');
    marco(
      h('h1', {}, enNube ? 'Crea tu negocio en la nube' : 'Crea tu cuenta'),
      h('p', { class: 'ayuda' }, enNube
        ? 'Tus datos se guardan en la nube y podrás entrar con tu usuario o correo desde la web y desde cualquier teléfono. Sigue funcionando sin internet y se sincroniza al volver la conexión.'
        : 'Serás el administrador del negocio. Desde Usuarios podrás crear cuentas para tus empleados.'),
      sinCripto, servidor?.el, negocio.el, nombre.el, usuario.el, correo.el, n1.el, n2.el,
      h('p', { class: 'ayuda' }, 'La contraseña debe tener al menos 8 caracteres, con letras y números.'),
      aviso, boton,
      h('button', { class: 'enlace', onClick: pantallaBienvenida }, 'Volver'));
    negocio.input.focus();
  }

  // ---------- Esperando la aprobación del proveedor ----------
  function pantallaPendiente() {
    marco(
      h('h1', {}, 'Registro pendiente de aprobación'),
      h('p', {}, 'Recibimos tu registro. Cuando el proveedor lo apruebe (después de confirmar el pago) podrás entrar.'),
      h('p', { class: 'ayuda' }, 'Cuando te avisen, abre la app y pulsa "Ya tengo una cuenta" con el usuario y la contraseña que acabas de crear.'),
      h('button', { class: 'btn primario', onClick: () => pantallaBienvenida() }, 'Entendido'));
  }

  // ---------- Entrar con una cuenta de la nube en un dispositivo nuevo ----------
  function pantallaEntrarNube() {
    const servidor = servidorCampo();
    const usuario = campo('Usuario o correo', { autocapitalize: 'none', autocomplete: 'username', 'aria-label': 'Usuario o correo' });
    const clave = claveCampo('Contraseña');
    const entrar = async () => {
      aviso2();
      boton.disabled = true;
      try {
        guardarServidor(servidor.input.value);
        const u = await entrarConCuentaNube(usuario.input.value, clave.input.value, 'reemplazar', progreso(boton));
        if (u.debeCambiar) pantallaCambioTemporal(u); else salir(u);
      } catch (e) {
        aviso.textContent = e.message || String(e);
        boton.disabled = false;
        boton.textContent = 'Entrar y descargar mis datos';
      }
    };
    const boton = h('button', { class: 'btn primario', onClick: entrar }, 'Entrar y descargar mis datos');
    for (const i of [usuario.input, clave.input]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); });
    marco(
      h('h1', {}, 'Entrar a mi negocio'),
      h('p', { class: 'ayuda' }, 'Escribe el usuario o correo de tu cuenta. Se descargarán los datos de tu negocio a este dispositivo.'),
      sinCripto, servidor.el, usuario.el, clave.el, aviso, boton,
      h('button', { class: 'enlace', onClick: () => pantallaRecuperar(true, pantallaEntrarNube) }, '¿Olvidaste tu contraseña?'),
      h('button', { class: 'enlace', onClick: pantallaBienvenida }, 'Volver'));
    usuario.input.focus();
  }

  // ---------- Primera vez en este dispositivo ----------
  function pantallaBienvenida() {
    marco(
      h('h1', {}, 'Bienvenido'),
      h('p', { class: 'ayuda' }, '¿Cómo quieres usar el sistema?'),
      h('button', { class: 'btn primario', onClick: () => pantallaRegistro(true) }, 'Crear mi negocio en la nube'),
      h('p', { class: 'ayuda' }, 'Recomendado: tus datos quedan respaldados y los ves desde la web y desde otros teléfonos.'),
      h('button', { class: 'btn', onClick: pantallaEntrarNube }, 'Ya tengo una cuenta'),
      h('button', { class: 'btn', onClick: () => pantallaRegistro(false) }, 'Usar solo en este dispositivo'),
      h('p', { class: 'ayuda' }, 'Más adelante podrás conectar el negocio a la nube desde Ajustes.'));
  }

  existenUsuarios().then((hay) => {
    if (!hay) pantallaBienvenida();
    else if (sesionPendiente?.debeCambiar) pantallaCambioTemporal(sesionPendiente);
    else pantallaEntrar();
  });
}
