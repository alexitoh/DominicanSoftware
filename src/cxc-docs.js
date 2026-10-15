// cxc-docs.js - CxC: notas de crédito, notas de débito, recibos y anticipos
import { h, hoja, toast, dinero } from './ui.js';
import {
  clientesCxc, listarNotas, crearNota, anularNota, facturasCredito, listarConceptosCxc, listarRecibos, listarAnticipos, crearAnticipo, aplicarAnticipo,
  aplicacionesAnticipo, quitarAplicacion, anularAnticipo, METODOS_PAGO_CXC,
} from './cxc-db.js';
import { consultar } from './database.js';
import { formularioCobro, detalleRecibo } from './cobros.js';
import { fechaHoy } from './conta-db.js';
import { campo, numero, fechaInput, texto, tabla, vacio, fechaCorta, limpiar, renglon } from './conta-ui-comun.js';

const selectDe = (items, { valor = '', vacioTexto = null, etiqueta = 'Elegir' } = {}) => {
  const s = h('select', { class: 'campo', 'aria-label': etiqueta }, vacioTexto != null ? h('option', { value: '' }, vacioTexto) : null, items.map(([v, t]) => h('option', { value: String(v) }, t)));
  s.value = String(valor ?? '');
  if (s.value === '' && vacioTexto == null && items.length) s.value = String(items[0][0]);
  return s;
};
const TITULO = { credito: 'Nota de crédito', debito: 'Nota de débito' };

// ---------- Notas de crédito y de débito ----------
export async function abrirNota(tipo, { clienteId = null, alGuardar = () => {} } = {}) {
  const clientes = await clientesCxc();
  const conceptos = (await listarConceptosCxc()).filter((k) => k.activo && (tipo === 'debito' ? k.tipo === 'cargo' : k.tipo !== 'cargo'));
  // Débitos: cualquier cliente con facturas a crédito. Se buscan al elegir el cliente.
  const conFacturas = [];
  for (const c of clientes) if ((await facturasCredito(c.id, { soloConSaldo: tipo === 'credito' })).length) conFacturas.push(c);
  if (!conFacturas.length) { toast(tipo === 'credito' ? 'No hay facturas a crédito con saldo' : 'No hay facturas a crédito'); return; }
  const cliente = selectDe(conFacturas.map((c) => [c.id, c.nombre]), { valor: clienteId ?? conFacturas[0].id, etiqueta: 'Cliente' });
  if (clienteId) cliente.disabled = true;
  const factura = selectDe([], { etiqueta: 'Factura' });
  let facturas = [];
  const concepto = selectDe(conceptos.map((k) => [k.id, k.nombre]), { vacioTexto: 'Sin motivo', etiqueta: 'Motivo' });
  const monto = numero(); const itbis = numero(); const ncf = texto('', tipo === 'credito' ? 'Ej. B0400000001 (opcional)' : 'Ej. B0300000001 (opcional)');
  const fecha = fechaInput(fechaHoy()); const notas = texto('', 'Opcional');
  const info = h('p', { class: 'ayuda' });
  const error = h('p', { class: 'error', role: 'alert' });

  async function cargarFacturas() {
    facturas = await facturasCredito(Number(cliente.value), { soloConSaldo: tipo === 'credito' });
    factura.replaceChildren(...facturas.map((f) => h('option', { value: String(f.id) }, `${f.numero} · debe ${dinero(f.saldo)}`)));
    if (facturas.length) factura.value = String(facturas[0].id);
    sugerir();
  }
  function sugerir() {
    const f = facturas.find((x) => String(x.id) === factura.value);
    info.textContent = f ? `Total de la factura ${dinero(f.total)}. Hoy debe ${dinero(f.saldo)}.` : '';
    const k = conceptos.find((x) => String(x.id) === concepto.value);
    if (f && k?.porcentaje > 0 && !monto.value) monto.value = String(Math.round(f.saldo * k.porcentaje) / 100);
  }
  cliente.addEventListener('change', cargarFacturas); factura.addEventListener('change', sugerir); concepto.addEventListener('change', () => { monto.value = ''; sugerir(); });
  await cargarFacturas();

  const cerrar = hoja(`Nueva ${TITULO[tipo].toLowerCase()}`, h('div', { class: 'cuerpo' },
    h('p', { class: 'ayuda' }, tipo === 'credito' ? 'Baja lo que debe el cliente en una factura (descuento o devolución).' : 'Sube lo que debe el cliente en una factura (intereses, cargos).'),
    campo('Cliente', cliente), campo('Factura', factura), info, campo('Motivo', concepto),
    h('div', { class: 'rejilla' }, campo('Monto (con ITBIS)', monto), campo('ITBIS incluido', itbis)),
    h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('NCF', ncf, tipo === 'credito' ? 'Comprobante B04.' : 'Comprobante B03.')),
    campo('Notas', notas), error,
    h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
      error.textContent = '';
      try {
        const r = await crearNota({ tipo, cliente_id: Number(cliente.value), venta_id: Number(factura.value), concepto_id: Number(concepto.value) || null, monto: monto.value, itbis: itbis.value, ncf: ncf.value, fecha: fecha.value, notas: notas.value });
        cerrar(); toast(`${TITULO[tipo]} ${r.numero} guardada`); await alGuardar();
      } catch (e) { error.textContent = limpiar(e); }
    } }, 'Guardar nota'))));
}

