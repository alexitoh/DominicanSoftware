// conta-ui-gastos.js - pestaña Gastos: registro de gastos desde Contabilidad, reportes de gasto y tipos de pago
import { h, hoja, toast, dinero } from './ui.js';
import {
  registrarGastoConta, anularGastoConta, listarGastos, reporteGastos, AGRUPACIONES_GASTO, listarTiposPago, guardarTipoPago, eliminarTipoPago, METODOS_PAGO,
  listarConceptos, listarBancos, listarCuentas, fechaHoy,
} from './conta-db.js';
import { CATEGORIAS } from './caja.js';
import { campo, numero, fechaInput, texto, selectCuentas, tabla, vacio, fechaCorta, limpiar, botonCSV, renglon } from './conta-ui-comun.js';

// Tres secciones: Gastos, Reportes de Gasto y Tipo de Pago.
const SECCIONES_GA = [['gastos', 'Gastos'], ['reportes', 'Reportes de Gasto'], ['tipos', 'Tipo de Pago']];
let seccionGA = 'gastos';

export async function vistaGastos(raiz) {
  const cuerpo = h('div');
  const barra = h('div', { class: 'segmento conta-tabs', role: 'tablist', 'aria-label': 'Gastos' });
  async function ir(id) {
    seccionGA = id;
    barra.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    const nueva = h('div');
    try { await SECCION_FN[id](nueva, () => ir(id), ir); } catch (e) { nueva.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar: ${e.message || e}`)); }
    if (seccionGA === id) cuerpo.replaceChildren(nueva);
  }
  barra.append(...SECCIONES_GA.map(([id, t]) => h('button', { 'data-id': id, role: 'tab', onClick: () => ir(id) }, t)));
  raiz.replaceChildren(barra, cuerpo);
  await ir(seccionGA);
}

// ---- Gastos ----
async function seccionGastos(raiz, recargar) {
  const hoy = fechaHoy();
  const desde = fechaInput(`${hoy.slice(0, 7)}-01`), hasta = fechaInput(hoy);
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar por concepto, beneficiario o NCF', 'aria-label': 'Buscar gasto' });
  const resumen = h('div', { class: 'totales' });
  const lista = h('div');
  let todos = [];

  async function cargar() { todos = await listarGastos({ desde: desde.value || '0000-00-00', hasta: hasta.value || hoy }); pintar(); }
  function pintar() {
    const q = buscar.value.trim().toLowerCase();
    const vis = todos.filter((g) => !q || [g.concepto, g.beneficiario, g.ncf, g.categoria].some((x) => (x || '').toLowerCase().includes(q)));
    const vig = vis.filter((g) => g.estado === 'vigente');
    resumen.replaceChildren(renglon('Gastos del período', dinero(vig.reduce((s, g) => s + g.monto, 0)), 'gran'), renglon('ITBIS incluido', dinero(vig.reduce((s, g) => s + g.itbis, 0))));
    lista.replaceChildren(vis.length ? h('div', { class: 'lista' }, vis.map((g) => h('button', { class: `fila inventario ${g.estado === 'anulado' ? 'apagada' : ''}`, onClick: () => detalle(g) },
      h('span', { class: 'datos' }, h('strong', {}, g.concepto),
        h('small', {}, [fechaCorta(g.fecha), g.categoria, g.beneficiario, g.ncf, g.tipo_pago || METODOS_PAGO[g.metodo], g.origen === 'conta' ? null : 'Caja', g.estado === 'anulado' ? 'anulado' : null].filter(Boolean).join(' · '))),
      h('span', { class: 'precio' }, dinero(g.monto))))) : vacio('No hay gastos en ese período.'));
  }

  function detalle(g) {
    const motivo = texto('', 'Motivo de la anulación');
    const error = h('p', { class: 'error', role: 'alert' });
    const puede = g.origen === 'conta' && g.estado === 'vigente';
    const cerrar = hoja(g.concepto, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' }, renglon('Monto', dinero(g.monto), 'gran'), renglon('ITBIS incluido', dinero(g.itbis)), renglon('Sin ITBIS', dinero(g.monto - g.itbis))),
      h('p', { class: 'ayuda' }, [fechaCorta(g.fecha), g.categoria, g.beneficiario && `Beneficiario: ${g.beneficiario}`, g.documento && `RNC/cédula ${g.documento}`, g.ncf && `NCF ${g.ncf}`,
        `Pago: ${g.tipo_pago || METODOS_PAGO[g.metodo] || g.metodo}`, g.nota].filter(Boolean).join(' · ')),
      g.origen !== 'conta' ? h('p', { class: 'ayuda' }, 'Este gasto se registró desde Caja.') : null,
      g.estado === 'anulado' ? h('p', { class: 'error' }, 'Gasto anulado: no se contabiliza ni entra a los reportes.') : null,
      puede ? campo('Anular este gasto', motivo, 'No se borra: queda anulado con su motivo.') : null, error,
      puede ? h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: async () => {
        try { await anularGastoConta(g.id, motivo.value); cerrar(); toast('Gasto anulado'); await recargar(); } catch (e) { error.textContent = limpiar(e); }
      } }, 'Anular gasto')) : null));
  }

  async function formulario() {
    const [tipos, conceptos, bancos] = await Promise.all([listarTiposPago(), listarConceptos(), listarBancos()]);
    void bancos;
    const tiposAct = tipos.filter((t) => t.activo);
    const conceptosG = conceptos.filter((c) => c.activo && c.tipo === 'gasto');
    const fecha = fechaInput(hoy);
    const concepto = texto('', 'Ej. Pago de alquiler');
    const selConcepto = h('select', { class: 'campo', 'aria-label': 'Concepto guardado' }, h('option', { value: '' }, '— Escribir libre —'), conceptosG.map((c) => h('option', { value: String(c.id) }, c.nombre)));
    const categoria = h('select', { class: 'campo', 'aria-label': 'Categoría' }, CATEGORIAS.map((x) => h('option', { value: x }, x)));
    categoria.value = 'Otros';
    selConcepto.addEventListener('change', () => {
      const c = conceptosG.find((x) => String(x.id) === selConcepto.value);
      if (!c) return;
      concepto.value = c.nombre;
      if (c.categoria_gasto) { if (![...categoria.children].some((o) => o.value === c.categoria_gasto)) categoria.append(h('option', { value: c.categoria_gasto }, c.categoria_gasto)); categoria.value = c.categoria_gasto; }
    });
    const beneficiario = texto('', 'A quién se le pagó'), documento = texto('', 'RNC o cédula (opcional)'), ncf = texto('', 'Ej. B0100000001 (opcional)');
    const monto = numero(), itbis = numero();
    const tipoPago = h('select', { class: 'campo', 'aria-label': 'Tipo de pago' }, tiposAct.map((t) => h('option', { value: String(t.id) }, t.nombre)));
    if (tiposAct.length) tipoPago.value = String((tiposAct.find((t) => t.metodo === 'efectivo') || tiposAct[0]).id);
    const referencia = texto('', 'N.º de cheque o referencia');
    const refBox = campo('Referencia', referencia);
    const nota = texto('', 'Opcional');
    const error = h('p', { class: 'error', role: 'alert' });
    const ajustar = () => { const t = tiposAct.find((x) => String(x.id) === tipoPago.value); refBox.hidden = !(t?.requiere_ref); };
    tipoPago.addEventListener('change', ajustar); ajustar();
    const cerrar = hoja('Nuevo gasto', h('div', { class: 'cuerpo' },
      tiposAct.length ? null : h('p', { class: 'error' }, 'No hay tipos de pago activos. Crea uno en la sección Tipo de Pago.'),
      h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('Monto pagado', monto)),
      conceptosG.length ? campo('Concepto guardado', selConcepto) : null, campo('Concepto', concepto), campo('Categoría', categoria),
      h('div', { class: 'rejilla' }, campo('Beneficiario / proveedor', beneficiario), campo('RNC / cédula', documento)),
      h('div', { class: 'rejilla' }, campo('NCF', ncf, 'Con NCF entra al 606.'), campo('ITBIS incluido', itbis)),
      campo('Tipo de pago', tipoPago, 'Define de dónde sale el dinero (caja, banco o cuenta).'), refBox, campo('Nota', nota), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        error.textContent = '';
        try {
          await registrarGastoConta({ fecha: fecha.value, concepto: concepto.value, categoria: categoria.value, beneficiario: beneficiario.value, documento: documento.value, ncf: ncf.value,
            itbis: itbis.value, monto: monto.value, tipo_pago_id: Number(tipoPago.value), referencia: referencia.value, nota: nota.value });
          cerrar(); toast('Gasto registrado'); await recargar();
        } catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar gasto'))));
  }

  desde.addEventListener('change', cargar); hasta.addEventListener('change', cargar); buscar.addEventListener('input', pintar);
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Registra gastos sin necesidad de tener la caja abierta (alquiler, luz, servicios…). Se contabilizan solos y, con NCF, entran al 606. Aquí también ves los gastos hechos desde Caja.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: formulario }, 'Nuevo gasto')),
    h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), buscar, resumen, lista);
  await cargar();
}

// ---- Reportes de Gasto ----
async function seccionReportes(raiz) {
  const hoy = fechaHoy();
  const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`), hasta = fechaInput(hoy);
  const agrupar = h('select', { class: 'campo', 'aria-label': 'Agrupar por' }, Object.entries(AGRUPACIONES_GASTO).map(([k, t]) => h('option', { value: k }, t)));
  agrupar.value = 'categoria';
  const cuerpo = h('div');

  async function pintar() {
    const r = await reporteGastos({ desde: desde.value || '0000-00-00', hasta: hasta.value || hoy, agrupar: agrupar.value });
    const etiqueta = AGRUPACIONES_GASTO[agrupar.value];
    const filas = r.grupos.map((g) => [g.clave, String(g.n), dinero(g.base), dinero(g.itbis), dinero(g.total), r.total ? `${Math.round((g.total / r.total) * 1000) / 10}%` : '']);
    const csvFilas = r.filas.map((f) => [f.fecha, f.origen, f.categoria, f.beneficiario, f.tipo_pago, f.concepto, f.ncf || '', f.monto - f.itbis, f.itbis, f.monto]);
    cuerpo.replaceChildren(
      h('div', { class: 'totales' }, renglon('Total de gastos', dinero(r.total), 'gran'), renglon('ITBIS incluido', dinero(r.itbis)), renglon('Cantidad de gastos', String(r.n))),
      filas.length ? tabla([etiqueta, 'Cant.', 'Sin ITBIS', 'ITBIS', 'Total', '%'], [...filas, ['Total', String(r.n), dinero(r.total - r.itbis), dinero(r.itbis), dinero(r.total), '100%']], { num: [1, 2, 3, 4, 5], clases: { [filas.length]: 'total' } })
        : vacio('No hay gastos en ese período.'),
      h('p', { class: 'ayuda' }, 'Incluye los gastos de Caja, los de Contabilidad y los desembolsos de caja chica. No incluye los anulados.'),
      filas.length ? botonCSV(`gastos-${desde.value}-${hasta.value}`, ['Fecha', 'Origen', 'Categoría', 'Beneficiario', 'Tipo de pago', 'Concepto', 'NCF', 'Sin ITBIS', 'ITBIS', 'Total'], csvFilas) : null);
  }
  for (const el of [desde, hasta]) el.addEventListener('change', pintar);
  agrupar.addEventListener('change', pintar);
  raiz.replaceChildren(h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), campo('Agrupar por', agrupar), cuerpo);
  await pintar();
}

