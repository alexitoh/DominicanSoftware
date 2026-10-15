// inicio.js - panel de inicio con un icono por módulo y avisos importantes
import { consultar } from './database.js';
import { h, dinero } from './ui.js';
import { traducir } from './i18n.js';
import { abrirPestana } from './contabilidad.js';

const svg = (cuerpo) => `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${cuerpo}</svg>`;

// Módulos de la app: sirven para el panel de inicio y la barra superior
export const MODULOS = [
  { id: 'ventas', titulo: 'Ventas', color: '#0E5A6B',
    icono: svg('<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20.5 7H6"/>') },
  { id: 'productos', titulo: 'Productos', color: '#2F7DB5',
    icono: svg('<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>') },
  { id: 'inventario', titulo: 'Inventario', color: '#5B6FB8',
    icono: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>') },
  { id: 'compras', titulo: 'Compras', color: '#C77A1E',
    icono: svg('<path d="M2 6h11v10H2z"/><path d="M13 9h4l4 4v3h-8"/><circle cx="6.5" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>') },
  { id: 'caja', titulo: 'Caja', color: '#2F9E5B',
    icono: svg('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.3"/>') },
  { id: 'clientes', titulo: 'Clientes', color: '#8A5BB8',
    icono: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.6 3.2-5.5 6.5-5.5s6 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14.5c2.6 0 4.2 1.5 4.5 4"/>') },
  { id: 'proveedores', titulo: 'Proveedores', color: '#7A6A4F',
    icono: svg('<path d="M3 21V10l6 3V10l6 3V6h6v15z"/><path d="M8 21v-4h3v4"/>') },
  { id: 'garantias', titulo: 'Garantías', color: '#1E8E8A',
    icono: svg('<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5L16 9.5"/>') },
  { id: 'reportes', titulo: 'Reportes', color: '#D14F85',
    icono: svg('<path d="M4 4v16h16"/><rect x="8" y="11" width="3" height="6"/><rect x="13" y="7" width="3" height="10"/><rect x="18" y="13" width="2" height="4"/>') },
  { id: 'contabilidad', titulo: 'Contabilidad', color: '#1F6F5C',
    icono: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8"/><path d="M8 11h2M12 11h2M8 15h2M12 15h2M16 11v4"/>') },
  { id: 'finanzas', titulo: 'Finanzas', color: '#B7791F',
    icono: svg('<path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 15l4-5 3 3 5-7"/><path d="M16 6h3v3"/>') },
  { id: 'usuarios', titulo: 'Usuarios', color: '#3D4F8A',
    icono: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.6-3.8 3.4-6 7-6s6.4 2.2 7 6"/><path d="M17.5 3.5l.7 1.4 1.5.2-1.1 1 .3 1.5-1.4-.8-1.4.8.3-1.5-1.1-1 1.5-.2z"/>') },
  { id: 'ajustes', titulo: 'Ajustes', color: '#5B6B78',
    icono: svg('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>') },
];

// Botón "Inicio" de la barra superior
export const INICIO = {
  id: 'inicio', titulo: 'Inicio', color: '#15212B',
  icono: svg('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>'),
};

// Palabras extra para encontrar cada módulo aunque no se escriba su nombre exacto
const PALABRAS = {
  ventas: 'vender factura facturar cotizacion cotizaciones pos cobrar', productos: 'articulos catalogo precio precios codigo',
  inventario: 'stock existencia existencias almacen ajuste', compras: 'comprar suplidor mercancia', caja: 'efectivo cierre apertura gastos turno',
  clientes: 'direcciones contactos telefono', proveedores: 'suplidores', garantias: 'garantia',
  reportes: 'informes estadisticas ganancias', contabilidad: 'factura suplidor orden de compras requisicion cotizacion solicitud compras anticipo suplidor tipo de suplidor pago de contado cxc cxp cuentas por cobrar pagar recibo recibos nota credito debito anticipo anticipos condicion de pago tipo de cliente abonos cobrar gastos periodos fiscal diarios deudas proveedores credito contable asientos balance cuentas banco bancos nomina activos fijos presupuesto libro diario mayor erp', finanzas: 'analisis financiero ratios razones balance general estado de resultados flujo de efectivo variacion de capital conversion moneda dolar euro tasa de cambio diferencia cambiaria presupuesto reporte dinamico', usuarios: 'empleados vendedores permisos contrasena', ajustes: 'configuracion nube respaldo logo moneda idioma',
};
const plano = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

// Módulos que coinciden con lo escrito (nombre en español o en el idioma actual, o palabras relacionadas)
export function buscarModulos(texto, puede = () => true) {
  const q = plano(texto);
  const todos = [INICIO, ...MODULOS].filter((m) => puede(m.id));
  if (!q) return todos.filter((m) => m.id !== 'inicio');
  // Primero los que empiezan con lo escrito, luego los que lo contienen
  const nota = (m) => {
    const nombres = [m.titulo, traducir(m.titulo)].map(plano);
    if (nombres.some((t) => t.startsWith(q))) return 0;
    if (nombres.some((t) => t.includes(q))) return 1;
    return plano(PALABRAS[m.id] || '').includes(q) ? 2 : 3;
  };
  return todos.map((m) => [nota(m), m]).filter(([n]) => n < 3).sort((a, b) => a[0] - b[0]).map(([, m]) => m);
}

export const icono = (m) => {
  const e = h('span', { class: 'tile-icono', style: `background:${m.color}` });
  e.innerHTML = m.icono; // SVG fijo definido arriba, sin datos del usuario
  return e;
};

export function crearVistaInicio(ir, puede = () => true, nombreUsuario = () => '') {
  return async function vistaInicio(raiz) {
    const cfg = Object.fromEntries((await consultar(
      "SELECT clave, valor FROM config WHERE clave IN ('negocio_nombre','negocio_logo')")).map((r) => [r.clave, r.valor]));
    const [hoy] = await consultar(
      "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM ventas WHERE estado = 'completada' AND date(fecha) = date('now','localtime')");
    const [caja] = await consultar("SELECT id FROM caja WHERE estado = 'abierta' LIMIT 1");
    const [reponer] = await consultar(
      'SELECT COUNT(*) AS n FROM productos WHERE activo = 1 AND (stock_actual <= 0 OR (stock_minimo > 0 AND stock_actual <= stock_minimo))');
    const [garantias] = await consultar(
      `SELECT COUNT(*) AS n FROM garantias g JOIN ventas v ON v.id = g.venta_id
        WHERE g.estado = 'vigente' AND v.estado = 'completada'
          AND date(g.vence) BETWEEN date('now','localtime') AND date('now','localtime','+30 days')`);
    const [porCobrar] = await consultar(
      `SELECT COALESCE(SUM(v.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE venta_id = v.id)), 0) AS total
         FROM ventas v WHERE v.metodo_pago = 'credito' AND v.estado = 'completada'`);
    const [vencidas] = await consultar(
      `SELECT COUNT(*) AS n, COALESCE(SUM(saldo), 0) AS total FROM (
         SELECT c.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos_compra WHERE compra_id = c.id) AS saldo, a.vence
           FROM cuentas_pagar a JOIN compras c ON c.id = a.compra_id
          WHERE c.estado = 'completada') WHERE saldo > 0.005 AND vence IS NOT NULL AND date(vence) < date('now','localtime')`);

    const dato = (et, val, clase = '') => h('div', {}, h('dt', {}, et), h('dd', { class: clase }, val));
    const aviso = (texto, destino, clase = '', pestana = null) =>
      h('button', { class: `aviso ${clase}`, onClick: () => { if (pestana) abrirPestana(pestana); ir(destino); } }, h('span', {}, texto), h('span', { class: 'flecha', 'aria-hidden': 'true' }, '›'));
    const avisos = [
      !caja && puede('caja') ? aviso('La caja está cerrada', 'caja') : null,
      reponer.n && puede('inventario') ? aviso(`${reponer.n} ${reponer.n === 1 ? 'producto por reponer' : 'productos por reponer'}`, 'inventario', 'alerta') : null,
      vencidas.n && puede('contabilidad') ? aviso(`${vencidas.n} ${vencidas.n === 1 ? 'cuenta vencida' : 'cuentas vencidas'} con proveedores (${dinero(vencidas.total)})`, 'contabilidad', 'alerta', 'cxp') : null,
      garantias.n && puede('garantias') ? aviso(`${garantias.n} ${garantias.n === 1 ? 'garantía vence' : 'garantías vencen'} en 30 días`, 'garantias') : null,
      porCobrar.total > 0.005 && puede('contabilidad') ? aviso(`Por cobrar a clientes: ${dinero(porCobrar.total)}`, 'contabilidad', '', 'cxc') : null,
    ].filter(Boolean);

    raiz.replaceChildren(
      h('header', { class: 'barra' }, h('h1', {}, 'Inicio')),
      h('section', { class: 'portada' },
        cfg.negocio_logo ? h('img', { class: 'portada-logo', src: cfg.negocio_logo, alt: '' }) : null,
        h('strong', {}, cfg.negocio_nombre || 'Mi negocio')),
      nombreUsuario() ? h('p', { class: 'saludo' }, `Hola, ${nombreUsuario()}`) : null,
      puede('ventas') ? h('dl', { class: 'resumen' },
        dato('Vendido hoy', dinero(hoy.total)),
        dato('Ventas hoy', String(hoy.n)),
        dato('Caja', caja ? 'Abierta' : 'Cerrada', caja ? 'pagada' : '')) : null,
      avisos.length ? h('div', { class: 'avisos' }, avisos) : null,
      buscadorModulos(ir, puede));
  };
}

// Caja de búsqueda con la lista de módulos que se va filtrando; Enter abre el primero
export function buscadorModulos(ir, puede, alElegir = () => {}) {
  const entrada = h('input', { class: 'campo buscador', type: 'search', placeholder: 'Buscar módulo…', 'aria-label': 'Buscar módulo', autocomplete: 'off' });
  const tiles = h('nav', { class: 'tiles', 'aria-label': 'Módulos' });
  const abrir = (m) => { alElegir(); ir(m.id); };
  const pintar = () => {
    const l = buscarModulos(entrada.value, puede);
    tiles.replaceChildren(...(l.length
      ? l.map((m) => h('button', { class: 'tile', onClick: () => abrir(m) }, icono(m), h('span', {}, m.titulo)))
      : [h('p', { class: 'vacio' }, 'No hay módulos con ese nombre.')]));
  };
  entrada.addEventListener('input', pintar);
  entrada.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const l = buscarModulos(entrada.value, puede); if (l[0]) abrir(l[0]); } });
  pintar();
  return h('div', { class: 'buscador-modulos' }, entrada, tiles);
}
