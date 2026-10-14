// conta-ui-asientos.js - pestañas Asientos y Cuentas (catálogo)
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { consultar } from './database.js';
import {
  libroContable, crearAsiento, anularAsiento, listarCuentas, listarCentros, crearCuenta, editarCuenta, eliminarCuenta, fechaHoy,
} from './conta-db.js';
import { diario, saldoNatural, r2, validarAsiento } from './conta-motor.js';
import { ROLES, TIPOS_CUENTA, nivelDe } from './conta-plan.js';
import { campo, numero, fechaInput, texto, selectCuentas, tabla, renglon, vacio, fechaCorta, limpiar } from './conta-ui-comun.js';

const ORIGENES = {
  manual: 'Manual', apertura: 'Apertura', cierre: 'Cierre', venta: 'Venta', cobro: 'Cobro', compra: 'Compra', pagocompra: 'Pago a proveedor',
  gasto: 'Gasto', activo: 'Activo fijo', baja: 'Baja de activo', depreciacion: 'Depreciación', nomina: 'Nómina', pagonomina: 'Pago de nómina', banco: 'Banco',
};

// ---------------- Asientos ----------------
export async function vistaAsientos(raiz) {
  const lib = await libroContable();
  const cuentas = new Map(lib.cuentas.map((c) => [c.id, c]));
  let filtro = 'todos';
  let buscar = '';
  const lista = h('div');
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Origen' });
  const cuadro = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar por concepto o número', onInput: (e) => { buscar = e.target.value.toLowerCase(); pintar(); } });
  const todos = diario(lib.lineas, '0000-01-01', '9999-12-31').reverse();

  function pintarSeg() {
    segmento.replaceChildren(...[['todos', 'Todos'], ['manual', 'Manuales'], ['auto', 'Automáticos']].map(([id, t]) =>
      h('button', { 'aria-pressed': String(filtro === id), onClick: () => { filtro = id; pintarSeg(); pintar(); } }, t)));
  }
  function pintar() {
    const f = todos.filter((a) => (filtro === 'todos' || (filtro === 'manual' ? a.origen === 'manual' : a.origen !== 'manual'))
      && (!buscar || `${a.concepto} ${a.numero}`.toLowerCase().includes(buscar))).slice(0, 150);
    lista.replaceChildren(f.length ? h('div', { class: 'lista' }, f.map((a) => {
      const total = r2(a.lineas.reduce((s, l) => s + l.debe, 0));
      return h('button', { class: 'fila inventario', onClick: () => detalle(a) },
        h('span', { class: 'datos' }, h('strong', {}, a.concepto), h('small', {}, `${fechaCorta(a.fecha)} · ${ORIGENES[a.origen === 'manual' ? a.lineas[0].tipoAsiento : a.origen] || a.origen} · ${a.numero}`)),
        h('span', { class: 'precio' }, dinero(total)));
    })) : vacio('No hay asientos con ese filtro.'));
  }

  function detalle(a) {
    const manual = a.origen === 'manual';
    const cerrar = hoja(a.concepto, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, `${fechaCorta(a.fecha)} · ${manual ? `Asiento ${a.numero}` : 'Asiento automático'}`),
      tabla(['Cuenta', 'Débito', 'Crédito'], a.lineas.map((l) => [
        h('span', {}, `${cuentas.get(l.cuenta_id)?.codigo} · ${cuentas.get(l.cuenta_id)?.nombre}`, l.detalle ? h('small', { class: 'ayuda' }, ` ${l.detalle}`) : null),
        l.debe ? dinero(l.debe) : '', l.haber ? dinero(l.haber) : '']), { num: [1, 2] }),
      manual ? h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: async () => {
        if (!(await confirmar('Anular asiento', `Se anulará el asiento ${a.numero}. No se borra: queda en el historial como anulado.`, 'Anular'))) return;
        try {
          const [{ id }] = await consultar('SELECT id FROM asientos WHERE numero = ?', [a.numero]);
          await anularAsiento(id); cerrar(); toast('Asiento anulado'); await vistaAsientos(raiz);
        } catch (e) { toast(limpiar(e), 'error'); }
      } }, 'Anular asiento')) : h('p', { class: 'ayuda' }, 'Este asiento se genera solo desde el documento original. Para cambiarlo, modifica o anula el documento.')));
    return cerrar;
  }

  async function nuevo(tipo = 'manual') {
    const cuentasAct = (await listarCuentas(true));
    const centros = (await listarCentros()).filter((c) => c.activo);
    const fecha = fechaInput(fechaHoy());
    const concepto = texto('', tipo === 'apertura' ? 'Saldos de apertura' : 'Ej. Pago de seguro');
    if (tipo === 'apertura') concepto.value = 'Saldos de apertura';
    const filas = [];
    const cuerpoFilas = h('div', { class: 'lineas-asiento' });
    const resumen = h('div', { class: 'totales' });
    const error = h('p', { class: 'error', role: 'alert' });
    function linea() {
      const c = selectCuentas(cuentasAct);
      const d = numero(), hb = numero();
      const ct = h('select', { class: 'campo', 'aria-label': 'Centro de costo' }, h('option', { value: '' }, 'Sin centro'), centros.map((x) => h('option', { value: String(x.id) }, x.nombre)));
      const det = texto('', 'Detalle (opcional)');
      const fila = { c, d, hb, ct, det };
      const caja = h('div', { class: 'linea-asiento' }, c,
        h('div', { class: 'rejilla' }, h('label', { class: 'etiqueta chica' }, 'Débito', d), h('label', { class: 'etiqueta chica' }, 'Crédito', hb)),
        centros.length ? ct : null, det,
        h('button', { class: 'icono', 'aria-label': 'Quitar línea', onClick: () => { if (filas.length > 2) { filas.splice(filas.indexOf(fila), 1); caja.remove(); sumar(); } } }, '✕'));
      [d, hb].forEach((i) => i.addEventListener('input', () => {
        if (i === d && d.value) hb.value = ''; if (i === hb && hb.value) d.value = ''; sumar();
      }));
      filas.push(fila); cuerpoFilas.append(caja);
    }
    const leer = () => filas.map((f) => ({ cuenta_id: Number(f.c.value) || null, debe: parseFloat(f.d.value) || 0, haber: parseFloat(f.hb.value) || 0, detalle: f.det.value.trim(), centro_id: Number(f.ct.value) || null }));
    function sumar() {
      const ls = leer();
      const d = r2(ls.reduce((s, l) => s + l.debe, 0)), hb = r2(ls.reduce((s, l) => s + l.haber, 0));
      resumen.replaceChildren(renglon('Débitos', dinero(d)), renglon('Créditos', dinero(hb)),
        renglon(Math.abs(d - hb) < 0.005 ? 'Cuadrado' : 'Diferencia', dinero(Math.abs(d - hb)), Math.abs(d - hb) < 0.005 ? '' : 'deuda'));
    }
    linea(); linea(); sumar();
    const guardar = h('button', { class: 'btn primario', onClick: async () => {
      error.textContent = '';
      try {
        validarAsiento(leer());
        guardar.disabled = true;
        const num = await crearAsiento({ fecha: fecha.value, concepto: concepto.value, tipo, lineas: leer() });
        cerrar(); toast(`Asiento ${num} guardado`); await vistaAsientos(raiz);
      } catch (e) { guardar.disabled = false; error.textContent = limpiar(e); }
    } }, 'Guardar asiento');
    const cerrar = hoja(tipo === 'apertura' ? 'Saldos de apertura' : 'Nuevo asiento', h('div', { class: 'cuerpo' },
      tipo === 'apertura' ? h('p', { class: 'ayuda' }, 'Registra aquí lo que tenías al empezar (caja, bancos, deudas, capital…). Si lo haces, define la fecha de inicio contable en la pestaña Ajustes para que los documentos anteriores no se cuenten dos veces.') : null,
      h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('Concepto', concepto)),
      cuerpoFilas,
      h('button', { class: 'btn', onClick: linea }, '+ Agregar línea'), resumen, error, h('div', { class: 'acciones' }, guardar)));
  }

  raiz.replaceChildren(
    h('div', { class: 'filtros' }, h('div', { class: 'acciones' },
      h('button', { class: 'btn primario', onClick: () => nuevo('manual') }, 'Nuevo asiento'),
      h('button', { class: 'btn', onClick: () => nuevo('apertura') }, 'Saldos de apertura')),
    segmento, cuadro),
    lib.faltantes.length ? h('p', { class: 'ayuda deuda', style: 'padding:0 1rem' }, `Falta asignar cuenta a: ${lib.faltantes.map((r) => ROLES[r] || r).join(', ')}. Mientras tanto, esos documentos no se contabilizan. Ve a Cuentas.`) : null,
    lista);
  pintarSeg(); pintar();
}

