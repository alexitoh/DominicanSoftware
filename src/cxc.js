// cxc.js - Cuentas por Cobrar (CxC), dentro de Contabilidad. Diez secciones:
// Cliente, Descuento y Devolución, Nota de Crédito, Nota de Débito, Recibo, Anticipo CxC, Condición de Pago, Reporte CxC, Reporte Dinámico y Tipo de Cliente.
import { h, hoja, toast, dinero } from './ui.js';
import {
  clientesCxc, estadoCuentaCliente, guardarCreditoCliente, listarTiposCliente, guardarTipoCliente, eliminarTipoCliente,
  listarCondiciones, guardarCondicion, eliminarCondicion, listarConceptosCxc, guardarConceptoCxc, eliminarConceptoCxc, TIPOS_CONCEPTO_CXC,
} from './cxc-db.js';
import { formularioCobro } from './cobros.js';
import { formularioCliente } from './clientes.js';
import { seccionNotas, seccionRecibos, seccionAnticipos, abrirNota, abrirAnticipo } from './cxc-docs.js';
import { seccionReporteCxc, seccionDinamico } from './cxc-reportes.js';
import { campo, numero, texto, tabla, vacio, fechaCorta, limpiar, renglon } from './conta-ui-comun.js';

export const SECCIONES_CXC = [
  ['cliente', 'Cliente'], ['descuento', 'Descuento y Devolución'], ['credito', 'Nota de Crédito'], ['debito', 'Nota de Débito'], ['recibo', 'Recibo'],
  ['anticipo', 'Anticipo CxC'], ['condicion', 'Condición de Pago'], ['reporte', 'Reporte CxC'], ['dinamico', 'Reporte Dinámico'], ['tipo', 'Tipo de Cliente'],
];
let seccion = 'cliente';