export async function seccionNotas(raiz, recargar, tipo) {
  const hoy = fechaHoy();
  const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`); const hasta = fechaInput(hoy);
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar por cliente, número o factura', 'aria-label': 'Buscar nota' });
  const resumen = h('div', { class: 'totales' }); const lista = h('div');
  let todas = [];
  async function cargar() { todas = await listarNotas({ tipo, desde: desde.value || '0000-00-00', hasta: hasta.value || hoy }); pintar(); }
  function pintar() {
    const q = buscar.value.trim().toLowerCase();
    const vis = todas.filter((n) => !q || `${n.cliente} ${n.numero} ${n.factura || ''} ${n.ncf || ''}`.toLowerCase().includes(q));
    const vig = vis.filter((n) => n.estado === 'vigente');
    resumen.replaceChildren(renglon(`Total ${tipo === 'credito' ? 'acreditado' : 'cargado'}`, dinero(vig.reduce((s, n) => s + n.monto, 0)), 'gran'), renglon('Notas vigentes', String(vig.length)));
    lista.replaceChildren(vis.length ? h('div', { class: 'lista' }, vis.map((n) => h('button', { class: `fila inventario ${n.estado === 'anulado' ? 'apagada' : ''}`, onClick: () => detalle(n) },
      h('span', { class: 'datos' }, h('strong', {}, `${n.numero} · ${n.cliente}`),
        h('small', {}, [fechaCorta(n.fecha), n.factura && `Factura ${n.factura}`, n.concepto, n.ncf, n.estado === 'anulado' ? 'anulada' : null].filter(Boolean).join(' · '))),
      h('span', { class: 'precio' }, dinero(n.monto))))) : vacio(`No hay ${TITULO[tipo].toLowerCase()}s en ese período.`));
  }
  function detalle(n) {
    const motivo = texto('', 'Motivo de la anulación'); const error = h('p', { class: 'error', role: 'alert' });
    const puede = n.estado === 'vigente';
    const cerrar = hoja(`${TITULO[tipo]} ${n.numero}`, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' }, renglon('Monto', dinero(n.monto), 'gran'), renglon('ITBIS incluido', dinero(n.itbis)), renglon('Sin ITBIS', dinero(n.monto - n.itbis))),
      h('p', { class: 'ayuda' }, [fechaCorta(n.fecha), n.cliente, n.factura && `Factura ${n.factura}`, n.concepto, n.ncf && `NCF ${n.ncf}`, n.notas].filter(Boolean).join(' · ')),
      n.estado === 'anulado' ? h('p', { class: 'error' }, `Anulada: ${n.anulado_motivo || ''}`) : null,
      puede ? campo('Anular esta nota', motivo, 'No se borra: la factura vuelve a deber lo que debía.') : null, error,
      puede ? h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: async () => {
        try { await anularNota(n.id, motivo.value); cerrar(); toast('Nota anulada'); await recargar(); } catch (e) { error.textContent = limpiar(e); }
      } }, 'Anular nota')) : null));
  }
  desde.addEventListener('change', cargar); hasta.addEventListener('change', cargar); buscar.addEventListener('input', pintar);
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, tipo === 'credito'
      ? 'Una nota de crédito baja lo que debe el cliente: por un descuento, una devolución o un error. Se contabiliza sola contra Descuentos y devoluciones en ventas. Aún no sale en el reporte 607 de la DGII.'
      : 'Una nota de débito sube lo que debe el cliente: intereses por mora, gastos de cobranza, cheque devuelto. Se contabiliza sola como Cargos y recargos a clientes. Aún no sale en el reporte 607 de la DGII.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => abrirNota(tipo, { alGuardar: recargar }) }, `Nueva ${TITULO[tipo].toLowerCase()}`)),
    h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), buscar, resumen, lista);
  await cargar();
}

// ---------- Recibos ----------
export async function seccionRecibos(raiz, recargar) {
  const hoy = fechaHoy();
  const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`); const hasta = fechaInput(hoy);
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar por cliente o número', 'aria-label': 'Buscar recibo' });
  const resumen = h('div', { class: 'totales' }); const lista = h('div');
  let todos = [];
  async function cargar() { todos = await listarRecibos({ desde: desde.value || '0000-00-00', hasta: hasta.value || hoy }); pintar(); }
  function pintar() {
    const q = buscar.value.trim().toLowerCase();
    const vis = todos.filter((r) => !q || `${r.cliente} ${r.numero}`.toLowerCase().includes(q));
    const vig = vis.filter((r) => r.estado === 'vigente');
    resumen.replaceChildren(renglon('Cobrado en el período', dinero(vig.reduce((s, r) => s + r.total, 0)), 'gran'), renglon('Recibos vigentes', String(vig.length)));
    lista.replaceChildren(vis.length ? h('div', { class: 'lista' }, vis.map((r) => h('button', { class: `fila inventario ${r.estado === 'anulado' ? 'apagada' : ''}`, onClick: () => detalleRecibo(r.id, { alCambiar: recargar }) },
      h('span', { class: 'datos' }, h('strong', {}, `${r.numero} · ${r.cliente}`), h('small', {}, `${fechaCorta(r.fecha)}${r.estado === 'anulado' ? ' · anulado' : ''}`)),
      h('span', { class: 'precio' }, dinero(r.total))))) : vacio('No hay recibos en ese período.'));
  }
  desde.addEventListener('change', cargar); hasta.addEventListener('change', cargar); buscar.addEventListener('input', pintar);
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Un recibo de ingreso es un cobro a un cliente: puede pagar una o varias facturas con uno o varios métodos de pago.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formularioCobro({ alGuardar: recargar }) }, 'Nuevo recibo')),
    h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), buscar, resumen, lista);
  await cargar();
}

