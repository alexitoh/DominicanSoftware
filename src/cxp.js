// cxp.js - Cuentas por Pagar (CxP), dentro de Contabilidad. Doce secciones:
// Factura Suplidor, Nota de Crédito, Nota de Débito, Orden de Compras, Suplidor, Anticipo CxP, Pago de Contado, Reporte CxP, Reporte Dinámico,
// Requisición Cotización, Solicitud Compras y Tipo de Suplidor.
import { h, hoja, toast, dinero } from './ui.js';
import { proveedoresCxp, estadoCuentaProveedor, listarTiposProveedor, guardarTipoProveedor, eliminarTipoProveedor, guardarTipoDeProveedor } from './cxp-db.js';
import { formularioProveedor } from './proveedores.js';
import { formularioCompra } from './compras.js';
import { seccionFacturas, seccionNotasProv, seccionAnticiposProv, seccionContado, abrirNotaProv, abrirAnticipoProv, formularioPagoProveedor, selectDe } from './cxp-docs.js';
import { seccionSolicitudes, seccionRequisiciones, seccionOrdenes } from './cxp-compras.js';
import { seccionReporteCxp, seccionDinamicoCxp } from './cxp-reportes.js';
import { campo, texto, tabla, vacio, fechaCorta, limpiar, renglon } from './conta-ui-comun.js';

export const SECCIONES_CXP = [
  ['factura', 'Factura Suplidor'], ['credito', 'Nota de Crédito'], ['debito', 'Nota de Débito'], ['orden', 'Orden de Compras'], ['suplidor', 'Suplidor'], ['anticipo', 'Anticipo CxP'],
  ['contado', 'Pago de Contado'], ['reporte', 'Reporte CxP'], ['dinamico', 'Reporte Dinámico'], ['requisicion', 'Requisición Cotización'], ['solicitud', 'Solicitud Compras'], ['tipo', 'Tipo de Suplidor'],
];
let seccion = 'factura';

