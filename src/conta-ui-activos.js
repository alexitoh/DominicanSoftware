// conta-ui-activos.js - pestañas Activos fijos y Nómina
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import {
  listarDepTipos, guardarDepTipo, eliminarDepTipo, listarTiposActivo, guardarTipoActivo, eliminarTipoActivo, METODOS_DEP,
  listarTasasInflacion, guardarTasaInflacion, eliminarTasaInflacion, propuestaInflacion, aplicarInflacion,
  listarActivos, crearActivo, actualizarActivo, bajaActivo, revalorizarActivo, MOTIVOS_RETIRO, CATEGORIAS_ACTIVO, listarCuentas, listarCentros, fechaHoy, configConta, guardarConfigConta,
  listarEmpleados, guardarEmpleado, prepararNomina, registrarNomina, pagarNomina, anularNomina, listarNominas, detalleNomina,
} from './conta-db.js';
import { calendarioDepreciacion, valoresActivo, r2 } from './conta-motor.js';
import { PARAMS_NOMINA, ETIQUETAS_NOMINA } from './conta-nomina.js';
import { campo, numero, fechaInput, texto, selectCuentas, tabla, vacio, fechaCorta, limpiar, botonCSV, renglon } from './conta-ui-comun.js';

// ---------------- Activos fijos ----------------
// Ocho secciones: Activo Fijo (registro), Depreciación, Reportes AF, Retiro, Revalorización, Tasa de Inflación, Tipo de Activo Fijo y Tipo de Depreciación.
const SECCIONES_AF = [['activo', 'Activo Fijo'], ['depreciacion', 'Depreciación'], ['reportes', 'Reportes AF'], ['retiro', 'Retiro'], ['reval', 'Revalorización'],
  ['inflacion', 'Tasa de Inflación'], ['tipos', 'Tipo de Activo Fijo'], ['deptipos', 'Tipo de Depreciación']];
let seccionAF = 'activo';
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreMes = (ym) => `${MESES[parseInt(ym.slice(5, 7), 10) - 1]} ${ym.slice(0, 4)}`;

export async function vistaActivos(raiz) {
  const cuerpo = h('div');
  const barra = h('div', { class: 'segmento conta-tabs', role: 'tablist', 'aria-label': 'Activos fijos' });
  async function ir(id) {
    seccionAF = id;
    barra.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    const nueva = h('div');
    try { await SECCION_FN[id](nueva, () => ir(id), ir); } catch (e) { nueva.replaceChildren(h('p', { class: 'error vacio' }, `No se pudo cargar: ${e.message || e}`)); }
    if (seccionAF === id) cuerpo.replaceChildren(nueva);
  }
  barra.append(...SECCIONES_AF.map(([id, t]) => h('button', { 'data-id': id, role: 'tab', onClick: () => ir(id) }, t)));
  raiz.replaceChildren(barra, cuerpo);
  await ir(seccionAF);
}

