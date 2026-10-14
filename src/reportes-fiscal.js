// reportes-fiscal.js - impuestos (607/606, ITBIS) y reportes de negocio (clientes, productos, P&L, flujo de caja)
import { consultar, exportarTexto, redondear, cajaAbierta, resumenCaja, configFiscal, asignarNCFVenta } from './database.js';
import { h, dinero, toast, hoja } from './ui.js';
import { condicionFecha } from './reportes.js';
import { selectorRango, rangoInicial, hoyISO } from './fechas.js';
import {
  filas607, filas606, textoDGII, nombreArchivoDGII, csv, ENCABEZADOS_607, ENCABEZADOS_606,
} from './itbis.js';
import { limpiarDocumento, validarDocumento } from './fiscal.js';

const renglon = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));
const dd = (s) => String(s || '').slice(0, 10).split('-').reverse().join('/');

// ---------------------------------------------------------------- IMPUESTOS
const mesActual = () => hoyISO().slice(0, 7);

export async function datosImpuestos(mes) {
  const cm = (col) => `strftime('%Y-%m', ${col}) = '${/^\d{4}-\d{2}$/.test(mes) ? mes : mesActual()}'`;
  const ventas = await consultar(
    `SELECT v.id, v.numero, v.fecha, v.total, v.itbis, v.ncf, v.metodo_pago, c.documento, c.nombre AS cliente
       FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.estado = 'completada' AND ${cm('v.fecha')} ORDER BY v.fecha, v.id`);
  const anuladas = await consultar(
    `SELECT numero, ncf FROM ventas v WHERE v.estado = 'anulada' AND v.ncf IS NOT NULL AND ${cm('v.fecha')}`);
  const compras = await consultar(
    `SELECT c.id, c.numero, c.fecha, c.total, c.itbis, c.ncf, p.documento, p.nombre AS proveedor,
            EXISTS(SELECT 1 FROM cuentas_pagar a WHERE a.compra_id = c.id) AS credito,
            (SELECT metodo FROM pagos_compra WHERE compra_id = c.id ORDER BY id LIMIT 1) AS metodo,
            (SELECT MAX(fecha) FROM pagos_compra WHERE compra_id = c.id) AS fecha_pago
       FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id
      WHERE c.estado = 'completada' AND ${cm('c.fecha')} ORDER BY c.fecha, c.id`);
  const gastos = await consultar(
    `SELECT id, fecha, concepto, monto AS total, itbis, ncf, documento, metodo FROM gastos WHERE ${cm('fecha')} ORDER BY fecha, id`);

  const cobrado = redondear(ventas.reduce((s, v) => s + v.itbis, 0));
  const pagado = redondear(compras.reduce((s, c) => s + c.itbis, 0) + gastos.reduce((s, g) => s + g.itbis, 0));

  const docs606 = [
    ...compras.map((c) => ({
      ncf: c.ncf, fecha: c.fecha, fecha_pago: c.fecha_pago, total: c.total, itbis: c.itbis, documento: c.documento, bienes: true,
      forma: c.credito ? 'credito' : (c.metodo || 'efectivo'),
    })),
    ...gastos.map((g) => ({ ncf: g.ncf, fecha: g.fecha, total: g.total, itbis: g.itbis, documento: g.documento, bienes: false, forma: g.metodo })),
  ];
  const avisos = [];
  const sinNcf = ventas.filter((v) => !v.ncf);
  if (sinNcf.length) avisos.push(`${sinNcf.length} ventas sin NCF: no entran en el 607.`);
  const b01 = ventas.filter((v) => v.ncf?.startsWith('B01') && limpiarDocumento(v.documento).length !== 9);
  if (b01.length) avisos.push(`${b01.length} ventas con NCF B01 sin un RNC válido del cliente.`);
  const compSin = compras.filter((c) => !c.ncf);
  if (compSin.length) avisos.push(`${compSin.length} compras sin NCF: no entran en el 606 ni dan ITBIS a favor.`);
  const gSin = gastos.filter((g) => !g.ncf);
  if (gSin.length) avisos.push(`${gSin.length} gastos sin NCF: no entran en el 606.`);
  if (anuladas.length) avisos.push(`${anuladas.length} ventas anuladas con NCF: se reportan en el formato 608 (no incluido aquí).`);
  const sinDoc = docs606.filter((d) => d.ncf && !limpiarDocumento(d.documento));
  if (sinDoc.length) avisos.push(`${sinDoc.length} comprobantes del 606 sin RNC/cédula del suplidor.`);

  return {
    mes, ventas, compras, gastos, sinNcf, cobrado, pagado, aPagar: redondear(cobrado - pagado),
    base: redondear(ventas.reduce((s, v) => s + v.total - v.itbis, 0)),
    filas607: filas607(ventas), filas606: filas606(docs606), avisos,
  };
}

