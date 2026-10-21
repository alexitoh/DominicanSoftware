// ecf.js - módulo de Facturación electrónica (e-CF) con la DGII.
// Tres secciones: Comprobantes (bandeja con el estado de cada uno), Emitir (E41 compras y E43 gastos menores) y Configuración
// (certificado digital, ambiente, datos del emisor y secuencias E autorizadas). Todo el trabajo pesado (XML, firma, envío) lo hace el servidor.
import { h, toast, dinero, confirmar } from './ui.js';
import { nube, haySesionNube, vinculado, fijarElectronico, refrescarElectronico } from './nube-app.js';
import { usuarioActual } from './auth.js';
import { NOMBRE_E } from './itbis.js';

export const ESTADOS_ECF = {
  pendiente: ['En cola', 'gris'], enviado: ['Enviado, esperando a la DGII', 'gris'], aceptado: ['Aceptado', 'ok'], condicional: ['Aceptado condicional', 'aviso'],
  rechazado: ['Rechazado', 'error'], error: ['Reintentando', 'aviso'], incompleto: ['Falta información', 'error'], anulado: ['Anulado', 'gris'],
};
const AYUDA_ESTADO = {
  incompleto: 'Falta un dato (por ejemplo la fecha de vencimiento de la secuencia o datos del emisor). Corrígelo y pulsa Reintentar.',
  rechazado: 'La DGII lo rechazó. Lee el motivo, corrige la factura o los datos y pulsa Reintentar (se arma de nuevo).',
};
const SECUENCIAS_E = ['E31', 'E32', 'E33', 'E34', 'E41', 'E43', 'E44', 'E45'];
const SECCIONES = [['comprobantes', 'Comprobantes'], ['emitir', 'Emitir E41 / E43'], ['config', 'Configuración']];
let seccion = 'comprobantes';

const esAdmin = () => usuarioActual()?.rol === 'admin';
const fechaCorta = (t) => String(t || '').replace('T', ' ').slice(0, 16);
const leerBase64 = (archivo) => new Promise((ok, fallo) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1] || '');
  r.onerror = () => fallo(new Error('No se pudo leer el archivo.'));
  r.readAsDataURL(archivo);
});
const claveNueva = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`).replace(/-/g, '');

export async function vistaEcf(raiz) {
  if (!vinculado() || !haySesionNube()) {
    raiz.replaceChildren(h('header', { class: 'barra' }, h('h1', {}, 'Facturación electrónica')),
      h('p', { class: 'vacio' }, 'La facturación electrónica se maneja desde el servidor. Conecta este equipo a la nube del negocio (Ajustes → Nube) para usarla.'));
    return;
  }
  const cuerpo = h('div');
  const barra = h('div', { class: 'segmento conta-tabs', role: 'tablist', 'aria-label': 'Facturación electrónica' });
  async function ir(id) {
    seccion = id;
    barra.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    const nueva = h('div');
    try { await FN[id](nueva, () => ir(id)); } catch (e) { nueva.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar: ${e.message || e}`)); }
    if (seccion === id) cuerpo.replaceChildren(nueva);
  }
  barra.append(...SECCIONES.map(([id, t]) => h('button', { 'data-id': id, role: 'tab', onClick: () => ir(id) }, t)));
  raiz.replaceChildren(h('header', { class: 'barra' }, h('h1', {}, 'Facturación electrónica')), barra, cuerpo);
  await ir(seccion);
}

