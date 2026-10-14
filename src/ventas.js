// ventas.js - historial, nueva venta con carrito, ventas a crédito, detalle y anulación
import { consultar, ejecutar, registrarVenta, anularVenta, redondear, configFiscal } from './database.js';
import { TIPOS_NCF, NOMBRE_COMPROBANTE, calcularItbis, comprobanteDeCliente } from './itbis.js';
import { buscarRNC } from './dgii.js';
import { limpiarDocumento } from './fiscal.js';
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { condicionRango, rangoInicial, selectorRango, hoyISO } from './fechas.js';
import { formularioCliente } from './clientes.js';
import { textoCondicion, DIAS_POR_DEFECTO } from './condicion.js';
import { formularioAbono } from './cobros.js';
import { compartirFactura } from './factura.js';
import { botonEscaner } from './escaner.js';
import { tienePermiso, registrarBitacora } from './auth.js';
import { vistaCotizaciones, formularioCotizacion } from './cotizaciones.js';

const PERIODOS = {
  hoy: "date(v.fecha) = date('now','localtime')",
  mes: "strftime('%Y-%m', v.fecha) = strftime('%Y-%m', 'now', 'localtime')",
  todas: '1 = 1',
};
const METODOS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque', credito: 'Crédito' };
const OPCIONES_PAGO = [
  ['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transferencia'], ['cheque', 'Cheque'], ['credito', 'Crédito (fiado)'],
];
const PAGADO = '(SELECT COALESCE(SUM(p.monto), 0) FROM pagos p WHERE p.venta_id = v.id)';

async function compartir(ventaId) {
  try {
    await compartirFactura(ventaId);
  } catch (e) {
    const msg = String(e?.message || e);
    if (!/cancel/i.test(msg)) toast(`No se pudo crear la factura: ${msg}`, 'error');
  }
}

const renglon = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));

