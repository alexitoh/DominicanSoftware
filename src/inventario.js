// inventario.js - existencias, alertas de reposición y movimientos de stock
import { consultar, transaccion, precioDesde, margenProducto, anotar } from './database.js';
import { botonEscaner } from './escaner.js';
import { h, hoja, toast, dinero, medidor } from './ui.js';

const REPONER = '(p.stock_actual <= 0 OR (p.stock_minimo > 0 AND p.stock_actual <= p.stock_minimo))';

export async function vistaInventario(raiz) {
  const estado = { texto: '', vista: 'todos' };
  const resumen = h('dl', { class: 'resumen' });
  const lista = h('div', { class: 'lista' });

  const buscador = h('input', {
    class: 'campo', type: 'search', placeholder: 'Buscar producto o ubicación',
    'aria-label': 'Buscar en inventario',
    onInput: (e) => { estado.texto = e.target.value; pintarLista(); },
  });

  const vistas = [['todos', 'Todos'], ['reponer', 'Por reponer'], ['agotados', 'Agotados']];
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Filtrar existencias' });
  const pintarSegmento = () => segmento.replaceChildren(...vistas.map(([id, texto]) =>
    h('button', {
      'aria-pressed': String(estado.vista === id),
      onClick: () => { estado.vista = id; pintarSegmento(); pintarLista(); },
    }, texto)));

  async function pintarResumen() {
    const [r] = await consultar(
      `SELECT COALESCE(SUM(p.stock_actual), 0) AS unidades,
              COALESCE(SUM(p.stock_actual * p.costo), 0) AS valor,
              COALESCE(SUM(CASE WHEN ${REPONER} THEN 1 ELSE 0 END), 0) AS reponer
         FROM productos p WHERE p.activo = 1`);
    const dato = (etiqueta, valor) => h('div', {}, h('dt', {}, etiqueta), h('dd', {}, valor));
    resumen.replaceChildren(
      dato('Unidades', r.unidades.toLocaleString('es-DO')),
      dato('Valor al costo', dinero(r.valor)),
      dato('Por reponer', String(r.reponer)));
  }

  async function pintarLista() {
    const like = `%${estado.texto.trim()}%`;
    const donde = estado.vista === 'reponer' ? `AND ${REPONER}` : estado.vista === 'agotados' ? 'AND p.stock_actual <= 0' : '';
    const filas = await consultar(
      `SELECT p.* FROM productos p
        WHERE p.activo = 1 AND (p.nombre LIKE ? OR p.codigo LIKE ? OR p.ubicacion LIKE ?) ${donde}
        ORDER BY ${estado.vista === 'todos' ? 'p.nombre' : 'p.stock_actual, p.nombre'}`,
      [like, like, like]);

    lista.replaceChildren(...(filas.length ? filas.map(fila) : [h('p', { class: 'vacio' },
      estado.vista === 'todos' && !estado.texto.trim()
        ? 'No hay productos todavía. Regístralos en la pestaña Productos.'
        : 'No hay productos en esta vista.')]));
  }

  function fila(p) {
    return h('button', { class: 'fila inventario', onClick: () => mover(p) },
      h('span', { class: 'datos' },
        h('strong', {}, p.nombre),
        h('small', {}, p.ubicacion || 'Sin ubicación'),
        h('span', { class: 'stock' }, medidor(p.stock_actual, p.stock_minimo),
          p.stock_minimo > 0 ? h('small', {}, `mínimo ${p.stock_minimo}`) : null)),
      h('span', { class: 'cantidad' }, String(p.stock_actual), h('small', {}, 'unidades')));
  }

  async function recargar() { await pintarResumen(); await pintarLista(); }

  async function mover(p) {
    let tipo = 'entrada';
    let cerrar = () => {};
    const cantidad = h('input', { class: 'campo', type: 'number', inputmode: 'numeric', min: '0', step: '1' });
    const costoNuevo = h('input', {
      class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01',
      placeholder: `Costo actual: ${dinero(p.costo)}`, 'aria-label': 'Costo nuevo',
    });
    const motivo = h('select', { class: 'campo', 'aria-label': 'Motivo de la salida' },
      ['Dañado', 'Garantía', 'Uso interno', 'Otro'].map((m) => h('option', { value: m }, m)));
    const etiqueta = h('span', {});
    const margenActual = margenProducto(p);
    const avisoPrecio = h('small', { class: 'ganancia' });
    costoNuevo.addEventListener('input', () => {
      const c = parseFloat(costoNuevo.value);
      avisoPrecio.textContent = Number.isFinite(c) && c >= 0 && margenActual != null
        ? `El precio de venta pasará de ${dinero(p.precio)} a ${dinero(precioDesde(c, margenActual))} (margen ${margenActual}%).`
        : '';
    });
    const campoCosto = h('label', { class: 'etiqueta' }, 'Costo nuevo (opcional)', costoNuevo, avisoPrecio,
      h('small', { class: 'ayuda' }, margenActual != null
        ? `El precio de venta se recalcula con el margen del producto (${margenActual}%). Si solo quieres cambiar el costo, deja la cantidad en 0.`
        : 'Si solo quieres cambiar el costo, deja la cantidad en 0.'));
    const campoMotivo = h('label', { class: 'etiqueta' }, 'Motivo', motivo);
    const error = h('p', { class: 'error', role: 'alert' });

    const tipos = [['entrada', 'Entrada'], ['salida', 'Salida'], ['ajuste', 'Ajuste']];
    const segmentoTipo = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Tipo de movimiento' });
    const actualizar = () => {
      segmentoTipo.replaceChildren(...tipos.map(([id, texto]) =>
        h('button', { 'aria-pressed': String(tipo === id), onClick: () => { tipo = id; actualizar(); } }, texto)));
      etiqueta.textContent = tipo === 'entrada' ? 'Unidades que llegan'
        : tipo === 'salida' ? 'Unidades que salen'
        : 'Cantidad contada en el almacén';
      campoCosto.style.display = tipo === 'entrada' ? '' : 'none';
      campoMotivo.style.display = tipo === 'salida' ? '' : 'none';
      error.textContent = '';
    };
    actualizar();

    async function registrar() {
      const n = parseInt(cantidad.value, 10);
      if (!Number.isInteger(n) || n < 0) { error.textContent = 'Escribe una cantidad válida.'; cantidad.focus(); return; }
      const soloCosto = tipo === 'entrada' && n === 0 && costoNuevo.value !== '';
      let delta;
      let razon;
      if (tipo === 'entrada') {
        if (n <= 0 && !soloCosto) { error.textContent = 'La cantidad debe ser mayor que cero.'; return; }
        delta = n; razon = 'compra';
      } else if (tipo === 'salida') {
        if (n <= 0) { error.textContent = 'La cantidad debe ser mayor que cero.'; return; }
        if (n > p.stock_actual) { error.textContent = `Solo hay ${p.stock_actual} unidades en stock.`; return; }
        delta = -n; razon = motivo.value;
      } else {
        delta = n - p.stock_actual; razon = 'ajuste de conteo';
        if (delta === 0) { error.textContent = 'El stock ya coincide con ese conteo.'; return; }
      }

      const set = soloCosto ? [] : [
        { statement: 'UPDATE productos SET stock_actual = stock_actual + ? WHERE id = ?', values: [delta, p.id] },
        {
          statement: 'INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo) VALUES (?,?,?,?)',
          values: [p.id, tipo, delta, razon],
        },
      ];
      let precioNuevo = null;
      if (tipo === 'entrada' && costoNuevo.value !== '') {
        const c = parseFloat(costoNuevo.value);
        if (!(c >= 0)) { error.textContent = 'El costo no es válido.'; return; }
        if (margenActual != null) {
          // El costo nuevo se toma como base: el precio sigue el margen del producto
          precioNuevo = precioDesde(c, margenActual);
          set.push({ statement: 'UPDATE productos SET costo = ?, precio = ?, margen = ? WHERE id = ?', values: [c, precioNuevo, margenActual, p.id] });
        } else {
          set.push({ statement: 'UPDATE productos SET costo = ? WHERE id = ?', values: [c, p.id] });
        }
      }
      try {
        await transaccion(set);
        await anotar(tipo === 'entrada' ? 'Entrada de inventario' : tipo === 'salida' ? 'Salida de inventario' : 'Ajuste de inventario',
          `${p.nombre}: ${soloCosto ? 'solo costo' : `${delta > 0 ? '+' : ''}${delta} (${razon})`}${precioNuevo != null ? `; precio → ${precioNuevo}` : ''}`);
        cerrar();
        toast(precioNuevo != null ? `Costo actualizado. Nuevo precio de venta: ${dinero(precioNuevo)}` : 'Movimiento registrado');
        await recargar();
      } catch (e) {
        error.textContent = `No se pudo registrar: ${e.message || e}`;
      }
    }

    const movs = await consultar(
      'SELECT tipo, cantidad, motivo, fecha FROM movimientos_inventario WHERE producto_id = ? ORDER BY id DESC LIMIT 8', [p.id]);
    const historial = movs.length
      ? h('ul', { class: 'historial' }, movs.map((m) => h('li', {},
          h('strong', {}, `${m.cantidad > 0 ? '+' : ''}${m.cantidad}`),
          h('span', {}, m.motivo || m.tipo),
          h('small', {}, m.fecha.slice(0, 16)))))
      : h('p', { class: 'ayuda' }, 'Este producto aún no tiene movimientos.');

    cerrar = hoja(p.nombre,
      h('div', { class: 'cuerpo' },
        h('p', { class: 'ayuda' }, `Stock actual: ${p.stock_actual} unidades`),
        segmentoTipo,
        h('label', { class: 'etiqueta' }, etiqueta, cantidad),
        campoCosto,
        campoMotivo,
        error,
        h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: registrar }, 'Registrar movimiento')),
        h('h3', {}, 'Últimos movimientos'),
        historial));
  }

  raiz.replaceChildren(
    h('header', { class: 'barra' }, h('h1', {}, 'Inventario')),
    resumen,
    h('div', { class: 'filtros' }, h('div', { class: 'buscador' }, buscador, botonEscaner({
      titulo: 'Buscar por código', ayuda: 'Escanea el código del producto',
      alLeer: (c) => { buscador.value = c; buscador.dispatchEvent(new Event('input')); return false; },
    })), segmento),
    lista);
  pintarSegmento();
  await recargar();
}