export async function vistaImpuestos(raiz) {
  const [{ valor: rnc } = { valor: '' }] = await consultar("SELECT valor FROM config WHERE clave = 'negocio_rnc'");
  const fiscal = await configFiscal();
  const mes = h('input', { class: 'campo', type: 'month', value: mesActual(), 'aria-label': 'Mes' });
  const cuerpo = h('div');

  async function exportar(formato, d) {
    if (!rnc || !validarDocumento('rnc', rnc).numero) { toast('Escribe el RNC de tu negocio en Ajustes → Datos fiscales', 'error'); return; }
    const periodo = d.mes.replace('-', '');
    const filas = formato === '607' ? d.filas607 : d.filas606;
    if (!filas.length) { toast('No hay registros con NCF en este mes', 'error'); return; }
    await exportarTexto(nombreArchivoDGII(formato, rnc, periodo), textoDGII(formato, rnc, periodo, filas));
  }
  async function exportarCsv(formato, d) {
    const filas = formato === '607' ? d.filas607 : d.filas606;
    if (!filas.length) { toast('No hay registros con NCF en este mes', 'error'); return; }
    await exportarTexto(`${formato}_${d.mes}.csv`, csv(formato === '607' ? ENCABEZADOS_607 : ENCABEZADOS_606, filas), 'text/csv');
  }

  function asignar(v, repintar) {
    let cerrar = () => {};
    const ncf = h('input', { class: 'campo', placeholder: 'B0200000001', value: v.ncf || '', autocomplete: 'off' });
    const error = h('p', { class: 'error', role: 'alert' });
    cerrar = hoja(`NCF de la venta ${v.numero}`, h('div', { class: 'cuerpo' },
      h('label', { class: 'etiqueta' }, 'Número de comprobante fiscal', ncf), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try { await asignarNCFVenta(v.id, ncf.value); cerrar(); toast('NCF guardado'); await repintar(); } catch (e) { error.textContent = e.message; }
      } }, 'Guardar'))));
  }

  async function pintar() {
    const d = await datosImpuestos(mes.value || mesActual());
    cuerpo.replaceChildren(
      fiscal.modo === 'no' ? h('p', { class: 'ayuda' }, 'El ITBIS está desactivado. Actívalo en Ajustes → Datos fiscales para que las ventas nuevas lo calculen.') : null,
      h('dl', { class: 'resumen' },
        h('div', {}, h('dt', {}, 'ITBIS cobrado'), h('dd', {}, dinero(d.cobrado))),
        h('div', {}, h('dt', {}, 'ITBIS pagado'), h('dd', {}, dinero(d.pagado))),
        h('div', {}, h('dt', {}, d.aPagar >= 0 ? 'ITBIS a pagar' : 'ITBIS a favor'), h('dd', { class: d.aPagar < 0 ? '' : 'deuda' }, dinero(Math.abs(d.aPagar))))),
      h('section', { class: 'seccion' },
        h('h2', {}, 'Resumen del mes'),
        h('div', { class: 'totales' },
          renglon(`Ventas (${d.ventas.length}) sin ITBIS`, dinero(d.base)),
          renglon('ITBIS cobrado en ventas', dinero(d.cobrado)),
          renglon(`ITBIS pagado en compras (${d.compras.length})`, dinero(d.compras.reduce((s, c) => s + c.itbis, 0))),
          renglon(`ITBIS pagado en gastos (${d.gastos.length})`, dinero(d.gastos.reduce((s, g) => s + g.itbis, 0))),
          renglon(d.aPagar >= 0 ? 'ITBIS a pagar' : 'ITBIS a favor', dinero(Math.abs(d.aPagar)), 'gran')),
        h('p', { class: 'ayuda' }, 'Es un estimado para tu control; el ITBIS final lo declara tu contador en el IT-1 con ajustes (proporcionalidad, retenciones, saldos anteriores).')),
      d.avisos.length ? h('section', { class: 'seccion' }, h('h2', {}, 'Revisa antes de enviar'),
        ...d.avisos.map((a) => h('p', { class: 'ayuda deuda' }, a))) : null,
      h('section', { class: 'seccion' },
        h('h2', {}, 'Formato 607 · Ventas'),
        h('p', { class: 'ayuda' }, `${d.filas607.length} comprobantes con NCF.`),
        h('div', { class: 'acciones' },
          h('button', { class: 'btn', onClick: () => exportarCsv('607', d) }, 'Excel (CSV)'),
          h('button', { class: 'btn primario', onClick: () => exportar('607', d) }, 'Archivo DGII (.TXT)'))),
      h('section', { class: 'seccion' },
        h('h2', {}, 'Formato 606 · Compras y gastos'),
        h('p', { class: 'ayuda' }, `${d.filas606.length} comprobantes con NCF.`),
        h('div', { class: 'acciones' },
          h('button', { class: 'btn', onClick: () => exportarCsv('606', d) }, 'Excel (CSV)'),
          h('button', { class: 'btn primario', onClick: () => exportar('606', d) }, 'Archivo DGII (.TXT)'))),
      h('p', { class: 'ayuda' }, 'Antes de subir el archivo a la Oficina Virtual, pásalo por la herramienta de pre-validación de la DGII y revísalo con tu contador.'),
      d.sinNcf.length ? h('section', { class: 'seccion' }, h('h2', {}, 'Ventas sin NCF'),
        h('div', { class: 'lista' }, d.sinNcf.slice(0, 50).map((v) => h('button', { class: 'fila inventario', onClick: () => asignar(v, pintar) },
          h('span', { class: 'datos' }, h('strong', {}, `${v.numero} · ${v.cliente || 'Cliente general'}`), h('small', {}, `${dd(v.fecha)} · toca para asignar NCF`)),
          h('span', { class: 'precio' }, dinero(v.total)))))) : null);
  }
  mes.addEventListener('change', pintar);
  raiz.replaceChildren(h('div', { class: 'filtros' }, h('label', { class: 'etiqueta' }, 'Mes', mes)), cuerpo);
  await pintar();
}

