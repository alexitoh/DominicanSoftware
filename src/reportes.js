// reportes.js - ventas, ganancias, gastos, productos más vendidos e inventario
import { consultar } from './database.js';
import { h, dinero } from './ui.js';
import { condicionRango, rangoInicial, selectorRango, hoyISO } from './fechas.js';
import { textoCondicion } from './condicion.js';
import { vistaNegocio, vistaFlujo } from './reportes-fiscal.js';

const PERIODOS = [['hoy', 'Hoy'], ['semana', '7 días'], ['mes', 'Mes'], ['anio', 'Año'], ['rango', 'Rango'], ['todo', 'Todo']];

// Condición SQL sobre una columna de fecha (guardadas en hora local)
export function condicionFecha(periodo, col, rango) {
  switch (periodo) {
    case 'rango': return condicionRango(col, rango);
    case 'hoy': return `date(${col}) = date('now','localtime')`;
    case 'semana': return `date(${col}) >= date('now','localtime','-6 days')`;
    case 'mes': return `strftime('%Y-%m', ${col}) = strftime('%Y-%m','now','localtime')`;
    case 'anio': return `strftime('%Y', ${col}) = strftime('%Y','now','localtime')`;
    default: return '1 = 1';
  }
}

const METODOS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque', credito: 'Crédito (fiado)' };
const renglon = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));

