// compras.js - compras a proveedores: historial, nueva compra (con margen de ganancia) y anulación
import { consultar, registrarCompra, anularCompra, redondear } from './database.js';
import { tienePermiso, registrarBitacora } from './auth.js';
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { condicionRango, rangoInicial, selectorRango } from './fechas.js';
import { formularioProveedor } from './proveedores.js';
import { textoCondicion, DIAS_POR_DEFECTO } from './condicion.js';
import { detalleCuenta } from './cuentas.js';
import { botonEscaner } from './escaner.js';

const PERIODOS = {
  hoy: "date(c.fecha) = date('now','localtime')",
  mes: "strftime('%Y-%m', c.fecha) = strftime('%Y-%m', 'now', 'localtime')",
  todas: '1 = 1',
};

const renglon = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));

// El margen se calcula sobre el costo: costo 60 con margen 30 % => precio 78
const precioDesde = (costo, margen) => redondear(costo * (1 + margen / 100));
const margenDesde = (costo, precio) => (costo > 0 ? ((precio - costo) / costo) * 100 : 0);
const fmt = (n) => String(redondear(n));

export async function vistaCompras(raiz) {
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
    const cond = estado.periodo === 'rango' ? condicionRango('c.fecha', estado.rango) : PERIODOS[estado.periodo];
    const [t] = await consultar(
      `SELECT COUNT(*) AS n, COALESCE(SUM(c.total), 0) AS total
         FROM compras c WHERE c.estado = 'completada' AND ${cond}`);
    const [u] = await consultar(
      `SELECT COALESCE(SUM(d.cantidad), 0) AS unidades
         FROM compra_detalle d JOIN compras c ON c.id = d.compra_id
        WHERE c.estado = 'completada' AND ${cond}`);
    const dato = (et, val) => h('div', {}, h('dt', {}, et), h('dd', {}, val));
    resumen.replaceChildren(
      dato('Comprado', dinero(t.total)),
      dato('Compras', String(t.n)),
      dato('Unidades', u.unidades.toLocaleString('es-DO')));

    const filas = await consultar(
      `SELECT c.*, p.nombre AS proveedor,
              (SELECT COUNT(*) FROM cuentas_pagar a WHERE a.compra_id = c.id) AS credito,
              c.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos_compra WHERE compra_id = c.id) AS saldo
         FROM compras c
         LEFT JOIN proveedores p ON p.id = c.proveedor_id
        WHERE ${cond} ORDER BY c.id DESC LIMIT 500`);
    lista.replaceChildren(...(filas.length
      ? filas.map(fila)
      : [h('p', { class: 'vacio' }, estado.periodo === 'todas'
          ? 'Aún no hay compras. Toca "Nueva compra" para registrar la primera.'
          : 'No hay compras en este período.')]));
  }

  function fila(c) {
    const anulada = c.estado === 'anulada';
    return h('button', { class: 'fila inventario', onClick: () => detalle(c.id) },
      h('span', { class: 'datos' },
        h('strong', {}, c.numero, anulada ? h('span', { class: 'anulada' }, ' (anulada)') : null),
        h('small', {}, c.proveedor || 'Sin proveedor'),
        h('small', {}, `${c.fecha.slice(0, 16)}${c.referencia ? `, Fact. ${c.referencia}` : ''}`)),
      h('span', { class: `precio${anulada ? ' tachado' : ''}` }, dinero(c.total),
        c.credito && !anulada ? h('small', { class: `bloque ${c.saldo > 0.005 ? 'deuda' : 'pagada'}` }, c.saldo > 0.005 ? `Debes ${dinero(c.saldo)}` : 'Pagada') : null));
  }

  async function detalle(id) {
    const [c] = await consultar(
      `SELECT c.*, p.nombre AS proveedor FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id WHERE c.id = ?`, [id]);
    const items = await consultar(
      `SELECT d.*, pr.nombre FROM compra_detalle d JOIN productos pr ON pr.id = d.producto_id WHERE d.compra_id = ? ORDER BY d.id`, [id]);
    const anulada = c.estado === 'anulada';
    const [cuenta] = await consultar('SELECT vence FROM cuentas_pagar WHERE compra_id = ?', [id]);
    const pagos = await consultar('SELECT * FROM pagos_compra WHERE compra_id = ? ORDER BY id', [id]);
    const pagado = redondear(pagos.reduce((t, p) => t + p.monto, 0));
    let cerrar = () => {};

    async function anular() {
      const unidades = items.reduce((s, i) => s + i.cantidad, 0);
      const ok = await confirmar('Anular compra',
        `Se anulará ${c.numero} y se restan ${unidades} unidades del inventario. El costo y el precio de venta de los productos no se modifican.${pagado > 0 ? ` Ya se habían pagado ${dinero(pagado)} al proveedor; el dinero que te devuelva no se registra aquí.` : ''}`, 'Anular compra');
      if (!ok) return;
      try {
        await anularCompra(id);
        await registrarBitacora('Compra anulada', c.numero);
        cerrar();
        toast('Compra anulada');
        await pintar();
      } catch (e) {
        toast(e.message || 'No se pudo anular', 'error');
      }
    }

    cerrar = hoja(c.numero,
      h('div', { class: 'cuerpo' },
        h('p', { class: 'ayuda' }, `${c.fecha.slice(0, 16)}, ${c.proveedor || 'Sin proveedor'}${c.referencia ? `, Fact. ${c.referencia}` : ''}`),
        anulada ? h('p', { class: 'error' }, 'Esta compra está anulada.') : null,
        h('ul', { class: 'historial detalle' }, items.map((i) => h('li', {},
          h('strong', {}, `${i.cantidad}×`),
          h('span', {}, `${i.nombre}, ${dinero(i.costo_unitario)} c/u`),
          h('small', {}, dinero(i.cantidad * i.costo_unitario))))),
        h('div', { class: 'totales' },
          renglon('Total', dinero(c.total), 'gran'),
          cuenta ? renglon('Pagado', dinero(pagado)) : null,
          cuenta ? renglon('Pendiente', dinero(anulada ? 0 : Math.max(0, redondear(c.total - pagado))), !anulada && c.total - pagado > 0.005 ? 'deuda' : '') : null,
          cuenta?.vence ? renglon('Fecha límite', cuenta.vence.split('-').reverse().join('/')) : null),
        anulada ? null : h('div', { class: 'acciones' },
          cuenta ? h('button', { class: 'btn', onClick: () => { cerrar(); detalleCuenta(id, pintar); } }, 'Ver cuenta por pagar') : null,
          tienePermiso('anular') ? h('button', { class: 'btn peligro', onClick: anular }, 'Anular compra') : null)));
  }

  // ---------- Nueva compra ----------
  async function nuevaCompra() {
    // producto_id -> { p, cantidad, costo, margen, precio }
    const carrito = new Map();
    let cerrar = () => {};

    const resultados = h('div', { class: 'resultados' });
    const lineas = h('div', { class: 'carrito' });
    const totales = h('div', { class: 'totales' });
    const error = h('p', { class: 'error', role: 'alert' });

    const buscar = h('input', {
      class: 'campo', type: 'search', 'aria-label': 'Buscar producto',
      placeholder: 'Buscar producto por nombre, código o marca',
      onInput: () => pintarResultados(),
    });
    const provInfo = new Map();
    const proveedor = h('select', { class: 'campo', 'aria-label': 'Proveedor', onChange: () => aplicarCondicion() });
    const ncfC = h('input', { class: 'campo', placeholder: 'B0100000001 (opcional)', autocomplete: 'off', 'aria-label': 'NCF' });
    const itbisC = h('input', { class: 'campo', type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'ITBIS de la compra' });
    const referencia = h('input', { class: 'campo', placeholder: 'Opcional', autocomplete: 'off', 'aria-label': 'Número de factura del proveedor' });
    const margenGlobal = h('input', {
      class: 'campo', type: 'number', inputmode: 'decimal', step: '0.01', placeholder: 'Ej. 30',
      'aria-label': 'Margen de ganancia para todos los productos', onInput: () => aplicarMargenGlobal(),
    });
    const actualizarCosto = h('input', { type: 'checkbox', checked: true });
    const actualizarPrecio = h('input', { type: 'checkbox', checked: true });
    const botonRegistrar = h('button', { class: 'btn primario', onClick: () => registrar() }, 'Registrar compra');
    const formaPago = h('select', { class: 'campo', 'aria-label': 'Forma de pago', onChange: () => mostrarCredito() },
      [['efectivo', 'Contado, efectivo'], ['tarjeta', 'Contado, tarjeta'], ['transferencia', 'Contado, transferencia'], ['cheque', 'Contado, cheque'], ['credito', 'Crédito (por pagar)']]
        .map(([k, t]) => h('option', { value: k }, t)));
    const plazo = h('input', { class: 'campo', type: 'number', inputmode: 'numeric', min: '0', step: '1', value: '30', 'aria-label': 'Plazo en días' });
    const inicial = h('input', { class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '0.00', 'aria-label': 'Pago inicial' });
    const metodoInicial = h('select', { class: 'campo', 'aria-label': 'Método del pago inicial' },
      [['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transferencia'], ['cheque', 'Cheque']].map(([k, t]) => h('option', { value: k }, t)));
    const bloqueCredito = h('div', { class: 'cuerpo sin-borde' },
      h('div', { class: 'rejilla' },
        h('label', { class: 'etiqueta' }, 'Plazo (días)', plazo),
        h('label', { class: 'etiqueta' }, 'Pago inicial (opcional)', inicial)),
      h('label', { class: 'etiqueta' }, 'Pago inicial con', metodoInicial));
    const mostrarCredito = () => { bloqueCredito.style.display = formaPago.value === 'credito' ? '' : 'none'; };
    mostrarCredito();

    async function cargarProveedores() {
      const ps = await consultar('SELECT id, nombre, condicion, dias_credito FROM proveedores ORDER BY nombre');
      provInfo.clear();
      ps.forEach((p) => provInfo.set(String(p.id), p));
      proveedor.replaceChildren(
        h('option', { value: '' }, 'Sin proveedor'),
        ...ps.map((p) => h('option', { value: p.id }, textoCondicion(p) ? `${p.nombre} (${textoCondicion(p)})` : p.nombre)));
    }
    // Aplica la condición de pago del proveedor elegido
    function aplicarCondicion() {
      const p = provInfo.get(proveedor.value);
      if (!p) return;
      if (p.condicion === 'credito') {
        formaPago.value = 'credito';
        plazo.value = String(p.dias_credito ?? DIAS_POR_DEFECTO);
      } else if (p.condicion === 'contado' && formaPago.value === 'credito') {
        formaPago.value = 'efectivo';
      }
      mostrarCredito();
    }

    const total = () => [...carrito.values()].reduce((s, l) => s + l.cantidad * l.costo, 0);

    async function pintarResultados() {
      const like = `%${buscar.value.trim()}%`;
      const filas = await consultar(
        `SELECT * FROM productos
          WHERE activo = 1 AND (nombre LIKE ? OR codigo LIKE ? OR marca LIKE ?)
          ORDER BY nombre LIMIT 20`, [like, like, like]);
      resultados.replaceChildren(...(filas.length
        ? filas.map((p) => h('button', { class: 'resultado', onClick: () => agregar(p) },
            h('span', { class: 'datos' }, h('strong', {}, p.nombre), h('small', {}, `${p.stock_actual} en stock`)),
            h('span', { class: 'precio' }, `Costo ${dinero(p.costo)}`)))
        : [h('p', { class: 'vacio' }, 'No hay productos con esa búsqueda. Si es nuevo, créalo primero en Productos.')]));
    }

    async function escanearProducto(codigo) {
      const [p] = await consultar('SELECT * FROM productos WHERE activo = 1 AND codigo = ? COLLATE NOCASE', [codigo]);
      if (!p) { toast(`No hay un producto con el código ${codigo}. Créalo primero en Productos.`, 'error'); return true; }
      agregar(p);
      toast(`Agregado: ${p.nombre}`);
      return true;
    }

    function agregar(p) {
      const l = carrito.get(p.id);
      if (l) {
        l.cantidad += 1;
      } else {
        const g = parseFloat(margenGlobal.value);
        if (Number.isFinite(g)) {
          // Hay un margen general: el precio de venta se calcula con él
          carrito.set(p.id, { p, cantidad: 1, costo: p.costo, margen: g, precio: Math.max(precioDesde(p.costo, g), 0) });
        } else {
          // Sin margen general: se parte del precio actual y se muestra su margen
          carrito.set(p.id, { p, cantidad: 1, costo: p.costo, margen: margenDesde(p.costo, p.precio), precio: p.precio });
        }
      }
      pintarLineas();
      pintarTotales();
    }

    // Aplica el margen general a todos los productos de la compra
    function aplicarMargenGlobal() {
      const g = parseFloat(margenGlobal.value);
      if (!Number.isFinite(g)) return;
      for (const l of carrito.values()) {
        l.margen = g;
        l.precio = Math.max(precioDesde(l.costo, g), 0);
      }
      pintarLineas();
      pintarTotales();
    }

    function pintarLineas() {
      if (!carrito.size) {
        lineas.replaceChildren(h('p', { class: 'vacio' }, 'Toca un producto de la lista para agregarlo a la compra.'));
        return;
      }
      lineas.replaceChildren(...[...carrito.entries()].map(([id, l]) => {
        const importe = h('strong', {}, dinero(l.cantidad * l.costo));
        const aviso = h('small', { class: 'deuda' });
        const avisar = () => { aviso.textContent = l.precio < l.costo ? 'El precio de venta queda por debajo del costo.' : ''; };

        const margen = h('input', {
          class: 'campo corto', type: 'number', inputmode: 'decimal', step: '0.01', value: fmt(l.margen),
          'aria-label': `Margen de ${l.p.nombre}`,
          onInput: (e) => {
            const m = parseFloat(e.target.value);
            if (!Number.isFinite(m)) return;
            l.margen = m;
            l.precio = Math.max(precioDesde(l.costo, m), 0);
            precio.value = fmt(l.precio);
            avisar();
            pintarTotales();
          },
        });
        const precio = h('input', {
          class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', value: fmt(l.precio),
          'aria-label': `Precio de venta de ${l.p.nombre}`,
          onInput: (e) => {
            l.precio = Math.max(parseFloat(e.target.value) || 0, 0);
            l.margen = margenDesde(l.costo, l.precio);
            margen.value = fmt(l.margen);
            avisar();
            pintarTotales();
          },
        });
        const costo = h('input', {
          class: 'campo', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', value: l.costo,
          'aria-label': `Costo de ${l.p.nombre}`,
          onInput: (e) => {
            l.costo = Math.max(parseFloat(e.target.value) || 0, 0);
            // El precio de venta sigue al costo manteniendo el margen
            l.precio = precioDesde(l.costo, l.margen);
            precio.value = fmt(l.precio);
            importe.textContent = dinero(l.cantidad * l.costo);
            avisar();
            pintarTotales();
          },
        });
        const cantidad = h('input', {
          class: 'campo corto', type: 'number', inputmode: 'numeric', min: '1', step: '1', value: l.cantidad,
          'aria-label': `Cantidad de ${l.p.nombre}`,
          onInput: (e) => {
            l.cantidad = parseInt(e.target.value, 10) || 0;
            importe.textContent = dinero(l.cantidad * l.costo);
            pintarTotales();
          },
        });
        avisar();

        return h('div', { class: 'linea' },
          h('div', { class: 'linea-cab' },
            h('span', { class: 'datos' }, h('strong', {}, l.p.nombre), h('small', {}, `${l.p.stock_actual} en stock ahora`)),
            h('button', { class: 'icono', 'aria-label': `Quitar ${l.p.nombre}`, onClick: () => { carrito.delete(id); pintarLineas(); pintarTotales(); } }, '✕')),
          h('div', { class: 'linea-pie' },
            h('label', { class: 'etiqueta chica' }, 'Costo por unidad', costo),
            h('label', { class: 'etiqueta chica' }, 'Cantidad', cantidad),
            importe),
          h('div', { class: 'linea-pie' },
            h('label', { class: 'etiqueta chica' }, 'Margen (%)', margen),
            h('label', { class: 'etiqueta chica' }, 'Precio de venta', precio)),
          aviso);
      }));
    }

    function pintarTotales() {
      const lineasCompra = [...carrito.values()];
      const unidades = lineasCompra.reduce((s, l) => s + l.cantidad, 0);
      const ganancia = lineasCompra.reduce((s, l) => s + l.cantidad * (l.precio - l.costo), 0);
      totales.replaceChildren(
        renglon('Unidades', String(unidades)),
        renglon('Ganancia estimada al vender todo', dinero(ganancia)),
        renglon('Total de la compra', dinero(total()), 'gran'));
    }

    async function registrar() {
      error.textContent = '';
      if (!carrito.size) { error.textContent = 'Agrega al menos un producto.'; return; }
      for (const l of carrito.values()) {
        if (!Number.isInteger(l.cantidad) || l.cantidad <= 0) { error.textContent = `Revisa la cantidad de "${l.p.nombre}".`; return; }
        if (!(l.costo >= 0)) { error.textContent = `Revisa el costo de "${l.p.nombre}".`; return; }
        if (actualizarPrecio.checked && !(l.precio > 0)) {
          error.textContent = `Revisa el precio de venta de "${l.p.nombre}": no puede ser 0.`;
          return;
        }
      }
      botonRegistrar.disabled = true;
      try {
        const numero = await registrarCompra({
          proveedor_id: proveedor.value ? Number(proveedor.value) : null,
          referencia: referencia.value.trim() || null,
          ncf: ncfC.value.trim() || null,
          itbis: parseFloat(itbisC.value) || 0,
          items: [...carrito.values()].map((l) => ({
            producto_id: l.p.id, cantidad: l.cantidad, costo_unitario: l.costo, precio_venta: l.precio,
          })),
          actualizarCosto: actualizarCosto.checked,
          actualizarPrecio: actualizarPrecio.checked,
          forma_pago: formaPago.value,
          inicial: formaPago.value === 'credito' ? Math.max(parseFloat(inicial.value) || 0, 0) : 0,
          metodo_inicial: metodoInicial.value,
          plazo_dias: formaPago.value === 'credito' && plazo.value !== '' ? parseInt(plazo.value, 10) : null,
        });
        cerrar();
        toast(`Compra ${numero} registrada`);
        await pintar();
      } catch (e) {
        botonRegistrar.disabled = false;
        error.textContent = e.message || String(e);
      }
    }

    cerrar = hoja('Nueva compra',
      h('div', { class: 'cuerpo' },
        h('div', { class: 'cliente-fila' },
          h('label', { class: 'etiqueta' }, 'Proveedor', proveedor),
          h('button', {
            class: 'btn',
            onClick: () => formularioProveedor(null, async (id) => { await cargarProveedores(); if (id) { proveedor.value = String(id); aplicarCondicion(); } }),
          }, 'Nuevo')),
        h('label', { class: 'etiqueta' }, 'Factura del proveedor', referencia),
        h('div', { class: 'rejilla' }, h('label', { class: 'etiqueta' }, 'NCF de la factura', ncfC), h('label', { class: 'etiqueta' }, 'ITBIS incluido', itbisC)),
        h('label', { class: 'etiqueta' }, 'Forma de pago', formaPago),
        bloqueCredito,
        h('label', { class: 'etiqueta' }, 'Margen de ganancia para todos los productos (%)', margenGlobal,
          h('small', { class: 'ayuda' }, 'Se calcula sobre el costo. Al escribirlo, el precio de venta de cada producto se calcula solo; luego puedes ajustar el margen o el precio de cada uno.')),
        h('div', { class: 'buscador' }, buscar, botonEscaner({
          titulo: 'Escanear productos de la compra',
          ayuda: 'Escanea el código de cada producto. Se agrega a la compra.',
          alLeer: escanearProducto,
        })),
        resultados,
        h('h3', {}, 'Productos de la compra'),
        lineas,
        h('label', { class: 'casilla' }, actualizarCosto, 'Actualizar el costo de cada producto con este precio de compra'),
        h('label', { class: 'casilla' }, actualizarPrecio, 'Actualizar el precio de venta de cada producto con estos márgenes'),
        totales,
        error,
        h('div', { class: 'acciones' }, botonRegistrar)));

    await cargarProveedores();
    pintarLineas();
    pintarTotales();
    await pintarResultados();
  }

  raiz.replaceChildren(
    h('header', { class: 'barra' },
      h('h1', {}, 'Compras'),
      h('button', { class: 'btn claro', onClick: nuevaCompra }, 'Nueva compra')),
    resumen,
    h('div', { class: 'filtros' }, segmento, filaRango.el),
    lista);
  pintarSegmento();
  await pintar();
}
