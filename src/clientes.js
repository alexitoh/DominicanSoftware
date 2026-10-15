// clientes.js - lista, detalle y formulario de clientes. El crédito, los cobros y lo que deben viven en Contabilidad → CxC.
import { consultar, ejecutar, leerReglasComprobante, anotar } from './database.js';
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { buscarRNC } from './dgii.js';
import { TIPOS_NCF, NOMBRE_COMPROBANTE, comprobanteDeCliente, REGLAS_COMPROBANTE_BASE } from './itbis.js';
import { TIPOS_DOC, validarDocumento, textoDocumento, formatearDocumento, limpiarDocumento } from './fiscal.js';

const CLIENTES = `
  SELECT c.*,
    (SELECT COUNT(*) FROM ventas v WHERE v.cliente_id = c.id AND v.estado = 'completada') AS compras,
    (SELECT COALESCE(SUM(v.total), 0) FROM ventas v WHERE v.cliente_id = c.id AND v.estado = 'completada') AS total
  FROM clientes c`;

const renglon = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));

// Se exporta para poder crear un cliente al vuelo desde la pantalla de ventas.
// alGuardar recibe el id del cliente guardado.
export function formularioCliente(c = null, alGuardar = () => {}) {
  const nuevo = !c;
  let cerrar = () => {};

  const campo = (etiqueta, input) => h('label', { class: 'etiqueta' }, etiqueta, input);
  const nombre = h('input', { class: 'campo', value: c?.nombre ?? '', autocomplete: 'off' });
  const telefono = h('input', { class: 'campo', type: 'tel', inputmode: 'tel', value: c?.telefono ?? '' });
  const direccion = h('input', { class: 'campo', value: c?.direccion ?? '' });
  const notas = h('textarea', { class: 'campo', rows: '2' }, c?.notas ?? '');
  const tipoDoc = h('select', { class: 'campo', 'aria-label': 'Tipo de documento' },
    ...TIPOS_DOC.map((t) => h('option', { value: t.id }, t.nombre)));
  tipoDoc.value = c?.tipo_doc || 'rnc';
  const documento = h('input', { class: 'campo', inputmode: 'text', autocomplete: 'off', placeholder: 'RNC, cédula o DNI', value: c?.documento ? formatearDocumento(c.tipo_doc, c.documento) : '', 'aria-label': 'Número de documento' });
  // Comprobante que se le da a este cliente: automático (según su RNC y su régimen en la DGII) o uno fijo
  let regimenDgii = c?.regimen_dgii ?? null;
  let reglas = REGLAS_COMPROBANTE_BASE;
  leerReglasComprobante().then((r) => { reglas = r; pintarSugerido(); }).catch(() => {});
  const tipoCpb = h('select', { class: 'campo', 'aria-label': 'Comprobante del cliente', onChange: () => pintarSugerido() },
    h('option', { value: '' }, 'Automático (según su RNC y régimen)'),
    ...Object.entries(TIPOS_NCF).map(([k, t]) => h('option', { value: k }, `${k} · ${t}`)));
  tipoCpb.value = c?.tipo_comprobante || '';
  const textoCpb = h('p', { class: 'ayuda', role: 'status' });
  function pintarSugerido() {
    const r = comprobanteDeCliente({ tipo_comprobante: tipoCpb.value, documento: documento.value, regimen_dgii: regimenDgii, nombre: nombre.value }, reglas);
    textoCpb.textContent = `Se le dará: ${NOMBRE_COMPROBANTE[r.tipo]} (${r.tipo}), ${r.motivo}.${regimenDgii ? ` Régimen en la DGII: ${regimenDgii}.` : ''}`;
  }
  const error = h('p', { class: 'error', role: 'alert' });

  // Consulta a la DGII: con 9 u 11 números llena el nombre solo si el contribuyente está ACTIVO; si no, avisa su estatus
  const estatusDgii = h('p', { class: 'ayuda', role: 'status' });
  let ultimaConsulta = null; // { numero, resultado }
  async function consultarDgii() {
    const num = limpiarDocumento(documento.value);
    if (tipoDoc.value === 'dni' || !/^(\d{9}|\d{11})$/.test(num)) { estatusDgii.textContent = ''; ultimaConsulta = null; return; }
    estatusDgii.className = 'ayuda'; estatusDgii.textContent = 'Consultando la DGII…';
    const r = await buscarRNC(num);
    if (limpiarDocumento(documento.value) !== num) return; // cambió mientras se consultaba
    ultimaConsulta = { numero: num, resultado: r.resultado };
    estatusDgii.textContent = r.mensaje;
    estatusDgii.className = r.resultado === 'activo' ? 'ayuda' : (r.resultado === 'inactivo' || r.resultado === 'noEncontrado') ? 'error' : 'ayuda';
    if (r.resultado === 'activo') {
      regimenDgii = r.datos.regimen || null;
      pintarSugerido();
      tipoDoc.value = num.length === 9 ? 'rnc' : 'cedula';
      if (!nombre.value.trim() || nombre.dataset.dgii === '1') { nombre.value = r.datos.nombre; nombre.dataset.dgii = '1'; }
    }
  }
  documento.addEventListener('change', () => { regimenDgii = null; pintarSugerido(); consultarDgii(); });
  documento.addEventListener('input', () => { if (/^(\d{9}|\d{11})$/.test(limpiarDocumento(documento.value))) consultarDgii(); });
  nombre.addEventListener('input', () => { nombre.dataset.dgii = '0'; });

  async function guardar() {
    error.textContent = '';
    if (ultimaConsulta?.resultado === 'inactivo' && ultimaConsulta.numero === limpiarDocumento(documento.value)) {
      error.textContent = `${estatusDgii.textContent} Corrige el RNC o quítalo para guardar al cliente sin documento.`; documento.focus(); return;
    }
    const n = nombre.value.trim();
    if (!n) { error.textContent = 'Escribe el nombre del cliente.'; nombre.focus(); return; }
    const doc = validarDocumento(tipoDoc.value, documento.value);
    if (doc.error) { error.textContent = doc.error; documento.focus(); return; }
    const valores = [n, telefono.value.trim() || null, direccion.value.trim() || null, notas.value.trim() || null, doc.tipo, doc.numero, tipoCpb.value || null, regimenDgii];
    try {
      if (doc.numero) {
        const [otro] = await consultar('SELECT nombre FROM clientes WHERE documento = ? AND id <> ?', [doc.numero, c?.id ?? -1]);
        if (otro) { error.textContent = `Ese documento ya pertenece a "${otro.nombre}".`; documento.focus(); return; }
      }
      let id = c?.id;
      if (nuevo) {
        const r = await ejecutar('INSERT INTO clientes (nombre, telefono, direccion, notas, tipo_doc, documento, tipo_comprobante, regimen_dgii) VALUES (?,?,?,?,?,?,?,?)', valores);
        id = r?.changes?.lastId;
        if (!id) id = (await consultar('SELECT last_insert_rowid() AS id'))[0].id;
      } else {
        await ejecutar('UPDATE clientes SET nombre=?, telefono=?, direccion=?, notas=?, tipo_doc=?, documento=?, tipo_comprobante=?, regimen_dgii=? WHERE id=?', [...valores, id]);
      }
      await anotar(nuevo ? 'Cliente creado' : 'Cliente modificado', nombre.value.trim());
      cerrar();
      toast(nuevo ? 'Cliente guardado' : 'Cambios guardados');
      await alGuardar(id);
    } catch (e) {
      error.textContent = `No se pudo guardar: ${e.message || e}`;
    }
  }

  async function quitar() {
    const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM ventas WHERE cliente_id = ?', [c.id]);
    if (n > 0) {
      error.textContent = `No se puede quitar: tiene ${n} ${n === 1 ? 'venta registrada' : 'ventas registradas'}.`;
      return;
    }
    const ok = await confirmar('Quitar cliente', `Se eliminará a "${c.nombre}".`, 'Quitar cliente');
    if (!ok) return;
    await ejecutar('DELETE FROM cliente_direcciones WHERE cliente_id = ?', [c.id]);
    await ejecutar('DELETE FROM cliente_contactos WHERE cliente_id = ?', [c.id]);
    await ejecutar('DELETE FROM clientes WHERE id = ?', [c.id]);
    await anotar('Cliente quitado', c.nombre);
    cerrar();
    toast('Cliente quitado');
    await alGuardar(null);
  }

  pintarSugerido();
  cerrar = hoja(nuevo ? 'Nuevo cliente' : 'Editar cliente',
    h('div', { class: 'cuerpo' },
      campo('Nombre', nombre),
      campo('Teléfono', telefono),
      h('div', { class: 'etiqueta' }, 'Identificación fiscal', h('div', { class: 'par' }, tipoDoc, documento)),
      estatusDgii,
      h('button', { class: 'btn chico', onClick: consultarDgii }, 'Verificar en la DGII'),
      campo('Comprobante que se le da', tipoCpb),
      textoCpb,
      campo('Dirección principal', direccion),
      campo('Notas', notas),
      h('p', { class: 'ayuda' }, 'El crédito (condición de pago, días, límite y tipo de cliente) se configura en Contabilidad → CxC → Cliente.'),
      error,
      h('div', { class: 'acciones' },
        nuevo ? null : h('button', { class: 'btn peligro', onClick: quitar }, 'Quitar cliente'),
        h('button', { class: 'btn primario', onClick: guardar }, 'Guardar cliente'))));
}