// ---- Activo Fijo: registro y ficha ----
async function seccionActivo(raiz, recargar, irA) {
  const activos = await listarActivos();
  const hoy = fechaHoy();
  const valores = activos.map((a) => ({ a, ...valoresActivo(a, hoy) }));
  const datalistId = 'categorias-af';

  async function formulario(a = null) {
    const cuentas = await listarCuentas(true);
    const nombre = texto(a?.nombre ?? ''), codigo = texto(a?.codigo ?? '', 'Código (opcional)');
    const categoria = texto(a?.categoria ?? '', 'Ej. Equipos de cómputo'); categoria.setAttribute('list', datalistId);
    const ubicacion = texto(a?.ubicacion ?? '', 'Dónde está'), serie = texto(a?.serie ?? '', 'Serie o chasis (opcional)'), notas = texto(a?.notas ?? '', 'Opcional');
    const fecha = fechaInput(hoy), costo = numero(), residual = numero(), vida = numero('60', '1');
    const contra = selectCuentas(cuentas, { vacioTexto: 'Pagado de Caja', tipos: ['activo', 'pasivo'] });
    const tiposAct = (await listarTiposActivo()).filter((t) => t.activo);
    const tiposDep = (await listarDepTipos()).filter((t) => t.activo);
    const selTipo = h('select', { class: 'campo', 'aria-label': 'Tipo de activo' }, h('option', { value: '' }, 'Sin tipo (usar categoría escrita)'), tiposAct.map((t) => h('option', { value: String(t.id) }, t.nombre)));
    const selDep = h('select', { class: 'campo', 'aria-label': 'Tipo de depreciación' }, h('option', { value: '' }, 'Línea recta (por defecto)'),
      tiposDep.map((t) => h('option', { value: String(t.id) }, `${t.nombre}${t.metodo === 'saldo_decreciente' ? '' : ''}`)));
    selTipo.addEventListener('change', () => {
      const t = tiposAct.find((x) => String(x.id) === selTipo.value);
      if (!t) return;
      vida.value = String(t.vida_meses);
      selDep.value = t.dep_tipo_id ? String(t.dep_tipo_id) : '';
      categoria.value = t.nombre;
      if (!t.deprecia) vida.value = String(t.vida_meses);
    });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(a ? 'Editar datos del activo' : 'Nuevo activo fijo', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), h('div', { class: 'rejilla' }, campo('Código', codigo), campo('Categoría', categoria)),
      h('div', { class: 'rejilla' }, campo('Ubicación', ubicacion), campo('Serie / chasis', serie)),
      a ? null : h('div', {}, h('div', { class: 'rejilla' }, campo('Tipo de activo', selTipo, 'Trae la vida útil y el tipo de depreciación; puedes cambiarlos.'), campo('Tipo de depreciación', selDep)),
        h('div', { class: 'rejilla' }, campo('Fecha de compra', fecha), campo('Costo', costo)),
        h('div', { class: 'rejilla' }, campo('Valor residual', residual), campo('Vida útil (meses)', vida, '60 meses = 5 años. En línea recta se reparte en cuotas iguales; en saldo decreciente manda el porcentaje anual.')),
        campo('Pagado con', contra, 'Si lo compraste a crédito, elige la cuenta por pagar correspondiente.')),
      campo('Notas', notas), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try {
          if (a) await actualizarActivo(a.id, { nombre: nombre.value, codigo: codigo.value, categoria: categoria.value, ubicacion: ubicacion.value, serie: serie.value, notas: notas.value });
          else await crearActivo({ nombre: nombre.value, codigo: codigo.value, categoria: categoria.value, ubicacion: ubicacion.value, serie: serie.value, notas: notas.value, fecha_adq: fecha.value, costo: costo.value, residual: residual.value !== '' ? residual.value : Math.round(parseFloat(costo.value || 0) * (tiposAct.find((x) => String(x.id) === selTipo.value)?.residual_pct || 0)) / 100, vida_meses: vida.value, contra_cuenta_id: Number(contra.value) || null,
            tipo_id: Number(selTipo.value) || null, dep_tipo_id: Number(selDep.value) || null });
          cerrar(); toast(a ? 'Activo actualizado' : 'Activo registrado'); await recargar();
        } catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar'))));
  }

  function detalle(v) {
    const { a } = v;
    const cal = calendarioDepreciacion(a, `${new Date().getFullYear() + 60}-12-31`);
    const cerrar = hoja(a.nombre, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' },
        renglon('Costo' + (a.revals.length ? ' (con revalorizaciones)' : ''), dinero(v.costo)),
        renglon('Depreciación acumulada', dinero(v.dep)),
        renglon('Valor en libros', dinero(v.libros), 'gran')),
      h('p', { class: 'ayuda' }, [a.categoria, a.ubicacion, a.serie && `Serie ${a.serie}`].filter(Boolean).join(' · ') || 'Sin categoría ni ubicación'),
      h('p', { class: 'ayuda' }, `Comprado ${fechaCorta(a.fecha_adq)} · vida ${a.vida_meses} meses · residual ${dinero(a.residual)} · ${a.estado === 'baja'
        ? `${a.baja_motivo ? MOTIVOS_RETIRO[a.baja_motivo] : 'Retirado'} el ${fechaCorta(a.fecha_baja)}`
        : `${cal.length} cuotas mensuales${cal[0] ? ` de ${dinero(cal[0].monto)}` : ''}`}`),
      h('div', { class: 'acciones' },
        h('button', { class: 'btn', onClick: () => { cerrar(); formulario(a); } }, 'Editar datos'),
        a.estado === 'activo' ? h('button', { class: 'btn', onClick: () => { cerrar(); irA('reval'); } }, 'Revalorizar') : null,
        a.estado === 'activo' ? h('button', { class: 'btn peligro', onClick: () => { cerrar(); irA('retiro'); } }, 'Retirar') : null)));
  }

  raiz.replaceChildren(
    h('datalist', { id: datalistId }, CATEGORIAS_ACTIVO.map((c) => h('option', { value: c }))),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nuevo activo fijo')),
    activos.length ? h('div', { class: 'lista' }, valores.map((v) => h('button', { class: `fila inventario ${v.a.estado === 'baja' ? 'apagada' : ''}`, onClick: () => detalle(v) },
      h('span', { class: 'datos' }, h('strong', {}, v.a.nombre), h('small', {}, `${v.a.codigo ? `${v.a.codigo} · ` : ''}${v.a.categoria ? `${v.a.categoria} · ` : ''}${fechaCorta(v.a.fecha_adq)} · costo ${dinero(v.costo)}${v.a.estado === 'baja' ? ' · retirado' : ''}`)),
      h('span', { class: 'precio' }, dinero(v.libros)))))
      : vacio('Registra aquí equipos, vehículos, mobiliario… El sistema calcula y contabiliza la depreciación cada mes.'));
}

// ---- Depreciación: lo que se carga cada mes ----
async function seccionDepreciacion(raiz) {
  const activos = await listarActivos();
  const hoy = fechaHoy();
  const mes = h('input', { class: 'campo', type: 'month', value: hoy.slice(0, 7), 'aria-label': 'Mes' });
  const cuerpo = h('div');
  const alFin = `${new Date().getFullYear() + 60}-12-31`;

  function pintar() {
    const ym = mes.value || hoy.slice(0, 7);
    const filas = [];
    for (const a of activos) {
      const cal = calendarioDepreciacion(a, alFin);
      const delMes = cal.find((d) => d.fecha.slice(0, 7) === ym);
      if (!delMes) continue;
      const acum = r2(cal.filter((d) => d.fecha <= delMes.fecha).reduce((x, d) => x + d.monto, 0));
      const v = valoresActivo(a, delMes.fecha);
      filas.push({ a, monto: delMes.monto, acum, libros: r2(v.costo - acum) });
    }
    const total = r2(filas.reduce((x, f) => x + f.monto, 0));
    // resumen de los 12 meses del año elegido
    const anio = ym.slice(0, 4);
    const porMes = Array.from({ length: 12 }, (_, i) => {
      const m = `${anio}-${String(i + 1).padStart(2, '0')}`;
      return [nombreMes(m), r2(activos.reduce((x, a) => x + calendarioDepreciacion(a, alFin).filter((d) => d.fecha.slice(0, 7) === m).reduce((y, d) => y + d.monto, 0), 0))];
    });
    cuerpo.replaceChildren(
      h('div', { class: 'totales' }, renglon(`Depreciación de ${nombreMes(ym)}`, dinero(total), 'gran')),
      filas.length ? tabla(['Activo', 'Cuota del mes', 'Acumulada', 'Valor en libros'], filas.map((f) => [f.a.nombre, dinero(f.monto), dinero(f.acum), dinero(f.libros)]), { num: [1, 2, 3] })
        : vacio('Ese mes no se deprecia ningún activo.'),
      h('h3', { class: 'seccion' }, `Depreciación de ${anio} mes a mes`),
      tabla(['Mes', 'Total'], porMes.map(([m, t]) => [m, dinero(t)]), { num: [1] }),
      botonCSV(`depreciacion-${anio}`, ['Mes', 'Total'], porMes));
  }
  mes.addEventListener('change', pintar);
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'La depreciación se calcula en línea recta, un asiento por mes, el último día de cada mes, empezando el mes siguiente a la compra. Se contabiliza sola; aquí la revisas.'),
    campo('Mes', mes), cuerpo);
  pintar();
}

