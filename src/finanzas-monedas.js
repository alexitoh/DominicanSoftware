// finanzas-monedas.js - Finanzas: Conversión Moneda, Diferencia Cambiaria y Reporte Dinámico
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { libroContable, listarCentros, listarCuentas, fechaHoy } from './conta-db.js';
import {
  listarMonedas, guardarMoneda, eliminarMoneda, listarTasas, guardarTasa, eliminarTasa, convertirMoneda,
  listarPartidas, guardarPartida, eliminarPartida, revaluar, contabilizarDiferencia, historialDiferencias,
} from './finanzas-db.js';
import { tablaDinamicaLibro, FILAS_DINAMICO, COLUMNAS_DINAMICO, MEDIDAS_DINAMICO } from './finanzas-motor.js';
import { TIPOS_CUENTA } from './conta-plan.js';
import { campo, numero, fechaInput, texto, selectCuentas, tabla, botonCSV, vacio, fechaCorta, limpiar, renglon, nombreTipo } from './conta-ui-comun.js';

const selectDe = (items, valor = '', etiqueta = 'Elegir') => {
  const s = h('select', { class: 'campo', 'aria-label': etiqueta }, items.map(([v, t]) => h('option', { value: String(v) }, t)));
  s.value = String(valor);
  if (s.value === '' && items.length) s.value = String(items[0][0]);
  return s;
};
const tasaTxt = (t) => (t == null ? 'sin tasa' : `${Number(t).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`);