// ---------- Anticipos ----------
export async function abrirAnticipo({ clienteId = null, alGuardar = () => {} } = {}) {
  const clientes = await consultar('SELECT id, nombre FROM clientes ORDER BY nombre COLLATE NOCASE');
  if (!clientes.length) { toast('Primero crea un cliente'); return; }
  const cliente = selectDe(clientes.map((c) => [c.id, c.nombre]), { valor: clienteId ?? clientes[0].id, etiqueta: 'Cliente' });
  if (clienteId) cliente.disabled = true;
  const monto = numero(); const fecha = fechaInput(fechaHoy());
  const metodo = selectDe(Object.entries(METODOS_PAGO_CXC), { valor: 'efectivo', etiqueta: 'Método' });
  const ref = texto('', 'N.º de cheque o referencia'); const notas = texto('', 'Opcional');
  const error = h('p', { class: 'error', role: 'alert' });
  const cerrar = hoja('Nuevo anticipo', h('div', { class: 'cuerpo' },
    h('p', { class: 'ayuda' }, 'Dinero que el cliente entrega por adelantado. Queda como un saldo a su favor que luego aplicas a sus facturas. Se contabiliza como Anticipos de clientes (pasivo), no como venta.'),
    campo('Cliente', cliente), h('div', { class: 'rejilla' }, campo('Monto', monto), campo('Fecha', fecha)), campo('Método de pago', metodo), campo('Referencia', ref), campo('Notas', notas), error,
    h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
      error.textContent = '';
      try { const r = await crearAnticipo({ cliente_id: Number(cliente.value), monto: monto.value, metodo: metodo.value, referencia: ref.value, fecha: fecha.value, notas: notas.value }); cerrar(); toast(`Anticipo ${r.numero} guardado`); await alGuardar(); }
      catch (e) { error.textContent = limpiar(e); }
    } }, 'Guardar anticipo'))));
}