// ---- Reportes AF ----
async function seccionReportes(raiz) {
  const activos = await listarActivos();
  const hoy = fechaHoy();
  const tipo = h('select', { class: 'campo', 'aria-label': 'Reporte' }, [
    ['listado', 'Listado de activos fijos'], ['categoria', 'Resumen por categoría'], ['depreciacion', 'Depreciación del período'],
    ['retiros', 'Retiros del período'], ['reval', 'Revalorizaciones del período'],
  ].map(([v, t]) => h('option', { value: v }, t)));
  const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`), hasta = fechaInput(hoy);
  const cuerpo = h('div');
  const rango = h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta));

  function pintar() {
    const t = tipo.value, d = desde.value, f = hasta.value || hoy;
    rango.hidden = t === 'listado' || t === 'categoria';
    let enc, filas, num, nombre = `activos-${t}`, total = null;
    if (t === 'listado' || t === 'categoria') {
      const vig = activos.filter((a) => a.fecha_adq <= f).map((a) => ({ a, v: valoresActivo(a, f) }));
      if (t === 'listado') {
        enc = ['Código', 'Activo', 'Categoría', 'Compra', 'Costo', 'Dep. acumulada', 'Valor en libros', 'Estado'];
        filas = vig.map(({ a, v }) => [a.codigo || '', a.nombre, a.categoria || '', fechaCorta(a.fecha_adq), v.costo, v.dep, v.libros, v.retirado ? 'Retirado' : 'Activo']);
        num = [4, 5, 6];
      } else {
        const g = new Map();
        for (const { a, v } of vig) {
          if (v.retirado) continue;
          const k = a.categoria || 'Sin categoría';
          const x = g.get(k) || { n: 0, costo: 0, dep: 0, libros: 0 };
          g.set(k, { n: x.n + 1, costo: x.costo + v.costo, dep: x.dep + v.dep, libros: x.libros + v.libros });
        }
        enc = ['Categoría', 'Activos', 'Costo', 'Dep. acumulada', 'Valor en libros'];
        filas = [...g.entries()].sort().map(([k, x]) => [k, x.n, r2(x.costo), r2(x.dep), r2(x.libros)]);
        num = [1, 2, 3, 4];
      }
      const idx = t === 'listado' ? [4, 5, 6] : [2, 3, 4];
      total = ['Total', ...Array(enc.length - 1).fill('')];
      for (const i of idx) total[i] = r2(filas.filter((r) => t === 'categoria' || r[7] === 'Activo').reduce((x, r) => x + r[i], 0));
    } else if (t === 'depreciacion') {
      enc = ['Activo', 'Categoría', 'Depreciación del período', 'Acumulada al cierre', 'Valor en libros'];
      filas = activos.map((a) => {
        const cal = calendarioDepreciacion(a, f);
        const per = r2(cal.filter((x) => x.fecha >= d).reduce((s, x) => s + x.monto, 0));
        const v = valoresActivo(a, f);
        return [a.nombre, a.categoria || '', per, v.dep, v.libros];
      }).filter((r) => r[2] > 0);
      num = [2, 3, 4];
      total = ['Total', '', r2(filas.reduce((x, r) => x + r[2], 0)), '', ''];
    } else if (t === 'retiros') {
      enc = ['Fecha', 'Activo', 'Motivo', 'Costo', 'Dep. acumulada', 'Valor en libros', 'Cobrado', 'Ganancia / (pérdida)'];
      filas = activos.filter((a) => a.estado === 'baja' && a.fecha_baja >= d && a.fecha_baja <= f).map((a) => {
        const v = valoresActivo(a, a.fecha_baja);
        const lib = r2(v.costo - v.dep), cobr = r2(a.baja_precio || 0);
        return [fechaCorta(a.fecha_baja), a.nombre, a.baja_motivo ? MOTIVOS_RETIRO[a.baja_motivo] : 'Baja', v.costo, v.dep, lib, cobr, r2(cobr - lib)];
      });
      num = [3, 4, 5, 6, 7];
      total = ['Total', '', '', ...[3, 4, 5, 6, 7].map((i) => r2(filas.reduce((x, r) => x + r[i], 0)))];
    } else {
      enc = ['Fecha', 'Activo', 'Valor anterior', 'Nuevo valor', 'Ajuste', 'Nota'];
      filas = activos.flatMap((a) => a.revals.filter((r) => r.fecha >= d && r.fecha <= f).map((r) => [fechaCorta(r.fecha), a.nombre, r.valor_anterior, r.valor_nuevo, r.ajuste, r.nota || '']));
      num = [2, 3, 4];
      total = ['Total', '', '', '', r2(filas.reduce((x, r) => x + r[4], 0)), ''];
    }
    const mostrar = (r) => r.map((v, i) => (num.includes(i) && typeof v === 'number' ? dinero(v) : v));
    cuerpo.replaceChildren(
      filas.length ? tabla(enc, [...filas.map(mostrar), mostrar(total)], { num }) : vacio('No hay datos para ese reporte.'),
      filas.length ? botonCSV(nombre, enc, [...filas, total]) : null);
  }
  for (const el of [tipo, desde, hasta]) el.addEventListener('change', pintar);
  raiz.replaceChildren(campo('Reporte', tipo), rango, cuerpo);
  pintar();
}

// ---- Retiro ----
async function seccionRetiro(raiz, recargar) {
  const activos = (await listarActivos()).filter((a) => a.estado === 'activo');
  const cuentas = await listarCuentas(true);
  const todos = await listarActivos();
  const retirados = todos.filter((a) => a.estado === 'baja').sort((x, y) => (x.fecha_baja < y.fecha_baja ? 1 : -1));
  const sel = h('select', { class: 'campo', 'aria-label': 'Activo a retirar' }, h('option', { value: '' }, '— Elige el activo —'), activos.map((a) => h('option', { value: String(a.id) }, `${a.codigo ? `${a.codigo} · ` : ''}${a.nombre}`)));
  const fecha = fechaInput(fechaHoy());
  const motivo = h('select', { class: 'campo', 'aria-label': 'Motivo' }, Object.entries(MOTIVOS_RETIRO).map(([k, t]) => h('option', { value: k }, t)));
  const precio = numero();
  const cobro = selectCuentas(cuentas, { vacioTexto: 'Caja (efectivo)', tipos: ['activo'] });
  const nota = texto('', 'Comprador, referencia… (opcional)');
  const resumen = h('div', { class: 'totales' });
  const cajaPrecio = campo('Precio de venta', precio), cajaCobro = campo('Cobrado en', cobro);
  const error = h('p', { class: 'error', role: 'alert' });

  function calcular() {
    const a = activos.find((x) => String(x.id) === sel.value);
    cajaPrecio.hidden = cajaCobro.hidden = motivo.value !== 'venta';
    if (!a || !fecha.value) { resumen.replaceChildren(); return; }
    const v = valoresActivo({ ...a, estado: 'activo' }, fecha.value);
    const lib = r2(v.costo - v.dep);
    const cobr = motivo.value === 'venta' ? r2(parseFloat(precio.value) || 0) : 0;
    const res = r2(cobr - lib);
    resumen.replaceChildren(
      renglon('Costo', dinero(v.costo)), renglon('Depreciación acumulada', dinero(v.dep)), renglon('Valor en libros', dinero(lib), 'gran'),
      motivo.value === 'venta' ? renglon('Precio de venta', dinero(cobr)) : null,
      renglon(res >= 0 ? 'Ganancia en el retiro' : 'Pérdida en el retiro', dinero(Math.abs(res)), res < 0 ? 'deuda' : ''));
  }
  for (const el of [sel, fecha, motivo]) el.addEventListener('change', calcular);
  precio.addEventListener('input', calcular);

  async function retirar() {
    error.textContent = '';
    const a = activos.find((x) => String(x.id) === sel.value);
    if (!a) { error.textContent = 'Elige el activo que vas a retirar.'; return; }
    if (!(await confirmar('Retirar activo', `Se dejará de depreciar "${a.nombre}" y se contabiliza el retiro.`, 'Retirar'))) return;
    try {
      await bajaActivo(a.id, fecha.value, { motivo: motivo.value, precio: precio.value, cuenta_id: Number(cobro.value) || null, nota: nota.value });
      toast('Activo retirado'); await recargar();
    } catch (e) { error.textContent = limpiar(e); }
  }

  raiz.replaceChildren(
    activos.length ? h('div', {},
      campo('Activo', sel), h('div', { class: 'rejilla' }, campo('Fecha del retiro', fecha), campo('Motivo', motivo)),
      cajaPrecio, cajaCobro, campo('Nota', nota), resumen, error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: retirar }, 'Retirar activo')))
      : vacio('No hay activos para retirar.'),
    h('h3', { class: 'seccion' }, 'Activos retirados'),
    retirados.length ? h('div', { class: 'lista' }, retirados.map((a) => {
      const v = valoresActivo(a, a.fecha_baja);
      const res = r2((a.baja_precio || 0) - (v.costo - v.dep));
      return h('div', { class: 'fila inventario' },
        h('span', { class: 'datos' }, h('strong', {}, a.nombre), h('small', {}, `${fechaCorta(a.fecha_baja)} · ${a.baja_motivo ? MOTIVOS_RETIRO[a.baja_motivo] : 'Baja'}${a.baja_nota ? ` · ${a.baja_nota}` : ''}`)),
        h('span', { class: res < 0 ? 'precio deuda' : 'precio' }, `${res >= 0 ? '+' : '-'}${dinero(Math.abs(res))}`));
    })) : vacio('Todavía no has retirado ningún activo.'));
  calcular();
}

// ---- Revalorización ----
async function seccionReval(raiz, recargar) {
  const todos = await listarActivos();
  const activos = todos.filter((a) => a.estado === 'activo');
  const sel = h('select', { class: 'campo', 'aria-label': 'Activo a revalorizar' }, h('option', { value: '' }, '— Elige el activo —'), activos.map((a) => h('option', { value: String(a.id) }, `${a.codigo ? `${a.codigo} · ` : ''}${a.nombre}`)));
  const fecha = fechaInput(fechaHoy());
  const nuevo = numero();
  const nota = texto('', 'Motivo o tasador (opcional)');
  const resumen = h('div', { class: 'totales' });
  const error = h('p', { class: 'error', role: 'alert' });

  function calcular() {
    const a = activos.find((x) => String(x.id) === sel.value);
    if (!a || !fecha.value) { resumen.replaceChildren(); return; }
    const v = valoresActivo(a, fecha.value);
    const n = parseFloat(nuevo.value);
    const aj = Number.isFinite(n) ? r2(n - v.libros) : null;
    resumen.replaceChildren(
      renglon('Valor en libros actual', dinero(v.libros), 'gran'),
      aj == null ? null : renglon(aj >= 0 ? 'Aumento (va a Superávit por revalorización)' : 'Disminución (va a pérdida)', dinero(Math.abs(aj)), aj < 0 ? 'deuda' : ''));
  }
  for (const el of [sel, fecha]) el.addEventListener('change', calcular);
  nuevo.addEventListener('input', calcular);

  async function aplicar() {
    error.textContent = '';
    const a = activos.find((x) => String(x.id) === sel.value);
    if (!a) { error.textContent = 'Elige el activo.'; return; }
    try {
      const r = await revalorizarActivo({ activo_id: a.id, fecha: fecha.value, valor_nuevo: nuevo.value, nota: nota.value });
      toast(`Revalorizado: ${r.ajuste >= 0 ? '+' : '-'}${dinero(Math.abs(r.ajuste))}`); await recargar();
    } catch (e) { error.textContent = limpiar(e); }
  }
  const hist = todos.flatMap((a) => a.revals.map((r) => ({ a, r }))).sort((x, y) => (x.r.fecha < y.r.fecha ? 1 : -1));
  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Cambia el valor en libros de un activo (por ejemplo, según un avalúo). Si sube, la diferencia va a Patrimonio como Superávit por revalorización; si baja, se registra como pérdida. Desde el mes siguiente se deprecia el nuevo valor durante la vida útil que le queda. Consulta con tu contador cómo tratarlo fiscalmente.'),
    activos.length ? h('div', {}, campo('Activo', sel), h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('Nuevo valor en libros', nuevo)), campo('Nota', nota), resumen, error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: aplicar }, 'Revalorizar')))
      : vacio('No hay activos para revalorizar.'),
    h('h3', { class: 'seccion' }, 'Revalorizaciones hechas'),
    hist.length ? h('div', { class: 'lista' }, hist.map(({ a, r }) => h('div', { class: 'fila inventario' },
      h('span', { class: 'datos' }, h('strong', {}, a.nombre), h('small', {}, `${fechaCorta(r.fecha)} · de ${dinero(r.valor_anterior)} a ${dinero(r.valor_nuevo)}${r.nota ? ` · ${r.nota}` : ''}`)),
      h('span', { class: r.ajuste < 0 ? 'precio deuda' : 'precio' }, `${r.ajuste >= 0 ? '+' : '-'}${dinero(Math.abs(r.ajuste))}`)))) : vacio('Todavía no hay revalorizaciones.'));
  calcular();
}

// ---- Tipo de Depreciación ----
async function seccionDepTipos(raiz, recargar) {
  const tipos = await listarDepTipos();

  function formulario(t = null) {
    const nombre = texto(t?.nombre ?? '', 'Ej. Saldo decreciente 20%');
    const metodo = h('select', { class: 'campo', 'aria-label': 'Método' }, Object.entries(METODOS_DEP).map(([k, v]) => h('option', { value: k }, v)));
    metodo.value = t?.metodo ?? 'lineal';
    const tasa = numero(t?.tasa_anual ?? '', '0.01');
    const notas = texto(t?.notas ?? '', 'Opcional');
    const activo = h('input', { type: 'checkbox', checked: t ? !!t.activo : true, 'aria-label': 'Activo' });
    const cajaTasa = campo('Porcentaje anual sobre el valor en libros', tasa, 'Cada mes se deprecia este porcentaje ÷ 12 del valor en libros, sin bajar del valor residual.');
    const error = h('p', { class: 'error', role: 'alert' });
    const ajustar = () => { cajaTasa.hidden = metodo.value !== 'saldo_decreciente'; };
    metodo.addEventListener('change', ajustar); ajustar();
    const cerrar = hoja(t ? 'Editar tipo de depreciación' : 'Nuevo tipo de depreciación', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), campo('Método', metodo, 'Línea recta: cuotas iguales según la vida útil del activo. Saldo decreciente: un porcentaje anual del valor en libros.'), cajaTasa, campo('Notas', notas),
      h('label', { class: 'etiqueta' }, h('span', {}, 'Disponible al registrar activos'), activo), error,
      h('div', { class: 'acciones' },
        t ? h('button', { class: 'btn peligro', onClick: async () => {
          if (!(await confirmar('Eliminar', `¿Eliminar "${t.nombre}"?`, 'Eliminar'))) return;
          try { await eliminarDepTipo(t.id); cerrar(); toast('Eliminado'); await recargar(); } catch (e) { error.textContent = limpiar(e); }
        } }, 'Eliminar') : null,
        h('button', { class: 'btn primario', onClick: async () => {
          try { await guardarDepTipo({ id: t?.id ?? null, nombre: nombre.value, metodo: metodo.value, tasa_anual: tasa.value, notas: notas.value, activo: activo.checked }); cerrar(); toast('Guardado'); await recargar(); }
          catch (e) { error.textContent = limpiar(e); }
        } }, 'Guardar'))));
  }

  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Define cómo se deprecian los activos. Al registrar un activo eliges uno de estos tipos y queda copiado en el activo. Las cuotas se contabilizan solas cada fin de mes.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nuevo tipo de depreciación')),
    tipos.length ? h('div', { class: 'lista' }, tipos.map((t) => h('button', { class: `fila inventario ${t.activo ? '' : 'apagada'}`, onClick: () => formulario(t) },
      h('span', { class: 'datos' }, h('strong', {}, t.nombre), h('small', {}, t.notas || METODOS_DEP[t.metodo])),
      h('span', { class: 'precio' }, t.metodo === 'saldo_decreciente' ? `${t.tasa_anual}% anual` : 'Línea recta'))))
      : vacio('Aún no hay tipos de depreciación.'));
}

// ---- Tipo de Activo Fijo ----
async function seccionTipos(raiz, recargar) {
  const [tipos, deps] = await Promise.all([listarTiposActivo(), listarDepTipos()]);

  function formulario(t = null) {
    const nombre = texto(t?.nombre ?? '', 'Ej. Equipos de cómputo');
    const vida = numero(t?.vida_meses ?? '60', '1');
    const residual = numero(t?.residual_pct ?? '0', '0.01');
    const dep = h('select', { class: 'campo', 'aria-label': 'Tipo de depreciación' }, h('option', { value: '' }, 'Línea recta'),
      deps.filter((d) => d.activo || d.id === t?.dep_tipo_id).map((d) => h('option', { value: String(d.id) }, d.nombre)));
    dep.value = t?.dep_tipo_id ? String(t.dep_tipo_id) : '';
    const deprecia = h('input', { type: 'checkbox', checked: t ? !!t.deprecia : true, 'aria-label': 'Se deprecia' });
    const notas = texto(t?.notas ?? '', 'Opcional');
    const activo = h('input', { type: 'checkbox', checked: t ? !!t.activo : true, 'aria-label': 'Activo' });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(t ? 'Editar tipo de activo' : 'Nuevo tipo de activo', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre),
      h('div', { class: 'rejilla' }, campo('Vida útil (meses)', vida), campo('Valor residual (%)', residual, 'Porcentaje del costo que vale al final.')),
      campo('Tipo de depreciación', dep),
      h('label', { class: 'etiqueta' }, h('span', {}, 'Se deprecia (los terrenos no)'), deprecia),
      campo('Notas', notas),
      h('label', { class: 'etiqueta' }, h('span', {}, 'Disponible al registrar activos'), activo), error,
      h('div', { class: 'acciones' },
        t ? h('button', { class: 'btn peligro', onClick: async () => {
          if (!(await confirmar('Eliminar', `¿Eliminar "${t.nombre}"?`, 'Eliminar'))) return;
          try { await eliminarTipoActivo(t.id); cerrar(); toast('Eliminado'); await recargar(); } catch (e) { error.textContent = limpiar(e); }
        } }, 'Eliminar') : null,
        h('button', { class: 'btn primario', onClick: async () => {
          try {
            await guardarTipoActivo({ id: t?.id ?? null, nombre: nombre.value, vida_meses: vida.value, residual_pct: residual.value, deprecia: deprecia.checked, dep_tipo_id: Number(dep.value) || null, notas: notas.value, activo: activo.checked });
            cerrar(); toast('Guardado'); await recargar();
          } catch (e) { error.textContent = limpiar(e); }
        } }, 'Guardar'))));
  }

  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Cada tipo trae valores por defecto (vida útil, valor residual y tipo de depreciación) que se copian al registrar un activo. Cambiar un tipo no altera los activos ya registrados, salvo el nombre de su categoría.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nuevo tipo de activo')),
    tipos.length ? h('div', { class: 'lista' }, tipos.map((t) => h('button', { class: `fila inventario ${t.activo ? '' : 'apagada'}`, onClick: () => formulario(t) },
      h('span', { class: 'datos' }, h('strong', {}, t.nombre),
        h('small', {}, t.deprecia ? `${t.vida_meses} meses · ${t.dep_nombre || 'Línea recta'}${t.residual_pct ? ` · residual ${t.residual_pct}%` : ''}` : 'No se deprecia')),
      h('span', { class: 'precio' }, `${t.n_activos} ${t.n_activos === 1 ? 'activo' : 'activos'}`))))
      : vacio('Aún no hay tipos de activo.'));
}

// ---- Tasa de Inflación y ajuste de los activos ----
async function seccionInflacion(raiz, recargar) {
  const tasas = await listarTasasInflacion();

  function formulario(t = null) {
    const anio = numero(t?.anio ?? String(new Date().getFullYear() - 1), '1');
    const tasa = numero(t?.tasa ?? '', '0.01');
    const fuente = texto(t?.fuente ?? '', 'Ej. Banco Central');
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(t ? `Tasa de ${t.anio}` : 'Nueva tasa de inflación', h('div', { class: 'cuerpo' },
      h('div', { class: 'rejilla' }, campo('Año', anio), campo('Tasa anual (%)', tasa)), campo('Fuente', fuente), error,
      h('div', { class: 'acciones' },
        t ? h('button', { class: 'btn peligro', onClick: async () => {
          if (!(await confirmar('Eliminar', `¿Eliminar la tasa de ${t.anio}?`, 'Eliminar'))) return;
          await eliminarTasaInflacion(t.id); cerrar(); toast('Eliminada'); await recargar();
        } }, 'Eliminar') : null,
        h('button', { class: 'btn primario', onClick: async () => {
          try { await guardarTasaInflacion({ anio: anio.value, tasa: tasa.value, fuente: fuente.value }); cerrar(); toast('Guardada'); await recargar(); }
          catch (e) { error.textContent = limpiar(e); }
        } }, 'Guardar'))));
  }

  async function ajustar(t) {
    let datos;
    try { datos = await propuestaInflacion(t.anio); } catch (e) { toast(limpiar(e), 'error'); return; }
    const elegidos = new Set(datos.propuesta.map((p) => p.activo.id));
    const error = h('p', { class: 'error', role: 'alert' });
    const total = () => dinero(r2(datos.propuesta.filter((p) => elegidos.has(p.activo.id)).reduce((s, p) => s + p.ajuste, 0)));
    const resumen = h('div', { class: 'totales' });
    const pintarTotal = () => resumen.replaceChildren(renglon('Ajuste total', total(), 'gran'));
    pintarTotal();
    const cerrar = hoja(`Ajuste por inflación ${t.anio} (${t.tasa}%)`, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, `Sube el valor en libros de cada activo en ${t.tasa}% al ${fechaCorta(datos.fecha)}. Es una revalorización: la diferencia va a Superávit por revalorización y desde el mes siguiente se deprecia el nuevo valor.`),
      datos.propuesta.length ? h('div', { class: 'lista' }, datos.propuesta.map((p) => h('label', { class: 'fila inventario' },
        h('input', { type: 'checkbox', checked: true, 'aria-label': `Ajustar ${p.activo.nombre}`, onChange: (e) => { if (e.target.checked) elegidos.add(p.activo.id); else elegidos.delete(p.activo.id); pintarTotal(); } }),
        h('span', { class: 'datos' }, h('strong', {}, p.activo.nombre), h('small', {}, `${dinero(p.libros)} → ${dinero(p.nuevo)}`)),
        h('span', { class: 'precio' }, `+${dinero(p.ajuste)}`))))
        : vacio(`No hay activos para ajustar en ${t.anio} (ya están ajustados a esa fecha o no tienen valor en libros).`),
      resumen, error,
      datos.propuesta.length ? h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try { const n = await aplicarInflacion(t.anio, [...elegidos]); cerrar(); toast(`${n} ${n === 1 ? 'activo ajustado' : 'activos ajustados'}`); await recargar(); }
        catch (e) { error.textContent = limpiar(e); }
      } }, 'Aplicar ajuste')) : null));
  }

  raiz.replaceChildren(
    h('p', { class: 'ayuda' }, 'Registra la inflación anual de cada año. Con ella puedes ajustar el valor de tus activos fijos en un solo paso. Confirma la tasa con la fuente oficial (Banco Central) y con tu contador antes de aplicar el ajuste.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nueva tasa de inflación')),
    tasas.length ? h('div', { class: 'lista' }, tasas.map((t) => h('div', { class: 'fila inventario' },
      h('button', { class: 'datos', onClick: () => formulario(t) }, h('strong', {}, String(t.anio)), h('small', {}, t.fuente || 'Sin fuente')),
      h('span', { class: 'precio' }, `${t.tasa}%`),
      h('button', { class: 'btn chico', onClick: () => ajustar(t) }, 'Ajustar activos'))))
      : vacio('Aún no hay tasas de inflación registradas.'));
}

const SECCION_FN = { activo: seccionActivo, depreciacion: seccionDepreciacion, reportes: seccionReportes, retiro: seccionRetiro, reval: seccionReval, inflacion: seccionInflacion, tipos: seccionTipos, deptipos: seccionDepTipos };

// ---------------- Nómina ----------------
export async function vistaNomina(raiz) {
  const [nominas, emps] = await Promise.all([listarNominas(), listarEmpleados()]);

  async function empleado(e = null) {
    const centros = (await listarCentros()).filter((c) => c.activo);
    const nombre = texto(e?.nombre ?? ''), cedula = texto(e?.cedula ?? ''), cargo = texto(e?.cargo ?? ''), salario = numero(e?.salario ?? ''), ingreso = fechaInput(e?.fecha_ingreso ?? '');
    const activo = h('input', { type: 'checkbox', checked: e ? !!e.activo : true });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(e ? 'Editar empleado' : 'Nuevo empleado', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), h('div', { class: 'rejilla' }, campo('Cédula', cedula), campo('Cargo', cargo)),
      h('div', { class: 'rejilla' }, campo('Salario mensual', salario), campo('Fecha de ingreso', ingreso)),
      e ? h('label', { class: 'etiqueta' }, activo, ' Empleado activo') : null, error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try { await guardarEmpleado({ id: e?.id ?? null, nombre: nombre.value, cedula: cedula.value, cargo: cargo.value, salario: salario.value, fecha_ingreso: ingreso.value, activo: activo.checked ? 1 : 0 }); cerrar(); toast('Empleado guardado'); await vistaNomina(raiz); }
        catch (x) { error.textContent = limpiar(x); }
      } }, 'Guardar'))));
    void centros;
  }

  async function nueva() {
    const periodo = h('input', { class: 'campo', type: 'month', value: fechaHoy().slice(0, 7) });
    const ajustes = {};
    const cuerpo = h('div');
    const error = h('p', { class: 'error', role: 'alert' });
    async function pintar() {
      const filas = await prepararNomina(ajustes);
      const t = (k) => r2(filas.reduce((s, f) => s + f[k], 0));
      cuerpo.replaceChildren(
        tabla(['Empleado', 'Salario', 'Otros ingr.', 'AFP', 'SFS', 'ISR', 'Otros desc.', 'Neto'], filas.map((f) => {
          const oi = numero(ajustes[f.empleado.id]?.otros_ingresos ?? ''), od = numero(ajustes[f.empleado.id]?.otros_desc ?? '');
          const cambio = () => { ajustes[f.empleado.id] = { otros_ingresos: parseFloat(oi.value) || 0, otros_desc: parseFloat(od.value) || 0 }; };
          oi.addEventListener('change', async () => { cambio(); await pintar(); }); od.addEventListener('change', async () => { cambio(); await pintar(); });
          return [f.empleado.nombre, dinero(f.salario), oi, dinero(f.afp), dinero(f.sfs), dinero(f.isr), od, dinero(f.neto)];
        }), { num: [1, 3, 4, 5, 7] }),
        h('p', { class: 'ayuda' }, `Neto a pagar ${dinero(t('neto'))} · Aporte patronal ${dinero(r2(t('afp_pat') + t('sfs_pat') + t('srl_pat') + t('infotep')))}`));
    }
    await pintar();
    const cerrar = hoja('Nueva nómina', h('div', { class: 'cuerpo' }, campo('Mes', periodo), cuerpo,
      h('p', { class: 'ayuda' }, 'Cálculo orientativo con los porcentajes de Ajustes de nómina. Verifica con tu contador antes de pagar o declarar a la TSS y la DGII.'), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try { const n = await registrarNomina({ periodo: periodo.value, ajustes }); cerrar(); toast(`Nómina ${n} registrada`); await vistaNomina(raiz); }
        catch (x) { error.textContent = limpiar(x); }
      } }, 'Registrar nómina'))));
  }

  async function detalleN(n) {
    const det = await detalleNomina(n.id);
    const metodo = h('select', { class: 'campo' }, ['efectivo', 'transferencia', 'cheque'].map((m) => h('option', { value: m }, m)));
    const filas = det.map((d) => [d.nombre, d.salario, d.otros_ingresos, d.afp, d.sfs, d.isr, d.otros_desc, d.neto]);
    const cerrar = hoja(`Nómina ${n.periodo}`, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, `${n.numero} · ${n.estado === 'anulada' ? 'Anulada' : n.pagada ? `Pagada ${fechaCorta(n.fecha_pago)}` : 'Pendiente de pago'}`),
      tabla(['Empleado', 'Salario', 'Otros ingr.', 'AFP', 'SFS', 'ISR', 'Otros desc.', 'Neto'], filas.map((f) => f.map((v, i) => (i ? dinero(v) : v))), { num: [1, 2, 3, 4, 5, 6, 7] }),
      botonCSV(`nomina-${n.periodo}`, ['Empleado', 'Salario', 'Otros ingresos', 'AFP', 'SFS', 'ISR', 'Otros descuentos', 'Neto'], filas),
      n.estado === 'vigente' ? h('div', {},
        n.pagada ? null : h('div', {}, campo('Pagar con', metodo), h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
          try { await pagarNomina(n.id, { metodo: metodo.value }); cerrar(); toast('Nómina pagada'); await vistaNomina(raiz); } catch (x) { toast(limpiar(x), 'error'); }
        } }, 'Marcar como pagada'))),
        h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: async () => {
          if (!(await confirmar('Anular nómina', 'Se quitará de la contabilidad.', 'Anular'))) return;
          try { await anularNomina(n.id); cerrar(); toast('Nómina anulada'); await vistaNomina(raiz); } catch (x) { toast(limpiar(x), 'error'); }
        } }, 'Anular'))) : null));
  }

  async function parametros() {
    const { nomina: p } = await configConta();
    const campos = Object.keys(PARAMS_NOMINA).map((k) => [k, numero(p[k])]);
    const cerrar = hoja('Ajustes de nómina', h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, 'Porcentajes (en %) y topes de la TSS e ISR. Cámbialos cuando la ley los actualice; verifica estos valores cada año.'),
      campos.map(([k, i]) => campo(ETIQUETAS_NOMINA[k] || k, i)),
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        for (const [k, i] of campos) if (i.value !== '' && Number(i.value) !== p[k]) await guardarConfigConta(k, i.value);
        cerrar(); toast('Parámetros guardados');
      } }, 'Guardar'))));
  }

  raiz.replaceChildren(
    h('div', { class: 'filtros' }, h('div', { class: 'acciones' },
      h('button', { class: 'btn primario', onClick: nueva, disabled: !emps.some((e) => e.activo) }, 'Nueva nómina'),
      h('button', { class: 'btn', onClick: () => empleado() }, 'Nuevo empleado'),
      h('button', { class: 'btn', onClick: parametros }, 'Parámetros'))),
    h('h3', { class: 'seccion' }, 'Nóminas'),
    nominas.length ? h('div', { class: 'lista' }, nominas.map((n) => h('button', { class: `fila inventario ${n.estado === 'anulada' ? 'apagada' : ''}`, onClick: () => detalleN(n) },
      h('span', { class: 'datos' }, h('strong', {}, `Nómina ${n.periodo}`), h('small', {}, `${n.empleados} empleados · ${n.estado === 'anulada' ? 'anulada' : n.pagada ? 'pagada' : 'por pagar'}`)),
      h('span', { class: 'precio' }, dinero(n.neto))))) : vacio('Aún no hay nóminas.'),
    h('h3', { class: 'seccion' }, 'Empleados'),
    emps.length ? h('div', { class: 'lista' }, emps.map((e) => h('button', { class: `fila inventario ${e.activo ? '' : 'apagada'}`, onClick: () => empleado(e) },
      h('span', { class: 'datos' }, h('strong', {}, e.nombre), h('small', {}, e.cargo || 'Sin cargo')), h('span', { class: 'precio' }, dinero(e.salario))))) : vacio('Agrega a tus empleados para calcular la nómina.'));
}