export async function vistaVentas(raiz) {
  const estado = { periodo: 'hoy', rango: rangoInicial() };
  const resumen = h('dl', { class: 'resumen' });
  const lista = h('div', { class: 'lista' });
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Período' });
  const filaRango = selectorRango(estado.rango, () => pintar());

  const pintarSegmento = () => segmento.replaceChildren(...[['hoy', 'Hoy'], ['mes', 'Este mes'], ['rango', 'Rango'], ['todas', 'Todas']].map(([id, t]) =>
    h('button', {
      'aria-pressed': String(estado.periodo === id),
      onClick: () => { estado.periodo = id; filaRango.mostrar(id === 'rango'); pintarSegmento(); pintar(); },
    }, t)));

  async function pintar() {
    const cond = estado.periodo === 'rango' ? condicionRango('v.fecha', estado.rango) : PERIODOS[estado.periodo];
    const [t] = await consultar(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(descuento), 0) AS dto
         FROM ventas v WHERE v.estado = 'completada' AND ${cond}`);
    const [g] = await consultar(
      `SELECT COALESCE(SUM(d.cantidad * (d.precio_unitario - d.costo_unitario) - d.descuento), 0) AS ganancia
         FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
        WHERE v.estado = 'completada' AND ${cond}`);
    const [sv] = await consultar(
      `SELECT COALESCE(SUM(s.cantidad * s.precio_unitario), 0) AS total
         FROM venta_servicios s JOIN ventas v ON v.id = s.venta_id
        WHERE v.estado = 'completada' AND ${cond}`);
    const dato = (et, val) => h('div', {}, h('dt', {}, et), h('dd', {}, val));
    resumen.replaceChildren(
      dato('Vendido', dinero(t.total)),
      dato('Ventas', String(t.n)),
      tienePermiso('reportes') ? dato('Ganancia', dinero(g.ganancia + sv.total - t.dto)) : null);

    const filas = await consultar(
      `SELECT v.*, c.nombre AS cliente, ${PAGADO} AS pagado FROM ventas v
         LEFT JOIN clientes c ON c.id = v.cliente_id
        WHERE ${cond} ORDER BY v.id DESC LIMIT 500`);
    lista.replaceChildren(...(filas.length
      ? filas.map(fila)
      : [h('p', { class: 'vacio' }, estado.periodo === 'todas'
          ? 'Aún no hay ventas. Toca "Nueva venta" para registrar la primera.'
          : 'No hay ventas en este período.')]));
  }

  function fila(v) {
    const anulada = v.estado === 'anulada';
    const credito = v.metodo_pago === 'credito' && !anulada;
    const debe = credito ? redondear(v.total - v.pagado) : 0;
    return h('button', { class: 'fila inventario', onClick: () => detalle(v.id) },
      h('span', { class: 'datos' },
        h('strong', {}, v.numero, anulada ? h('span', { class: 'anulada' }, ' (anulada)') : null),
        h('small', {}, v.cliente || 'Cliente general'),
        h('small', {}, `${v.fecha.slice(0, 16)}, ${METODOS[v.metodo_pago] || v.metodo_pago}`),
        credito ? h('small', { class: debe > 0.005 ? 'deuda' : 'pagada' }, debe > 0.005 ? `Debe ${dinero(debe)}` : 'Pagada') : null),
      h('span', { class: `precio${anulada ? ' tachado' : ''}` }, dinero(v.total)));
  }

  async function detalle(id) {
    const [v] = await consultar(
      `SELECT v.*, c.nombre AS cliente, u.nombre AS vendedor FROM ventas v
         LEFT JOIN clientes c ON c.id = v.cliente_id LEFT JOIN usuarios u ON u.id = v.usuario_id WHERE v.id = ?`, [id]);
    const items = await consultar(
      `SELECT d.*, p.nombre FROM venta_detalle d JOIN productos p ON p.id = d.producto_id WHERE d.venta_id = ? ORDER BY d.id`, [id]);
    const servicios = await consultar('SELECT * FROM venta_servicios WHERE venta_id = ? ORDER BY id', [id]);
    const pagos = await consultar('SELECT * FROM pagos WHERE venta_id = ? ORDER BY id', [id]);
    const [cobro] = await consultar('SELECT vence FROM cuentas_cobrar WHERE venta_id = ?', [id]);
    const garantias = await consultar(
      `SELECT g.*, p.nombre FROM garantias g JOIN productos p ON p.id = g.producto_id WHERE g.venta_id = ? ORDER BY g.id`, [id]);
    const anulada = v.estado === 'anulada';
    const credito = v.metodo_pago === 'credito';
    const pagado = redondear(pagos.reduce((s, p) => s + p.monto, 0));
    const saldo = redondear(v.total - pagado);
    let cerrar = () => {};

    async function anular() {
      const unidades = items.reduce((s, i) => s + i.cantidad, 0);
      const aviso = credito && pagado > 0 ? ` Tiene ${dinero(pagado)} en abonos que deberás devolver al cliente.` : '';
      const ok = await confirmar('Anular venta',
        `Se anulará ${v.numero} y las ${unidades} unidades vuelven al inventario.${aviso}`, 'Anular venta');
      if (!ok) return;
      try {
        await anularVenta(id);
        await registrarBitacora('Venta anulada', v.numero);
        cerrar();
        toast('Venta anulada');
        await pintar();
      } catch (e) {
        toast(e.message || 'No se pudo anular', 'error');
      }
    }

    cerrar = hoja(v.numero,
      h('div', { class: 'cuerpo' },
        h('p', { class: 'ayuda' }, `${v.fecha.slice(0, 16)}, ${v.cliente || 'Cliente general'}, ${METODOS[v.metodo_pago] || v.metodo_pago}`),
        v.ncf ? h('p', { class: 'ayuda' }, `${NOMBRE_COMPROBANTE[v.ncf.slice(0, 3)] || 'Comprobante'}, NCF ${v.ncf}`) : null,
        v.vendedor ? h('p', { class: 'ayuda' }, `Atendió: ${v.vendedor}`) : null,
        anulada ? h('p', { class: 'error' }, 'Esta venta está anulada.') : null,
        h('ul', { class: 'historial detalle' }, items.map((i) => h('li', {},
          h('strong', {}, `${i.cantidad}×`),
          h('span', {}, i.nombre),
          h('small', {}, dinero(i.cantidad * i.precio_unitario - (i.descuento || 0))))),
          ...servicios.map((x) => h('li', {},
            h('strong', {}, `${x.cantidad}×`),
            h('span', {}, `${x.descripcion} (servicio)`),
            h('small', {}, dinero(x.cantidad * x.precio_unitario))))),
        garantias.length ? h('div', {},
          h('h3', {}, 'Garantías'),
          h('ul', { class: 'historial detalle' }, garantias.map((g) => h('li', {},
            h('span', {}, `${g.nombre}${g.serie ? `, serie ${g.serie}` : ''}`),
            h('small', {}, `${g.meses} m, hasta ${g.vence.split('-').reverse().join('/')}`))))) : null,
        h('div', { class: 'totales' },
          renglon('Subtotal', dinero(v.subtotal)),
          v.descuento > 0 ? renglon('Descuento', `- ${dinero(v.descuento)}`) : null,
          v.itbis > 0 && Math.abs(v.total - (v.subtotal - v.descuento) - v.itbis) < 0.01 ? renglon('ITBIS', dinero(v.itbis)) : null,
          renglon('Total', dinero(v.total), 'gran'),
          credito ? renglon('Abonado', dinero(pagado)) : null,
          credito ? renglon('Pendiente', dinero(anulada ? 0 : Math.max(0, saldo)),
            !anulada && saldo > 0.005 ? 'deuda' : '') : null,
          credito && cobro?.vence ? renglon('Fecha límite', cobro.vence.split('-').reverse().join('/'),
            !anulada && saldo > 0.005 && cobro.vence < hoyISO() ? 'deuda' : '') : null),
        pagos.length ? h('h3', {}, 'Abonos') : null,
        pagos.length
          ? h('ul', { class: 'historial abonos' }, pagos.map((p) => h('li', {},
              h('span', {}, `${p.fecha.slice(0, 10)}, ${METODOS[p.metodo] || p.metodo}${p.nota ? `, ${p.nota}` : ''}`),
              h('strong', {}, dinero(p.monto)))))
          : null,
        h('div', { class: 'acciones' },
          anulada || !tienePermiso('anular') ? null : h('button', { class: 'btn peligro', onClick: anular }, 'Anular venta'),
          credito && !anulada && saldo > 0.005
            ? h('button', {
                class: 'btn',
                onClick: () => formularioAbono({ id, numero: v.numero, total: v.total, pagado },
                  async () => { cerrar(); await pintar(); await detalle(id); }),
              }, 'Registrar abono')
            : null,
          h('button', { class: 'btn primario', onClick: () => compartir(id) }, 'Compartir factura'))));
  }

  // ---------- Nueva venta ----------
  async function nuevaVenta(precarga = null) {
    const carrito = new Map(); // producto_id -> { p, cantidad, precio }
    const servicios = []; // { descripcion, cantidad, precio } - mano de obra, sin inventario
    let cerrar = () => {};

    const resultados = h('div', { class: 'resultados' });
    const lineas = h('div', { class: 'carrito' });
    const totales = h('div', { class: 'totales' });
    const error = h('p', { class: 'error', role: 'alert' });

    const buscar = h('input', {
      class: 'campo', type: 'search', 'aria-label': 'Buscar producto',
      placeholder: 'Buscar producto por nombre, código o marca',
      onInput: () => pintarResultados(),
      onKeydown: async (e) => {
        if (e.key !== 'Enter' || !buscar.value.trim()) return;
        const [p] = await consultar('SELECT * FROM productos WHERE activo = 1 AND stock_actual > 0 AND codigo = ? COLLATE NOCASE', [buscar.value.trim()]);
        if (p) { await agregar(p); buscar.value = ''; pintarResultados(); }
      },
    });
    const clientesInfo = new Map();
    const cliente = h('select', { class: 'campo', 'aria-label': 'Cliente', onChange: () => { tipoNcf.value = 'auto'; pintarTotales(); aprenderRegimen(); } });
    const avisoCredito = h('p', { class: 'ayuda', role: 'status' });
    // Comprobante fiscal y consulta del RNC en la DGII
    const cfgF = await configFiscal();
    const tipoNcf = h('select', { class: 'campo', 'aria-label': 'Tipo de comprobante', onChange: () => pintarTotales() },
      h('option', { value: 'auto' }, 'Automático (según el cliente)'),
      ...Object.entries(TIPOS_NCF).map(([k, t]) => h('option', { value: k }, `${k} · ${t}`)));
    const estatusRnc = h('p', { class: 'ayuda', role: 'status' });
    const avisoNcf = h('p', { class: 'ayuda', role: 'status' });
    const rncRapido = h('input', {
      class: 'campo', inputmode: 'numeric', autocomplete: 'off', placeholder: 'RNC o cédula (consulta la DGII)', 'aria-label': 'RNC del cliente',
      onChange: () => buscarPorRnc(),
    });
    // Si el cliente tiene RNC y aún no sabemos su régimen, se pregunta a la DGII para asignarle el comprobante correcto
    async function aprenderRegimen() {
      const id = cliente.value;
      const c = clientesInfo.get(id);
      if (!id || !c || cfgF.modo === 'no' || c.regimen_dgii || limpiarDocumento(c.documento || '').length !== 9) return;
      const r = await buscarRNC(c.documento);
      if (r.resultado === 'activo' && r.datos.regimen) {
        await ejecutar('UPDATE clientes SET regimen_dgii = ? WHERE id = ?', [r.datos.regimen, Number(id)]);
        c.regimen_dgii = r.datos.regimen;
        if (cliente.value === id) pintarTotales();
      } else if (r.resultado === 'inactivo') {
        estatusRnc.className = 'error'; estatusRnc.textContent = r.mensaje;
      }
    }
    async function buscarPorRnc() {
      const num = limpiarDocumento(rncRapido.value);
      estatusRnc.className = 'ayuda';
      if (!num) { estatusRnc.textContent = ''; return; }
      estatusRnc.textContent = 'Consultando la DGII…';
      const r = await buscarRNC(num);
      estatusRnc.textContent = r.mensaje;
      if (r.resultado === 'inactivo' || r.resultado === 'noEncontrado' || r.resultado === 'invalido') {
        estatusRnc.className = 'error';
        if (r.resultado === 'inactivo') toast(r.mensaje, 'error');
        return;
      }
      if (r.resultado !== 'activo') {
        // Sin conexión o sin nube: si el cliente ya está guardado con ese documento, se elige igual
        const [ya] = await consultar('SELECT id FROM clientes WHERE documento = ?', [num]);
        if (ya) cliente.value = String(ya.id);
        return;
      }
      let [ya] = await consultar('SELECT id FROM clientes WHERE documento = ?', [num]);
      if (!ya) {
        await ejecutar('INSERT INTO clientes (nombre, tipo_doc, documento) VALUES (?,?,?)', [r.datos.nombre, num.length === 9 ? 'rnc' : 'cedula', num]);
        [ya] = await consultar('SELECT id FROM clientes WHERE documento = ?', [num]);
        await cargarClientes();
      }
      await ejecutar('UPDATE clientes SET regimen_dgii = ? WHERE id = ?', [r.datos.regimen || null, ya.id]);
      await cargarClientes();
      cliente.value = String(ya.id);
      tipoNcf.value = 'auto';
      pintarTotales();
    }
    const metodo = h('select', { class: 'campo', 'aria-label': 'Método de pago', onChange: () => pintarTotales() },
      OPCIONES_PAGO.map(([k, t]) => h('option', { value: k }, t)));
    const descuento = h('input', {
      class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01',
      placeholder: '0.00', 'aria-label': 'Descuento', onInput: () => pintarTotales(),
    });
    const recibido = h('input', {
      class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01',
      placeholder: '0.00', 'aria-label': 'Efectivo recibido', onInput: () => pintarTotales(),
    });
    const inicial = h('input', {
      class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01',
      placeholder: '0.00', 'aria-label': 'Pago inicial', onInput: () => pintarTotales(),
    });
    const campoRecibido = h('label', { class: 'etiqueta' }, 'Efectivo recibido (opcional)', recibido);
    const campoInicial = h('label', { class: 'etiqueta' }, 'Pago inicial (opcional)', inicial);
    const botonCobrar = h('button', { class: 'btn primario', onClick: () => cobrar() }, 'Cobrar');

    async function cargarClientes() {
      const cs = await consultar('SELECT id, nombre, condicion, dias_credito, documento, tipo_comprobante, regimen_dgii FROM clientes ORDER BY nombre');
      clientesInfo.clear();
      cs.forEach((c) => clientesInfo.set(String(c.id), c));
      cliente.replaceChildren(
        h('option', { value: '' }, 'Cliente general'),
        ...cs.map((c) => h('option', { value: c.id }, textoCondicion(c) ? `${c.nombre} (${textoCondicion(c)})` : c.nombre)));
    }

    // Días que tendrá el cliente para pagar una venta a crédito (30 si no tiene condición definida)
    const diasCredito = () => {
      const c = clientesInfo.get(cliente.value);
      return c?.condicion === 'credito' ? (c.dias_credito ?? DIAS_POR_DEFECTO) : DIAS_POR_DEFECTO;
    };
    function pintarAvisoCredito() {
      const c = clientesInfo.get(cliente.value);
      if (metodo.value !== 'credito' || !c) { avisoCredito.textContent = ''; avisoCredito.className = 'ayuda'; return; }
      const d = new Date();
      d.setDate(d.getDate() + diasCredito());
      const fecha = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      avisoCredito.className = c.condicion === 'contado' ? 'error' : 'ayuda';
      avisoCredito.textContent = `Vence en ${diasCredito()} días (${fecha}).`
        + (c.condicion === 'contado' ? ' Este cliente está marcado como Contado; revisa su condición en Clientes.' : '');
    }

    const subtotal = () => [...carrito.values()].reduce((s, l) => s + l.cantidad * l.precio, 0)
      + servicios.reduce((s, l) => s + l.cantidad * l.precio, 0);
    // ITBIS que se suma al precio (si la facturación con comprobante está encendida)
    const itbisDe = (sub, dto) => (cfgF.modo === 'adicional' ? calcularItbis({
      lineas: [...[...carrito.values()].map((l) => ({ neto: l.cantidad * l.precio, exento: !!l.p.itbis_exento })), ...servicios.map((l) => ({ neto: l.cantidad * l.precio, exento: false }))],
      descuento: dto, tasa: cfgF.tasa, modo: 'adicional',
    }) : 0);
    const descuentoAplicado = (sub) => Math.min(Math.max(parseFloat(descuento.value) || 0, 0), sub);

    async function pintarResultados() {
      const like = `%${buscar.value.trim()}%`;
      const filas = await consultar(
        `SELECT * FROM productos
          WHERE activo = 1 AND stock_actual > 0 AND (nombre LIKE ? OR codigo LIKE ? OR marca LIKE ?)
          ORDER BY nombre LIMIT 20`, [like, like, like]);
      resultados.replaceChildren(...(filas.length
        ? filas.map((p) => h('button', { class: 'resultado', onClick: () => agregar(p) },
            h('span', { class: 'datos' }, h('strong', {}, p.nombre), h('small', {}, `${p.stock_actual} en stock`)),
            h('span', { class: 'precio' }, dinero(p.precio))))
        : [h('p', { class: 'vacio' }, 'No hay productos disponibles con esa búsqueda.')]));
    }

    // Busca por código exacto y agrega a la venta. Devuelve true para que la cámara siga abierta.
    async function escanearProducto(codigo) {
      const [p] = await consultar('SELECT * FROM productos WHERE activo = 1 AND codigo = ? COLLATE NOCASE', [codigo]);
      if (!p) { toast(`No hay un producto con el código ${codigo}`, 'error'); return true; }
      if (p.stock_actual <= 0) { toast(`${p.nombre} está agotado`, 'error'); return true; }
      await agregar(p);
      toast(`Agregado: ${p.nombre}`);
      return true;
    }

    async function agregar(p) {
      const l = carrito.get(p.id);
      if (l) {
        if (l.cantidad >= p.stock_actual) { toast(`Solo hay ${p.stock_actual} en stock`, 'error'); return; }
        l.cantidad += 1;
      } else {
        // La garantía se recuerda por producto: queda la última que usaste
        const [g] = await consultar('SELECT valor FROM config WHERE clave = ?', [`garantia_p${p.id}`]);
        carrito.set(p.id, { p, cantidad: 1, precio: p.precio, garantia: parseInt(g?.valor, 10) || 0, serie: '' });
      }
      pintarLineas();
      pintarTotales();
    }

    function pintarLineas() {
      if (!carrito.size && !servicios.length) {
        lineas.replaceChildren(h('p', { class: 'vacio' }, 'Toca un producto de la lista para agregarlo a la venta, o agrega un servicio.'));
        return;
      }
      const lineasServicio = servicios.map((l, i) => {
        const importe = h('strong', {}, dinero(l.cantidad * l.precio));
        const actualizar = () => { importe.textContent = dinero(l.cantidad * l.precio); pintarTotales(); };
        return h('div', { class: 'linea' },
          h('div', { class: 'linea-cab' },
            h('input', {
              class: 'campo', value: l.descripcion, placeholder: 'Descripción del servicio', 'aria-label': 'Descripción',
              onInput: (e) => { l.descripcion = e.target.value; },
            }),
            h('button', { class: 'icono', 'aria-label': 'Quitar servicio', onClick: () => { servicios.splice(i, 1); pintarLineas(); pintarTotales(); } }, '✕')),
          h('div', { class: 'linea-pie' },
            h('label', { class: 'etiqueta chica' }, 'Precio',
              h('input', {
                class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', value: l.precio, 'aria-label': 'Precio',
                onInput: (e) => { l.precio = parseFloat(e.target.value) || 0; actualizar(); },
              })),
            h('label', { class: 'etiqueta chica' }, 'Cantidad',
              h('input', {
                class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.5', value: l.cantidad, 'aria-label': 'Cantidad',
                onInput: (e) => { l.cantidad = parseFloat(e.target.value) || 0; actualizar(); },
              })),
            importe));
      });
      lineas.replaceChildren(...[...carrito.entries()].map(([id, l]) => {
        const importe = h('strong', {}, dinero(l.cantidad * l.precio));
        const cant = h('span', {}, String(l.cantidad));
        const cambiar = (d) => {
          const n = l.cantidad + d;
          if (n <= 0) { carrito.delete(id); pintarLineas(); pintarTotales(); return; }
          if (n > l.p.stock_actual) { toast(`Solo hay ${l.p.stock_actual} en stock`, 'error'); return; }
          l.cantidad = n;
          cant.textContent = String(n);
          importe.textContent = dinero(l.cantidad * l.precio);
          pintarTotales();
        };
        const precio = h('input', {
          class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01',
          value: l.precio, 'aria-label': `Precio de ${l.p.nombre}`,
          onInput: (e) => {
            l.precio = parseFloat(e.target.value) || 0;
            importe.textContent = dinero(l.cantidad * l.precio);
            pintarTotales();
          },
        });
        const serieInput = h('input', {
          class: 'campo', placeholder: 'Nº de serie', autocomplete: 'off', value: l.serie,
          'aria-label': `Número de serie de ${l.p.nombre}`,
          onInput: (e) => { l.serie = e.target.value; },
        });
        return h('div', { class: 'linea' },
          h('div', { class: 'linea-cab' }, h('strong', {}, l.p.nombre),
            h('button', { class: 'icono', 'aria-label': `Quitar ${l.p.nombre}`, onClick: () => { carrito.delete(id); pintarLineas(); pintarTotales(); } }, '✕')),
          h('div', { class: 'linea-pie' },
            precio,
            h('div', { class: 'stepper' },
              h('button', { 'aria-label': 'Restar uno', onClick: () => cambiar(-1) }, '−'), cant,
              h('button', { 'aria-label': 'Sumar uno', onClick: () => cambiar(1) }, '+')),
            importe),
          h('div', { class: 'linea-pie garantia' },
            h('label', { class: 'etiqueta chica' }, 'Garantía (meses)',
              h('input', {
                class: 'campo', type: 'number', inputmode: 'numeric', min: '0', step: '1', value: l.garantia,
                'aria-label': `Meses de garantía de ${l.p.nombre}`,
                onInput: (e) => { l.garantia = Math.max(parseInt(e.target.value, 10) || 0, 0); },
              })),
            h('label', { class: 'etiqueta chica' }, 'Serie (opcional)',
              h('div', { class: 'buscador' }, serieInput, botonEscaner({
                titulo: `Serie de ${l.p.nombre}`,
                ayuda: l.cantidad > 1 ? 'Escanea la serie de cada unidad, una tras otra.' : 'Escanea el número de serie del equipo.',
                alLeer: async (codigo) => {
                  const lista = l.serie.split(',').map((x) => x.trim()).filter(Boolean);
                  if (lista.includes(codigo)) { toast('Esa serie ya está en esta línea', 'error'); return l.cantidad > lista.length; }
                  const [dup] = await consultar(
                    `SELECT v.numero FROM garantias g JOIN ventas v ON v.id = g.venta_id
                      WHERE g.serie LIKE ? AND g.estado = 'vigente' AND v.estado = 'completada' LIMIT 1`, [`%${codigo}%`]);
                  if (dup) toast(`Aviso: esa serie ya se vendió en ${dup.numero}`, 'error');
                  lista.push(codigo);
                  l.serie = lista.join(', ');
                  serieInput.value = l.serie;
                  return l.cantidad > lista.length; // sigue abierta hasta completar las unidades
                },
              }, 'Escanear')))));
      }), ...lineasServicio);
    }

    function pintarTotales() {
      pintarAvisoCredito();
      if (cfgF.modo !== 'no') {
        const elegido = tipoNcf.value || 'auto';
        const sug = comprobanteDeCliente(clientesInfo.get(cliente.value));
        const t = elegido === 'auto' ? sug.tipo : elegido;
        avisoNcf.textContent = `Se entregará: ${NOMBRE_COMPROBANTE[t]} (${t})${elegido === 'auto' ? `, ${sug.motivo}` : ', elegido por ti'}.`;
      }
      const sub = subtotal();
      const dto = descuentoAplicado(sub);
      const imp = itbisDe(sub, dto);
      const total = sub - dto + imp;
      const rec = parseFloat(recibido.value) || 0;
      const esCredito = metodo.value === 'credito';
      const ini = Math.min(Math.max(parseFloat(inicial.value) || 0, 0), total);
      campoRecibido.style.display = metodo.value === 'efectivo' ? '' : 'none';
      campoInicial.style.display = esCredito ? '' : 'none';
      totales.replaceChildren(
        renglon('Subtotal', dinero(sub)),
        dto > 0 ? renglon('Descuento', `- ${dinero(dto)}`) : null,
        imp > 0 ? renglon(`ITBIS ${cfgF.tasa}%`, dinero(imp)) : null,
        renglon('Total', dinero(total), 'gran'),
        metodo.value === 'efectivo' && rec > 0
          ? renglon(rec >= total ? 'Cambio' : 'Falta', dinero(Math.abs(rec - total)))
          : null,
        esCredito ? renglon('Pago inicial', dinero(ini)) : null,
        esCredito ? renglon('Queda pendiente', dinero(total - ini), 'deuda') : null);
    }

    async function cobrar() {
      error.textContent = '';
      if (!carrito.size && !servicios.length) { error.textContent = 'Agrega al menos un producto o servicio.'; return; }
      if (servicios.some((l) => !l.descripcion.trim())) { error.textContent = 'Escribe la descripción de cada servicio.'; return; }
      if (servicios.some((l) => !(l.cantidad > 0))) { error.textContent = 'La cantidad de cada servicio debe ser mayor que cero.'; return; }
      const sub = subtotal();
      const dto = Math.max(parseFloat(descuento.value) || 0, 0);
      if (dto > sub) { error.textContent = 'El descuento no puede ser mayor que el subtotal.'; descuento.focus(); return; }

      const esCredito = metodo.value === 'credito';
      const total = redondear(sub - dto + itbisDe(sub, dto));
      const ini = esCredito ? Math.max(parseFloat(inicial.value) || 0, 0) : 0;
      if (esCredito && !cliente.value) { error.textContent = 'Para vender a crédito elige un cliente.'; cliente.focus(); return; }
      if (esCredito && redondear(ini) > total) { error.textContent = 'El pago inicial no puede ser mayor que el total.'; inicial.focus(); return; }

      // Comprobantes de crédito fiscal: el RNC del cliente debe estar ACTIVO en la DGII (si no se puede consultar, se deja pasar)
      if (cfgF.modo !== 'no' && cliente.value && tipoNcf.value !== 'B02' && tipoNcf.value !== 'ninguno') {
        const [cl] = await consultar('SELECT documento FROM clientes WHERE id = ?', [Number(cliente.value)]);
        if (cl?.documento && limpiarDocumento(cl.documento).length === 9) {
          const r = await buscarRNC(cl.documento);
          if (r.resultado === 'inactivo' || r.resultado === 'noEncontrado') {
            error.textContent = `${r.mensaje} Cambia el comprobante a Consumo (B02) o elige otro cliente.`; return;
          }
        }
      }

      botonCobrar.disabled = true;
      try {
        const numero = await registrarVenta({
          tipo_ncf: cfgF.modo === 'no' ? 'ninguno' : (tipoNcf.value || 'auto'),
          cliente_id: cliente.value ? Number(cliente.value) : null,
          items: [...carrito.values()].map((l) => ({
            producto_id: l.p.id, cantidad: l.cantidad, precio_unitario: l.precio, descuento: 0,
            garantia_meses: l.garantia, serie: l.serie,
          })),
          servicios: servicios.map((l) => ({ descripcion: l.descripcion, cantidad: l.cantidad, precio_unitario: l.precio })),
          descuento: dto,
          metodo_pago: metodo.value,
          inicial: ini,
          dias_credito: esCredito ? diasCredito() : null,
        });
        const [v] = await consultar('SELECT id, total FROM ventas WHERE numero = ?', [numero]);
        if (precarga?.cotizacion_id) {
          await ejecutar("UPDATE cotizaciones SET estado = 'facturada', venta_id = ? WHERE id = ?", [v.id, precarga.cotizacion_id]).catch(() => {});
        }
        for (const l of carrito.values()) {
          await ejecutar('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)', [`garantia_p${l.p.id}`, String(l.garantia || 0)]).catch(() => {});
        }
        cerrar();
        await pintar();
        exito(v, numero, esCredito ? redondear(v.total - ini) : 0);
      } catch (e) {
        botonCobrar.disabled = false;
        error.textContent = e.message || String(e);
      }
    }

    cerrar = hoja('Nueva venta',
      h('div', { class: 'cuerpo' },
        h('div', { class: 'buscador' }, buscar, botonEscaner({
          titulo: 'Escanear productos',
          ayuda: 'Escanea el código de cada producto. Se agrega a la venta y la cámara sigue abierta.',
          alLeer: escanearProducto,
        })),
        resultados,
        h('button', {
          class: 'btn',
          onClick: () => { servicios.push({ descripcion: '', cantidad: 1, precio: 0 }); pintarLineas(); pintarTotales(); },
        }, '+ Servicio / mano de obra'),
        h('h3', {}, 'Productos de la venta'),
        lineas,
        h('div', { class: 'cliente-fila' },
          h('label', { class: 'etiqueta' }, 'Cliente', cliente),
          h('button', {
            class: 'btn',
            onClick: () => formularioCliente(null, async (id) => { await cargarClientes(); if (id) cliente.value = String(id); }),
          }, 'Nuevo')),
        h('label', { class: 'etiqueta' }, 'RNC / cédula del cliente', rncRapido),
        estatusRnc,
        cfgF.modo === 'no' ? null : h('label', { class: 'etiqueta' }, 'Tipo de comprobante', tipoNcf),
        cfgF.modo === 'no' ? null : avisoNcf,
        h('div', { class: 'rejilla' },
          h('label', { class: 'etiqueta' }, 'Método de pago', metodo),
          h('label', { class: 'etiqueta' }, 'Descuento', descuento)),
        avisoCredito,
        campoRecibido,
        campoInicial,
        totales,
        error,
        h('div', { class: 'acciones' }, botonCobrar)));

    await cargarClientes();
    if (precarga) await aplicarPrecarga();
    pintarLineas();
    pintarTotales();
    await pintarResultados();

    // Llena el carrito con los productos y servicios de una cotización
    async function aplicarPrecarga() {
      if (precarga.cliente_id) cliente.value = String(precarga.cliente_id);
      if (precarga.descuento > 0) descuento.value = String(precarga.descuento);
      const avisos = [];
      for (const it of precarga.items) {
        const [p] = await consultar('SELECT * FROM productos WHERE id = ? AND activo = 1', [it.producto_id]);
        if (!p) { avisos.push(`${it.descripcion} (ya no existe)`); continue; }
        if (p.stock_actual <= 0) { avisos.push(`${p.nombre} (agotado)`); continue; }
        const cantidad = Math.max(1, Math.round(it.cantidad));
        if (cantidad > p.stock_actual) avisos.push(`${p.nombre} (hay ${p.stock_actual} de ${cantidad})`);
        const [g] = await consultar('SELECT valor FROM config WHERE clave = ?', [`garantia_p${p.id}`]);
        carrito.set(p.id, {
          p, cantidad: Math.min(cantidad, p.stock_actual), precio: it.precio_unitario,
          garantia: parseInt(g?.valor, 10) || 0, serie: '',
        });
      }
      for (const x of precarga.servicios) {
        servicios.push({ descripcion: x.descripcion, cantidad: x.cantidad, precio: x.precio_unitario });
      }
      if (avisos.length) error.textContent = `Revisa: ${avisos.join('; ')}.`;
    }
  }

  // Convierte una cotización en venta: abre "Nueva venta" con sus productos y precios
  async function convertirCotizacion(id) {
    const [c] = await consultar('SELECT * FROM cotizaciones WHERE id = ?', [id]);
    if (!c) return;
    const det = await consultar('SELECT * FROM cotizacion_detalle WHERE cotizacion_id = ? ORDER BY id', [id]);
    const productos = det.filter((d) => d.producto_id);
    await nuevaVenta({
      cotizacion_id: id, cliente_id: c.cliente_id, descuento: c.descuento, items: productos,
      servicios: det.filter((d) => !d.producto_id),
    });
  }

  function exito(v, numero, pendiente) {
    const cerrar = hoja('Venta registrada',
      h('div', { class: 'cuerpo' },
        h('p', {}, `${numero} por ${dinero(v.total)}. El inventario ya se actualizó.`),
        pendiente > 0.005 ? h('p', { class: 'deuda' }, `Queda pendiente ${dinero(pendiente)}. Puedes registrar abonos desde el detalle de la venta o desde Clientes.`) : null,
        h('div', { class: 'acciones' },
          h('button', { class: 'btn', onClick: () => cerrar() }, 'Listo'),
          h('button', { class: 'btn primario', onClick: () => compartir(v.id) }, 'Compartir factura'))));
  }

  // Pestañas: Ventas | Cotizaciones
  const panelVentas = h('div', {}, resumen, h('div', { class: 'filtros' }, segmento, filaRango.el), lista);
  const panelCot = h('div');
  const pestanas = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Sección' });
  const botonNuevo = h('button', { class: 'btn claro' });
  let modo = 'ventas';
  let repintarCot = null;

  async function cambiarModo(m) {
    modo = m;
    pestanas.replaceChildren(...[['ventas', 'Ventas'], ['cotizaciones', 'Cotizaciones']].map(([id, t]) =>
      h('button', { 'aria-pressed': String(modo === id), onClick: () => cambiarModo(id) }, t)));
    panelVentas.style.display = modo === 'ventas' ? '' : 'none';
    panelCot.style.display = modo === 'cotizaciones' ? '' : 'none';
    botonNuevo.textContent = modo === 'ventas' ? 'Nueva venta' : 'Nueva cotización';
    if (modo === 'cotizaciones') repintarCot = await vistaCotizaciones(panelCot, { convertir: convertirCotizacion });
  }
  botonNuevo.addEventListener('click', () => {
    if (modo === 'ventas') nuevaVenta();
    else formularioCotizacion(null, async () => { repintarCot = await vistaCotizaciones(panelCot, { convertir: convertirCotizacion }); });
  });

  raiz.replaceChildren(
    h('header', { class: 'barra' }, h('h1', {}, 'Ventas'), botonNuevo),
    h('div', { class: 'filtros' }, pestanas),
    panelVentas,
    panelCot);
  pintarSegmento();
  await pintar();
  await cambiarModo('ventas');
}
