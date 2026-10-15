// main.js - arranque, navegación, ajustes y respaldo
import './style.css';
import { Capacitor } from '@capacitor/core';
import { initDB, consultar, ejecutar, crearRespaldo, restaurarRespaldo, leerSecuenciasNCF, guardarSecuenciaNCF, leerReglasComprobante, guardarReglasComprobante } from './database.js';
import { TIPOS_NCF, REGLAS_COMPROBANTE_BASE } from './itbis.js';
import { validarDocumento } from './fiscal.js';
import { estadoPadron, actualizarPadron, subirPadron } from './dgii.js';
import { h, toast, confirmar, setMoneda, hoja, atrasAtendido } from './ui.js';
import { setIdioma, getIdioma, instalarTraductor } from './i18n.js';
import { asegurarSesion } from './login.js';
import { tienePermiso, usuarioActual, registrarBitacora } from './auth.js';
import { vistaUsuarios, abrirMiCuenta } from './usuarios.js';
import { indicadorNube, seccionNube } from './nube-ui.js';
import { campanaAvisos, bannerPago } from './avisos-ui.js';
import { cargarVinculo, vinculado, iniciarSincronizacionAutomatica, haySesionNube, subirSecuenciasLocales } from './nube-app.js';
import { nube } from './nube.js';
import { vistaVentas } from './ventas.js';
import { vistaProductos } from './productos.js';
import { vistaInventario } from './inventario.js';
import { vistaCompras } from './compras.js';
import { vistaClientes } from './clientes.js';
import { vistaProveedores } from './proveedores.js';
import { vistaCaja } from './caja.js';
import { vistaReportes } from './reportes.js';
import { vistaContabilidad } from './contabilidad.js';
import { vistaGarantias } from './garantias.js';
import { vistaCuentas } from './cuentas.js';
import { crearVistaInicio, MODULOS, INICIO, icono, buscadorModulos } from './inicio.js';

instalarTraductor(); // las asignaciones a textContent también se traducen