// ---- Tipo de Pago ----
async function seccionTipos(raiz, recargar) {
  const tipos = await listarTiposPago();
  const bancos = (await listarBancos()).filter((b) => b.activo);
  const cuentas = await listarCuentas(true);

  function formulario(t = null) {
    const nombre = texto(t?.nombre ?? '', 'Ej. Transferencia BHD');
    const metodo = h('select', { class: 'campo', 'aria-label': 'Método base' }, Object.entries(METODOS_PAGO).map(([k, v]) => h('option', { value: k }, v)));
    metodo.value = t?.metodo ?? 'efectivo';
    const banco = h('select', { class: 'campo', 'aria-label': 'Banco' }, h('option', { value: '' }, 'Ninguno'), bancos.map((b) => h('option', { value: String(b.id) }, b.nombre)));
    banco.value = t?.banco_id ? String(t.banco_id) : '';
    const cuenta = selectCuentas(cuentas, { valor: t?.cuenta_id || '', vacioTexto: 'Ninguna (usa Caja o Banco según el método)', tipos: ['activo', 'pasivo'] });
    const ref = h('input', { type: 'checkbox', checked: !!t?.requiere_ref, 'aria-label': 'Pide referencia' });
    const activo = h('input', { type: 'checkbox', checked: t ? !!t.activo : true, 'aria-label': 'Activo' });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(t ? 'Editar tipo de pago' : 'Nuevo tipo de pago', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), campo('Método base', metodo, 'Efectivo sale de la Caja general; tarjeta, transferencia y cheque salen del banco.'),
      campo('Banco', banco, 'Opcional: si el pago sale de una cuenta bancaria en particular.'), campo('O cuenta contable', cuenta, 'Opcional: otra cuenta (por ejemplo una tarjeta de crédito).'),
      h('label', { class: 'etiqueta' }, h('span', {}, 'Pedir número de referencia o cheque'), ref),
      h('label', { class: 'etiqueta' }, h('span', {}, 'Disponible'), activo), error,
      h('div', { class: 'acciones' },
        t ? h('button', { class: 'btn peligro', onClick: async () => {
          try { await eliminarTipoPago(t.id); cerrar(); toast('Eliminado'); await recargar(); } catch (e) { error.textContent = limpiar(e); }
        } }, 'Eliminar') : null,
        h('button', { class: 'btn primario', onClick: async () => {
          try {
            await guardarTipoPago({ id: t?.id ?? null, nombre: nombre.value, metodo: metodo.value, banco_id: Number(banco.value) || null, cuenta_id: Number(cuenta.value) || null, requiere_ref: ref.checked, activo: activo.checked });
            cerrar(); toast('Guardado'); await recargar();
          } catch (e) { error.textContent = limpiar(e); }
        } }, 'Guardar'))));
  }

  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Los tipos de pago son las formas con que pagas un gasto. Cada uno define de dónde sale el dinero para la contabilidad.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nuevo tipo de pago')),
    tipos.length ? h('div', { class: 'lista' }, tipos.map((t) => h('button', { class: `fila inventario ${t.activo ? '' : 'apagada'}`, onClick: () => formulario(t) },
      h('span', { class: 'datos' }, h('strong', {}, t.nombre),
        h('small', {}, [METODOS_PAGO[t.metodo], t.banco_nombre && `Banco: ${t.banco_nombre}`, t.cuenta_nombre && `Cuenta: ${t.cuenta_codigo} ${t.cuenta_nombre}`, t.requiere_ref ? 'pide referencia' : null].filter(Boolean).join(' · '))),
      h('span', { class: 'precio' }, `${t.n_gastos} ${t.n_gastos === 1 ? 'gasto' : 'gastos'}`))))
      : vacio('Aún no hay tipos de pago.'));
}

const SECCION_FN = { gastos: seccionGastos, reportes: seccionReportes, tipos: seccionTipos };