const METODOS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque', credito: 'Crédito' };

// Formulario genérico para una dirección o un contacto: campos [clave, etiqueta, requerido, atributos]
function formularioHijo({ titulo, tabla, clienteId, fila, campos, alGuardar }) {
  const entradas = campos.map(([k, et, req, attr]) => ({ k, req, et, input: h('input', { class: 'campo', value: fila?.[k] ?? '', autocomplete: 'off', ...(attr || {}) }) }));
  const error = h('p', { class: 'error', role: 'alert' });
  let cerrar = () => {};
  async function guardar() {
    error.textContent = '';
    const v = Object.fromEntries(entradas.map((e) => [e.k, e.input.value.trim() || null]));
    const falta = entradas.find((e) => e.req && !v[e.k]);
    if (falta) { error.textContent = `Escribe: ${falta.et}.`; falta.input.focus(); return; }
    try {
      if (fila) await ejecutar(`UPDATE ${tabla} SET ${entradas.map((e) => `${e.k}=?`).join(', ')} WHERE id=?`, [...entradas.map((e) => v[e.k]), fila.id]);
      else await ejecutar(`INSERT INTO ${tabla} (cliente_id, ${entradas.map((e) => e.k).join(', ')}) VALUES (?, ${entradas.map(() => '?').join(', ')})`, [clienteId, ...entradas.map((e) => v[e.k])]);
      cerrar();
      await alGuardar();
    } catch (e) { error.textContent = `No se pudo guardar: ${e.message || e}`; }
  }
  async function quitar() {
    const ok = await confirmar('Quitar', '¿Quitar este registro del cliente?', 'Quitar');
    if (!ok) return;
    await ejecutar(`DELETE FROM ${tabla} WHERE id = ?`, [fila.id]);
    cerrar();
    await alGuardar();
  }
  cerrar = hoja(titulo, h('div', { class: 'cuerpo' },
    ...entradas.map((e) => h('label', { class: 'etiqueta' }, e.et, e.input)),
    error,
    h('div', { class: 'acciones' },
      fila ? h('button', { class: 'btn peligro', onClick: quitar }, 'Quitar') : null,
      h('button', { class: 'btn primario', onClick: guardar }, 'Guardar'))));
}

