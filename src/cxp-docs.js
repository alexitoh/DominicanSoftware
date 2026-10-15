// cxp-docs.js - CxP: facturas del suplidor, notas de crédito y débito, anticipos, pagos de contado y pago a un suplidor
import { h, hoja, toast, dinero } from './ui.js';
import {
  listarFacturasSuplidor, detalleFacturaSuplidor, facturasCreditoProveedor, listarNotasProveedor, crearNotaProveedor, anularNotaProveedor,
  listarAnticiposProveedor, crearAnticipoProveedor, aplicarAnticipoProveedor, aplicacionesAnticipoProveedor, quitarAplicacionProveedor, anularAnticipoProveedor,
  listarComprasContado, pagarSuplidor, METODOS_PAGO_CXP, CONCEPTOS_NC, CONCEPTOS_ND,
} from './cxp-db.js';
import { consultar } from './database.js';
import { fechaHoy } from './conta-db.js';
import { formularioCompra } from './compras.js';
import { formularioPagoCompra, estadoCuenta } from './cuentas.js';
import { campo, numero, fechaInput, texto, tabla, vacio, fechaCorta, limpiar, renglon } from './conta-ui-comun.js';

export const selectDe = (items, { valor = '', vacioTexto = null, etiqueta = 'Elegir' } = {}) => {
  const s = h('select', { class: 'campo', 'aria-label': etiqueta }, vacioTexto != null ? h('option', { value: '' }, vacioTexto) : null, items.map(([v, t]) => h('option', { value: String(v) }, t)));
  s.value = String(valor ?? '');
  if (s.value === '' && vacioTexto == null && items.length) s.value = String(items[0][0]);
  return s;
};
const TITULO = { credito: 'Nota de crédito', debito: 'Nota de débito' };
const ETIQUETA_MOV = { nota_credito: 'Nota de crédito', nota_debito: 'Nota de débito', anticipo: 'Anticipo aplicado', ...METODOS_PAGO_CXP };
const provsConFacturas = async (soloConSaldo) => {
  const provs = await consultar('SELECT id, nombre FROM proveedores ORDER BY nombre COLLATE NOCASE');
  const r = [];
  for (const p of provs) if ((await facturasCreditoProveedor(p.id, { soloConSaldo })).length) r.push(p);
  return r;
};

// ---------- Notas de crédito y de débito ----------
export async function abrirNotaProv(tipo, { proveedorId = null, compraId = null, alGuardar = () => {} } = {}) {
  const provs = await provsConFacturas(tipo === 'credito');
  if (!provs.length) { toast(tipo === 'credito' ? 'No hay facturas a crédito con saldo' : 'No hay facturas a crédito'); return; }
  const proveedor = selectDe(provs.map((p) => [p.id, p.nombre]), { valor: proveedorId ?? provs[0].id, etiqueta: 'Suplidor' });
  if (proveedorId) proveedor.disabled = true;
  const factura = selectDe([], { etiqueta: 'Factura' });
  let facturas = [];
  const concepto = selectDe((tipo === 'credito' ? CONCEPTOS_NC : CONCEPTOS_ND).map((c) => [c, c]), { etiqueta: 'Concepto' });
  const monto = numero(); const itbis = numero(); const ncf = texto('', tipo === 'credito' ? 'Ej. B0400000001 (opcional)' : 'Ej. B0300000001 (opcional)');
  const fecha = fechaInput(fechaHoy()); const notas = texto('', 'Opcional');
  const info = h('p', { class: 'ayuda' }); const error = h('p', { class: 'error', role: 'alert' });
  async function cargarFacturas() {
    facturas = await facturasCreditoProveedor(Number(proveedor.value), { soloConSaldo: tipo === 'credito' });
    factura.replaceChildren(...facturas.map((f) => h('option', { value: String(f.id) }, `${f.numero} · se debe ${dinero(f.saldo)}`)));
    const quiere = compraId && facturas.find((f) => f.id === compraId);
    factura.value = String((quiere || facturas[0])?.id ?? '');
    sugerir();
  }
  function sugerir() { const f = facturas.find((x) => String(x.id) === factura.value); info.textContent = f ? `Total de la factura ${dinero(f.total)}. Hoy se debe ${dinero(f.saldo)}.` : ''; }
  proveedor.addEventListener('change', cargarFacturas); factura.addEventListener('change', sugerir);
  await cargarFacturas();
  const cerrar = hoja(`Nueva ${TITULO[tipo].toLowerCase()}`, h('div', { class: 'cuerpo' },
    h('p', { class: 'ayuda' }, tipo === 'credito' ? 'Baja lo que le debes al suplidor en una factura (descuento, devolución o error).' : 'Sube lo que le debes al suplidor en una factura (intereses, fletes, diferencias).'),
    campo('Suplidor', proveedor), campo('Factura', factura), info, campo('Concepto', concepto),
    h('div', { class: 'rejilla' }, campo('Monto (con ITBIS)', monto), campo('ITBIS incluido', itbis)),
    h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('NCF', ncf, tipo === 'credito' ? 'Comprobante B04 del suplidor.' : 'Comprobante B03 del suplidor.')),
    campo('Notas', notas), error,
    h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
      error.textContent = '';
      try {
        const r = await crearNotaProveedor({ tipo, proveedor_id: Number(proveedor.value), compra_id: Number(factura.value), concepto: concepto.value, monto: monto.value, itbis: itbis.value, ncf: ncf.value, fecha: fecha.value, notas: notas.value });
        cerrar(); toast(`${TITULO[tipo]} ${r.numero} guardada`); await alGuardar();
      } catch (e) { error.textContent = limpiar(e); }
    } }, 'Guardar nota'))));
}