// ---------- Comprobantes ----------
async function seccionComprobantes(raiz, recargar) {
  const [cfg, lista] = await Promise.all([nube.ecf(), nube.enviosEcf()]);
  fijarElectronico(cfg.activo);
  const r = cfg.resumen || {};
  const total = Object.values(r).reduce((a, b) => a + b, 0);
  const pendientes = (r.pendiente || 0) + (r.enviado || 0) + (r.error || 0);
  const problemas = (r.rechazado || 0) + (r.incompleto || 0);

  const estadoGeneral = !cfg.activo
    ? h('p', { class: 'ayuda' }, 'La facturación electrónica está apagada. Actívala en Configuración cuando tengas el certificado digital y las secuencias E autorizadas por la DGII.')
    : h('p', { class: 'ayuda' }, `Ambiente: ${(cfg.ambientes.find((a) => a.id === cfg.ambiente) || {}).nombre || cfg.ambiente}. ${cfg.ambiente !== 'ecf' ? 'Los comprobantes de este ambiente NO tienen validez fiscal.' : ''}`);

  const errorAcc = h('p', { class: 'error', role: 'alert' });
  async function reintentar(e, reconstruir = false) {
    errorAcc.textContent = '';
    try { await nube.reintentarEcf(e.uid, { reconstruir }); await nube.procesarEcf().catch(() => {}); toast('Se volvió a enviar'); await recargar(); } catch (x) { errorAcc.textContent = x.message; }
  }
  async function verXml(e) {
    errorAcc.textContent = '';
    try {
      const resp = await nube.llamar('GET', `/api/ecf/envios/${encodeURIComponent(e.uid)}/xml`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([resp.xml || ''], { type: 'application/xml' }));
      a.download = `${e.encf}.xml`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (x) { errorAcc.textContent = x.message; }
  }

  const filas = lista.envios.map((e) => {
    const [texto, clase] = ESTADOS_ECF[e.estado] || [e.estado, 'gris'];
    return h('li', { class: 'fila-ecf' },
      h('div', { class: 'cabecera-fila' },
        h('strong', {}, e.encf), ' ',
        h('span', { class: `etiqueta-estado ${clase}` }, texto), ' ',
        h('span', { class: 'ayuda' }, `${NOMBRE_E[e.tipo] || e.tipo} · ${dinero(e.monto)} · ${fechaCorta(e.creado)}`)),
      e.mensaje ? h('p', { class: 'ayuda' }, e.mensaje) : null,
      AYUDA_ESTADO[e.estado] ? h('p', { class: 'ayuda' }, AYUDA_ESTADO[e.estado]) : null,
      e.estado === 'error' ? h('p', { class: 'ayuda' }, `Intento ${e.intentos}. Se vuelve a intentar solo, con esperas cada vez más largas.`) : null,
      h('div', { class: 'acciones' },
        ['rechazado', 'incompleto', 'error'].includes(e.estado) && esAdmin() ? h('button', { class: 'btn chico', onClick: () => reintentar(e, e.estado !== 'error') }, 'Reintentar') : null,
        esAdmin() && ['aceptado', 'condicional', 'rechazado', 'enviado', 'error'].includes(e.estado) ? h('button', { class: 'btn chico', onClick: () => verXml(e) }, 'Descargar XML') : null));
  });

  raiz.replaceChildren(
    estadoGeneral,
    h('dl', { class: 'resumen' },
      h('div', {}, h('dt', {}, 'Comprobantes'), h('dd', {}, String(total))),
      h('div', {}, h('dt', {}, 'Aceptados'), h('dd', {}, String((r.aceptado || 0) + (r.condicional || 0)))),
      h('div', {}, h('dt', {}, 'En proceso'), h('dd', {}, String(pendientes))),
      h('div', {}, h('dt', {}, 'Con problema'), h('dd', { class: problemas ? 'neg' : '' }, String(problemas)))),
    errorAcc,
    h('div', { class: 'acciones' },
      h('button', { class: 'btn', onClick: async () => { try { await nube.procesarEcf(); } catch (x) { errorAcc.textContent = x.message; return; } await recargar(); } }, 'Revisar ahora con la DGII'),
      h('button', { class: 'btn', onClick: recargar }, 'Actualizar')),
    filas.length ? h('ul', { class: 'lista-ecf' }, ...filas) : h('p', { class: 'vacio' }, 'Aún no hay comprobantes electrónicos.'));
}

// ---------- Emitir E41 / E43 ----------
async function seccionEmitir(raiz) {
  const cfg = await nube.ecf();
  if (!cfg.activo) { raiz.replaceChildren(h('p', { class: 'vacio' }, 'Activa la facturación electrónica en Configuración para emitir comprobantes.')); return; }
  const tipo = h('select', { class: 'campo', 'aria-label': 'Tipo de comprobante' },
    h('option', { value: 'E41' }, 'E41 · Comprobante de compras (a quien no da factura)'), h('option', { value: 'E43' }, 'E43 · Gastos menores'));
  const rnc = h('input', { class: 'campo', inputmode: 'numeric', placeholder: 'RNC o cédula (opcional en E43)', autocomplete: 'off', 'aria-label': 'RNC del proveedor' });
  const razon = h('input', { class: 'campo', placeholder: 'Nombre de quien te vende', autocomplete: 'off', 'aria-label': 'Nombre del proveedor' });
  const pago = h('select', { class: 'campo', 'aria-label': 'Tipo de pago' }, h('option', { value: '1' }, 'Contado'), h('option', { value: '2' }, 'Crédito'));
  const limite = h('input', { class: 'campo', type: 'date', 'aria-label': 'Fecha límite de pago' });
  const retItbis = h('input', { class: 'campo', type: 'number', min: '0', step: '0.01', placeholder: 'ITBIS retenido', inputmode: 'decimal', 'aria-label': 'ITBIS retenido' });
  const retIsr = h('input', { class: 'campo', type: 'number', min: '0', step: '0.01', placeholder: 'ISR retenido', inputmode: 'decimal', 'aria-label': 'ISR retenido' });
  const cajaLineas = h('div');
  const lineas = [];
  const nuevaLinea = () => {
    const nombre = h('input', { class: 'campo', placeholder: 'Descripción', autocomplete: 'off', 'aria-label': 'Descripción' });
    const cant = h('input', { class: 'campo', type: 'number', min: '0', step: '0.01', value: '1', inputmode: 'decimal', 'aria-label': 'Cantidad' });
    const precio = h('input', { class: 'campo', type: 'number', min: '0', step: '0.01', placeholder: 'Precio', inputmode: 'decimal', 'aria-label': 'Precio' });
    const exento = h('input', { type: 'checkbox', 'aria-label': 'Exento de ITBIS' });
    const bien = h('select', { class: 'campo', 'aria-label': 'Bien o servicio' }, h('option', { value: '1' }, 'Bien'), h('option', { value: '0' }, 'Servicio'));
    const fila = h('div', { class: 'rejilla' }, nombre, cant, precio, bien, h('label', { class: 'etiqueta fila-check' }, exento, ' Exento'));
    const l = { nombre, cant, precio, exento, bien, fila };
    lineas.push(l); cajaLineas.append(fila);
  };
  nuevaLinea();
  const error = h('p', { class: 'error', role: 'alert' });
  const resultado = h('p', { class: 'ayuda', role: 'status' });
  let clave = claveNueva(); // si el envío se corta y se repite, el servidor devuelve el mismo comprobante
  const emitir = async () => {
    error.textContent = ''; resultado.textContent = '';
    const datos = lineas.filter((l) => l.nombre.value.trim() || l.precio.value).map((l) => ({
      nombre: l.nombre.value.trim(), cantidad: Number(l.cant.value), precio: Number(l.precio.value), exento: l.exento.checked, bien: l.bien.value === '1',
    }));
    if (!datos.length) { error.textContent = 'Agrega al menos una línea.'; return; }
    if (!(await confirmar('Emitir comprobante', `Se emitirá un ${tipo.value} y se enviará a la DGII (${cfg.ambiente === 'ecf' ? 'PRODUCCIÓN' : 'ambiente de pruebas'}). ¿Continuar?`, 'Emitir'))) return;
    try {
      const r = await nube.emitirEcf({
        tipo: tipo.value, clave, lineas: datos, comprador: { rnc: rnc.value, razon: razon.value }, tipoPago: Number(pago.value), fechaLimitePago: limite.value || undefined,
        itbisRetenido: Number(retItbis.value) || 0, isrRetenido: Number(retIsr.value) || 0,
      });
      clave = claveNueva();
      resultado.textContent = `Emitido ${r.encf}${r.envio ? ` · ${(ESTADOS_ECF[r.envio.estado] || [r.envio.estado])[0]}${r.envio.mensaje ? ` · ${r.envio.mensaje}` : ''}` : ''}`;
      toast('Comprobante emitido');
    } catch (e) { error.textContent = e.message; }
  };
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'E41: cuando le compras a alguien que no te da factura con comprobante (con ITBIS/ISR retenido si aplica). E43: gastos menores. Las facturas de venta (E31, E32…) salen solas desde Ventas.'),
    h('label', { class: 'etiqueta' }, 'Tipo', tipo),
    h('div', { class: 'rejilla' }, h('label', { class: 'etiqueta' }, 'RNC / cédula', rnc), h('label', { class: 'etiqueta' }, 'Nombre', razon)),
    h('div', { class: 'rejilla' }, h('label', { class: 'etiqueta' }, 'Pago', pago), h('label', { class: 'etiqueta' }, 'Fecha límite (si es a crédito)', limite)),
    h('h3', {}, 'Líneas (precio sin ITBIS)'),
    cajaLineas,
    h('button', { class: 'btn chico', onClick: nuevaLinea }, '+ Agregar línea'),
    h('div', { class: 'rejilla' }, retItbis, retIsr),
    error, resultado,
    h('button', { class: 'btn primario', onClick: emitir }, 'Emitir y enviar a la DGII'));
}