export async function vistaCxc(raiz) {
  const cuerpo = h('div');
  const barra = h('div', { class: 'segmento conta-tabs', role: 'tablist', 'aria-label': 'Cuentas por cobrar' });
  async function ir(id) {
    seccion = id;
    barra.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    const nueva = h('div');
    try { await FN[id](nueva, () => ir(id), ir); } catch (e) { nueva.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar: ${e.message || e}`)); }
    if (seccion === id) cuerpo.replaceChildren(nueva);
  }
  barra.append(...SECCIONES_CXC.map(([id, t]) => h('button', { 'data-id': id, role: 'tab', onClick: () => ir(id) }, t)));
  raiz.replaceChildren(barra, cuerpo);
  await ir(seccion);
}

const selectDe = (items, { valor = '', vacioTexto = null, etiqueta = 'Elegir' } = {}) => {
  const s = h('select', { class: 'campo', 'aria-label': etiqueta }, vacioTexto != null ? h('option', { value: '' }, vacioTexto) : null,
    items.map(([v, t]) => h('option', { value: String(v) }, t)));
  s.value = String(valor ?? '');
  if (s.value === '' && vacioTexto == null && items.length) s.value = String(items[0][0]);
  return s;
};

// ---- Cliente ----
async function seccionCliente(raiz, recargar) {
  const todos = await clientesCxc();
  const [tipos, conds] = await Promise.all([listarTiposCliente(), listarCondiciones()]);
  let filtro = 'todos'; let q = '';
  const resumen = h('div', { class: 'totales' });
  const lista = h('div');
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Filtro de clientes' });
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar por nombre o documento', 'aria-label': 'Buscar cliente', onInput: (e) => { q = e.target.value.trim().toLowerCase(); pintar(); } });
  const FILTROS = [['todos', 'Todos'], ['saldo', 'Con saldo'], ['vencido', 'Vencidos'], ['anticipo', 'Con anticipo']];

  function pintar() {
    segmento.replaceChildren(...FILTROS.map(([id, t]) => h('button', { 'aria-pressed': String(filtro === id), onClick: () => { filtro = id; pintar(); } }, t)));
    const vis = todos.filter((c) => (filtro === 'todos' || (filtro === 'saldo' && c.saldo > 0.005) || (filtro === 'vencido' && c.vencido > 0.005) || (filtro === 'anticipo' && c.anticipos > 0.005))
      && (!q || `${c.nombre} ${c.documento || ''}`.toLowerCase().includes(q)));
    resumen.replaceChildren(renglon('Por cobrar', dinero(todos.reduce((s, c) => s + c.saldo, 0)), 'gran'), renglon('Vencido', dinero(todos.reduce((s, c) => s + c.vencido, 0))),
      renglon('Anticipos sin aplicar', dinero(todos.reduce((s, c) => s + c.anticipos, 0))), renglon('Clientes con saldo', String(todos.filter((c) => c.saldo > 0.005).length)));
    lista.replaceChildren(vis.length ? h('div', { class: 'lista' }, vis.map((c) => h('button', { class: 'fila inventario', onClick: () => detalle(c.id) },
      h('span', { class: 'datos' }, h('strong', {}, c.nombre),
        h('small', {}, [c.tipo_cliente, c.condicion_nombre || (c.condicion === 'credito' ? `Crédito ${c.dias_credito ?? 30} días` : c.condicion === 'contado' ? 'Contado' : 'Sin condición'),
          c.limite_credito > 0 ? `límite ${dinero(c.limite_credito)}` : null].filter(Boolean).join(' · ')),
        c.vencido > 0.005 ? h('small', { class: 'deuda' }, `Vencido ${dinero(c.vencido)}`) : null),
      h('span', { class: 'precio' }, dinero(c.saldo), c.anticipos > 0.005 ? h('small', { class: 'bloque' }, `Anticipo ${dinero(c.anticipos)}`) : null)))) : vacio('Ningún cliente coincide.'));
  }

  async function detalle(id) {
    const e = await estadoCuentaCliente(id);
    const c = e.cliente;
    const tipo = selectDe(tipos.filter((t) => t.activo || t.id === c.tipo_cliente_id).map((t) => [t.id, t.nombre]), { valor: c.tipo_cliente_id ?? '', vacioTexto: 'Sin tipo', etiqueta: 'Tipo de cliente' });
    const cond = selectDe(conds.filter((t) => t.activo || t.id === c.condicion_pago_id).map((t) => [t.id, `${t.nombre}${t.dias ? '' : ' (sin crédito)'}`]), { valor: c.condicion_pago_id ?? '', vacioTexto: 'Sin definir (paga de contado)', etiqueta: 'Condición de pago' });
    const limite = numero(c.limite_credito > 0 ? c.limite_credito : '');
    limite.setAttribute('aria-label', 'Límite de crédito');
    tipo.addEventListener('change', () => { const t = tipos.find((x) => String(x.id) === tipo.value); if (t?.limite_credito > 0 && !limite.value) limite.value = String(t.limite_credito); });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrarTodo = () => { cerrar(); };
    const refrescar = async () => { cerrar(); await recargar(); };
    const cerrar = hoja(c.nombre, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, [c.telefono, c.documento && `Documento ${c.documento}`].filter(Boolean).join(' · ') || 'Sin datos de contacto'),
      h('div', { class: 'totales' }, renglon('Debe', dinero(e.saldo), 'gran'), renglon('Anticipos sin aplicar', dinero(e.anticiposDisponibles)),
        c.limite_credito > 0 ? renglon('Crédito disponible', dinero(Math.max(0, c.limite_credito - e.saldo))) : null),
      h('h3', {}, 'Crédito del cliente'),
      campo('Tipo de cliente', tipo), campo('Condición de pago', cond, 'Define los días que tiene para pagar. Sin condición con días, el cliente solo compra de contado.'),
      campo('Límite de crédito', limite, 'Vacío = sin límite. Las ventas a crédito no pueden pasarlo.'), error,
      h('button', { class: 'btn', onClick: async () => {
        error.textContent = '';
        try { await guardarCreditoCliente({ cliente_id: id, tipo_cliente_id: Number(tipo.value) || null, condicion_pago_id: Number(cond.value) || null, limite_credito: limite.value }); toast('Crédito guardado'); await refrescar(); }
        catch (x) { error.textContent = limpiar(x); }
      } }, 'Guardar crédito'),
      h('h3', {}, 'Facturas pendientes'),
      e.facturas.length ? tabla(['Factura', 'Vence', 'Saldo'], e.facturas.map((f) => [f.numero, fechaCorta(f.vence), dinero(f.saldo)]), { num: [2] }) : vacio('No debe nada.'),
      e.movimientos.length ? h('h3', {}, 'Últimos movimientos') : null,
      e.movimientos.length ? tabla(['Fecha', 'Detalle', 'Monto'], e.movimientos.slice(0, 15).map((m) => [fechaCorta(m.fecha), `${m.factura} · ${m.nota || m.metodo}`, dinero(m.monto)]), { num: [2] }) : null,
      h('div', { class: 'acciones' },
        h('button', { class: 'btn primario', onClick: () => { cerrarTodo(); formularioCobro({ clienteId: id, alGuardar: recargar }); } }, 'Nuevo recibo'),
        h('button', { class: 'btn', onClick: () => { cerrarTodo(); abrirNota('credito', { clienteId: id, alGuardar: recargar }); } }, 'Nota de crédito'),
        h('button', { class: 'btn', onClick: () => { cerrarTodo(); abrirNota('debito', { clienteId: id, alGuardar: recargar }); } }, 'Nota de débito'),
        h('button', { class: 'btn', onClick: () => { cerrarTodo(); abrirAnticipo({ clienteId: id, alGuardar: recargar }); } }, 'Anticipo'))));
  }

  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Aquí se maneja todo lo que te deben los clientes: su crédito, cobros, notas y anticipos. Toca un cliente para ver su estado de cuenta.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn', onClick: () => formularioCliente(null, recargar) }, 'Nuevo cliente')),
    buscar, segmento, resumen, lista);
  pintar();
}

// ---- Catálogos: Tipo de Cliente, Condición de Pago, Descuento y Devolución ----
async function seccionTipos(raiz, recargar) {
  const tipos = await listarTiposCliente();
  function formulario(t = null) {
    const nombre = texto(t?.nombre ?? '', 'Ej. Mayorista');
    const desc = numero(t?.descuento || ''); const lim = numero(t?.limite_credito || '');
    const notas = texto(t?.notas ?? '', 'Opcional');
    const activo = h('input', { type: 'checkbox', checked: t ? !!t.activo : true, 'aria-label': 'Activo' });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(t ? 'Editar tipo de cliente' : 'Nuevo tipo de cliente', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), campo('Descuento sugerido (%)', desc, 'Referencia para las notas de crédito de este tipo de cliente.'),
      campo('Límite de crédito sugerido', lim, 'Se propone al asignar este tipo a un cliente sin límite.'), campo('Notas', notas),
      h('label', { class: 'etiqueta' }, h('span', {}, 'Disponible'), activo), error,
      h('div', { class: 'acciones' },
        t ? h('button', { class: 'btn peligro', onClick: async () => { try { await eliminarTipoCliente(t.id); cerrar(); toast('Eliminado'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Eliminar') : null,
        h('button', { class: 'btn primario', onClick: async () => {
          try { await guardarTipoCliente({ id: t?.id ?? null, nombre: nombre.value, descuento: desc.value, limite_credito: lim.value, notas: notas.value, activo: activo.checked ? 1 : 0 }); cerrar(); toast('Guardado'); await recargar(); }
          catch (e) { error.textContent = limpiar(e); }
        } }, 'Guardar'))));
  }
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Clasifica a tus clientes (consumidor final, mayorista, empresa…). Se asigna en la sección Cliente y se usa en los reportes.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nuevo tipo de cliente')),
    tipos.length ? h('div', { class: 'lista' }, tipos.map((t) => h('button', { class: `fila inventario ${t.activo ? '' : 'apagada'}`, onClick: () => formulario(t) },
      h('span', { class: 'datos' }, h('strong', {}, t.nombre), h('small', {}, [t.descuento > 0 ? `${t.descuento}% de descuento` : null, t.limite_credito > 0 ? `límite ${dinero(t.limite_credito)}` : null].filter(Boolean).join(' · ') || 'Sin descuento ni límite')),
      h('span', { class: 'precio' }, `${t.n_clientes} ${t.n_clientes === 1 ? 'cliente' : 'clientes'}`)))) : vacio('Aún no hay tipos de cliente.'));
}

async function seccionCondiciones(raiz, recargar) {
  const conds = await listarCondiciones();
  function formulario(k = null) {
    const nombre = texto(k?.nombre ?? '', 'Ej. 30 días');
    const dias = numero(k?.dias || '', '0'); dias.setAttribute('step', '1');
    const activo = h('input', { type: 'checkbox', checked: k ? !!k.activo : true, 'aria-label': 'Activa' });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(k ? 'Editar condición de pago' : 'Nueva condición de pago', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), campo('Días para pagar', dias, '0 = de contado (sin crédito). Si cambias los días, los clientes con esta condición los toman al instante.'),
      h('label', { class: 'etiqueta' }, h('span', {}, 'Disponible'), activo), error,
      h('div', { class: 'acciones' },
        k ? h('button', { class: 'btn peligro', onClick: async () => { try { await eliminarCondicion(k.id); cerrar(); toast('Eliminada'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Eliminar') : null,
        h('button', { class: 'btn primario', onClick: async () => {
          try { await guardarCondicion({ id: k?.id ?? null, nombre: nombre.value, dias: dias.value === '' ? 0 : Number(dias.value), activo: activo.checked ? 1 : 0 }); cerrar(); toast('Guardada'); await recargar(); }
          catch (e) { error.textContent = limpiar(e); }
        } }, 'Guardar'))));
  }
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Las condiciones de pago fijan cuántos días tiene un cliente para pagar. Se asignan en la sección Cliente; las ventas a crédito toman ese plazo.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nueva condición de pago')),
    conds.length ? h('div', { class: 'lista' }, conds.map((k) => h('button', { class: `fila inventario ${k.activo ? '' : 'apagada'}`, onClick: () => formulario(k) },
      h('span', { class: 'datos' }, h('strong', {}, k.nombre), h('small', {}, k.dias > 0 ? `${k.dias} días para pagar` : 'De contado')),
      h('span', { class: 'precio' }, `${k.n_clientes} ${k.n_clientes === 1 ? 'cliente' : 'clientes'}`)))) : vacio('Aún no hay condiciones de pago.'));
}

async function seccionDescuentos(raiz, recargar) {
  const lista = await listarConceptosCxc();
  function formulario(k = null) {
    const nombre = texto(k?.nombre ?? '', 'Ej. Descuento por volumen');
    const tipo = selectDe(Object.entries(TIPOS_CONCEPTO_CXC), { valor: k?.tipo ?? 'descuento', etiqueta: 'Tipo' });
    const pct = numero(k?.porcentaje || ''); const notas = texto(k?.notas ?? '', 'Opcional');
    const activo = h('input', { type: 'checkbox', checked: k ? !!k.activo : true, 'aria-label': 'Activo' });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(k ? 'Editar motivo' : 'Nuevo motivo', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), campo('Tipo', tipo, 'Descuento y devolución se usan en notas de crédito; cargo, en notas de débito.'),
      campo('Porcentaje sugerido (%)', pct, 'Opcional: la nota propone ese % de lo que debe la factura.'), campo('Notas', notas),
      h('label', { class: 'etiqueta' }, h('span', {}, 'Disponible'), activo), error,
      h('div', { class: 'acciones' },
        k ? h('button', { class: 'btn peligro', onClick: async () => { try { await eliminarConceptoCxc(k.id); cerrar(); toast('Eliminado'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Eliminar') : null,
        h('button', { class: 'btn primario', onClick: async () => {
          try { await guardarConceptoCxc({ id: k?.id ?? null, nombre: nombre.value, tipo: tipo.value, porcentaje: pct.value, notas: notas.value, activo: activo.checked ? 1 : 0 }); cerrar(); toast('Guardado'); await recargar(); }
          catch (e) { error.textContent = limpiar(e); }
        } }, 'Guardar'))));
  }
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Los motivos de descuento, devolución y cargo que se eligen al hacer una nota de crédito o de débito. Una devolución de mercancía NO reingresa el inventario sola: ajústalo en Inventario.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nuevo motivo')),
    lista.length ? h('div', { class: 'lista' }, lista.map((k) => h('button', { class: `fila inventario ${k.activo ? '' : 'apagada'}`, onClick: () => formulario(k) },
      h('span', { class: 'datos' }, h('strong', {}, k.nombre), h('small', {}, [TIPOS_CONCEPTO_CXC[k.tipo], k.porcentaje > 0 ? `${k.porcentaje}%` : null].filter(Boolean).join(' · '))),
      h('span', { class: 'precio' }, `${k.n_docs} ${k.n_docs === 1 ? 'nota' : 'notas'}`)))) : vacio('Aún no hay motivos.'));
}

const FN = {
  cliente: seccionCliente, descuento: seccionDescuentos, credito: (r, rec) => seccionNotas(r, rec, 'credito'), debito: (r, rec) => seccionNotas(r, rec, 'debito'),
  recibo: seccionRecibos, anticipo: seccionAnticipos, condicion: seccionCondiciones, reporte: seccionReporteCxc, dinamico: seccionDinamico, tipo: seccionTipos,
};