// ---------------------------------------------------------------- NEGOCIO
export async function datosNegocio(periodo, rango) {
  const cv = condicionFecha(periodo, 'v.fecha', rango);
  const base = `FROM ventas v WHERE v.estado = 'completada' AND ${cv}`;
  const porCliente = await consultar(
    `SELECT COALESCE(c.nombre, 'Cliente general') AS nombre, COUNT(*) AS n, SUM(v.total) AS total
       FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.estado = 'completada' AND ${cv} GROUP BY v.cliente_id ORDER BY total DESC LIMIT 50`);
  const porVendedor = await consultar(
    `SELECT COALESCE(u.nombre, 'Sin asignar') AS nombre, COUNT(*) AS n, SUM(v.total) AS total
       FROM ventas v LEFT JOIN usuarios u ON u.id = v.usuario_id
      WHERE v.estado = 'completada' AND ${cv} GROUP BY v.usuario_id ORDER BY total DESC`);
  const porProducto = await consultar(
    `SELECT p.nombre, SUM(d.cantidad) AS cantidad, SUM(d.cantidad * d.precio_unitario - d.descuento) AS total
       FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id JOIN productos p ON p.id = d.producto_id
      WHERE v.estado = 'completada' AND ${cv} GROUP BY d.producto_id ORDER BY total DESC LIMIT 50`);
  const porCategoria = await consultar(
    `SELECT COALESCE(k.nombre, 'Sin categoría') AS nombre, SUM(d.cantidad) AS cantidad, SUM(d.cantidad * d.precio_unitario - d.descuento) AS total
       FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id JOIN productos p ON p.id = d.producto_id
       LEFT JOIN categorias k ON k.id = p.categoria_id
      WHERE v.estado = 'completada' AND ${cv} GROUP BY p.categoria_id ORDER BY total DESC`);
  const porPeriodo = await consultar(
    `SELECT strftime('%Y-%m', v.fecha) AS mes, COUNT(*) AS n, SUM(v.total) AS total ${base} GROUP BY mes ORDER BY mes DESC LIMIT 24`);

  // Pérdidas y ganancias
  const [t] = await consultar(`SELECT COALESCE(SUM(v.total), 0) AS total, COALESCE(SUM(v.itbis), 0) AS itbis ${base}`);
  const [cs] = await consultar(
    `SELECT COALESCE(SUM(d.cantidad * d.costo_unitario), 0) AS costo
       FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id WHERE v.estado = 'completada' AND ${cv}`);
  const gastosCat = await consultar(
    `SELECT COALESCE(categoria, 'Sin categoría') AS categoria, SUM(monto - itbis) AS total FROM gastos
      WHERE ${condicionFecha(periodo, 'fecha', rango)} GROUP BY categoria ORDER BY total DESC`);
  const ingresos = redondear(t.total - t.itbis);
  const costo = redondear(cs.costo);
  const gastosTot = redondear(gastosCat.reduce((s, g) => s + g.total, 0));
  const pyg = { ingresos, itbis: redondear(t.itbis), costo, bruta: redondear(ingresos - costo), gastosCat, gastos: gastosTot, neta: redondear(ingresos - costo - gastosTot) };
  return { porCliente, porVendedor, porProducto, porCategoria, porPeriodo, pyg };
}