// ---------- Conversión Moneda ----------
export async function seccionMonedas(raiz, recargar) {
  const monedas = await listarMonedas();
  const activas = monedas.filter((m) => m.activa);
  const opciones = [['BASE', 'Peso dominicano (DOP)'], ...activas.map((m) => [m.id, `${m.nombre} (${m.codigo})`])];
  const monto = numero(''); const de = selectDe(opciones, activas[0]?.id ?? 'BASE', 'De'); const a = selectDe(opciones, 'BASE', 'A'); const fecha = fechaInput(fechaHoy());
  const res = h('div', { class: 'totales' });
  async function convertir() {
    if (!(Number(monto.value) > 0)) { res.replaceChildren(h('small', { class: 'ayuda' }, 'Escribe un monto para convertir.')); return; }
    try {
      const r = await convertirMoneda({ monto: Number(monto.value), de: de.value === 'BASE' ? 'BASE' : Number(de.value), a: a.value === 'BASE' ? 'BASE' : Number(a.value), fecha: fecha.value || fechaHoy() });
      res.replaceChildren(renglon('Resultado', r.resultado.toFixed(2), 'gran'), h('small', { class: 'ayuda' }, `Tasa usada: ${tasaTxt(r.tasaDe)} → ${tasaTxt(r.tasaA)} pesos`));
    } catch (e) { res.replaceChildren(h('p', { class: 'error' }, limpiar(e))); }
  }
  for (const el of [monto, de, a, fecha]) el.addEventListener('input', convertir);

  const lista = h('div', { class: 'lista' }, monedas.length ? monedas.map((m) => h('button', { class: `fila inventario ${m.activa ? '' : 'apagada'}`, onClick: () => detalle(m) },
    h('span', { class: 'datos' }, h('strong', {}, `${m.codigo} · ${m.nombre}`), h('small', {}, m.tasa_actual ? `1 ${m.codigo} = ${tasaTxt(m.tasa_actual)} DOP al ${fechaCorta(m.fecha_tasa)}` : 'Sin tasa registrada')),
    h('span', { class: 'precio' }, m.activa ? '' : 'inactiva'))) : [vacio('Aún no hay monedas.')]);

  function formMoneda(m = null) {
    const codigo = texto(m?.codigo || '', 'USD'); const nombre = texto(m?.nombre || ''); const simbolo = texto(m?.simbolo || '', '$');
    const activa = selectDe([['1', 'Activa'], ['0', 'Inactiva']], m ? (m.activa ? '1' : '0') : '1', 'Estado'); const error = h('p', { class: 'error' });
    const cerrar = hoja(m ? 'Editar moneda' : 'Nueva moneda', h('div', { class: 'cuerpo' }, campo('Código', codigo), campo('Nombre', nombre), campo('Símbolo', simbolo), campo('Estado', activa), error,
      h('div', { class: 'acciones' },
        h('button', { class: 'btn primario', onClick: async () => { try { await guardarMoneda({ id: m?.id || null, codigo: codigo.value, nombre: nombre.value, simbolo: simbolo.value, activa: activa.value === '1' }); cerrar(); toast('Moneda guardada'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Guardar'),
        m ? h('button', { class: 'btn peligro', onClick: async () => { if (!(await confirmar('Eliminar moneda', `¿Eliminar ${m.codigo} y sus tasas?`, 'Eliminar'))) return; try { await eliminarMoneda(m.id); cerrar(); toast('Moneda eliminada'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Eliminar') : null)));
  }
  async function detalle(m) {
    const tasa = numero(''); const f = fechaInput(fechaHoy()); const error = h('p', { class: 'error' }); const hist = h('div');
    async function pintar() {
      const ts = await listarTasas(m.id);
      hist.replaceChildren(ts.length ? tabla(['Fecha', 'Tasa', ''], ts.slice(0, 30).map((t) => [fechaCorta(t.fecha), tasaTxt(t.tasa), h('button', { class: 'enlace', onClick: async () => { await eliminarTasa(t.id); await pintar(); await recargar(); } }, 'Quitar')]), { num: [1] }) : vacio('Sin tasas todavía.'));
    }
    hoja(`${m.codigo} · tasas de cambio`, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, `Cuántos pesos vale 1 ${m.codigo}. Si registras una tasa para una fecha que ya existe, se reemplaza.`),
      h('div', { class: 'rejilla' }, campo('Fecha', f), campo('Tasa en pesos', tasa)), error,
      h('div', { class: 'acciones' },
        h('button', { class: 'btn primario', onClick: async () => { error.textContent = ''; try { await guardarTasa({ moneda_id: m.id, fecha: f.value, tasa: tasa.value }); tasa.value = ''; toast('Tasa guardada'); await pintar(); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Guardar tasa'),
        h('button', { class: 'btn', onClick: () => formMoneda(m) }, 'Editar moneda')), hist));
    await pintar();
  }

  const pie = h('div', { class: 'totales' });
  try {
    const lib = await libroContable({ hasta: fechaHoy() });
    const caja = lib.cuentas.filter((c) => !c.grupo && (c.rol === 'caja' || c.rol === 'banco'));
    const saldo = caja.reduce((s, c) => s + lib.lineas.filter((l) => l.cuenta_id === c.id).reduce((x, l) => x + l.debe - l.haber, 0), 0);
    const filas = [];
    for (const m of activas) { if (!m.tasa_actual) continue; filas.push(renglon(`Efectivo y bancos en ${m.codigo}`, `${(saldo / m.tasa_actual).toFixed(2)} ${m.codigo}`)); }
    pie.replaceChildren(renglon('Efectivo y bancos (DOP)', dinero(saldo), 'gran'), ...filas);
  } catch { /* sin pie */ }

  raiz.replaceChildren(
    h('h3', { class: 'seccion' }, 'Convertidor'),
    h('div', { class: 'rejilla' }, campo('Monto', monto), campo('Fecha de la tasa', fecha)), h('div', { class: 'rejilla' }, campo('De', de), campo('A', a)), res,
    h('h3', { class: 'seccion' }, 'Monedas y tasas'), h('button', { class: 'btn primario', onClick: () => formMoneda() }, 'Nueva moneda'), lista, pie);
  await convertir();
}

// ---------- Diferencia Cambiaria ----------
export async function seccionDiferencia(raiz, recargar) {
  const [monedas, cuentas, partidas, hist] = await Promise.all([listarMonedas(), listarCuentas(true), listarPartidas(), historialDiferencias()]);
  const fecha = fechaInput(fechaHoy());
  const cuerpo = h('div');
  async function pintar() {
    const r = await revaluar(fecha.value || fechaHoy());
    cuerpo.replaceChildren(
      r.filas.length ? tabla(['Partida', 'Libro', 'Nuevo', 'Efecto'], r.filas.map((f) => [h('button', { class: 'enlace', onClick: () => form(partidas.find((p) => p.id === f.id)) }, `${f.descripcion} (${f.monto_ext} ${f.moneda})`),
        `${dinero(f.valor_libro)} @${tasaTxt(f.tasa_libro)}`, f.sinTasa ? 'sin tasa' : `${dinero(f.valor_nuevo)} @${tasaTxt(f.tasa_nueva)}`, f.sinTasa ? '' : h('span', { class: f.efecto < 0 ? 'deuda' : '' }, dinero(f.efecto))]), { num: [1, 2, 3] })
        : vacio('No hay partidas en moneda extranjera. Agrega una cuenta en dólares (banco, préstamo…) para revaluarla.'),
      h('div', { class: 'totales' }, renglon('Ganancia cambiaria', dinero(r.ganancia)), renglon('Pérdida cambiaria', dinero(r.perdida)), renglon('Resultado', dinero(r.ganancia - r.perdida), 'gran')),
      h('button', { class: 'btn primario', onClick: async () => {
        if (!(await confirmar('Contabilizar diferencia', `Se creará un asiento con ganancia ${dinero(r.ganancia)} y pérdida ${dinero(r.perdida)}.`, 'Contabilizar'))) return;
        try { const x = await contabilizarDiferencia(fecha.value || fechaHoy()); toast(`Asiento ${x.numero} creado`); await recargar(); } catch (e) { toast(limpiar(e), 'error'); }
      } }, 'Contabilizar diferencia'),
      h('p', { class: 'ayuda' }, 'Solo revalúa las partidas que registres aquí. Las cuentas por cobrar y por pagar no se incluyen: se calculan con las facturas.'));
  }
  function form(p = null) {
    const desc = texto(p?.descripcion || '', 'Ej.: Cuenta banco en dólares'); const mon = selectDe(monedas.filter((m) => m.activa).map((m) => [m.id, m.codigo]), p?.moneda_id ?? '', 'Moneda');
    const cta = selectCuentas(cuentas, { valor: p?.cuenta_id, tipos: ['activo', 'pasivo'] });
    const m = numero(p?.monto_ext ?? ''); const t = numero(p?.tasa_libro ?? ''); const f = fechaInput(p?.fecha || fechaHoy()); const notas = texto(p?.notas || ''); const error = h('p', { class: 'error' });
    const cerrar = hoja(p ? 'Editar partida' : 'Nueva partida en moneda extranjera', h('div', { class: 'cuerpo' }, campo('Descripción', desc), campo('Moneda', mon), campo('Cuenta contable', cta), h('div', { class: 'rejilla' }, campo('Monto en moneda extranjera', m), campo('Tasa registrada hoy', t)), campo('Fecha', f), campo('Notas', notas), error,
      h('div', { class: 'acciones' },
        h('button', { class: 'btn primario', onClick: async () => { try { await guardarPartida({ id: p?.id || null, descripcion: desc.value, moneda_id: Number(mon.value), cuenta_id: Number(cta.value), monto_ext: m.value, tasa_libro: t.value, fecha: f.value, notas: notas.value }); cerrar(); toast('Partida guardada'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Guardar'),
        p ? h('button', { class: 'btn peligro', onClick: async () => { try { await eliminarPartida(p.id); cerrar(); toast('Partida eliminada'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Eliminar') : null)));
  }
  fecha.addEventListener('change', pintar);
  raiz.replaceChildren(h('div', { class: 'rejilla' }, campo('Revaluar al', fecha), h('button', { class: 'btn', onClick: () => form() }, 'Nueva partida')), cuerpo,
    h('h3', { class: 'seccion' }, 'Historial'),
    hist.length ? tabla(['Fecha', 'Partida', 'Tasa', 'Efecto', 'Asiento'], hist.map((d) => [fechaCorta(d.fecha), d.descripcion, `${tasaTxt(d.tasa_anterior)} → ${tasaTxt(d.tasa_nueva)}`, dinero(d.monto), `#${d.asiento_numero}`]), { num: [3] }) : vacio('Aún no se ha contabilizado ninguna diferencia.'));
  await pintar();
}

// ---------- Reporte Dinámico ----------
export async function seccionDinamicoFinanzas(raiz) {
  const hoy = fechaHoy();
  const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`); const hasta = fechaInput(hoy);
  const filas = selectDe(Object.entries(FILAS_DINAMICO), 'cuenta', 'Filas'); const cols = selectDe(Object.entries(COLUMNAS_DINAMICO), 'ninguna', 'Columnas'); const med = selectDe(Object.entries(MEDIDAS_DINAMICO), 'neto', 'Medida');
  const marcados = new Set(Object.keys(TIPOS_CUENTA));
  const chips = h('div', { class: 'segmento' }, Object.keys(TIPOS_CUENTA).map((k) => h('button', { 'aria-pressed': 'true', onClick: (e) => { if (marcados.has(k)) marcados.delete(k); else marcados.add(k); e.currentTarget.setAttribute('aria-pressed', String(marcados.has(k))); pintar(); } }, nombreTipo(k))));
  const cuerpo = h('div');
  async function pintar() {
    const [lib, centros] = await Promise.all([libroContable({ hasta: hasta.value || hoy }), listarCentros()]);
    const r = tablaDinamicaLibro(lib.lineas, lib.cuentas, { desde: desde.value || '0000-01-01', hasta: hasta.value || hoy, tipos: [...marcados], filas: filas.value, columnas: cols.value, medida: med.value, centros });
    const enc = [FILAS_DINAMICO[filas.value], ...r.columnas, ...(r.columnas.length > 1 ? ['Total'] : [])];
    const una = r.columnas.length <= 1;
    const fila = (g) => [g.clave, ...r.columnas.map((c) => dinero(g.valores[c] || 0)), ...(una ? [] : [dinero(g.total)])];
    cuerpo.replaceChildren(r.filas.length ? tabla(enc, [...r.filas.map(fila), fila({ clave: 'Total', valores: r.totales, total: r.total })], { num: enc.map((_, i) => i).slice(1), clases: { [r.filas.length]: 'total' } }) : vacio('No hay movimientos con esos filtros.'),
      r.filas.length ? botonCSV(`finanzas-dinamico-${filas.value}`, enc, [...r.filas.map((g) => [g.clave, ...r.columnas.map((c) => g.valores[c] || 0), ...(una ? [] : [g.total])])]) : null);
  }
  for (const el of [desde, hasta, filas, cols, med]) el.addEventListener('change', pintar);
  raiz.replaceChildren(h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), h('div', { class: 'rejilla' }, campo('Filas', filas), campo('Columnas', cols)), campo('Medida', med), chips, cuerpo);
  await pintar();
}