// ---------- Configuración ----------
async function seccionConfig(raiz, recargar) {
  const [cfg, ncf] = await Promise.all([nube.ecf(), nube.ncf()]);
  fijarElectronico(cfg.activo);
  const admin = esAdmin();
  const msg = h('p', { class: 'ayuda', role: 'status' });
  const err = h('p', { class: 'error', role: 'alert' });
  const guardando = async (fn, ok) => {
    err.textContent = ''; msg.textContent = '';
    try { await fn(); if (ok) toast(ok); await refrescarElectronico(); await recargar(); } catch (e) { err.textContent = e.message; }
  };

  // Certificado
  const archivo = h('input', { type: 'file', accept: '.p12,.pfx', 'aria-label': 'Archivo del certificado' });
  const claveCert = h('input', { class: 'campo', type: 'password', placeholder: 'Contraseña del certificado', autocomplete: 'off', 'aria-label': 'Contraseña del certificado' });
  const c = cfg.certificado;
  const bloqueCert = h('section', { class: 'seccion' },
    h('h2', {}, 'Certificado digital'),
    h('p', { class: 'ayuda' }, 'Es el archivo .p12 que te entrega una entidad certificadora autorizada (por ejemplo Viafirma o DigiFirma) a nombre de la empresa. Se guarda cifrado en el servidor y nunca vuelve a los dispositivos.'),
    c ? h('p', { class: 'ayuda' }, `Cargado: ${c.sujeto}. ${c.vencido ? 'VENCIDO' : `Vence el ${c.vence}`}.`) : h('p', { class: 'ayuda' }, 'Todavía no hay certificado cargado.'),
    admin ? h('div', {},
      h('label', { class: 'etiqueta' }, 'Archivo .p12 / .pfx', archivo), claveCert,
      h('div', { class: 'acciones' },
        c ? h('button', { class: 'btn', onClick: () => guardando(async () => { if (await confirmar('Quitar certificado', 'La facturación electrónica se apagará.', 'Quitar')) await nube.quitarCertificado(); }) }, 'Quitar') : null,
        h('button', { class: 'btn primario', onClick: () => guardando(async () => {
          const f = archivo.files?.[0];
          if (!f) throw new Error('Elige el archivo del certificado.');
          await nube.subirCertificado({ p12: await leerBase64(f), clave: claveCert.value });
        }, 'Certificado guardado') }, c ? 'Reemplazar certificado' : 'Subir certificado'))) : h('p', { class: 'ayuda' }, 'Solo el administrador puede cambiar el certificado.'));

  // Ambiente y activación
  const ambiente = h('select', { class: 'campo', 'aria-label': 'Ambiente de la DGII', disabled: !admin }, ...cfg.ambientes.map((a) => h('option', { value: a.id }, a.nombre)));
  ambiente.value = cfg.ambiente;
  const activo = h('input', { type: 'checkbox', checked: cfg.activo, disabled: !admin, 'aria-label': 'Facturación electrónica activa' });
  const bloqueEstado = h('section', { class: 'seccion' },
    h('h2', {}, 'Conexión con la DGII'),
    h('p', { class: 'ayuda' }, 'Pruebas (TesteCF) y Certificación (CerteCF) no tienen validez fiscal. Producción (eCF) solo cuando la DGII ya te autorizó como emisor electrónico. Con la facturación electrónica activa, Ventas emite E31/E32/E44/E45 en lugar de B01/B02/B14/B15.'),
    h('label', { class: 'etiqueta' }, 'Ambiente', ambiente),
    h('label', { class: 'etiqueta fila-check' }, activo, ' Facturación electrónica activa'),
    admin ? h('div', { class: 'acciones' },
      h('button', { class: 'btn', onClick: () => guardando(async () => { const r = await nube.probarEcf(); msg.textContent = r.mensaje || 'La DGII respondió: el certificado y la conexión funcionan.'; }) }, 'Probar conexión'),
      h('button', { class: 'btn primario', onClick: () => guardando(() => nube.guardarEcf({ activo: activo.checked, ambiente: ambiente.value }), 'Guardado') }, 'Guardar')) : null);

  // Datos del emisor
  const CAMPOS = [['razon', 'Razón social'], ['comercial', 'Nombre comercial'], ['direccion', 'Dirección'], ['municipio', 'Municipio (código)'], ['provincia', 'Provincia (código)'], ['correo', 'Correo'], ['telefono', 'Teléfono']];
  const ent = Object.fromEntries(CAMPOS.map(([k]) => [k, h('input', { class: 'campo', value: cfg.extra?.[k] || '', disabled: !admin, autocomplete: 'off', 'aria-label': k })]));
  const bloqueEmisor = h('section', { class: 'seccion' },
    h('h2', {}, 'Datos del emisor'),
    h('p', { class: 'ayuda' }, 'Aparecen en el XML. El RNC es el del negocio (Ajustes → Facturación). Municipio y provincia llevan el código de la DGII (por ejemplo 010000 Distrito Nacional).'),
    ...CAMPOS.map(([k, t]) => h('label', { class: 'etiqueta' }, t, ent[k])),
    admin ? h('button', { class: 'btn primario', onClick: () => guardando(() => nube.guardarEcf({ extra: Object.fromEntries(CAMPOS.map(([k]) => [k, ent[k].value])) }), 'Datos guardados') }, 'Guardar datos') : null);

  // Secuencias E
  const filasSec = SECUENCIAS_E.map((tipo) => {
    const s = ncf.secuencias.find((x) => x.tipo === tipo) || { siguiente: 0, hasta: 0, vence: '' };
    const sig = h('input', { class: 'campo', type: 'number', min: '0', value: s.siguiente || '', placeholder: 'Próximo', inputmode: 'numeric', disabled: !admin, 'aria-label': `${tipo} próximo` });
    const hasta = h('input', { class: 'campo', type: 'number', min: '0', value: s.hasta || '', placeholder: 'Último', inputmode: 'numeric', disabled: !admin, 'aria-label': `${tipo} último` });
    const vence = h('input', { class: 'campo', type: 'date', value: s.vence || '', disabled: !admin || tipo === 'E32' || tipo === 'E34', 'aria-label': `${tipo} vence` });
    return { tipo, sig, hasta, vence, fila: h('div', { class: 'rejilla' }, h('strong', {}, `${tipo} · ${NOMBRE_E[tipo]}`), sig, hasta, vence) };
  });
  const bloqueSec = h('section', { class: 'seccion' },
    h('h2', {}, 'Secuencias autorizadas (e-NCF)'),
    h('p', { class: 'ayuda' }, 'Rangos que la DGII te autorizó para cada tipo electrónico: próximo número, último autorizado y fecha de vencimiento (E32 y E34 no llevan vencimiento).'),
    ...filasSec.map((f) => f.fila),
    admin ? h('button', { class: 'btn primario', onClick: () => guardando(async () => {
      for (const f of filasSec) await nube.guardarNcf(f.tipo, { siguiente: parseInt(f.sig.value, 10) || 0, hasta: parseInt(f.hasta.value, 10) || 0, vence: f.vence.value || '' });
    }, 'Secuencias guardadas') }, 'Guardar secuencias') : null);

  raiz.replaceChildren(msg, err, bloqueCert, bloqueEstado, bloqueEmisor, bloqueSec);
}

const FN = { comprobantes: seccionComprobantes, emitir: seccionEmitir, config: seccionConfig };
