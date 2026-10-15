// caja.js - apertura de caja, gastos y cierre con cuadre de efectivo
import {
  consultar, cajaAbierta, abrirCaja, resumenCaja, registrarGasto, eliminarGasto, cerrarCaja,
  listarPendientes, detallePendiente, cobrarPendiente, cancelarPendiente,
} from './database.js';
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { panelCobro } from './caja-cobro.js';
import { imprimirContado, abrirImpresoras } from './impresion.js';
import { sincronizarAhora } from './nube-app.js';

const CATEGORIAS = [
  'Alquiler', 'Luz y agua', 'Internet y teléfono', 'Transporte', 'Sueldos', 'Pago a proveedor', 'Mantenimiento', 'Otros',
];
const METODOS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque' };

const renglon = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));
const campo = (etiqueta, input) => h('label', { class: 'etiqueta' }, etiqueta, input);
const numero = (placeholder = '0.00') => h('input', {
  class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder,
});

export async function vistaCaja(raiz) {
  const cuerpo = h('div');
  const porCobrar = h('div');
  let cajaActual = null;
  let conteoAnterior = null;

  async function pintar() {
    const caja = await cajaAbierta();
    cajaActual = caja;
    const historial = await consultar("SELECT * FROM caja WHERE estado = 'cerrada' ORDER BY id DESC LIMIT 30");
    cuerpo.replaceChildren(
      porCobrar,
      caja ? await bloqueAbierta(caja) : bloqueCerrada(historial[0]),
      seccionHistorial(historial));
    await pintarPorCobrar();
  }

  // ---------- Ventas enviadas por los vendedores, esperando que el cliente pague ----------
  async function pintarPorCobrar() {
    const lista = await listarPendientes();
    if (conteoAnterior != null && lista.length > conteoAnterior) toast('Hay una nueva venta por cobrar');
    conteoAnterior = lista.length;
    porCobrar.replaceChildren(h('section', { class: 'seccion' },
      h('h2', {}, lista.length ? `Por cobrar (${lista.length})` : 'Por cobrar'),
      !lista.length
        ? h('p', { class: 'ayuda' }, 'No hay ventas esperando. Cuando un vendedor envíe una venta al contado a caja, aparecerá aquí.')
        : h('div', { class: 'lista' },
            !cajaActual ? h('p', { class: 'error' }, 'Abre la caja para poder cobrar estas ventas.') : null,
            ...lista.map((p) => h('button', { class: 'fila inventario', onClick: () => cobrarVenta(p) },
              h('span', { class: 'datos' },
                h('strong', {}, `${p.numero} · ${p.cliente || 'Cliente general'}`),
                h('small', {}, `${p.fecha.slice(11, 16)} · ${p.lineas} ${p.lineas === 1 ? 'línea' : 'líneas'}${p.vendedor ? ` · ${p.vendedor}` : ''}`)),
              h('span', { class: 'precio' }, dinero(p.total)))))));
  }

  async function cobrarVenta(p) {
    if (!cajaActual) { toast('Abre la caja para cobrar', 'error'); return; }
    const { items, servicios } = await detallePendiente(p.id);
    let cerrar = () => {};
    const error = h('p', { class: 'error', role: 'alert' });
    async function cancelar() {
      const ok = await confirmar('Cancelar venta', `Se cancelará ${p.numero} por ${dinero(p.total)}. El vendedor tendrá que enviarla de nuevo.`, 'Cancelar venta');
      if (!ok) return;
      try { await cancelarPendiente(p.id); cerrar(); toast('Venta cancelada'); await pintarPorCobrar(); } catch (e) { error.textContent = e.message || String(e); }
    }
    const avisos = items.filter((l) => l.stock_actual < l.cantidad).map((l) => `${l.nombre} (hay ${l.stock_actual})`);
    cerrar = hoja(`Cobrar ${p.numero}`,
      h('div', { class: 'cuerpo' },
        h('p', { class: 'ayuda' }, `${p.cliente || 'Cliente general'}${p.vendedor ? ` · Vendedor: ${p.vendedor}` : ''}`),
        h('ul', { class: 'historial detalle' },
          ...items.map((l) => h('li', {}, h('strong', {}, `${l.cantidad}×`), h('span', {}, l.nombre), h('small', {}, dinero(l.cantidad * l.precio_unitario - (l.descuento || 0))))),
          ...servicios.map((s) => h('li', {}, h('strong', {}, `${s.cantidad}×`), h('span', {}, `${s.descripcion} (servicio)`), h('small', {}, dinero(s.cantidad * s.precio_unitario))))),
        avisos.length ? h('p', { class: 'error' }, `Falta inventario: ${avisos.join('; ')}. Cancela la venta o corrige el inventario antes de cobrar.`) : null,
        panelCobro({
          total: p.total,
          alCobrar: async ({ metodo, recibido }) => {
            const numero = await cobrarPendiente(p.id, { metodo_pago: metodo });
            const [v] = await consultar('SELECT id, total FROM ventas WHERE numero = ?', [numero]);
            cerrar();
            toast(`Cobrado. Factura ${numero}`);
            await pintar();
            await imprimirContado(v.id, { recibido: recibido ?? null });
          },
        }),
        error,
        h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: cancelar }, 'Cancelar esta venta'))));
  }

  // Las ventas nuevas llegan por sincronización: mientras esta pantalla esté abierta se revisa cada pocos segundos
  const reloj = setInterval(async () => {
    if (cuerpo.isConnected === false) { clearInterval(reloj); return; }
    try { await sincronizarAhora(); await pintarPorCobrar(); } catch { /* sin conexión: se reintenta */ }
  }, 6000);

  // ---------- Caja cerrada: abrir ----------
  function bloqueCerrada(ultimo) {
    const inicial = numero();
    inicial.value = ultimo?.efectivo_contado ?? 0;
    inicial.setAttribute('aria-label', 'Efectivo inicial');
    const error = h('p', { class: 'error', role: 'alert' });
    const boton = h('button', { class: 'btn primario', onClick: abrir }, 'Abrir caja');

    async function abrir() {
      error.textContent = '';
      const valor = parseFloat(inicial.value);
      if (!(valor >= 0)) { error.textContent = 'Escribe cuánto efectivo hay para empezar (puede ser 0).'; inicial.focus(); return; }
      boton.disabled = true;
      try {
        await abrirCaja(valor);
        toast('Caja abierta');
        await pintar();
      } catch (e) {
        boton.disabled = false;
        error.textContent = e.message || String(e);
      }
    }

    return h('section', { class: 'seccion' },
      h('h2', {}, 'La caja está cerrada'),
      h('p', { class: 'ayuda' }, 'Ábrela al empezar el día con el efectivo que tienes en el cajón. Los gastos se registran con la caja abierta.'),
      campo('Efectivo inicial', inicial),
      error,
      boton);
  }

  // ---------- Caja abierta: resumen, gastos y cierre ----------
  async function bloqueAbierta(caja) {
    const r = await resumenCaja(caja);
    const gastos = await consultar('SELECT * FROM gastos WHERE caja_id = ? ORDER BY id DESC', [caja.id]);
    const fueraDeCaja = `Fuera del cajón: tarjeta ${dinero(r.tarjeta)}, transferencia ${dinero(r.transferencia)}${r.cheque > 0 ? `, cheques ${dinero(r.cheque)}` : ''}.`
      + (r.gastos_otros > 0 ? ` Gastos pagados sin efectivo: ${dinero(r.gastos_otros)}.` : '')
      + (r.proveedores_otros > 0 ? ` Pagos a proveedores sin efectivo: ${dinero(r.proveedores_otros)}.` : '');

    return h('div', {},
      h('section', { class: 'seccion' },
        h('h2', {}, 'Caja abierta'),
        h('p', { class: 'ayuda' }, `Desde ${caja.fecha_apertura.slice(0, 16)}`),
        h('div', { class: 'totales' },
          renglon('Efectivo inicial', dinero(r.inicial)),
          renglon('Ventas en efectivo', dinero(r.ventas_efectivo)),
          renglon('Cobros de crédito en efectivo', dinero(r.cobros_efectivo)),
          renglon('Gastos en efectivo', `- ${dinero(r.gastos_efectivo)}`),
          renglon('Pagos a proveedores en efectivo', `- ${dinero(r.proveedores_efectivo)}`),
          renglon('Efectivo esperado en caja', dinero(r.esperado), 'gran')),
        h('p', { class: 'ayuda' }, fueraDeCaja),
        h('div', { class: 'acciones' },
          h('button', { class: 'btn', onClick: () => formularioGasto() }, 'Registrar gasto'),
          h('button', { class: 'btn primario', onClick: () => formularioCierre(caja, r) }, 'Cerrar caja'))),
      h('section', { class: 'seccion' },
        h('h2', {}, 'Gastos de este turno'),
        gastos.length
          ? h('div', { class: 'lista' }, gastos.map((g) => h('button', { class: 'fila inventario', onClick: () => detalleGasto(g) },
              h('span', { class: 'datos' },
                h('strong', {}, g.concepto),
                h('small', {}, [g.categoria, METODOS[g.metodo] || g.metodo, g.fecha.slice(11, 16)].filter(Boolean).join(', '))),
              h('span', { class: 'precio' }, dinero(g.monto)))))
          : h('p', { class: 'ayuda' }, 'Todavía no hay gastos en este turno.')));
  }

  function formularioGasto() {
    let cerrar = () => {};
    const concepto = h('input', { class: 'campo', placeholder: 'Ej. Almuerzo, gasolina, luz', autocomplete: 'off' });
    const categoria = h('select', { class: 'campo', 'aria-label': 'Categoría' },
      CATEGORIAS.map((c) => h('option', { value: c }, c)));
    categoria.value = 'Otros';
    const monto = numero();
    const metodo = h('select', { class: 'campo', 'aria-label': 'Método de pago' },
      Object.entries(METODOS).map(([k, t]) => h('option', { value: k }, t)));
    const nota = h('input', { class: 'campo', placeholder: 'Opcional', autocomplete: 'off' });
    const ncfG = h('input', { class: 'campo', placeholder: 'B0100000001 (opcional)', autocomplete: 'off' });
    const itbisG = h('input', { class: 'campo', type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: '0.00' });
    const docG = h('input', { class: 'campo', inputmode: 'numeric', placeholder: 'RNC del suplidor', autocomplete: 'off' });
    const error = h('p', { class: 'error', role: 'alert' });
    const boton = h('button', { class: 'btn primario', onClick: guardar }, 'Guardar gasto');

    async function guardar() {
      error.textContent = '';
      const m = parseFloat(monto.value);
      if (!concepto.value.trim()) { error.textContent = 'Escribe en qué se gastó.'; concepto.focus(); return; }
      if (!(m > 0)) { error.textContent = 'Escribe el monto del gasto.'; monto.focus(); return; }
      boton.disabled = true;
      try {
        await registrarGasto({
          concepto: concepto.value, categoria: categoria.value, monto: m,
          metodo: metodo.value, nota: nota.value.trim() || null,
          ncf: ncfG.value.trim() || null, itbis: parseFloat(itbisG.value) || 0, documento: docG.value.trim() || null,
        });
        cerrar();
        toast('Gasto registrado');
        await pintar();
      } catch (e) {
        boton.disabled = false;
        error.textContent = e.message || String(e);
      }
    }

    cerrar = hoja('Registrar gasto',
      h('div', { class: 'cuerpo' },
        campo('Concepto', concepto),
        h('div', { class: 'rejilla' }, campo('Categoría', categoria), campo('Monto', monto)),
        campo('Pagado con', metodo),
        campo('Nota', nota),
        h('div', { class: 'rejilla' }, campo('NCF', ncfG), campo('ITBIS incluido', itbisG)),
        campo('RNC del suplidor', docG),
        error,
        h('div', { class: 'acciones' }, boton)));
  }

  function detalleGasto(g) {
    let cerrar = () => {};
    async function quitar() {
      const ok = await confirmar('Eliminar gasto', `Se eliminará "${g.concepto}" por ${dinero(g.monto)} y el efectivo esperado se recalcula.`, 'Eliminar gasto');
      if (!ok) return;
      try {
        await eliminarGasto(g.id);
        cerrar();
        toast('Gasto eliminado');
        await pintar();
      } catch (e) {
        toast(e.message || 'No se pudo eliminar', 'error');
      }
    }
    cerrar = hoja(g.concepto,
      h('div', { class: 'cuerpo' },
        h('div', { class: 'totales' },
          renglon('Monto', dinero(g.monto), 'gran'),
          renglon('Categoría', g.categoria || 'Sin categoría'),
          renglon('Pagado con', METODOS[g.metodo] || g.metodo),
          renglon('Fecha', g.fecha.slice(0, 16))),
        g.nota ? h('p', { class: 'ayuda' }, g.nota) : null,
        h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: quitar }, 'Eliminar gasto'))));
  }

  function formularioCierre(caja, r) {
    let cerrar = () => {};
    const contado = numero();
    contado.setAttribute('aria-label', 'Efectivo contado');
    const nota = h('input', { class: 'campo', placeholder: 'Opcional', autocomplete: 'off' });
    const diferencia = h('p', { class: 'ayuda', role: 'status' });
    const error = h('p', { class: 'error', role: 'alert' });
    const boton = h('button', { class: 'btn primario', onClick: cerrarTurno }, 'Cerrar caja');

    contado.addEventListener('input', () => {
      const v = parseFloat(contado.value);
      if (!Number.isFinite(v)) { diferencia.textContent = ''; diferencia.className = 'ayuda'; return; }
      const d = Math.round((v - r.esperado) * 100) / 100;
      diferencia.className = d < 0 ? 'deuda' : 'ayuda';
      diferencia.textContent = d === 0 ? 'La caja cuadra.' : d > 0 ? `Sobran ${dinero(d)}.` : `Faltan ${dinero(-d)}.`;
    });

    async function cerrarTurno() {
      error.textContent = '';
      const v = parseFloat(contado.value);
      if (!(v >= 0)) { error.textContent = 'Cuenta el efectivo del cajón y escríbelo aquí (puede ser 0).'; contado.focus(); return; }
      boton.disabled = true;
      try {
        await cerrarCaja({ cajaId: caja.id, contado: v, notas: nota.value.trim() });
        cerrar();
        toast('Caja cerrada');
        await pintar();
      } catch (e) {
        boton.disabled = false;
        error.textContent = e.message || String(e);
      }
    }

    cerrar = hoja('Cerrar caja',
      h('div', { class: 'cuerpo' },
        h('div', { class: 'totales' }, renglon('Efectivo esperado', dinero(r.esperado), 'gran')),
        campo('Efectivo contado en el cajón', contado),
        diferencia,
        campo('Nota', nota),
        error,
        h('div', { class: 'acciones' }, boton)));
  }

  // ---------- Historial de cierres ----------
  function seccionHistorial(historial) {
    return h('section', { class: 'seccion' },
      h('h2', {}, 'Cierres anteriores'),
      historial.length
        ? h('div', { class: 'lista' }, historial.map((c) => {
            const d = c.diferencia ?? 0;
            return h('div', { class: 'fila inventario' },
              h('span', { class: 'datos' },
                h('strong', {}, c.fecha_apertura.slice(0, 10)),
                h('small', {}, `${c.fecha_apertura.slice(11, 16)} a ${(c.fecha_cierre || '').slice(11, 16)}, esperado ${dinero(c.efectivo_esperado)}`),
                c.notas ? h('small', {}, c.notas) : null),
              h('span', { class: 'precio' }, dinero(c.efectivo_contado),
                h('small', { class: `bloque ${d < 0 ? 'deuda' : d > 0 ? '' : 'pagada'}` },
                  d === 0 ? 'Cuadró' : d > 0 ? `Sobraron ${dinero(d)}` : `Faltaron ${dinero(-d)}`)));
          }))
        : h('p', { class: 'ayuda' }, 'Aún no hay cierres de caja.'));
  }

  raiz.replaceChildren(h('header', { class: 'barra' }, h('h1', {}, 'Caja'), h('button', { class: 'btn claro', onClick: () => abrirImpresoras() }, 'Impresoras')), cuerpo);
  await pintar();
}