export async function seccionNotasProv(raiz, recargar, tipo) {
  const hoy = fechaHoy();
  const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`); const hasta = fechaInput(hoy);
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar por suplidor, número o factura', 'aria-label': 'Buscar nota' });
  const resumen = h('div', { class: 'totales' }); const lista = h('div');
  let todas = [];
  async function cargar() { todas = await listarNotasProveedor({ tipo, desde: desde.value || '0000-00-00', hasta: hasta.value || hoy }); pintar(); }
  function pintar() {
    const q = buscar.value.trim().toLowerCase();
    const vis = todas.filter((n) => !q || `${n.proveedor} ${n.numero} ${n.factura || ''} ${n.ncf || ''}`.toLowerCase().includes(q));
    const vig = vis.filter((n) => n.estado === 'vigente');
    resumen.replaceChildren(renglon(`Total ${tipo === 'credito' ? 'acreditado' : 'cargado'}`, dinero(vig.reduce((s, n) => s + n.monto, 0)), 'gran'), renglon('Notas vigentes', String(vig.length)));
    lista.replaceChildren(vis.length ? h('div', { class: 'lista' }, vis.map((n) => h('button', { class: `fila inventario ${n.estado === 'anulado' ? 'apagada' : ''}`, onClick: () => detalle(n) },
      h('span', { class: 'datos' }, h('strong', {}, `${n.numero} · ${n.proveedor}`),
        h('small', {}, [fechaCorta(n.fecha), n.factura && `Factura ${n.factura}`, n.concepto, n.ncf, n.estado === 'anulado' ? 'anulada' : null].filter(Boolean).join(' · '))),
      h('span', { class: 'precio' }, dinero(n.monto))))) : vacio(`No hay ${TITULO[tipo].toLowerCase()}s en ese período.`));
  }
  function detalle(n) {
    const motivo = texto('', 'Motivo de la anulación'); const error = h('p', { class: 'error', role: 'alert' });
    const puede = n.estado === 'vigente';
    const cerrar = hoja(`${TITULO[tipo]} ${n.numero}`, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' }, renglon('Monto', dinero(n.monto), 'gran'), renglon('ITBIS incluido', dinero(n.itbis)), renglon('Sin ITBIS', dinero(n.monto - n.itbis))),
      h('p', { class: 'ayuda' }, [fechaCorta(n.fecha), n.proveedor, n.factura && `Factura ${n.factura}`, n.concepto, n.ncf && `NCF ${n.ncf}`, n.notas].filter(Boolean).join(' · ')),
      n.estado === 'anulado' ? h('p', { class: 'error' }, `Anulada: ${n.anulado_motivo || ''}`) : null,
      puede ? campo('Anular esta nota', motivo, 'No se borra: la factura vuelve a deber lo que debía.') : null, error,
      puede ? h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: async () => {
        try { await anularNotaProveedor(n.id, motivo.value); cerrar(); toast('Nota anulada'); await recargar(); } catch (e) { error.textContent = limpiar(e); }
      } }, 'Anular nota')) : null));
  }
  desde.addEventListener('change', cargar); hasta.addEventListener('change', cargar); buscar.addEventListener('input', pintar);
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, tipo === 'credito'
      ? 'Una nota de crédito baja lo que le debes al suplidor: por un descuento, una devolución o un error en la factura. Se contabiliza sola contra Descuentos y devoluciones en compras. Una devolución de mercancía NO baja el inventario sola: ajústalo en Inventario. Aún no sale en el 606.'
      : 'Una nota de débito sube lo que le debes al suplidor: intereses, fletes o diferencias de precio. Se contabiliza sola como Cargos y recargos de proveedores. Aún no sale en el 606.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => abrirNotaProv(tipo, { alGuardar: recargar }) }, `Nueva ${TITULO[tipo].toLowerCase()}`)),
    h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), buscar, resumen, lista);
  await cargar();
}

// ---------- Anticipos ----------
export async function abrirAnticipoProv({ proveedorId = null, alGuardar = () => {} } = {}) {
  const provs = await consultar('SELECT id, nombre FROM proveedores ORDER BY nombre COLLATE NOCASE');
  if (!provs.length) { toast('Primero crea un suplidor'); return; }
  const proveedor = selectDe(provs.map((p) => [p.id, p.nombre]), { valor: proveedorId ?? provs[0].id, etiqueta: 'Suplidor' });
  if (proveedorId) proveedor.disabled = true;
  const monto = numero(); const fecha = fechaInput(fechaHoy());
  const metodo = selectDe(Object.entries(METODOS_PAGO_CXP), { valor: 'efectivo', etiqueta: 'Método' });
  const ref = texto('', 'N.º de cheque o referencia'); const notas = texto('', 'Opcional');
  const error = h('p', { class: 'error', role: 'alert' });
  const cerrar = hoja('Nuevo anticipo a suplidor', h('div', { class: 'cuerpo' },
    h('p', { class: 'ayuda' }, 'Dinero que entregas al suplidor por adelantado. Queda como un saldo a tu favor que luego aplicas a sus facturas. Se contabiliza como Anticipos a proveedores (activo), no como gasto. Si pagas en efectivo, no entra al cuadre del cajero.'),
    campo('Suplidor', proveedor), h('div', { class: 'rejilla' }, campo('Monto', monto), campo('Fecha', fecha)), campo('Método de pago', metodo), campo('Referencia', ref), campo('Notas', notas), error,
    h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
      error.textContent = '';
      try { const r = await crearAnticipoProveedor({ proveedor_id: Number(proveedor.value), monto: monto.value, metodo: metodo.value, referencia: ref.value, fecha: fecha.value, notas: notas.value }); cerrar(); toast(`Anticipo ${r.numero} guardado`); await alGuardar(); }
      catch (e) { error.textContent = limpiar(e); }
    } }, 'Guardar anticipo'))));
}

export async function seccionAnticiposProv(raiz, recargar) {
  const lista = await listarAnticiposProveedor();
  const disp = lista.filter((a) => a.estado === 'vigente').reduce((s, a) => s + a.disponible, 0);
  async function detalle(a) {
    const apps = await aplicacionesAnticipoProveedor(a.id);
    const facturas = a.estado === 'vigente' && a.disponible > 0.005 ? await facturasCreditoProveedor(a.proveedor_id, { soloConSaldo: true }) : [];
    const factura = selectDe(facturas.map((f) => [f.id, `${f.numero} · se debe ${dinero(f.saldo)}`]), { etiqueta: 'Factura' });
    const monto = numero(); const motivo = texto('', 'Motivo de la anulación'); const error = h('p', { class: 'error', role: 'alert' });
    const recarga = async () => { cerrar(); await recargar(); };
    const cerrar = hoja(`Anticipo ${a.numero}`, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' }, renglon('Entregado', dinero(a.monto), 'gran'), renglon('Disponible', dinero(a.disponible))),
      h('p', { class: 'ayuda' }, [fechaCorta(a.fecha), a.proveedor, METODOS_PAGO_CXP[a.metodo], a.referencia, a.notas].filter(Boolean).join(' · ')),
      a.estado === 'anulado' ? h('p', { class: 'error' }, `Anulado: ${a.anulado_motivo || ''}`) : null,
      apps.length ? h('h3', {}, 'Aplicaciones') : null,
      apps.length ? tabla(['Fecha', 'Factura', 'Monto', ''], apps.map((p) => [fechaCorta(p.fecha), p.factura, dinero(p.monto),
        h('button', { class: 'btn chico', onClick: async () => { try { await quitarAplicacionProveedor(p.id); toast('Aplicación quitada'); await recarga(); } catch (e) { error.textContent = limpiar(e); } } }, 'Quitar')]), { num: [2] }) : null,
      facturas.length ? h('h3', {}, 'Aplicar a una factura') : null,
      facturas.length ? campo('Factura', factura) : null, facturas.length ? campo('Monto a aplicar', monto) : null,
      facturas.length ? h('button', { class: 'btn primario', onClick: async () => {
        error.textContent = '';
        try { await aplicarAnticipoProveedor({ anticipo_id: a.id, compra_id: Number(factura.value), monto: monto.value }); toast('Anticipo aplicado'); await recarga(); } catch (e) { error.textContent = limpiar(e); }
      } }, 'Aplicar') : (a.estado === 'vigente' && a.disponible > 0.005 ? h('p', { class: 'ayuda' }, 'Este suplidor no tiene facturas a crédito con saldo.') : null),
      a.estado === 'vigente' && !apps.length ? campo('Anular este anticipo', motivo) : null, error,
      a.estado === 'vigente' && !apps.length ? h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: async () => {
        try { await anularAnticipoProveedor(a.id, motivo.value); toast('Anticipo anulado'); await recarga(); } catch (e) { error.textContent = limpiar(e); }
      } }, 'Anular anticipo')) : null));
  }
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Los anticipos son dinero que entregaste a un suplidor antes de tener su factura. Aplícalos a sus facturas a crédito cuando las tengas.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => abrirAnticipoProv({ alGuardar: recargar }) }, 'Nuevo anticipo')),
    h('div', { class: 'totales' }, renglon('Anticipos sin aplicar', dinero(disp), 'gran')),
    lista.length ? h('div', { class: 'lista' }, lista.map((a) => h('button', { class: `fila inventario ${a.estado === 'anulado' ? 'apagada' : ''}`, onClick: () => detalle(a) },
      h('span', { class: 'datos' }, h('strong', {}, `${a.numero} · ${a.proveedor}`), h('small', {}, [fechaCorta(a.fecha), METODOS_PAGO_CXP[a.metodo], a.estado === 'anulado' ? 'anulado' : `disponible ${dinero(a.disponible)}`].join(' · '))),
      h('span', { class: 'precio' }, dinero(a.monto))))) : vacio('Aún no hay anticipos.'));
}

// ---------- Pagar a un suplidor (se reparte entre sus facturas) ----------
export function formularioPagoProveedor({ proveedorId, nombre, deuda, alGuardar = () => {} }) {
  const monto = numero(deuda); const metodo = selectDe(Object.entries(METODOS_PAGO_CXP), { valor: 'efectivo', etiqueta: 'Método' });
  const nota = texto('', 'Opcional'); const error = h('p', { class: 'error', role: 'alert' });
  const cerrar = hoja(`Pagar a ${nombre}`, h('div', { class: 'cuerpo' },
    h('p', { class: 'ayuda' }, `Se le debe ${dinero(deuda)}. El pago se reparte entre sus facturas, las que vencen primero antes. Si pagas en efectivo con la caja abierta, se descuenta del efectivo esperado.`),
    campo('Monto', monto), campo('Método de pago', metodo), campo('Nota', nota), error,
    h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
      error.textContent = '';
      try { const r = await pagarSuplidor({ proveedor_id: proveedorId, monto: monto.value, metodo: metodo.value, nota: nota.value }); cerrar(); toast(`Pago aplicado a ${r.aplicados.length} ${r.aplicados.length === 1 ? 'factura' : 'facturas'}`); await alGuardar(); }
      catch (e) { error.textContent = limpiar(e); }
    } }, 'Registrar pago'))));
}

// ---------- Factura Suplidor ----------
export async function seccionFacturas(raiz, recargar, ir, opciones = {}) {
  const hoy = fechaHoy();
  const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`); const hasta = fechaInput(hoy);
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar por suplidor, número o factura', 'aria-label': 'Buscar factura' });
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Filtro de facturas' });
  const resumen = h('div', { class: 'totales' }); const lista = h('div');
  let filtro = 'pendientes'; let todas = [];
  const FILTROS = [['pendientes', 'Pendientes'], ['vencidas', 'Vencidas'], ['pagadas', 'Pagadas'], ['todas', 'Todas']];
  async function cargar() { todas = await listarFacturasSuplidor({ desde: desde.value || '0000-00-00', hasta: hasta.value || hoy }); pintar(); }
  const estadoDe = (f) => (f.estado === 'anulada' ? { id: 'anulada', texto: 'Anulada' } : !f.credito ? { id: 'contado', texto: 'Contado' } : estadoCuenta(f));
  function pintar() {
    segmento.replaceChildren(...FILTROS.map(([id, t]) => h('button', { 'aria-pressed': String(filtro === id), onClick: () => { filtro = id; pintar(); } }, t)));
    const q = buscar.value.trim().toLowerCase();
    const con = todas.map((f) => ({ f, e: estadoDe(f) }));
    const pend = con.filter((x) => x.f.credito && x.f.estado === 'completada' && x.e.id !== 'pagada');
    const vis = con.filter(({ f, e }) => (filtro === 'todas' || (filtro === 'pendientes' && f.credito && f.estado === 'completada' && e.id !== 'pagada') || (filtro === 'vencidas' && e.id === 'vencida') || (filtro === 'pagadas' && f.estado === 'completada' && (e.id === 'pagada' || e.id === 'contado')))
      && (!q || `${f.proveedor} ${f.numero} ${f.referencia || ''}`.toLowerCase().includes(q)));
    resumen.replaceChildren(renglon('Por pagar', dinero(pend.reduce((s, x) => s + x.f.saldo, 0)), 'gran'), renglon('Vencido', dinero(pend.filter((x) => x.e.id === 'vencida').reduce((s, x) => s + x.f.saldo, 0))), renglon('Facturas pendientes', String(pend.length)));
    lista.replaceChildren(vis.length ? h('div', { class: 'lista' }, vis.map(({ f, e }) => h('button', { class: `fila inventario ${f.estado === 'anulada' ? 'apagada' : ''}`, onClick: () => detalle(f.id) },
      h('span', { class: 'datos' }, h('strong', {}, f.proveedor), h('small', {}, `${f.numero} · ${fechaCorta(f.fecha)}${f.referencia ? ` · Fact. ${f.referencia}` : ''}`), h('small', { class: e.id === 'vencida' ? 'deuda' : '' }, e.texto)),
      h('span', { class: 'precio' }, f.credito && f.estado === 'completada' ? dinero(Math.max(0, f.saldo)) : dinero(f.total), f.credito && f.estado === 'completada' ? h('small', { class: 'bloque' }, `de ${dinero(f.total)}`) : null)))) : vacio('No hay facturas con ese filtro.'));
  }
  async function detalle(id) {
    const f = await detalleFacturaSuplidor(id);
    const e = estadoDe(f);
    const vigente = f.estado === 'completada' && f.credito;
    const refrescar = async () => { cerrar(); await recargar(); };
    const cerrar = hoja(f.numero, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, `${f.proveedor}${f.proveedor_tel ? `, ${f.proveedor_tel}` : ''}, ${fechaCorta(f.fecha)}${f.referencia ? `, Fact. ${f.referencia}` : ''}${f.ncf ? `, NCF ${f.ncf}` : ''}`),
      f.estado === 'anulada' ? h('p', { class: 'error' }, 'Esta factura está anulada.') : null,
      h('ul', { class: 'historial detalle' }, f.items.map((i) => h('li', {}, h('strong', {}, `${i.cantidad}×`), h('span', {}, `${i.nombre}, ${dinero(i.costo_unitario)} c/u`), h('small', {}, dinero(i.cantidad * i.costo_unitario))))),
      h('div', { class: 'totales' }, renglon('Total de la factura', dinero(f.total)),
        vigente ? renglon('Pendiente', dinero(Math.max(0, f.saldo)), e.id === 'pagada' ? 'gran pagada' : 'gran deuda') : renglon('Forma de pago', f.credito ? 'A crédito' : 'Contado'),
        vigente ? renglon('Estado', e.texto, e.id === 'vencida' ? 'deuda' : '') : null, vigente && f.vence ? renglon('Fecha límite', fechaCorta(f.vence)) : null),
      f.movimientos.length ? h('h3', {}, 'Pagos y notas') : null,
      f.movimientos.length ? h('ul', { class: 'historial detalle' }, f.movimientos.map((p) => h('li', {}, h('span', {}, `${fechaCorta(p.fecha)}, ${ETIQUETA_MOV[p.metodo] || p.metodo}${p.nota && !/^(Nota|Anticipo)/.test(p.nota) ? `, ${p.nota}` : ''}`), h('small', {}, dinero(p.monto))))) : null,
      vigente ? h('div', { class: 'acciones' },
        f.saldo > 0.005 ? h('button', { class: 'btn primario', onClick: () => { cerrar(); formularioPagoCompra({ id: f.id, numero: f.numero, total: f.total, pagado: f.total - f.saldo }, recargar); } }, 'Registrar pago') : null,
        f.saldo > 0.005 ? h('button', { class: 'btn', onClick: () => { cerrar(); abrirNotaProv('credito', { proveedorId: f.proveedor_id, compraId: f.id, alGuardar: recargar }); } }, 'Nota de crédito') : null,
        h('button', { class: 'btn', onClick: () => { cerrar(); abrirNotaProv('debito', { proveedorId: f.proveedor_id, compraId: f.id, alGuardar: recargar }); } }, 'Nota de débito')) : null));
  }
  desde.addEventListener('change', cargar); hasta.addEventListener('change', cargar); buscar.addEventListener('input', pintar);
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Las facturas que te dan tus suplidores (compras). Toca una para ver sus pagos, pagarla o hacerle una nota. Al registrar una, elige "Crédito (por pagar)" para que quede en cuentas por pagar.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formularioCompra(recargar, opciones.compra || {}) }, 'Nueva factura de suplidor')),
    h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), buscar, segmento, resumen, lista);
  await cargar();
}