// Versión web instalable (PWA): solo en el navegador y ya publicada; en la APK no se usa
if ('serviceWorker' in navigator && Capacitor.getPlatform() === 'web' && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

const pantalla = document.getElementById('pantalla');
const nav = document.getElementById('nav');

// Barra superior con el icono de cada módulo (siempre visible)
const barraModulos = [INICIO, ...MODULOS];

const vistas = {
  inicio: crearVistaInicio((id) => ir(id), (id) => tienePermiso(id), () => usuarioActual()?.nombre?.split(' ')[0] || ''),
  ventas: vistaVentas,
  productos: vistaProductos,
  inventario: vistaInventario,
  compras: vistaCompras,
  caja: vistaCaja,
  cuentas: vistaCuentas,
  garantias: vistaGarantias,
  reportes: vistaReportes,
  contabilidad: vistaContabilidad,
  clientes: vistaClientes,
  proveedores: vistaProveedores,
  usuarios: vistaUsuarios,
  ajustes: vistaAjustes,
};

let actual = 'inicio';
let rutaLista = false;

// "Atrás" y "adelante" del navegador o del teléfono: primero cierran ventanas abiertas, luego cambian de pantalla
window.addEventListener('popstate', () => {
  if (atrasAtendido() || !rutaLista) return;
  const id = rutaDe() || 'inicio';
  if (id !== actual) ir(id, { push: false });
});

function abrirBuscador() {
  const caja = h('div', { class: 'cuerpo' });
  const cerrar = hoja('Buscar módulo', caja);
  caja.append(buscadorModulos((id) => ir(id), (id) => tienePermiso(id), cerrar));
  caja.querySelector('input')?.focus();
}

async function cargarMoneda() {
  const [m] = await consultar("SELECT valor FROM config WHERE clave = 'moneda'");
  setMoneda(m?.valor);
}

async function cargarIdioma() {
  const [i] = await consultar("SELECT valor FROM config WHERE clave = 'idioma'");
  setIdioma(i?.valor === 'en' ? 'en' : 'es');
}

function construirNav() {
  const u = usuarioActual();
  nav.replaceChildren(
    ...barraModulos.filter((m) => tienePermiso(m.id)).map((m) =>
      h('button', { 'data-id': m.id, title: m.titulo, 'aria-label': m.titulo, onClick: () => ir(m.id) }, icono(m))),
    // Sincronización y cuenta del usuario: siempre visibles a la derecha
    h('div', { class: 'nav-fijo' },
      h('button', { class: 'nav-nube', title: 'Buscar módulo', 'aria-label': 'Buscar módulo', onClick: abrirBuscador },
        Object.assign(document.createElement('span'), { innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' })),
      campanaAvisos(),
      indicadorNube(),
      h('button', { class: 'nav-cuenta', title: 'Mi cuenta', 'aria-label': 'Mi cuenta', onClick: () => abrirMiCuenta(() => location.reload()) },
        h('span', { class: 'avatar' }, String(u?.nombre || '?').trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase()))));
  nav.querySelector(`[data-id="${actual}"]`)?.setAttribute('aria-current', 'page');
}

// Cada pantalla tiene su propia dirección (#/ventas, #/productos…) para que "atrás" y "adelante" funcionen y se pueda compartir el enlace
const rutaDe = () => { const r = /^#\/([a-z]+)/.exec(location.hash); return r && vistas[r[1]] ? r[1] : null; };

async function ir(id, { push = true } = {}) {
  if (!tienePermiso(id)) {
    pantalla.replaceChildren(h('p', { class: 'error vacio' }, 'No tienes permiso para entrar a esta sección. Habla con el administrador.'));
    return;
  }
  actual = id;
  if (push && location.hash !== `#/${id}`) history.pushState({ ruta: id }, '', `#/${id}`);
  nav.querySelectorAll('button').forEach((b) => {
    if (b.dataset.id === id) { b.setAttribute('aria-current', 'page'); b.scrollIntoView?.({ inline: 'center', block: 'nearest' }); }
    else b.removeAttribute('aria-current');
  });
  pantalla.scrollTop = 0;
  try {
    await vistas[id](pantalla);
  } catch (e) {
    pantalla.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar la pantalla: ${e.message || e}`));
  }
}

// Reduce el logo a 500 px como máximo. Los PNG conservan la transparencia.
function prepararLogo(archivo, max = 500) {
  return new Promise((ok, fallo) => {
    const img = new Image();
    const url = URL.createObjectURL(archivo);
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * r));
      c.height = Math.max(1, Math.round(img.height * r));
      const png = /png|svg|gif|webp/i.test(archivo.type);
      const ctx = c.getContext('2d');
      if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => { URL.revokeObjectURL(url); fallo(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}

async function vistaAjustes(raiz) {
  const cfg = Object.fromEntries((await consultar('SELECT clave, valor FROM config')).map((r) => [r.clave, r.valor]));
  const campos = [
    ['negocio_nombre', 'Nombre del negocio'],
    ['negocio_telefono', 'Teléfono'],
    ['negocio_direccion', 'Dirección'],
    ['moneda', 'Símbolo de moneda'],
    ['margen_defecto', 'Margen de ganancia por defecto en productos nuevos (%)'],
  ];
  const inputs = Object.fromEntries(campos.map(([k]) => [k, h('input', { class: 'campo', value: cfg[k] ?? '' })]));

  async function guardar() {
    for (const [k] of campos) {
      await ejecutar('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)', [k, inputs[k].value.trim()]);
    }
    await cargarMoneda();
    toast('Datos guardados');
  }

  async function respaldar() {
    try {
      await crearRespaldo();
      await registrarBitacora('Respaldo creado');
      toast('Respaldo creado');
    } catch (e) {
      toast(`No se pudo crear el respaldo: ${e.message || e}`, 'error');
    }
  }

  const archivo = h('input', {
    type: 'file', accept: '.json,application/json', class: 'oculto',
    onChange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const ok = await confirmar('Restaurar respaldo',
        'Se reemplazarán todos los datos actuales por los del archivo. Esta acción no se puede deshacer.', 'Restaurar');
      if (!ok) return;
      try {
        await restaurarRespaldo(f);
        toast('Respaldo restaurado. Se reiniciará la app.');
        // Los usuarios también vienen en el respaldo: se vuelve a pedir el acceso
        setTimeout(() => location.reload(), 1200);
      } catch (err) {
        toast(err.message || 'No se pudo restaurar', 'error');
      }
    },
  });

  // Logo: se reduce y se guarda en la base (entra en los respaldos) para el encabezado de las facturas
  const vistaLogo = h('div', { class: 'logo-vista' });
  async function pintarLogo() {
    const [l] = await consultar("SELECT valor FROM config WHERE clave = 'negocio_logo'");
    vistaLogo.replaceChildren(l?.valor
      ? h('img', { src: l.valor, alt: 'Logo del negocio' })
      : h('p', { class: 'ayuda' }, 'Aún no has agregado un logo.'));
    quitarLogo.style.display = l?.valor ? '' : 'none';
  }
  const quitarLogo = h('button', {
    class: 'btn peligro',
    onClick: async () => {
      await ejecutar("DELETE FROM config WHERE clave = 'negocio_logo'");
      toast('Logo quitado');
      await pintarLogo();
    },
  }, 'Quitar logo');
  const archivoLogo = h('input', {
    type: 'file', accept: 'image/*', class: 'oculto',
    onChange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const datos = await prepararLogo(f);
        await ejecutar('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)', ['negocio_logo', datos]);
        toast('Logo guardado');
        await pintarLogo();
      } catch (err) {
        toast(err.message || 'No se pudo guardar el logo', 'error');
      }
    },
  });
  await pintarLogo();

  // Idioma de la app y de las facturas PDF
  const guardarConfig = (clave, valor) => ejecutar('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)', [clave, valor]);
  const selIdioma = h('select', {
    class: 'campo', 'aria-label': 'Idioma de la aplicación',
    onChange: async (e) => {
      await guardarConfig('idioma', e.target.value);
      setIdioma(e.target.value);
      construirNav();
      toast('Idioma guardado');
      await ir('ajustes');
    },
  }, h('option', { value: 'es' }, 'Español'), h('option', { value: 'en' }, 'English'));
  selIdioma.value = getIdioma();
  const selFactura = h('select', {
    class: 'campo', 'aria-label': 'Idioma de las facturas',
    onChange: async (e) => { await guardarConfig('idioma_factura', e.target.value); toast('Idioma guardado'); },
  }, h('option', { value: 'app' }, 'Igual que la app'), h('option', { value: 'es' }, 'Español'), h('option', { value: 'en' }, 'English'));
  selFactura.value = cfg.idioma_factura || 'app';

  // Datos fiscales: RNC, ITBIS y secuencias de NCF autorizadas por la DGII (las secuencias son de este dispositivo)
  const rncNegocio = h('input', { class: 'campo', value: cfg.negocio_rnc ?? '', inputmode: 'numeric', placeholder: '9 números', autocomplete: 'off' });
  const activoFact = h('input', { type: 'checkbox', checked: cfg.itbis_modo === 'adicional' || cfg.itbis_modo === 'incluido', 'aria-label': 'Facturación con comprobante' });
  const tasaItbis = h('input', { class: 'campo', type: 'number', min: '0', step: '0.01', value: cfg.itbis_tasa || '18', inputmode: 'decimal' });
  // Con la nube conectada las secuencias son del negocio y viven en el servidor; sin nube, de este dispositivo
  let ncfServidor = null; let ncfAviso = '';
  const ncfNube = vinculado() && haySesionNube();
  if (ncfNube) {
    try { await subirSecuenciasLocales(); ncfServidor = await nube.ncf(); } catch { ncfAviso = 'Sin conexión con el servidor: las secuencias del negocio no se pueden ver ni cambiar ahora.'; }
  }
  const adminNcf = usuarioActual()?.rol === 'admin';
  const secuencias = ncfNube
    ? (ncfServidor?.secuencias || []).map((x) => ({ tipo: x.tipo, sig: x.siguiente, hasta: x.hasta }))
    : await leerSecuenciasNCF();
  const anuladosNcf = (await consultar('SELECT ncf FROM ncf_anulados ORDER BY id DESC LIMIT 20')).map((x) => x.ncf);
  const bloqueadoNcf = ncfNube && (!ncfServidor || !adminNcf);
  const camposNcf = secuencias.map((s) => ({
    s, sig: h('input', { class: 'campo', type: 'number', min: '0', value: s.sig || '', placeholder: 'Próximo', inputmode: 'numeric', disabled: bloqueadoNcf }),
    hasta: h('input', { class: 'campo', type: 'number', min: '0', value: s.hasta || '', placeholder: 'Último', inputmode: 'numeric', disabled: bloqueadoNcf }),
  }));
  // Reglas: si el régimen/categoría que la DGII tiene para el cliente contiene un texto, se le da ese comprobante
  const reglasLista = await leerReglasComprobante();
  const cajaReglas = h('div', { class: 'reglas-cpb' });
  const filasReglas = [];
  const nuevaRegla = (r = { texto: '', tipo: 'B14' }) => {
    const texto = h('input', { class: 'campo', value: r.texto, placeholder: 'Texto (ej. ZONA FRANCA)', 'aria-label': 'Texto de la regla', autocomplete: 'off' });
    const tipo = h('select', { class: 'campo', 'aria-label': 'Comprobante de la regla' }, ...Object.entries(TIPOS_NCF).map(([k, t]) => h('option', { value: k }, `${k} · ${t}`)));
    tipo.value = r.tipo;
    const fila = { texto, tipo };
    const caja = h('div', { class: 'rejilla' }, texto, tipo, h('button', { class: 'btn chico', onClick: () => { filasReglas.splice(filasReglas.indexOf(fila), 1); caja.remove(); } }, 'Quitar'));
    filasReglas.push(fila); cajaReglas.append(caja);
  };
  reglasLista.forEach(nuevaRegla);
  const errorFiscal = h('p', { class: 'error', role: 'alert' });
  async function guardarFiscal() {
    errorFiscal.textContent = '';
    const doc = validarDocumento('rnc', rncNegocio.value);
    if (doc.error) { errorFiscal.textContent = doc.error; return; }
    const tasa = parseFloat(tasaItbis.value);
    if (!(tasa > 0 && tasa < 100)) { errorFiscal.textContent = 'La tasa de ITBIS no es válida.'; return; }
    try {
      if (ncfNube) {
        if (!bloqueadoNcf) {
          for (const c of camposNcf) {
            const sig = parseInt(c.sig.value, 10) || 0; const hasta = parseInt(c.hasta.value, 10) || 0;
            if (sig === (c.s.sig || 0) && hasta === (c.s.hasta || 0)) continue;
            if (c.s.sig > 0 && sig > 0 && sig < c.s.sig && !(await confirmar('Bajar el próximo número', `${c.s.tipo}: pasaste de ${c.s.sig} a ${sig}. Si ya se emitieron comprobantes en ese rango, se repetirían.`, 'Continuar'))) return;
            const r = await nube.guardarNcf(c.s.tipo, { siguiente: sig, hasta });
            c.s.sig = r.siguiente; c.s.hasta = r.hasta;
          }
        }
      } else {
        for (const c of camposNcf) await guardarSecuenciaNCF(c.s.tipo, parseInt(c.sig.value, 10) || 0, parseInt(c.hasta.value, 10) || 0);
      }
      await guardarReglasComprobante(filasReglas.map((f) => ({ texto: f.texto.value, tipo: f.tipo.value })));
    } catch (e) { errorFiscal.textContent = e.message; return; }
    for (const [k, v] of [['negocio_rnc', doc.numero || ''], ['itbis_modo', activoFact.checked ? 'adicional' : 'no'], ['itbis_tasa', String(tasa)]]) await guardarConfig(k, v);
    toast(activoFact.checked ? 'Facturación con comprobante encendida' : 'Facturación con comprobante apagada');
  }

  // Padrón de contribuyentes de la DGII (vive en el servidor; solo el administrador lo actualiza)
  const textoPadron = h('p', { class: 'ayuda', role: 'status' });
  const errorPadron = h('p', { class: 'error', role: 'alert' });
  const cargarEstadoPadron = async () => {
    try {
      const e = await estadoPadron();
      textoPadron.textContent = e.cantidad ? `Listado de la DGII cargado: ${e.cantidad.toLocaleString('es-DO')} contribuyentes (actualizado ${String(e.actualizado).slice(0, 10)}).` : 'El listado de la DGII aún no está cargado: la consulta de RNC no funcionará hasta cargarlo.';
    } catch { textoPadron.textContent = ''; }
  };
  const esAdmin = usuarioActual()?.rol === 'admin';
  const seccionPadron = vinculado() ? h('div', {},
    h('h3', {}, 'Consulta de RNC en la DGII'),
    textoPadron, errorPadron,
    esAdmin ? h('div', { class: 'acciones' },
      h('button', { class: 'btn', onClick: async (e) => {
        errorPadron.textContent = ''; e.target.disabled = true; textoPadron.textContent = 'Bajando el listado de la DGII… puede tardar unos minutos.';
        try { await actualizarPadron(); toast('Listado de la DGII actualizado'); } catch (x) { errorPadron.textContent = x.message; }
        e.target.disabled = false; await cargarEstadoPadron();
      } }, 'Actualizar desde la DGII'),
      h('label', { class: 'btn' }, 'Subir archivo (DGII_RNC.zip o .txt)', h('input', { type: 'file', accept: '.zip,.txt', hidden: true, onChange: async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        errorPadron.textContent = ''; textoPadron.textContent = 'Subiendo y procesando el archivo…';
        try { await subirPadron(f); toast('Listado cargado'); } catch (x) { errorPadron.textContent = x.message; }
        e.target.value = ''; await cargarEstadoPadron();
      } }))) : null) : null;
  if (seccionPadron) cargarEstadoPadron();

  raiz.replaceChildren(
    h('header', { class: 'barra' }, h('h1', {}, 'Ajustes')),
    h('section', { class: 'seccion' },
      h('h2', {}, 'Idioma / Language'),
      h('p', { class: 'ayuda' }, 'Elige el idioma de la aplicación y el de las facturas PDF.'),
      h('label', { class: 'etiqueta' }, 'Idioma de la aplicación', selIdioma),
      h('label', { class: 'etiqueta' }, 'Idioma de las facturas', selFactura)),
    h('section', { class: 'seccion' },
      h('h2', {}, 'Logo del negocio'),
      h('p', { class: 'ayuda' }, 'Aparece en el encabezado de las facturas. Mejor si es un archivo PNG con fondo transparente o blanco.'),
      vistaLogo,
      h('div', { class: 'acciones' },
        quitarLogo,
        h('label', { class: 'btn primario' }, 'Elegir logo', archivoLogo))),
    h('section', { class: 'seccion' },
      h('h2', {}, 'Facturación con comprobante (DGII)'),
      h('p', { class: 'ayuda' }, 'Encendida: toda venta sale con comprobante fiscal (NCF) y el ITBIS se suma al precio de venta. Al facturar eliges el tipo; si el cliente no tiene RNC se le da una factura de consumo (B02). Apagada: se factura sin comprobante ni ITBIS. Escribe abajo los rangos de NCF que la DGII te autorizó.'),
      h('p', { class: 'ayuda' }, ncfNube ? 'Las secuencias son de este negocio y se guardan en el servidor: todos los equipos del negocio usan la misma y cada factura pide su número al servidor, así no se repite ninguno. Sin internet el equipo no puede facturar (solo consultar).' : 'Sin la nube conectada, las secuencias son de este dispositivo.'),
      ncfAviso ? h('p', { class: 'error', role: 'status' }, ncfAviso) : null,
      anuladosNcf.length ? h('p', { class: 'ayuda' }, 'Comprobantes anulados porque la factura no se llegó a guardar (están en Reportes → Impuestos, formato 608): ' + anuladosNcf.join(' · ')) : null,
      ncfNube && ncfServidor && !adminNcf ? h('p', { class: 'ayuda' }, 'Solo el administrador puede cambiar las secuencias.') : null,
      h('label', { class: 'etiqueta fila-check' }, activoFact, ' Facturar con comprobante e ITBIS'),
      h('label', { class: 'etiqueta' }, 'RNC del negocio', rncNegocio),
      cfg.negocio_categoria ? h('p', { class: 'ayuda' }, `Categoría / régimen en la DGII: ${cfg.negocio_categoria}`) : null,
      h('label', { class: 'etiqueta' }, 'Tasa de ITBIS (%)', tasaItbis),
      ...camposNcf.map((c) => h('div', { class: 'rejilla' },
        h('label', { class: 'etiqueta' }, `${c.s.tipo} · ${TIPOS_NCF[c.s.tipo]} · próximo`, c.sig),
        h('label', { class: 'etiqueta' }, 'Último autorizado', c.hasta))),
      h('h3', {}, 'Comprobante según la categoría del cliente'),
      h('p', { class: 'ayuda' }, 'La DGII asigna el comprobante según el tipo de contribuyente: B01 a contribuyentes con RNC, B02 a consumidores finales, B14 a regímenes especiales (por ejemplo zonas francas, con exención vigente) y B15 al Estado. Aquí dices con qué texto del régimen o categoría que muestra la DGII se aplica cada uno. Lo que no coincida con ninguna regla recibe B01. En la ficha de un cliente puedes fijar otro.'),
      cajaReglas,
      h('button', { class: 'btn chico', onClick: () => nuevaRegla() }, '+ Agregar regla'),
      errorFiscal,
      h('button', { class: 'btn primario', onClick: guardarFiscal }, 'Guardar'),
      seccionPadron),
    h('section', { class: 'seccion' },
      h('h2', {}, 'Datos del negocio'),
      ...campos.map(([k, et]) => h('label', { class: 'etiqueta' }, et, inputs[k])),
      h('button', { class: 'btn primario', onClick: guardar }, 'Guardar datos')),
    seccionNube(),
    h('section', { class: 'seccion' },
      h('h2', {}, 'Respaldo de la base de datos'),
      h('p', { class: 'ayuda' }, 'El respaldo guarda productos, inventario, clientes, ventas y compras en un archivo. Envíalo a tu correo o a Drive para tenerlo a salvo.'),
      h('button', { class: 'btn primario', onClick: respaldar }, 'Crear respaldo'),
      vinculado()
        ? h('p', { class: 'ayuda' }, 'Con la nube conectada no se restaura desde un archivo: tus datos se recuperan de la nube al entrar en otro dispositivo.')
        : h('label', { class: 'btn' }, 'Restaurar desde un archivo', archivo)));
}

// Cuando llegan datos de otros dispositivos se refresca la pantalla, salvo que la persona esté escribiendo o tenga algo abierto
window.addEventListener('caraudio:datos-nuevos', async () => {
  const ocupado = document.querySelector('.fondo') || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  await cargarMoneda();
  if (!ocupado && actual !== 'ajustes') await ir(actual);
  else toast('Llegaron datos nuevos de otro dispositivo');
});

(async () => {
  try {
    await initDB();
    await cargarVinculo();   // ¿este dispositivo está conectado a la nube?
    await cargarMoneda();
    await cargarIdioma();
    await asegurarSesion(); // registro, inicio de sesión o sesión guardada
    await cargarMoneda();   // por si llegaron datos de la nube al entrar
    await cargarIdioma();   // por si cambió al restaurar
    construirNav();
    bannerPago(pantalla);
    const inicial = rutaDe();
    const primera = inicial && tienePermiso(inicial) ? inicial : 'inicio';
    history.replaceState({ ruta: primera }, '', `#/${primera}`);
    rutaLista = true;
    await ir(primera, { push: false });
    iniciarSincronizacionAutomatica();
  } catch (e) {
    document.body.append(h('p', { class: 'error vacio' }, `No se pudo abrir la base de datos: ${e.message || e}`));
  }
})();
