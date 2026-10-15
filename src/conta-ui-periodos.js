// conta-ui-periodos.js - pestaña Períodos: Período Contable (cierre mensual) y Período Fiscal (declaraciones DGII)
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import {
  resumenPeriodos, cerrarPeriodo, reabrirPeriodo, cerrarPeriodosHasta, cerrarEjercicio, fechaHoy,
  FORMULARIOS_FISCALES, estadoDeclaracion, configFiscalPeriodo, guardarMesInicioFiscal, mesesFiscales, listarDeclaraciones, marcarDeclaracion, quitarDeclaracion,
} from './conta-db.js';
import { campo, fechaInput, texto, tabla, vacio, fechaCorta, limpiar } from './conta-ui-comun.js';

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const nombreMes = (p) => `${MESES[parseInt(p.slice(5, 7), 10) - 1]} ${p.slice(0, 4)}`;
let seccion = 'contable';
let anioVista = null;

export async function vistaPeriodos(raiz) {
  anioVista = anioVista || Number(fechaHoy().slice(0, 4));
  const cuerpo = h('div');
  const barra = h('div', { class: 'segmento conta-tabs', role: 'tablist', 'aria-label': 'Períodos' });
  async function ir(id) {
    seccion = id;
    barra.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    const nueva = h('div');
    try { await (id === 'contable' ? contable : fiscal)(nueva, () => ir(id)); } catch (e) { nueva.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar: ${e.message || e}`)); }
    if (seccion === id) cuerpo.replaceChildren(nueva);
  }
  barra.append(...[['contable', 'Período Contable'], ['fiscal', 'Período Fiscal']].map(([id, t]) => h('button', { 'data-id': id, role: 'tab', onClick: () => ir(id) }, t)));
  raiz.replaceChildren(barra, cuerpo);
  await ir(seccion);
}

function selectorAnio(recargar) {
  const hoyA = Number(fechaHoy().slice(0, 4));
  const sel = h('select', { class: 'campo', 'aria-label': 'Año' }, Array.from({ length: 8 }, (_, i) => hoyA + 1 - i).map((a) => h('option', { value: String(a) }, String(a))));
  sel.value = String(anioVista);
  sel.addEventListener('change', () => { anioVista = Number(sel.value); recargar(); });
  return campo('Año', sel);
}

async function contable(raiz, recargar) {
  const r = await resumenPeriodos(anioVista);
  const hoyMes = fechaHoy().slice(0, 7);
  async function accion(fn, msg) { try { await fn(); toast(msg); await recargar(); } catch (e) { toast(limpiar(e), 'error'); } }
  const ultimoMes = [...r.meses].reverse().find((m) => m.asientos > 0 && m.mes <= hoyMes)?.mes || `${anioVista}-01`;
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Un mes cerrado no admite nuevos movimientos, ni anulaciones, con fecha dentro de él. Ciérralo cuando ya revisaste todo; puedes reabrirlo si hace falta.'),
    selectorAnio(recargar),
    r.ejercicioCerrado ? h('p', { class: 'ayuda' }, `Ejercicio ${anioVista} cerrado con el asiento ${r.ejercicioCerrado}.`) : null,
    h('div', { class: 'lista' }, r.meses.map((m) => h('div', { class: 'fila inventario' },
      h('span', { class: 'datos' }, h('strong', {}, nombreMes(m.mes)), h('small', {}, `${m.asientos} ${m.asientos === 1 ? 'asiento' : 'asientos'} · movimiento ${dinero(m.debitos)} · ${m.cerrado ? 'Cerrado' : (m.mes > hoyMes ? 'Futuro' : 'Abierto')}`)),
      h('button', { class: `btn ${m.cerrado ? '' : 'primario'}`, 'aria-label': `${m.cerrado ? 'Reabrir' : 'Cerrar'} ${nombreMes(m.mes)}`, onClick: async () => {
        if (m.cerrado) { if (await confirmar('Reabrir período', `Se podrán registrar movimientos en ${nombreMes(m.mes)}.`, 'Reabrir')) await accion(() => reabrirPeriodo(m.mes), 'Período reabierto'); }
        else await accion(() => cerrarPeriodo(m.mes), 'Período cerrado');
      } }, m.cerrado ? 'Reabrir' : 'Cerrar')))),
    h('div', { class: 'acciones' },
      h('button', { class: 'btn', onClick: async () => {
        if (await confirmar('Cerrar varios períodos', `Se cerrarán todos los meses de enero hasta ${nombreMes(ultimoMes)}.`, 'Cerrar')) await accion(async () => { await cerrarPeriodosHasta(ultimoMes); }, 'Períodos cerrados');
      } }, `Cerrar hasta ${nombreMes(ultimoMes)}`),
      r.ejercicioCerrado ? null : h('button', { class: 'btn', onClick: async () => {
        if (await confirmar('Cerrar el ejercicio', `Se genera el asiento de cierre ${anioVista}: pasa la utilidad del año a patrimonio y deja los ingresos y gastos en cero.`, 'Cerrar ejercicio')) await accion(() => cerrarEjercicio(anioVista), 'Ejercicio cerrado');
      } }, `Cerrar ejercicio ${anioVista}`)));
}

const COLORES = { presentada: 'Presentada', porpresentar: 'Por presentar', vencida: 'Vencida', pendiente: 'Pendiente' };

async function fiscal(raiz, recargar) {
  const { mesInicio } = await configFiscalPeriodo();
  const periodos = mesesFiscales(anioVista, mesInicio);
  const decl = await listarDeclaraciones(periodos);
  const mapa = new Map(decl.map((d) => [d.clave, d]));
  const hoy = fechaHoy();

  function formulario(periodo, form, titulo) {
    const d = mapa.get(`${periodo}:${form}`);
    const fecha = fechaInput(d?.fecha_presentada || hoy), ref = texto(d?.referencia ?? '', 'N.º de acuse (opcional)'), notas = texto(d?.notas ?? '', 'Opcional');
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(`${titulo} · ${nombreMes(periodo)}`, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, 'Marca la declaración como presentada a la DGII. El sistema no la envía: es solo tu control.'),
      campo('Fecha de presentación', fecha), campo('Referencia', ref), campo('Notas', notas), error,
      h('div', { class: 'acciones' },
        d ? h('button', { class: 'btn peligro', onClick: async () => { try { await quitarDeclaracion(periodo, form); cerrar(); toast('Marca quitada'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Quitar marca') : null,
        h('button', { class: 'btn primario', onClick: async () => {
          try { await marcarDeclaracion({ periodo, formulario: form, fecha: fecha.value, referencia: ref.value, notas: notas.value }); cerrar(); toast('Marcada como presentada'); await recargar(); }
          catch (e) { error.textContent = limpiar(e); }
        } }, 'Marcar presentada'))));
  }

  const inicio = h('select', { class: 'campo', 'aria-label': 'Mes de inicio del año fiscal' }, MESES.map((m, i) => h('option', { value: String(i + 1) }, m)));
  inicio.value = String(mesInicio);
  inicio.addEventListener('change', async () => { try { await guardarMesInicioFiscal(inicio.value); toast('Año fiscal actualizado'); await recargar(); } catch (e) { toast(limpiar(e), 'error'); } });

  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Control de las declaraciones mensuales a la DGII. Toca un formulario para marcarlo como presentado. Los vencimientos mostrados (día 15 para 606/607/608 y día 20 para IT-1, del mes siguiente) son referencia: confírmalos con la DGII o tu contador.'),
    h('div', { class: 'rejilla' }, selectorAnio(recargar), campo('El año fiscal empieza en', inicio)),
    h('div', { class: 'lista' }, periodos.map((p) => h('div', { class: 'fila inventario' },
      h('span', { class: 'datos' }, h('strong', {}, nombreMes(p)),
        h('small', {}, FORMULARIOS_FISCALES.map(([f, t]) => {
          const d = mapa.get(`${p}:${f}`);
          const e = estadoDeclaracion(p, f, !!d, hoy);
          return `${f}: ${COLORES[e]}${d ? ` (${fechaCorta(d.fecha_presentada)})` : ''}`;
        }).join(' · '))),
      h('span', { class: 'acciones' }, FORMULARIOS_FISCALES.map(([f, t]) => {
        const e = estadoDeclaracion(p, f, mapa.has(`${p}:${f}`), hoy);
        return h('button', { class: `btn ${e === 'vencida' ? 'peligro' : (e === 'presentada' ? '' : 'primario')}`, 'aria-label': `${t} ${nombreMes(p)}: ${COLORES[e]}`, onClick: () => formulario(p, f, t) }, f);
      }))))));
}