// ---------------------------------------------------------------- FLUJO DE CAJA
export const TRAMOS = [['vencido', 'Vencido', -1e9, -1], ['s1', 'Próximos 7 días', 0, 7], ['s2', '8 a 14 días', 8, 14], ['s3', '15 a 30 días', 15, 30], ['s4', '31 a 60 días', 31, 60], ['s5', 'Más de 60 días', 61, 1e9]];

export async function datosFlujo(hoy = hoyISO()) {
  const dias = (f) => Math.round((Date.UTC(+f.slice(0, 4), +f.slice(5, 7) - 1, +f.slice(8, 10)) - Date.UTC(+hoy.slice(0, 4), +hoy.slice(5, 7) - 1, +hoy.slice(8, 10))) / 86400000);
  const cobrar = await consultar(
    `SELECT * FROM (
       SELECT v.numero, c.nombre AS tercero,
              COALESCE(a.vence, date(v.fecha, '+' || COALESCE(c.dias_credito, 30) || ' days')) AS vence,
              v.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE venta_id = v.id) AS saldo
         FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id LEFT JOIN cuentas_cobrar a ON a.venta_id = v.id
        WHERE v.metodo_pago = 'credito' AND v.estado = 'completada') WHERE saldo > 0.005`);
  const pagar = await consultar(
    `SELECT * FROM (
       SELECT c.numero, p.nombre AS tercero,
              COALESCE(a.vence, date(c.fecha, '+' || COALESCE(p.dias_credito, 30) || ' days')) AS vence,
              c.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos_compra WHERE compra_id = c.id) AS saldo
         FROM cuentas_pagar a JOIN compras c ON c.id = a.compra_id LEFT JOIN proveedores p ON p.id = c.proveedor_id
        WHERE c.estado = 'completada') WHERE saldo > 0.005`);
  let inicial = 0;
  const caja = await cajaAbierta();
  if (caja) inicial = (await resumenCaja(caja)).esperado;
  let acumulado = redondear(inicial);
  const tramos = TRAMOS.map(([id, nombre, a, b]) => {
    const dentro = (x) => { const n = dias(x.vence); return n >= a && n <= b; };
    const entra = redondear(cobrar.filter(dentro).reduce((s, x) => s + x.saldo, 0));
    const sale = redondear(pagar.filter(dentro).reduce((s, x) => s + x.saldo, 0));
    acumulado = redondear(acumulado + entra - sale);
    return { id, nombre, entra, sale, neto: redondear(entra - sale), acumulado };
  });
  return {
    inicial: redondear(inicial), tramos,
    totalEntra: redondear(cobrar.reduce((s, x) => s + x.saldo, 0)), totalSale: redondear(pagar.reduce((s, x) => s + x.saldo, 0)),
  };
}