export async function vistaCxp(raiz) {
  const cuerpo = h('div');
  const barra = h('div', { class: 'segmento conta-tabs', role: 'tablist', 'aria-label': 'Cuentas por pagar' });
  async function ir(id) {
    seccion = id;
    barra.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    const nueva = h('div');
    try { await FN[id](nueva, () => ir(id), ir); } catch (e) { nueva.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar: ${e.message || e}`)); }
    if (seccion === id) cuerpo.replaceChildren(nueva);
  }
  barra.append(...SECCIONES_CXP.map(([id, t]) => h('button', { 'data-id': id, role: 'tab', onClick: () => ir(id) }, t)));
  raiz.replaceChildren(barra, cuerpo);
  await ir(seccion);
}

// ---- Suplidor ----
async function seccionSuplidor(raiz, recargar) {
  const todos = await proveedoresCxp();
  const tipos = await listarTiposProveedor();
  let filtro = 'todos'; let q = '';
  const resumen = h('div', { class: 'totales' }); const lista = h('div');
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Filtro de suplidores' });
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar por nombre o documento', 'aria-label': 'Buscar suplidor', onInput: (e) => { q = e.target.value.trim().toLowerCase(); pintar(); } });
  const FILTROS = [['todos', 'Todos'], ['saldo', 'Con saldo'], ['vencido', 'Vencidos'], ['anticipo', 'Con anticipo']];
  function pintar() {
    segmento.replaceChildren(...FILTROS.map(([id, t]) => h('button', { 'aria-pressed': String(filtro === id), onClick: () => { filtro = id; pintar(); } }, t)));
    const vis = todos.filter((p) => (filtro === 'todos' || (filtro === 'saldo' && p.saldo > 0.005) || (filtro === 'vencido' && p.vencido > 0.005) || (filtro === 'anticipo' && p.anticipos > 0.005))
      && (!q || `${p.nombre} ${p.documento || ''}`.toLowerCase().includes(q)));
    resumen.replaceChildren(renglon('Por pagar', dinero(todos.reduce((s, p) => s + p.saldo, 0)), 'gran'), renglon('Vencido', dinero(todos.reduce((s, p) => s + p.vencido, 0))),
      renglon('Anticipos sin aplicar', dinero(todos.reduce((s, p) => s + p.anticipos, 0))), renglon('Suplidores con saldo', String(todos.filter((p) => p.saldo > 0.005).length)));
    lista.replaceChildren(vis.length ? h('div', { class: 'lista' }, vis.map((p) => h('button', { class: 'fila inventario', onClick: () => detalle(p.id) },
      h('span', { class: 'datos' }, h('strong', {}, p.nombre),
        h('small', {}, [p.tipo_proveedor, p.condicion === 'credito' ? `Crédito ${p.dias_credito ?? 30} días` : p.condicion === 'contado' ? 'Contado' : null, p.telefono].filter(Boolean).join(' · ') || 'Sin datos'),
        p.vencido > 0.005 ? h('small', { class: 'deuda' }, `Vencido ${dinero(p.vencido)}`) : null),
      h('span', { class: 'precio' }, dinero(p.saldo), p.anticipos > 0.005 ? h('small', { class: 'bloque' }, `Anticipo ${dinero(p.anticipos)}`) : null)))) : vacio('Ningún suplidor coincide.'));
  }
  async function detalle(id) {
    const e = await estadoCuentaProveedor(id);
    const p = e.proveedor;
    const tipo = selectDe(tipos.filter((t) => t.activo || t.id === p.tipo_proveedor_id).map((t) => [t.id, t.nombre]), { valor: p.tipo_proveedor_id ?? '', vacioTexto: 'Sin tipo', etiqueta: 'Tipo de suplidor' });
    const error = h('p', { class: 'error', role: 'alert' });
    const refrescar = async () => { cerrar(); await recargar(); };
    const cerrar = hoja(p.nombre, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, [p.telefono, p.documento && `Documento ${p.documento}`, p.condicion === 'credito' ? `Crédito ${p.dias_credito ?? 30} días` : p.condicion === 'contado' ? 'Contado' : null].filter(Boolean).join(' · ') || 'Sin datos de contacto'),
      h('div', { class: 'totales' }, renglon('Se le debe', dinero(e.saldo), 'gran'), renglon('Anticipos sin aplicar', dinero(e.anticiposDisponibles))),
      campo('Tipo de suplidor', tipo), error,
      h('button', { class: 'btn', onClick: async () => { error.textContent = ''; try { await guardarTipoDeProveedor(id, Number(tipo.value) || null); toast('Tipo guardado'); await refrescar(); } catch (x) { error.textContent = limpiar(x); } } }, 'Guardar tipo'),
      h('h3', {}, 'Facturas pendientes'),
      e.facturas.length ? tabla(['Factura', 'Vence', 'Saldo'], e.facturas.map((f) => [f.numero, fechaCorta(f.vence), dinero(f.saldo)]), { num: [2] }) : vacio('No se le debe nada.'),
      e.movimientos.length ? h('h3', {}, 'Últimos movimientos') : null,
      e.movimientos.length ? tabla(['Fecha', 'Detalle', 'Monto'], e.movimientos.slice(0, 15).map((m) => [fechaCorta(m.fecha), `${m.factura} · ${m.nota || m.metodo}`, dinero(m.monto)]), { num: [2] }) : null,
      h('div', { class: 'acciones' },
        e.saldo > 0.005 ? h('button', { class: 'btn primario', onClick: () => { cerrar(); formularioPagoProveedor({ proveedorId: id, nombre: p.nombre, deuda: e.saldo, alGuardar: recargar }); } }, 'Pagar') : null,
        h('button', { class: 'btn', onClick: () => { cerrar(); formularioCompra(recargar, { proveedorId: id }); } }, 'Nueva factura'),
        h('button', { class: 'btn', onClick: () => { cerrar(); abrirNotaProv('credito', { proveedorId: id, alGuardar: recargar }); } }, 'Nota de crédito'),
        h('button', { class: 'btn', onClick: () => { cerrar(); abrirNotaProv('debito', { proveedorId: id, alGuardar: recargar }); } }, 'Nota de débito'),
        h('button', { class: 'btn', onClick: () => { cerrar(); abrirAnticipoProv({ proveedorId: id, alGuardar: recargar }); } }, 'Anticipo'),
        h('button', { class: 'btn', onClick: () => { cerrar(); formularioProveedor(p, recargar); } }, 'Editar suplidor'))));
  }
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Aquí se maneja todo lo que le debes a tus suplidores: facturas, pagos, notas y anticipos. Toca uno para ver su estado de cuenta.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn', onClick: () => formularioProveedor(null, recargar) }, 'Nuevo suplidor')),
    buscar, segmento, resumen, lista);
  pintar();
}

// ---- Tipo de Suplidor ----
async function seccionTipos(raiz, recargar) {
  const tipos = await listarTiposProveedor();
  function formulario(t = null) {
    const nombre = texto(t?.nombre ?? '', 'Ej. Importador'); const notas = texto(t?.notas ?? '', 'Opcional');
    const activo = h('input', { type: 'checkbox', checked: t ? !!t.activo : true, 'aria-label': 'Activo' });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(t ? 'Editar tipo de suplidor' : 'Nuevo tipo de suplidor', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), campo('Notas', notas), h('label', { class: 'etiqueta' }, h('span', {}, 'Disponible'), activo), error,
      h('div', { class: 'acciones' },
        t ? h('button', { class: 'btn peligro', onClick: async () => { try { await eliminarTipoProveedor(t.id); cerrar(); toast('Eliminado'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Eliminar') : null,
        h('button', { class: 'btn primario', onClick: async () => {
          try { await guardarTipoProveedor({ id: t?.id ?? null, nombre: nombre.value, notas: notas.value, activo: activo.checked ? 1 : 0 }); cerrar(); toast('Guardado'); await recargar(); }
          catch (e) { error.textContent = limpiar(e); }
        } }, 'Guardar'))));
  }
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Clasifica a tus suplidores (distribuidor, fabricante, servicios…). Se asigna en la sección Suplidor y se usa para filtrar el Reporte CxP y el Reporte Dinámico.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nuevo tipo de suplidor')),
    tipos.length ? h('div', { class: 'lista' }, tipos.map((t) => h('button', { class: `fila inventario ${t.activo ? '' : 'apagada'}`, onClick: () => formulario(t) },
      h('span', { class: 'datos' }, h('strong', {}, t.nombre), h('small', {}, t.notas || 'Sin notas')),
      h('span', { class: 'precio' }, `${t.n_proveedores} ${t.n_proveedores === 1 ? 'suplidor' : 'suplidores'}`)))) : vacio('Aún no hay tipos de suplidor.'));
}

const FN = {
  factura: seccionFacturas, credito: (r, rec) => seccionNotasProv(r, rec, 'credito'), debito: (r, rec) => seccionNotasProv(r, rec, 'debito'), orden: seccionOrdenes,
  suplidor: seccionSuplidor, anticipo: seccionAnticiposProv, contado: seccionContado, reporte: seccionReporteCxp, dinamico: seccionDinamicoCxp,
  requisicion: seccionRequisiciones, solicitud: seccionSolicitudes, tipo: seccionTipos,
};
