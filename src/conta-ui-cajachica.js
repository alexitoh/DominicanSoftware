// conta-ui-cajachica.js - pestaña Caja chica: fondos fijos con custodio, desembolsos con vale, reposición y reporte
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import {
  listarCajasChicas, guardarCajaChica, aumentarFondo, registrarDesembolso, desembolsosPorReponer, reponerCajaChica, anularMovCajaChica,
  movimientosCajaChica, TIPOS_CAJA_CHICA, listarBancos, fechaHoy,
} from './conta-db.js';
import { r2 } from './conta-motor.js';
import { CATEGORIAS } from './caja.js';
import { campo, numero, fechaInput, texto, tabla, vacio, fechaCorta, limpiar, botonCSV, renglon } from './conta-ui-comun.js';

// Cuatro secciones: Caja Chica (fondos), Desembolso, Reporte Caja Chica y Reposición.
const SECCIONES_CC = [['caja', 'Caja Chica'], ['desembolso', 'Desembolso'], ['reporte', 'Reporte Caja Chica'], ['reposicion', 'Reposición']];
let seccionCC = 'caja';
let cajaElegida = null; // id de la caja chica con la que se trabaja en Desembolso, Reporte y Reposición

export async function vistaCajaChica(raiz) {
  const cuerpo = h('div');
  const barra = h('div', { class: 'segmento conta-tabs', role: 'tablist', 'aria-label': 'Caja chica' });
  async function ir(id) {
    seccionCC = id;
    barra.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    const nueva = h('div');
    try { await SECCION_FN[id](nueva, () => ir(id), ir); } catch (e) { nueva.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar: ${e.message || e}`)); }
    if (seccionCC === id) cuerpo.replaceChildren(nueva);
  }
  barra.append(...SECCIONES_CC.map(([id, t]) => h('button', { 'data-id': id, role: 'tab', onClick: () => ir(id) }, t)));
  raiz.replaceChildren(barra, cuerpo);
  await ir(seccionCC);
}

// Selector de caja chica para las secciones que trabajan sobre una. Devuelve { el, cajas, actual() }.
function selectorCaja(cajas, alCambiar) {
  const activas = cajas.filter((c) => c.activa);
  if (!activas.some((c) => c.id === cajaElegida)) cajaElegida = activas[0]?.id ?? null;
  const sel = h('select', { class: 'campo', 'aria-label': 'Caja chica' }, activas.map((c) => h('option', { value: String(c.id) }, `${c.nombre} · saldo ${dinero(c.saldo)}`)));
  if (cajaElegida) sel.value = String(cajaElegida);
  sel.addEventListener('change', () => { cajaElegida = Number(sel.value); alCambiar(); });
  return { el: sel, actual: () => cajas.find((c) => c.id === cajaElegida) || null };
}

const bancoSelect = async (vacioTexto = 'Caja general (efectivo)') => {
  const bancos = (await listarBancos()).filter((b) => b.activo);
  const s = h('select', { class: 'campo', 'aria-label': 'Origen del dinero' }, h('option', { value: '' }, vacioTexto), bancos.map((b) => h('option', { value: String(b.id) }, b.nombre)));
  return s;
};

// ---- Caja Chica: los fondos ----
async function seccionCaja(raiz, recargar, irA) {
  const cajas = await listarCajasChicas();

  async function formulario(c = null) {
    const nombre = texto(c?.nombre ?? '', 'Ej. Caja chica oficina');
    const custodio = texto(c?.custodio ?? '', 'Quién la maneja');
    const fondo = numero();
    const fecha = fechaInput(fechaHoy());
    const origen = await bancoSelect();
    const notas = texto(c?.notas ?? '', 'Opcional');
    const activa = h('input', { type: 'checkbox', checked: c ? !!c.activa : true, 'aria-label': 'Activa' });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(c ? 'Editar caja chica' : 'Nueva caja chica', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), campo('Custodio (responsable)', custodio),
      c ? null : h('div', {}, h('div', { class: 'rejilla' }, campo('Fondo inicial', fondo), campo('Fecha', fecha)),
        campo('El dinero sale de', origen, 'Se contabiliza: sube Caja chica y baja la Caja general o el banco que elijas.')),
      campo('Notas', notas),
      c ? h('label', { class: 'etiqueta' }, h('span', {}, 'Activa'), activa) : null, error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try {
          const id = await guardarCajaChica({ id: c?.id ?? null, nombre: nombre.value, custodio: custodio.value, notas: notas.value, activa: activa.checked, fondo: fondo.value, banco_id: Number(origen.value) || null, fecha: fecha.value });
          if (!c) cajaElegida = id;
          cerrar(); toast(c ? 'Guardada' : 'Caja chica creada'); await recargar();
        } catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar'))));
  }

  async function aumentar(c) {
    const monto = numero(), fecha = fechaInput(fechaHoy()), origen = await bancoSelect();
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(`Aumentar fondo · ${c.nombre}`, h('div', { class: 'cuerpo' },
      h('div', { class: 'rejilla' }, campo('Monto a agregar', monto), campo('Fecha', fecha)), campo('El dinero sale de', origen), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try { await aumentarFondo({ caja_chica_id: c.id, monto: monto.value, banco_id: Number(origen.value) || null, fecha: fecha.value }); cerrar(); toast('Fondo aumentado'); await recargar(); }
        catch (e) { error.textContent = limpiar(e); }
      } }, 'Aumentar'))));
  }

  function detalle(c) {
    const cerrar = hoja(c.nombre, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' }, renglon('Fondo autorizado', dinero(c.fondo)), renglon('Gastado sin reponer', dinero(c.por_reponer)), renglon('Disponible', dinero(c.saldo), 'gran')),
      h('p', { class: 'ayuda' }, `${c.custodio ? `Custodio: ${c.custodio}. ` : ''}${c.n_por_reponer} ${c.n_por_reponer === 1 ? 'desembolso pendiente' : 'desembolsos pendientes'} de reposición.`),
      h('div', { class: 'acciones' },
        h('button', { class: 'btn', onClick: () => { cerrar(); formulario(c); } }, 'Editar'),
        h('button', { class: 'btn', onClick: () => { cerrar(); aumentar(c); } }, 'Aumentar fondo'),
        c.activa ? h('button', { class: 'btn', onClick: () => { cajaElegida = c.id; cerrar(); irA('desembolso'); } }, 'Registrar desembolso') : null)));
  }

  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'La caja chica es un fondo fijo para gastos menores, a cargo de un custodio. Se gasta con vales (Desembolso) y se repone periódicamente hasta completar el fondo (Reposición).'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nueva caja chica')),
    cajas.length ? h('div', { class: 'lista' }, cajas.map((c) => h('button', { class: `fila inventario ${c.activa ? '' : 'apagada'}`, onClick: () => detalle(c) },
      h('span', { class: 'datos' }, h('strong', {}, c.nombre), h('small', {}, `${c.custodio || 'Sin custodio'} · fondo ${dinero(c.fondo)}${c.n_por_reponer ? ` · por reponer ${dinero(c.por_reponer)}` : ''}`)),
      h('span', { class: 'precio' }, dinero(c.saldo)))))
      : vacio('Crea tu primera caja chica con su fondo inicial.'));
}

// ---- Desembolso ----
async function seccionDesembolso(raiz, recargar, irA) {
  const cajas = await listarCajasChicas();
  const sel = selectorCaja(cajas, recargar);
  const c = sel.actual();
  if (!c) { raiz.replaceChildren(vacio('Primero crea una caja chica en la sección "Caja Chica".')); return; }

  const fecha = fechaInput(fechaHoy());
  const concepto = texto('', 'Ej. Compra de café y azúcar');
  const categoria = h('select', { class: 'campo', 'aria-label': 'Categoría' }, CATEGORIAS.map((x) => h('option', { value: x }, x)));
  categoria.value = 'Otros';
  const beneficiario = texto('', 'A quién se le pagó');
  const documento = texto('', 'RNC o cédula (opcional)');
  const comprobante = texto('', 'N.º de vale o recibo');
  const ncf = texto('', 'Ej. B1300000001 (opcional)');
  const itbis = numero(), monto = numero();
  const error = h('p', { class: 'error', role: 'alert' });
  const lista = h('div');

  async function pintarLista() {
    const movs = await movimientosCajaChica(c.id, { todos: true });
    const ds = movs.filter((m) => m.tipo === 'desembolso').slice(0, 20);
    lista.replaceChildren(ds.length ? h('div', { class: 'lista' }, ds.map((m) => h('div', { class: `fila inventario ${m.estado === 'anulado' ? 'apagada' : ''}` },
      h('span', { class: 'datos' }, h('strong', {}, m.concepto), h('small', {}, `${m.numero} · ${fechaCorta(m.fecha)}${m.beneficiario ? ` · ${m.beneficiario}` : ''}${m.ncf ? ` · ${m.ncf}` : ''}${m.estado === 'anulado' ? ' · anulado' : m.reposicion_numero ? ` · repuesto ${m.reposicion_numero}` : ''}`)),
      h('span', { class: 'precio' }, dinero(m.monto)),
      m.estado === 'vigente' && !m.reposicion_numero ? h('button', { class: 'btn chico', onClick: async () => {
        if (!(await confirmar('Anular desembolso', `Se anulará ${m.numero} y el dinero vuelve al fondo.`, 'Anular'))) return;
        try { await anularMovCajaChica(m.id); toast('Desembolso anulado'); await recargar(); } catch (e) { toast(limpiar(e), 'error'); }
      } }, 'Anular') : null)))
      : vacio('Todavía no hay desembolsos en esta caja.'));
  }

  async function guardar() {
    error.textContent = '';
    try {
      const n = await registrarDesembolso({ caja_chica_id: c.id, fecha: fecha.value, concepto: concepto.value, categoria: categoria.value, beneficiario: beneficiario.value,
        documento: documento.value, comprobante: comprobante.value, ncf: ncf.value, itbis: itbis.value, monto: monto.value });
      toast(`Desembolso ${n} registrado`); await recargar();
    } catch (e) { error.textContent = limpiar(e); }
  }

  raiz.replaceChildren(
    campo('Caja chica', sel.el),
    h('div', { class: 'totales' }, renglon('Disponible', dinero(c.saldo), 'gran')),
    h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('Monto pagado', monto)),
    campo('Concepto', concepto), campo('Categoría de gasto', categoria),
    h('div', { class: 'rejilla' }, campo('Beneficiario', beneficiario), campo('RNC / cédula', documento)),
    h('div', { class: 'rejilla' }, campo('N.º de vale / recibo', comprobante), campo('NCF', ncf, 'Con NCF entra al reporte 606.')),
    campo('ITBIS incluido en el monto', itbis),
    error,
    h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: guardar }, 'Registrar desembolso')),
    h('h3', { class: 'seccion' }, 'Últimos desembolsos'), lista);
  await pintarLista();
}

// ---- Reposición ----
async function seccionReposicion(raiz, recargar) {
  const cajas = await listarCajasChicas();
  const sel = selectorCaja(cajas, recargar);
  const c = sel.actual();
  if (!c) { raiz.replaceChildren(vacio('Primero crea una caja chica en la sección "Caja Chica".')); return; }
  const pend = await desembolsosPorReponer(c.id);
  const elegidos = new Set(pend.map((d) => d.id));
  const fecha = fechaInput(fechaHoy());
  const origen = await bancoSelect();
  const resumen = h('div', { class: 'totales' });
  const error = h('p', { class: 'error', role: 'alert' });
  const total = () => r2(pend.filter((d) => elegidos.has(d.id)).reduce((s, d) => s + d.monto, 0));
  const pintarTotal = () => resumen.replaceChildren(renglon('A reponer', dinero(total()), 'gran'), renglon('Disponible después', dinero(r2(c.saldo + total()))));
  pintarTotal();

  async function reponer() {
    error.textContent = '';
    try {
      const r = await reponerCajaChica({ caja_chica_id: c.id, fecha: fecha.value, banco_id: Number(origen.value) || null, ids: [...elegidos] });
      toast(`Reposición ${r.numero} por ${dinero(r.monto)}`); await recargar();
    } catch (e) { error.textContent = limpiar(e); }
  }

  const reposiciones = (await movimientosCajaChica(c.id, { todos: true })).filter((m) => m.tipo === 'reposicion').slice(0, 15);
  raiz.replaceChildren(
    campo('Caja chica', sel.el),
    h('p', { class: 'ayuda' }, 'Repone lo gastado para que el fondo vuelva a su monto. El dinero sale de la Caja general o del banco que elijas.'),
    pend.length ? h('div', { class: 'lista' }, pend.map((d) => h('label', { class: 'fila inventario' },
      h('input', { type: 'checkbox', checked: true, 'aria-label': `Reponer ${d.concepto}`, onChange: (e) => { if (e.target.checked) elegidos.add(d.id); else elegidos.delete(d.id); pintarTotal(); } }),
      h('span', { class: 'datos' }, h('strong', {}, d.concepto), h('small', {}, `${d.numero} · ${fechaCorta(d.fecha)}${d.ncf ? ` · ${d.ncf}` : ''}`)),
      h('span', { class: 'precio' }, dinero(d.monto)))))
      : vacio('No hay desembolsos pendientes de reponer.'),
    resumen,
    pend.length ? h('div', {}, h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('El dinero sale de', origen)), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: reponer }, 'Hacer reposición'))) : null,
    h('h3', { class: 'seccion' }, 'Reposiciones hechas'),
    reposiciones.length ? h('div', { class: 'lista' }, reposiciones.map((m) => h('div', { class: `fila inventario ${m.estado === 'anulado' ? 'apagada' : ''}` },
      h('span', { class: 'datos' }, h('strong', {}, m.numero), h('small', {}, `${fechaCorta(m.fecha)} · ${m.concepto}${m.estado === 'anulado' ? ' · anulada' : ''}`)),
      h('span', { class: 'precio' }, dinero(m.monto)),
      m.estado === 'vigente' ? h('button', { class: 'btn chico', onClick: async () => {
        if (!(await confirmar('Anular reposición', `Se anulará ${m.numero}; sus desembolsos vuelven a quedar pendientes.`, 'Anular'))) return;
        try { await anularMovCajaChica(m.id); toast('Reposición anulada'); await recargar(); } catch (e) { toast(limpiar(e), 'error'); }
      } }, 'Anular') : null)))
      : vacio('Todavía no hay reposiciones.'));
}

// ---- Reporte Caja Chica ----
async function seccionReporte(raiz, recargar) {
  const cajas = await listarCajasChicas();
  const sel = selectorCaja(cajas, recargar);
  const c = sel.actual();
  if (!c) { raiz.replaceChildren(vacio('Primero crea una caja chica en la sección "Caja Chica".')); return; }
  const hoy = fechaHoy();
  const desde = fechaInput(`${hoy.slice(0, 7)}-01`), hasta = fechaInput(hoy);
  const cuerpo = h('div');

  async function pintar() {
    const movs = (await movimientosCajaChica(c.id, { desde: desde.value || '0000-00-00', hasta: hasta.value || hoy })).reverse();
    const des = movs.filter((m) => m.tipo === 'desembolso');
    const totDes = r2(des.reduce((s, m) => s + m.monto, 0));
    const itbis = r2(des.reduce((s, m) => s + m.itbis, 0));
    const rep = r2(movs.filter((m) => m.tipo === 'reposicion').reduce((s, m) => s + m.monto, 0));
    const porCat = new Map();
    for (const m of des) porCat.set(m.categoria || 'Otros', r2((porCat.get(m.categoria || 'Otros') || 0) + m.monto - m.itbis));
    const filas = movs.map((m) => [fechaCorta(m.fecha), m.numero, TIPOS_CAJA_CHICA[m.tipo], [m.concepto, m.beneficiario].filter(Boolean).join(' · '), m.ncf || '',
      m.tipo === 'desembolso' ? `- ${dinero(m.monto)}` : `+ ${dinero(m.monto)}`]);
    cuerpo.replaceChildren(
      h('div', { class: 'totales' },
        renglon('Fondo autorizado', dinero(c.fondo)), renglon('Desembolsado en el período', dinero(totDes)), renglon('ITBIS incluido', dinero(itbis)),
        renglon('Repuesto en el período', dinero(rep)), renglon('Disponible hoy', dinero(c.saldo), 'gran'),
        renglon('Pendiente de reponer hoy', dinero(c.por_reponer))),
      h('h3', { class: 'seccion' }, 'Desembolsos por categoría (sin ITBIS)'),
      porCat.size ? tabla(['Categoría', 'Total'], [...porCat.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, dinero(v)]), { num: [1] }) : vacio('Sin desembolsos en el período.'),
      h('h3', { class: 'seccion' }, 'Movimientos'),
      filas.length ? tabla(['Fecha', 'N.º', 'Tipo', 'Detalle', 'NCF', 'Monto'], filas, { num: [5] }) : vacio('Sin movimientos en el período.'),
      filas.length ? botonCSV(`caja-chica-${c.nombre}`, ['Fecha', 'Número', 'Tipo', 'Detalle', 'NCF', 'Monto'], filas) : null);
  }
  desde.addEventListener('change', pintar); hasta.addEventListener('change', pintar);
  raiz.replaceChildren(campo('Caja chica', sel.el), h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), cuerpo);
  await pintar();
}

const SECCION_FN = { caja: seccionCaja, desembolso: seccionDesembolso, reporte: seccionReporte, reposicion: seccionReposicion };