// ---------- Pago de Contado ----------
export async function seccionContado(raiz, recargar) {
  const hoy = fechaHoy();
  const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`); const hasta = fechaInput(hoy);
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar por suplidor o número', 'aria-label': 'Buscar compra de contado' });
  const resumen = h('div', { class: 'totales' }); const lista = h('div');
  let todas = [];
  async function cargar() { todas = await listarComprasContado({ desde: desde.value || '0000-00-00', hasta: hasta.value || hoy }); pintar(); }
  function pintar() {
    const q = buscar.value.trim().toLowerCase();
    const vis = todas.filter((c) => !q || `${c.proveedor} ${c.numero} ${c.referencia || ''}`.toLowerCase().includes(q));
    resumen.replaceChildren(renglon('Pagado de contado', dinero(vis.reduce((s, c) => s + c.total, 0)), 'gran'), renglon('Compras', String(vis.length)));
    lista.replaceChildren(vis.length ? h('div', { class: 'lista' }, vis.map((c) => h('div', { class: 'fila inventario' },
      h('span', { class: 'datos' }, h('strong', {}, c.proveedor), h('small', {}, [c.numero, fechaCorta(c.fecha), c.referencia && `Fact. ${c.referencia}`, ETIQUETA_MOV[c.metodo] || c.metodo].filter(Boolean).join(' · '))),
      h('span', { class: 'precio' }, dinero(c.total))))) : vacio('No hay compras de contado en ese período.'));
  }
  desde.addEventListener('change', cargar); hasta.addEventListener('change', cargar); buscar.addEventListener('input', pintar);
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Compras que pagas en el momento (efectivo, tarjeta, transferencia o cheque): no crean deuda. Se contabilizan solas y las de efectivo descuentan del cuadre de caja.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formularioCompra(recargar, { formaPago: 'efectivo' }) }, 'Nuevo pago de contado')),
    h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), buscar, resumen, lista);
  await cargar();
}
