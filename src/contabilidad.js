// contabilidad.js - módulo Contabilidad: pantalla principal con pestañas
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import {
  libroContable, fechaHoy, configConta, guardarInicioConta, periodosCerrados, cerrarPeriodo, reabrirPeriodo, cerrarEjercicio,
  listarCentros, guardarCentro, listarPresupuestos, guardarPresupuesto, listarCuentas, saldosPorCobrar, saldosPorPagar,
} from './conta-db.js';
import { balanceGeneral, estadoResultados, presupuestoVsReal, r2 } from './conta-motor.js';
import { ROLES } from './conta-plan.js';
import { vistaCuentas } from './conta-ui-asientos.js';
import { vistaDiarios } from './conta-ui-diarios.js';
import { vistaGastos } from './conta-ui-gastos.js';
import { vistaPeriodos } from './conta-ui-periodos.js';
import { vistaBancos } from './conta-ui-bancos.js';
import { vistaActivos, vistaNomina } from './conta-ui-activos.js';
import { vistaReportes } from './conta-ui-reportes.js';
import { vistaCuadreCaja } from './caja.js';
import { vistaCuentas as vistaCxp } from './cuentas.js';
import { vistaCxc } from './cxc.js';
import { vistaCajaChica } from './conta-ui-cajachica.js';
import { campo, numero, fechaInput, texto, selectCuentas, tabla, vacio, limpiar } from './conta-ui-comun.js';

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

async function vistaResumen(raiz) {
  const hoy = fechaHoy();
  const lib = await libroContable();
  const b = balanceGeneral(lib.cuentas, lib.lineas, hoy);
  const e = estadoResultados(lib.cuentas, lib.lineas, `${hoy.slice(0, 4)}-01-01`, hoy);
  const efectivo = r2(b.activos.filter((x) => ['caja', 'banco'].includes(x.cuenta.rol) || x.cuenta.codigo.startsWith('111')).reduce((s, x) => s + x.monto, 0));
  const [cxc, cxp] = await Promise.all([saldosPorCobrar(), saldosPorPagar()]);
  const suma = (xs) => r2(xs.reduce((s, x) => s + x.saldo, 0));
  const tarjeta = (t, v, extra = '') => h('div', {}, h('span', {}, t), h('span', { class: extra }, dinero(v)));
  raiz.replaceChildren(
    lib.faltantes.length ? h('p', { class: 'error', style: 'padding:.5rem 1rem' }, `Falta asignar cuenta a: ${lib.faltantes.map((r) => ROLES[r] || r).join(', ')}. Esos documentos no se contabilizan hasta que lo hagas (pestaña Cuentas).`) : null,
    !b.cuadra ? h('p', { class: 'error', style: 'padding:.5rem 1rem' }, `El balance no cuadra (diferencia ${dinero(b.diferencia)}). Revisa los asientos manuales.`) : null,
    h('h3', { class: 'seccion' }, `Situación al ${hoy.split('-').reverse().join('/')}`),
    h('div', { class: 'totales' }, tarjeta('Efectivo en caja y bancos', efectivo), tarjeta('Por cobrar', suma(cxc)), tarjeta('Por pagar', suma(cxp), 'deuda')),
    h('div', { class: 'totales' }, tarjeta('Activos', b.totalActivos), tarjeta('Pasivos', b.totalPasivos), tarjeta('Patrimonio', b.totalPatrimonio)),
    h('h3', { class: 'seccion' }, `Resultados del año ${hoy.slice(0, 4)}`),
    h('div', { class: 'totales' }, tarjeta('Ingresos', e.totalIngresos), tarjeta('Costos y gastos', r2(e.totalCostos + e.totalGastos)), tarjeta('Utilidad', e.utilidadNeta, e.utilidadNeta < 0 ? 'deuda' : '')),
    h('p', { class: 'ayuda', style: 'padding:.75rem 1rem' }, lib.inicio ? `Contabilidad desde el ${lib.inicio.split('-').reverse().join('/')}.` : 'La contabilidad toma todos los documentos del sistema. Si ya tenías operaciones antes, registra los saldos de apertura y fija la fecha de inicio en Ajustes.'),
    h('p', { class: 'ayuda', style: 'padding:0 1rem 1rem' }, 'Ventas, cobros, compras, pagos, gastos, activos, nómina y bancos generan sus asientos solos. Para otros movimientos usa Asientos → Nuevo asiento.'));
}