// ---------------- Cuentas (catálogo) ----------------
export async function vistaCuentas(raiz) {
  const lib = await libroContable();
  const saldos = new Map();
  for (const l of lib.lineas) { const s = saldos.get(l.cuenta_id) || { d: 0, h: 0 }; s.d += l.debe; s.h += l.haber; saldos.set(l.cuenta_id, s); }
  const saldoDe = (c) => { const s = saldos.get(c.id); return s ? saldoNatural(c.tipo, s.d, s.h) : 0; };
  const hojas = lib.cuentas;
  const sumaTitulo = (c) => r2(hojas.filter((x) => !x.grupo && x.tipo === c.tipo && x.codigo.startsWith(c.codigo)).reduce((s, x) => s + saldoDe(x), 0));

  function formulario(c = null) {
    const nuevo = !c;
    const codigo = texto(c?.codigo ?? '', 'Ej. 6210');
    const nombre = texto(c?.nombre ?? '');
    const tipo = h('select', { class: 'campo' }, Object.entries(TIPOS_CUENTA).map(([k, t]) => h('option', { value: k }, t.nombre)));
    tipo.value = c?.tipo || 'gasto';
    const grupo = h('input', { type: 'checkbox', checked: !!c?.grupo });
    const rol = h('select', { class: 'campo' }, h('option', { value: '' }, 'Ninguno'), Object.entries(ROLES).map(([k, t]) => h('option', { value: k }, t)));
    rol.value = c?.rol || '';
    const cat = texto(c?.categoria_gasto ?? '', 'Categoría de gasto de Caja (opcional)');
    const activo = h('input', { type: 'checkbox', checked: c ? !!c.activo : true });
    const error = h('p', { class: 'error', role: 'alert' });
    const datos = () => ({ codigo: codigo.value, nombre: nombre.value, tipo: tipo.value, grupo: grupo.checked, rol: rol.value || null, categoria_gasto: cat.value.trim() || null, activo: activo.checked ? 1 : 0 });
    const cerrar = hoja(nuevo ? 'Nueva cuenta' : 'Editar cuenta', h('div', { class: 'cuerpo' },
      h('div', { class: 'rejilla' }, campo('Código', codigo), campo('Tipo', tipo)),
      campo('Nombre', nombre),
      h('label', { class: 'etiqueta' }, grupo, ' Es un título (agrupa otras cuentas, no recibe movimientos)'),
      campo('Función en la contabilización automática', rol, 'Elige una para que el sistema use esta cuenta en ventas, compras, nómina, etc. Una función la tiene una sola cuenta.'),
      campo('Gastos de Caja que carga a esta cuenta', cat, 'Escribe el nombre exacto de la categoría de gasto (por ejemplo, Alquiler).'),
      nuevo ? null : h('label', { class: 'etiqueta' }, activo, ' Cuenta activa'),
      error,
      h('div', { class: 'acciones' },
        nuevo || c.sistema ? null : h('button', { class: 'btn peligro', onClick: async () => {
          try { await eliminarCuenta(c.id); cerrar(); toast('Cuenta eliminada'); await vistaCuentas(raiz); } catch (e) { error.textContent = limpiar(e); }
        } }, 'Eliminar'),
        h('button', { class: 'btn primario', onClick: async () => {
          error.textContent = '';
          try { if (nuevo) await crearCuenta(datos()); else await editarCuenta(c.id, datos()); cerrar(); toast('Cuenta guardada'); await vistaCuentas(raiz); }
          catch (e) { error.textContent = limpiar(e); }
        } }, 'Guardar'))));
  }

  raiz.replaceChildren(
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nueva cuenta')),
    h('div', { class: 'lista' }, lib.cuentas.map((c) => h('button', { class: `fila inventario ${c.activo ? '' : 'apagada'}`, onClick: () => formulario(c) },
      h('span', { class: 'datos', style: `padding-left:${nivelDe(c.codigo) * 14}px` },
        h('strong', {}, `${c.codigo} · ${c.nombre}`),
        h('small', {}, `${TIPOS_CUENTA[c.tipo].nombre}${c.grupo ? ' · título' : ''}${c.rol ? ` · ${ROLES[c.rol]}` : ''}${c.categoria_gasto ? ` · gastos "${c.categoria_gasto}"` : ''}${c.activo ? '' : ' · desactivada'}`)),
      h('span', { class: 'precio' }, dinero(c.grupo ? sumaTitulo(c) : saldoDe(c)))))),
    h('p', { class: 'ayuda', style: 'padding:.75rem 1rem' }, 'Saldo según su naturaleza (activos y gastos suben con débitos; pasivos, patrimonio e ingresos con créditos).'));
}