export async function datosReporte(periodo, rango) {
  const cv = condicionFecha(periodo, 'v.fecha', rango);
  const [t] = await consultar(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(descuento), 0) AS dto
       FROM ventas v WHERE v.estado = 'completada' AND ${cv}`);
  const [g] = await consultar(
    `SELECT COALESCE(SUM(d.cantidad * (d.precio_unitario - d.costo_unitario) - d.descuento), 0) AS ganancia
       FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
      WHERE v.estado = 'completada' AND ${cv}`);
  const [sv] = await consultar(
    `SELECT COALESCE(SUM(s.cantidad * s.precio_unitario), 0) AS total
       FROM venta_servicios s JOIN ventas v ON v.id = s.venta_id
      WHERE v.estado = 'completada' AND ${cv}`);
  g.ganancia += sv.total; // los servicios no tienen costo de inventario
  const [gs] = await consultar(`SELECT COALESCE(SUM(monto), 0) AS total FROM gastos WHERE estado = 'vigente' AND ${condicionFecha(periodo, 'fecha', rango)}`);
  const [cp] = await consultar(
    `SELECT COALESCE(SUM(total), 0) AS total FROM compras c WHERE c.estado = 'completada' AND ${condicionFecha(periodo, 'c.fecha', rango)}`);
  const metodos = await consultar(
    `SELECT metodo_pago AS metodo, COUNT(*) AS n, SUM(total) AS total FROM ventas v
      WHERE v.estado = 'completada' AND ${cv} GROUP BY metodo_pago ORDER BY total DESC`);
  const porDia = await consultar(
    `SELECT date(v.fecha) AS dia, COUNT(*) AS n, SUM(total) AS total FROM ventas v
      WHERE v.estado = 'completada' AND ${cv} GROUP BY date(v.fecha) ORDER BY dia DESC LIMIT 92`);
  const top = await consultar(
    `SELECT p.nombre, SUM(d.cantidad) AS cantidad,
            SUM(d.cantidad * d.precio_unitario - d.descuento) AS ingreso,
            SUM(d.cantidad * (d.precio_unitario - d.costo_unitario) - d.descuento) AS ganancia
       FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id JOIN productos p ON p.id = d.producto_id
      WHERE v.estado = 'completada' AND ${cv}
      GROUP BY d.producto_id ORDER BY cantidad DESC, ingreso DESC LIMIT 10`);
  const gastosCat = await consultar(
    `SELECT COALESCE(categoria, 'Sin categoría') AS categoria, SUM(monto) AS total FROM (
       SELECT categoria, monto, fecha FROM gastos WHERE estado = 'vigente'
       UNION ALL SELECT categoria, monto, fecha FROM caja_chica_movs WHERE tipo = 'desembolso' AND estado = 'vigente')
      WHERE ${condicionFecha(periodo, 'fecha', rango)} GROUP BY categoria ORDER BY total DESC`);
  const [porCobrar] = await consultar(
    `SELECT COALESCE(SUM(v.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE venta_id = v.id)), 0) AS total
       FROM ventas v WHERE v.metodo_pago = 'credito' AND v.estado = 'completada'`);
  const [porPagar] = await consultar(
    `SELECT COALESCE(SUM(c.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos_compra WHERE compra_id = c.id)), 0) AS total
       FROM cuentas_pagar a JOIN compras c ON c.id = a.compra_id WHERE c.estado = 'completada'`);
  const vendedores = await consultar(
    `SELECT COALESCE(u.nombre, 'Sin asignar') AS vendedor, COUNT(*) AS n, COALESCE(SUM(v.total), 0) AS total
       FROM ventas v LEFT JOIN usuarios u ON u.id = v.usuario_id
      WHERE v.estado = 'completada' AND ${cv} GROUP BY v.usuario_id ORDER BY total DESC`);
  const [inv] = await consultar(
    `SELECT COUNT(*) AS productos, COALESCE(SUM(stock_actual), 0) AS unidades,
            COALESCE(SUM(stock_actual * costo), 0) AS al_costo, COALESCE(SUM(stock_actual * precio), 0) AS al_precio,
            COALESCE(SUM(CASE WHEN stock_actual <= 0 THEN 1 ELSE 0 END), 0) AS agotados,
            COALESCE(SUM(CASE WHEN stock_actual > 0 AND stock_actual <= stock_minimo THEN 1 ELSE 0 END), 0) AS bajos
       FROM productos WHERE activo = 1`);
  return {
    ventas: t.n, vendido: t.total, gananciaBruta: g.ganancia - t.dto, gastos: gs.total, compras: cp.total,
    neta: g.ganancia - t.dto - gs.total, metodos, vendedores, porDia, top, gastosCat, porCobrar: porCobrar.total, porPagar: porPagar.total, inv,
  };
}

export async function vistaReportes(raiz) {
  const estado = { periodo: 'mes', rango: rangoInicial() };
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Período' });
  const filaRango = selectorRango(estado.rango, () => pintar());
  const cuerpo = h('div');
  const pestanas = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Reporte' });
  const barraPeriodo = h('div', { class: 'filtros' }, segmento, filaRango.el);
  const contenido = h('div');
  let pestana = 'general';
  const pintarPestanas = () => pestanas.replaceChildren(...[['general', 'Resumen'], ['negocio', 'Negocio y P&L'], ['flujo', 'Flujo de caja']].map(([id, t]) =>
    h('button', { 'aria-pressed': String(pestana === id), onClick: async () => {
      pestana = id; pintarPestanas();
      barraPeriodo.style.display = id === 'general' ? '' : 'none';
      if (id === 'general') { contenido.replaceChildren(cuerpo); await pintar(); }
      else if (id === 'negocio') await vistaNegocio(contenido);
      else await vistaFlujo(contenido);
    } }, t)));

  const pintarSegmento = () => segmento.replaceChildren(...PERIODOS.map(([id, t]) =>
    h('button', {
      'aria-pressed': String(estado.periodo === id),
      onClick: () => { estado.periodo = id; filaRango.mostrar(id === 'rango'); pintarSegmento(); pintar(); },
    }, t)));

  async function pintar() {
    const d = await datosReporte(estado.periodo, estado.rango);
    const dato = (et, val, clase = '') => h('div', {}, h('dt', {}, et), h('dd', { class: clase }, val));
    const maxDia = Math.max(1, ...d.porDia.map((x) => x.total));

    cuerpo.replaceChildren(
      h('dl', { class: 'resumen' },
        dato('Vendido', dinero(d.vendido)),
        dato('Ganancia', dinero(d.gananciaBruta)),
        dato('Ganancia neta', dinero(d.neta), d.neta < 0 ? 'deuda' : '')),
      h('section', { class: 'seccion' },
        h('h2', {}, 'Resumen'),
        h('div', { class: 'totales' },
          renglon(`Ventas (${d.ventas})`, dinero(d.vendido)),
          renglon('Ganancia de las ventas', dinero(d.gananciaBruta)),
          renglon('Gastos', `- ${dinero(d.gastos)}`),
          renglon('Ganancia neta', dinero(d.neta), 'gran'),
          renglon('Compras a proveedores', dinero(d.compras))),
        h('p', { class: 'ayuda' }, 'La ganancia neta es la ganancia de las ventas menos los gastos. Las compras no se restan: lo que vendes ya descuenta su costo.')),
      d.porPagar > 0.005
        ? h('section', { class: 'seccion' }, h('div', { class: 'totales' },
            d.porPagar > 0.005 ? renglon('Por pagar a proveedores (ahora)', dinero(d.porPagar), 'deuda') : null)) : null,
      h('section', { class: 'seccion' },
        h('h2', {}, 'Ventas por método de pago'),
        d.metodos.length
          ? h('div', { class: 'totales' }, d.metodos.map((m) => renglon(`${METODOS[m.metodo] || m.metodo} (${m.n})`, dinero(m.total))))
          : h('p', { class: 'ayuda' }, 'Sin ventas en este período.')),
      d.vendedores.length > 1 || (d.vendedores[0] && d.vendedores[0].vendedor !== 'Sin asignar')
        ? h('section', { class: 'seccion' },
            h('h2', {}, 'Ventas por vendedor'),
            h('div', { class: 'totales' }, d.vendedores.map((x) => renglon(`${x.vendedor} (${x.n})`, dinero(x.total)))))
        : null,
      h('section', { class: 'seccion' },
        h('h2', {}, 'Ventas por día'),
        d.porDia.length
          ? h('div', { class: 'dias' }, d.porDia.map((x) => h('div', { class: 'dia' },
              h('span', {}, `${x.dia.slice(8, 10)}/${x.dia.slice(5, 7)}`),
              h('span', { class: 'barrita' }, h('i', { style: `width:${Math.max(2, (x.total / maxDia) * 100)}%` })),
              h('span', {}, dinero(x.total)))))
          : h('p', { class: 'ayuda' }, 'Sin ventas en este período.')),
      h('section', { class: 'seccion' },
        h('h2', {}, 'Productos más vendidos'),
        d.top.length
          ? h('div', { class: 'lista' }, d.top.map((p, i) => h('div', { class: 'fila inventario' },
              h('span', { class: 'datos' },
                h('strong', {}, `${i + 1}. ${p.nombre}`),
                h('small', {}, `${p.cantidad} vendidos, ganancia ${dinero(p.ganancia)}`)),
              h('span', { class: 'precio' }, dinero(p.ingreso)))))
          : h('p', { class: 'ayuda' }, 'Sin ventas en este período.')),
      h('section', { class: 'seccion' },
        h('h2', {}, 'Gastos por categoría'),
        d.gastosCat.length
          ? h('div', { class: 'totales' }, d.gastosCat.map((c) => renglon(c.categoria, dinero(c.total))))
          : h('p', { class: 'ayuda' }, 'Sin gastos en este período.')),
      h('section', { class: 'seccion' },
        h('h2', {}, 'Inventario (ahora)'),
        h('div', { class: 'totales' },
          renglon(`Productos activos (${d.inv.unidades} unidades)`, String(d.inv.productos)),
          renglon('Valor al costo', dinero(d.inv.al_costo), 'gran'),
          renglon('Valor a precio de venta', dinero(d.inv.al_precio)),
          renglon('Ganancia potencial', dinero(d.inv.al_precio - d.inv.al_costo)),
          renglon('Agotados', String(d.inv.agotados), d.inv.agotados ? 'deuda' : ''),
          renglon('Con stock bajo', String(d.inv.bajos)))));
  }

  raiz.replaceChildren(
    h('header', { class: 'barra' }, h('h1', {}, 'Reportes')),
    h('div', { class: 'filtros' }, pestanas),
    barraPeriodo,
    contenido);
  contenido.replaceChildren(cuerpo);
  pintarPestanas();
  pintarSegmento();
  await pintar();
}