async function vistaPresupuesto(raiz) {
  const est = { anio: Number(fechaHoy().slice(0, 4)) };
  const cont = h('div');
  const anio = h('input', { class: 'campo', type: 'number', value: est.anio, min: 2000, max: 2100, 'aria-label': 'Año', onChange: (e) => { est.anio = Number(e.target.value); pintar(); } });
  raiz.replaceChildren(h('div', { class: 'filtros' }, campo('Año', anio), h('button', { class: 'btn primario', onClick: () => editar() }, 'Definir presupuesto de una cuenta')), cont);

  async function pintar() {
    const [lib, pres] = await Promise.all([libroContable({ hasta: `${est.anio}-12-31` }), listarPresupuestos(est.anio)]);
    const filas = presupuestoVsReal(lib.cuentas, lib.lineas, pres, est.anio);
    cont.replaceChildren(filas.length ? tabla(['Cuenta', 'Presupuesto', 'Real', 'Diferencia'], filas.map((f) => [h('button', { class: 'enlace', onClick: () => editar(f.cuenta) }, `${f.cuenta.codigo} · ${f.cuenta.nombre}`), dinero(f.presupuesto), dinero(f.real), h('span', { class: f.diferencia < 0 ? 'deuda' : '' }, dinero(f.diferencia))]), { num: [1, 2, 3] })
      : vacio('Aún no hay presupuesto para este año. Define montos mensuales por cuenta de ingresos, costos o gastos para compararlos con lo real.'),
    filas.length ? h('p', { class: 'ayuda' }, 'Diferencia = presupuesto − real. En gastos, negativo significa que te pasaste.') : null);
  }

  async function editar(cuenta = null) {
    const cuentas = await listarCuentas(true);
    const sel = selectCuentas(cuentas, { valor: cuenta?.id, tipos: ['ingreso', 'costo', 'gasto'] });
    const cajas = MESES.map(() => numero(''));
    const cargar = async () => {
      const id = Number(sel.value);
      const ps = await listarPresupuestos(est.anio);
      cajas.forEach((c, i) => { c.value = ps.find((p) => p.cuenta_id === id && p.mes === i + 1)?.monto || ''; });
    };
    sel.addEventListener('change', cargar); await cargar();
    const anual = numero('');
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(`Presupuesto ${est.anio}`, h('div', { class: 'cuerpo' }, campo('Cuenta', sel),
      campo('Total anual (se reparte en partes iguales)', anual, 'Opcional: escribe un total y se llenan los 12 meses.'),
      h('button', { class: 'btn', onClick: () => { const t = parseFloat(anual.value); if (t > 0) cajas.forEach((c) => { c.value = r2(t / 12); }); } }, 'Repartir'),
      h('div', { class: 'rejilla' }, MESES.map((m, i) => h('label', { class: 'etiqueta chica' }, m, cajas[i]))), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try { if (!sel.value) throw new Error('Elige la cuenta.'); await guardarPresupuesto(est.anio, Number(sel.value), cajas.map((c) => parseFloat(c.value) || 0)); cerrar(); toast('Presupuesto guardado'); await pintar(); }
        catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar'))));
  }
  await pintar();
}

async function vistaAjustes(raiz) {
  const [cfg, cerrados, centros] = await Promise.all([configConta(), periodosCerrados(), listarCentros()]);
  const inicio = fechaInput(cfg.inicio);
  const periodo = h('input', { class: 'campo', type: 'month', value: fechaHoy().slice(0, 7), 'aria-label': 'Mes a cerrar' });
  const anio = h('input', { class: 'campo', type: 'number', value: Number(fechaHoy().slice(0, 4)) - 1, min: 2000, max: 2100, 'aria-label': 'Año a cerrar' });
  const refrescar = () => vistaAjustes(raiz);
  const probar = async (fn, ok) => { try { await fn(); toast(ok); await refrescar(); } catch (e) { toast(limpiar(e), 'error'); } };

  function centro(c = null) {
    const nombre = texto(c?.nombre ?? ''), codigo = texto(c?.codigo ?? '', 'Código (opcional)');
    const activo = h('input', { type: 'checkbox', checked: c ? !!c.activo : true });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(c ? 'Editar centro de costo' : 'Nuevo centro de costo', h('div', { class: 'cuerpo' }, campo('Nombre', nombre, 'Ej. Tienda principal, Instalaciones, Taller'), campo('Código', codigo),
      c ? h('label', { class: 'etiqueta' }, activo, ' Activo') : null, error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try { await guardarCentro({ id: c?.id ?? null, codigo: codigo.value, nombre: nombre.value, activo: activo.checked ? 1 : 0 }); cerrar(); await refrescar(); } catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar'))));
  }

  raiz.replaceChildren(
    h('h3', { class: 'seccion' }, 'Fecha de inicio de la contabilidad'),
    h('div', { class: 'cuerpo' }, campo('Contar documentos desde', inicio, 'Vacío = todos. Si ya registraste saldos de apertura, pon aquí la fecha de ese asiento para no contar dos veces lo anterior.'),
      h('button', { class: 'btn', onClick: () => probar(() => guardarInicioConta(inicio.value), 'Fecha guardada') }, 'Guardar fecha')),
    h('h3', { class: 'seccion' }, 'Cierre de períodos'),
    h('div', { class: 'cuerpo' }, h('p', { class: 'ayuda' }, 'Un mes cerrado no permite crear ni anular asientos, movimientos de banco, activos o nóminas con fecha en ese mes. No bloquea las ventas ni las compras normales.'),
      h('div', { class: 'rejilla' }, campo('Mes', periodo), h('button', { class: 'btn', onClick: () => probar(() => cerrarPeriodo(periodo.value), 'Período cerrado') }, 'Cerrar mes')),
      cerrados.length ? h('div', { class: 'lista' }, cerrados.map((p) => h('div', { class: 'fila inventario' }, h('span', { class: 'datos' }, h('strong', {}, p)),
        h('button', { class: 'btn chico', onClick: () => probar(() => reabrirPeriodo(p), 'Período reabierto') }, 'Reabrir')))) : vacio('No hay períodos cerrados.')),
    h('h3', { class: 'seccion' }, 'Cierre del ejercicio'),
    h('div', { class: 'cuerpo' }, h('p', { class: 'ayuda' }, 'Al terminar el año, salda ingresos, costos y gastos contra Utilidad del ejercicio con un asiento de cierre. Los reportes de resultados no lo cuentan.'),
      h('div', { class: 'rejilla' }, campo('Año', anio), h('button', { class: 'btn peligro', onClick: async () => {
        if (!(await confirmar('Cerrar ejercicio', `Se generará el asiento de cierre del ${anio.value}.`, 'Cerrar'))) return;
        probar(async () => { await cerrarEjercicio(anio.value); }, 'Ejercicio cerrado');
      } }, 'Cerrar ejercicio'))),
    h('h3', { class: 'seccion' }, 'Centros de costo'),
    h('div', { class: 'cuerpo' }, h('button', { class: 'btn', onClick: () => centro() }, 'Nuevo centro de costo'),
      centros.length ? h('div', { class: 'lista' }, centros.map((c) => h('button', { class: `fila inventario ${c.activo ? '' : 'apagada'}`, onClick: () => centro(c) }, h('span', { class: 'datos' }, h('strong', {}, c.nombre), h('small', {}, c.codigo || '— ')))))
        : vacio('Sin centros de costo.')));
}

const TABS = [
  ['resumen', 'Resumen', vistaResumen], ['asientos', 'Asientos', vistaDiarios], ['cuentas', 'Cuentas', vistaCuentas], ['bancos', 'Bancos', vistaBancos], ['cxc', 'CXC', vistaCxc], ['cxp', 'CXP', vistaCxp], ['cuadre', 'Cuadre de caja', vistaCuadreCaja], ['cajachica', 'Caja chica', vistaCajaChica], ['gastos', 'Gastos', vistaGastos],
  ['activos', 'Activos fijos', vistaActivos], ['nomina', 'Nómina', vistaNomina], ['reportes', 'Reportes', vistaReportes], ['periodos', 'Períodos', vistaPeriodos], ['presupuesto', 'Presupuesto', vistaPresupuesto], ['ajustes', 'Ajustes', vistaAjustes],
];
let tabActual = 'resumen';
// Abre Contabilidad directamente en una pestaña (por ejemplo, desde un aviso del inicio)
export const abrirPestana = (id) => { if (TABS.some((t) => t[0] === id)) tabActual = id; };

export async function vistaContabilidad(raiz) {
  const cuerpo = h('div', { class: 'conta-cuerpo' });
  const barra = h('div', { class: 'segmento conta-tabs', role: 'tablist', 'aria-label': 'Secciones de contabilidad' });
  async function mostrar(id) {
    tabActual = id;
    barra.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    cuerpo.replaceChildren(h('p', { class: 'ayuda vacio-chico' }, 'Cargando…'));
    const nueva = h('div');
    try { await TABS.find((t) => t[0] === id)[2](nueva); } catch (e) { nueva.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar: ${e.message || e}`)); }
    if (tabActual === id) cuerpo.replaceChildren(nueva);
  }
  barra.append(...TABS.map(([id, t]) => h('button', { 'data-id': id, role: 'tab', onClick: () => mostrar(id) }, t)));
  raiz.replaceChildren(barra, cuerpo);
  await mostrar(tabActual);
}