export async function vistaNegocio(raiz) {
  const estado = { periodo: 'mes', rango: rangoInicial() };
  const PER = [['hoy', 'Hoy'], ['semana', '7 días'], ['mes', 'Mes'], ['anio', 'Año'], ['rango', 'Rango'], ['todo', 'Todo']];
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Período' });
  const filaRango = selectorRango(estado.rango, () => pintar());
  const cuerpo = h('div');
  const pintarSeg = () => segmento.replaceChildren(...PER.map(([id, t]) => h('button', {
    'aria-pressed': String(estado.periodo === id),
    onClick: () => { estado.periodo = id; filaRango.mostrar(id === 'rango'); pintarSeg(); pintar(); },
  }, t)));
  const lista = (titulo, filas, detalle) => h('section', { class: 'seccion' }, h('h2', {}, titulo),
    filas.length ? h('div', { class: 'totales' }, filas.map((x) => renglon(detalle(x), dinero(x.total)))) : h('p', { class: 'ayuda' }, 'Sin ventas en este período.'));

  async function pintar() {
    const d = await datosNegocio(estado.periodo, estado.rango);
    const y = d.pyg;
    cuerpo.replaceChildren(
      h('section', { class: 'seccion' }, h('h2', {}, 'Pérdidas y ganancias'),
        h('div', { class: 'totales' },
          renglon('Ingresos por ventas (sin ITBIS)', dinero(y.ingresos)),
          renglon('Costo de lo vendido', `- ${dinero(y.costo)}`),
          renglon('Utilidad bruta', dinero(y.bruta), 'gran'),
          ...y.gastosCat.map((g) => renglon(`Gasto: ${g.categoria}`, `- ${dinero(g.total)}`)),
          renglon('Total gastos', `- ${dinero(y.gastos)}`),
          renglon(y.neta >= 0 ? 'Utilidad neta' : 'Pérdida neta', dinero(y.neta), `gran ${y.neta < 0 ? 'deuda' : ''}`)),
        h('p', { class: 'ayuda' }, 'Cálculo rápido por ventas realizadas (no por cobros). Los gastos se muestran sin su ITBIS.')),
      lista('Ventas por cliente', d.porCliente, (x) => `${x.nombre} (${x.n})`),
      lista('Ventas por vendedor', d.porVendedor, (x) => `${x.nombre} (${x.n})`),
      lista('Ventas por producto', d.porProducto, (x) => `${x.nombre} (${x.cantidad})`),
      lista('Ventas por categoría', d.porCategoria, (x) => `${x.nombre} (${x.cantidad})`),
      lista('Ventas por mes', d.porPeriodo, (x) => `${x.mes} (${x.n})`));
  }
  raiz.replaceChildren(h('div', { class: 'filtros' }, segmento, filaRango.el), cuerpo);
  pintarSeg();
  await pintar();
}

export async function vistaFlujo(raiz) {
  const d = await datosFlujo();
  raiz.replaceChildren(
    h('dl', { class: 'resumen' },
      h('div', {}, h('dt', {}, 'Por cobrar'), h('dd', {}, dinero(d.totalEntra))),
      h('div', {}, h('dt', {}, 'Por pagar'), h('dd', { class: d.totalSale ? 'deuda' : '' }, dinero(d.totalSale))),
      h('div', {}, h('dt', {}, 'Neto'), h('dd', {}, dinero(d.totalEntra - d.totalSale)))),
    h('section', { class: 'seccion' }, h('h2', {}, 'Flujo de caja estimado'),
      h('div', { class: 'totales' }, renglon('Efectivo en caja ahora', dinero(d.inicial))),
      ...d.tramos.map((t) => h('div', { class: 'totales' },
        h('strong', {}, t.nombre),
        renglon('Entra (cobros)', dinero(t.entra)),
        renglon('Sale (pagos a proveedores)', `- ${dinero(t.sale)}`),
        renglon('Saldo acumulado', dinero(t.acumulado), t.acumulado < 0 ? 'gran deuda' : 'gran'))),
      h('p', { class: 'ayuda' }, 'Supone que cada factura se cobra y se paga en su fecha límite. No incluye ventas ni gastos futuros. Lo vencido se muestra aparte porque aún no se ha cobrado o pagado.')));
}