export async function seccionAnticipos(raiz, recargar) {
  const lista = await listarAnticipos();
  const disp = lista.filter((a) => a.estado === 'vigente').reduce((s, a) => s + a.disponible, 0);
  async function detalle(a) {
    const apps = await aplicacionesAnticipo(a.id);
    const facturas = a.estado === 'vigente' && a.disponible > 0.005 ? await facturasCredito(a.cliente_id, { soloConSaldo: true }) : [];
    const factura = selectDe(facturas.map((f) => [f.id, `${f.numero} · debe ${dinero(f.saldo)}`]), { etiqueta: 'Factura' });
    const monto = numero(); const motivo = texto('', 'Motivo de la anulación'); const error = h('p', { class: 'error', role: 'alert' });
    const recarga = async () => { cerrar(); await recargar(); };
    const cerrar = hoja(`Anticipo ${a.numero}`, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' }, renglon('Recibido', dinero(a.monto), 'gran'), renglon('Disponible', dinero(a.disponible))),
      h('p', { class: 'ayuda' }, [fechaCorta(a.fecha), a.cliente, METODOS_PAGO_CXC[a.metodo], a.referencia, a.notas].filter(Boolean).join(' · ')),
      a.estado === 'anulado' ? h('p', { class: 'error' }, `Anulado: ${a.anulado_motivo || ''}`) : null,
      apps.length ? h('h3', {}, 'Aplicaciones') : null,
      apps.length ? tabla(['Fecha', 'Factura', 'Monto', ''], apps.map((p) => [fechaCorta(p.fecha), p.factura, dinero(p.monto),
        h('button', { class: 'btn chico', onClick: async () => { try { await quitarAplicacion(p.id); toast('Aplicación quitada'); await recarga(); } catch (e) { error.textContent = limpiar(e); } } }, 'Quitar')]), { num: [2] }) : null,
      facturas.length ? h('h3', {}, 'Aplicar a una factura') : null,
      facturas.length ? campo('Factura', factura) : null, facturas.length ? campo('Monto a aplicar', monto) : null,
      facturas.length ? h('button', { class: 'btn primario', onClick: async () => {
        error.textContent = '';
        try { await aplicarAnticipo({ anticipo_id: a.id, venta_id: Number(factura.value), monto: monto.value }); toast('Anticipo aplicado'); await recarga(); } catch (e) { error.textContent = limpiar(e); }
      } }, 'Aplicar') : (a.estado === 'vigente' && a.disponible > 0.005 ? h('p', { class: 'ayuda' }, 'El cliente no tiene facturas a crédito con saldo.') : null),
      a.estado === 'vigente' && !apps.length ? campo('Anular este anticipo', motivo) : null, error,
      a.estado === 'vigente' && !apps.length ? h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: async () => {
        try { await anularAnticipo(a.id, motivo.value); toast('Anticipo anulado'); await recarga(); } catch (e) { error.textContent = limpiar(e); }
      } }, 'Anular anticipo')) : null));
  }
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Los anticipos son dinero que el cliente pagó antes de tener una factura. Aplícalos a sus facturas a crédito cuando las tenga.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => abrirAnticipo({ alGuardar: recargar }) }, 'Nuevo anticipo')),
    h('div', { class: 'totales' }, renglon('Anticipos sin aplicar', dinero(disp), 'gran')),
    lista.length ? h('div', { class: 'lista' }, lista.map((a) => h('button', { class: `fila inventario ${a.estado === 'anulado' ? 'apagada' : ''}`, onClick: () => detalle(a) },
      h('span', { class: 'datos' }, h('strong', {}, `${a.numero} · ${a.cliente}`), h('small', {}, [fechaCorta(a.fecha), METODOS_PAGO_CXC[a.metodo], a.estado === 'anulado' ? 'anulado' : `disponible ${dinero(a.disponible)}`].join(' · '))),
      h('span', { class: 'precio' }, dinero(a.monto))))) : vacio('Aún no hay anticipos.'));
}