function formularioDireccion(clienteId, fila, alGuardar) {
  formularioHijo({
    titulo: fila ? 'Editar dirección' : 'Nueva dirección de entrega', tabla: 'cliente_direcciones', clienteId, fila, alGuardar,
    campos: [['etiqueta', 'Nombre (Casa, Oficina, Almacén…)', false], ['direccion', 'Dirección', true], ['referencia', 'Referencia o indicaciones', false]],
  });
}

function formularioContacto(clienteId, fila, alGuardar) {
  formularioHijo({
    titulo: fila ? 'Editar contacto' : 'Nuevo contacto', tabla: 'cliente_contactos', clienteId, fila, alGuardar,
    campos: [['nombre', 'Nombre', true], ['cargo', 'Cargo o relación', false], ['telefono', 'Teléfono', false, { type: 'tel', inputmode: 'tel' }], ['correo', 'Correo', false, { type: 'email', inputmode: 'email' }]],
  });
}

export async function vistaClientes(raiz) {
  const estado = { texto: '' };
  const resumen = h('dl', { class: 'resumen' });
  const lista = h('div', { class: 'lista' });

  const buscador = h('input', {
    class: 'campo', type: 'search', placeholder: 'Buscar por nombre, teléfono o documento',
    'aria-label': 'Buscar cliente',
    onInput: (e) => { estado.texto = e.target.value; pintar(); },
  });

  async function pintar() {
    const [{ n: totalClientes }] = await consultar('SELECT COUNT(*) AS n FROM clientes');
    const dato = (et, val) => h('div', {}, h('dt', {}, et), h('dd', {}, val));
    resumen.replaceChildren(dato('Clientes', String(totalClientes)));

    const like = `%${estado.texto.trim()}%`;
    const soloDoc = limpiarDocumento(estado.texto);
    let filas = await consultar(`${CLIENTES} WHERE c.nombre LIKE ? OR c.telefono LIKE ? OR c.documento LIKE ? ORDER BY c.nombre`, [like, like, soloDoc ? `%${soloDoc}%` : '\u0000']);

    lista.replaceChildren(...(filas.length
      ? filas.map((c) => h('button', { class: 'fila inventario', onClick: () => detalleCliente(c.id) },
          h('span', { class: 'datos' },
            h('strong', {}, c.nombre),
            h('small', {}, [c.telefono || 'Sin teléfono', c.documento ? textoDocumento(c.tipo_doc, c.documento) : null].filter(Boolean).join(' · '))),
          h('span', { class: 'precio' }, dinero(c.total),
            h('small', { class: 'bloque' }, `${c.compras} ${c.compras === 1 ? 'compra' : 'compras'}`))))
      : [h('p', { class: 'vacio' }, estado.texto.trim()
            ? 'Ningún cliente coincide con la búsqueda.'
            : 'Aún no hay clientes. Toca "Nuevo cliente" para registrar el primero.')]));
  }

  async function detalleCliente(id) {
    const [c] = await consultar(`${CLIENTES} WHERE c.id = ?`, [id]);
    if (!c) return;
    const direcciones = await consultar('SELECT * FROM cliente_direcciones WHERE cliente_id = ? ORDER BY id', [id]);
    const contactos = await consultar('SELECT * FROM cliente_contactos WHERE cliente_id = ? ORDER BY id', [id]);
    const historial = await consultar(
      `SELECT v.id, v.numero, v.fecha, v.total, v.metodo_pago, v.estado FROM ventas v WHERE v.cliente_id = ? ORDER BY v.id DESC LIMIT 100`, [id]);
    let cerrar = () => {};
    const recargar = async () => { cerrar(); await detalleCliente(id); };

    cerrar = hoja(c.nombre,
      h('div', { class: 'cuerpo' },
        h('p', { class: 'ayuda' }, [c.telefono, c.direccion].filter(Boolean).join(', ') || 'Sin datos de contacto'),
        c.documento ? h('p', { class: 'ayuda' }, `Identificación: ${textoDocumento(c.tipo_doc, c.documento)}`) : null,
        h('div', { class: 'totales' },
          renglon('Compras', String(c.compras)),
          renglon('Total comprado', dinero(c.total))),
        seccionDirecciones(direcciones),
        seccionContactos(contactos),
        h('h3', {}, 'Historial de compras'),
        historial.length
          ? h('div', { class: 'carrito' }, historial.map((v) => h('div', { class: 'linea' },
              h('div', { class: 'linea-cab' }, h('strong', {}, v.numero), h('span', {}, dinero(v.total))),
              h('div', { class: 'linea-pie' }, h('small', { class: v.estado === 'anulada' ? 'deuda' : 'ayuda' },
                `${v.fecha.slice(0, 10)} · ${METODOS[v.metodo_pago] || v.metodo_pago}${v.estado === 'anulada' ? ' · anulada' : ''}`)))))
          : h('p', { class: 'ayuda' }, 'Todavía no tiene compras.'),
        h('div', { class: 'acciones' },
          h('button', { class: 'btn', onClick: () => { cerrar(); formularioCliente(c, pintar); } }, 'Editar cliente'),
          )));

    function seccionDirecciones(lista) {
      return h('div', {},
        h('h3', {}, 'Direcciones de entrega'),
        lista.length ? lista.map((d) => h('div', { class: 'fila-simple' },
          h('span', { class: 'datos' }, h('strong', {}, d.etiqueta || 'Dirección'), h('small', {}, [d.direccion, d.referencia].filter(Boolean).join(' · '))),
          h('button', { class: 'btn chico', onClick: () => formularioDireccion(id, d, recargar) }, 'Editar')))
          : h('p', { class: 'ayuda' }, c.direccion ? 'Solo tiene la dirección principal.' : 'No tiene direcciones guardadas.'),
        h('button', { class: 'btn chico', onClick: () => formularioDireccion(id, null, recargar) }, 'Agregar dirección'));
    }

    function seccionContactos(lista) {
      return h('div', {},
        h('h3', {}, 'Contactos'),
        lista.length ? lista.map((k) => h('div', { class: 'fila-simple' },
          h('span', { class: 'datos' }, h('strong', {}, k.nombre), h('small', {}, [k.cargo, k.telefono, k.correo].filter(Boolean).join(' · ') || 'Sin datos')),
          h('button', { class: 'btn chico', onClick: () => formularioContacto(id, k, recargar) }, 'Editar')))
          : h('p', { class: 'ayuda' }, 'No tiene contactos asociados.'),
        h('button', { class: 'btn chico', onClick: () => formularioContacto(id, null, recargar) }, 'Agregar contacto'));
    }
  }

  raiz.replaceChildren(
    h('header', { class: 'barra' },
      h('h1', {}, 'Clientes'),
      h('button', { class: 'btn claro', onClick: () => formularioCliente(null, pintar) }, 'Nuevo cliente')),
    resumen,
    h('div', { class: 'filtros' }, buscador),
    lista);
  await pintar();
}
