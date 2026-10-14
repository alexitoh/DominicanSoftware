// productos.js - lista, búsqueda y formulario de productos
import { consultar, ejecutar, transaccion, precioDesde, margenProducto } from './database.js';
import { botonEscaner } from './escaner.js';
import { h, hoja, toast, dinero, confirmar, medidor } from './ui.js';

// Reduce la foto a ~400 px para que la base de datos y los respaldos no pesen de más
function redimensionar(archivo, max = 400) {
  return new Promise((ok, fallo) => {
    const img = new Image();
    const url = URL.createObjectURL(archivo);
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * r);
      c.height = Math.round(img.height * r);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => fallo(new Error('No se pudo leer la imagen'));
    img.src = url;
  });
}

export async function vistaProductos(raiz) {
  const filtro = { texto: '', cat: '' };
  const lista = h('div', { class: 'lista' });

  const buscador = h('input', {
    class: 'campo', type: 'search', placeholder: 'Buscar por nombre, código o marca',
    'aria-label': 'Buscar producto',
    onInput: (e) => { filtro.texto = e.target.value; pintar(); },
  });
  const selCat = h('select', {
    class: 'campo', 'aria-label': 'Filtrar por categoría',
    onChange: (e) => { filtro.cat = e.target.value; pintar(); },
  });

  async function cargarCategorias() {
    const cats = await consultar('SELECT id, nombre FROM categorias ORDER BY nombre');
    selCat.replaceChildren(
      h('option', { value: '' }, 'Todas las categorías'),
      ...cats.map((c) => h('option', { value: c.id }, c.nombre)));
    selCat.value = filtro.cat;
    return cats;
  }

  async function pintar() {
    const like = `%${filtro.texto.trim()}%`;
    const filas = await consultar(
      `SELECT p.*, c.nombre AS categoria
         FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
        WHERE p.activo = 1 AND (p.nombre LIKE ? OR p.codigo LIKE ? OR p.marca LIKE ?)
        ${filtro.cat ? 'AND p.categoria_id = ?' : ''}
        ORDER BY p.nombre`,
      filtro.cat ? [like, like, like, filtro.cat] : [like, like, like]);

    const hayFiltro = filtro.texto.trim() || filtro.cat;
    lista.replaceChildren(...(filas.length
      ? filas.map(fila)
      : [h('p', { class: 'vacio' }, hayFiltro
          ? 'Ningún producto coincide con la búsqueda.'
          : 'Aún no hay productos. Toca "Nuevo producto" para registrar el primero.')]));
  }

  function fila(p) {
    const detalle = [p.marca, p.categoria].filter(Boolean).join(', ');
    return h('button', { class: 'fila', onClick: () => formulario(p) },
      p.foto
        ? h('img', { class: 'miniatura', src: p.foto, alt: '' })
        : h('span', { class: 'miniatura vacia', 'aria-hidden': 'true' }, p.nombre.charAt(0).toUpperCase()),
      h('span', { class: 'datos' },
        h('strong', {}, p.nombre),
        detalle ? h('small', {}, detalle) : null,
        h('span', { class: 'stock' }, medidor(p.stock_actual, p.stock_minimo), h('small', {}, `${p.stock_actual} en stock`))),
      h('span', { class: 'precio' }, dinero(p.precio)));
  }

  async function formulario(p = null) {
    const nuevo = !p;
    const cats = await cargarCategorias();
    let foto = p?.foto ?? null;
    let cerrar = () => {};

    const campo = (etiqueta, input, ayuda) =>
      h('label', { class: 'etiqueta' }, etiqueta, input, ayuda ? h('small', { class: 'ayuda' }, ayuda) : null);
    const numero = (valor, decimales) => h('input', {
      class: 'campo', type: 'number', min: '0', value: valor,
      inputmode: decimales ? 'decimal' : 'numeric', step: decimales ? '0.01' : '1',
    });

    const nombre = h('input', { class: 'campo', value: p?.nombre ?? '', autocomplete: 'off' });
    const codigo = h('input', { class: 'campo', value: p?.codigo ?? '', autocomplete: 'off' });
    const marca = h('input', { class: 'campo', value: p?.marca ?? '', autocomplete: 'off' });
    const categoria = h('select', { class: 'campo' },
      h('option', { value: '' }, 'Sin categoría'),
      ...cats.map((c) => h('option', { value: c.id }, c.nombre)));
    categoria.value = p?.categoria_id ?? '';
    const nuevaCat = h('input', { class: 'campo', placeholder: 'O escribe una categoría nueva', 'aria-label': 'Categoría nueva' });
    const costo = numero(p?.costo ?? '', true);
    const precio = numero(p?.precio ?? '', true);
    // Margen sobre el costo. Producto nuevo: parte del margen por defecto de Ajustes (si hay uno)
    const margenDef = nuevo ? parseFloat((await consultar("SELECT valor FROM config WHERE clave = 'margen_defecto'"))[0]?.valor) : NaN;
    const margenInicial = nuevo ? (Number.isFinite(margenDef) ? margenDef : '') : (margenProducto(p) ?? '');
    const margen = numero(margenInicial, true);
    const ganancia = h('p', { class: 'ganancia' });
    const calcular = () => {
      const c = parseFloat(costo.value) || 0;
      const v = parseFloat(precio.value) || 0;
      ganancia.textContent = v > 0
        ? `Ganancia por unidad: ${dinero(v - c)}${c > 0 ? ` (${Math.round(((v - c) / c) * 100)}% sobre el costo)` : ''}`
        : '';
    };
    // Costo o margen => precio. Precio => margen.
    const aplicarMargen = () => {
      const c = parseFloat(costo.value);
      const m = parseFloat(margen.value);
      if (Number.isFinite(c) && Number.isFinite(m)) precio.value = precioDesde(c, m);
    };
    costo.addEventListener('input', () => { aplicarMargen(); calcular(); });
    margen.addEventListener('input', () => { aplicarMargen(); calcular(); });
    precio.addEventListener('input', () => {
      const c = parseFloat(costo.value);
      const v = parseFloat(precio.value);
      if (c > 0 && Number.isFinite(v)) margen.value = Math.round(((v - c) / c) * 10000) / 100;
      calcular();
    });
    calcular();

    const stockInicial = nuevo ? numero('0', false) : null;
    const stockMinimo = numero(p?.stock_minimo ?? 0, false);
    const exento = h('input', { type: 'checkbox', checked: !!p?.itbis_exento });
    const ubicacion = h('input', { class: 'campo', value: p?.ubicacion ?? '', placeholder: 'Ej. Estante B2' });

    const vistaFoto = h('div', { class: 'foto' });
    const pintarFoto = () => vistaFoto.replaceChildren(foto ? h('img', { src: foto, alt: 'Foto del producto' }) : h('span', {}, 'Sin foto'));
    pintarFoto();
    const archivo = h('input', {
      type: 'file', accept: 'image/*', class: 'oculto',
      onChange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try { foto = await redimensionar(f); pintarFoto(); } catch (err) { toast(err.message, 'error'); }
      },
    });
    const error = h('p', { class: 'error', role: 'alert' });

    async function guardar() {
      error.textContent = '';
      const nombreV = nombre.value.trim();
      const precioV = parseFloat(precio.value);
      const costoV = parseFloat(costo.value) || 0;
      const minimoV = parseInt(stockMinimo.value, 10) || 0;
      const inicialV = nuevo ? parseInt(stockInicial.value, 10) || 0 : 0;

      if (!nombreV) { error.textContent = 'Escribe el nombre del producto.'; nombre.focus(); return; }
      if (!(precioV >= 0)) { error.textContent = 'Escribe el precio de venta.'; precio.focus(); return; }
      if (costoV < 0 || minimoV < 0 || inicialV < 0) { error.textContent = 'Los números no pueden ser negativos.'; return; }

      try {
        let catId = categoria.value ? Number(categoria.value) : null;
        const nc = nuevaCat.value.trim();
        if (nc) {
          await ejecutar('INSERT OR IGNORE INTO categorias (nombre) VALUES (?)', [nc]);
          const [c] = await consultar('SELECT id FROM categorias WHERE nombre = ?', [nc]);
          catId = c.id;
        }
        const cod = codigo.value.trim() || null;
        const mar = marca.value.trim() || null;
        const ubi = ubicacion.value.trim() || null;
        const mV = parseFloat(margen.value);
        const margenV = Number.isFinite(mV) ? mV : null;

        if (nuevo) {
          const set = [{
            statement: `INSERT INTO productos (codigo, nombre, categoria_id, marca, costo, precio, margen, stock_actual, stock_minimo, ubicacion, foto, itbis_exento)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            values: [cod, nombreV, catId, mar, costoV, precioV, margenV, inicialV, minimoV, ubi, foto, exento.checked ? 1 : 0],
          }];
          if (inicialV > 0) {
            set.push({
              statement: `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo)
                          VALUES (last_insert_rowid(), 'entrada', ?, 'stock inicial')`,
              values: [inicialV],
            });
          }
          await transaccion(set);
        } else {
          await ejecutar(
            `UPDATE productos SET codigo=?, nombre=?, categoria_id=?, marca=?, costo=?, precio=?, margen=?, stock_minimo=?, ubicacion=?, foto=?, itbis_exento=?
              WHERE id = ?`,
            [cod, nombreV, catId, mar, costoV, precioV, margenV, minimoV, ubi, foto, exento.checked ? 1 : 0, p.id]);
        }
        cerrar();
        toast(nuevo ? 'Producto guardado' : 'Cambios guardados');
        await cargarCategorias();
        await pintar();
      } catch (e) {
        error.textContent = /UNIQUE/i.test(e.message || String(e))
          ? 'Ya existe un producto con ese código.'
          : `No se pudo guardar: ${e.message || e}`;
      }
    }

    async function quitar() {
      const ok = await confirmar('Quitar producto',
        `"${p.nombre}" dejará de aparecer en la lista. Las ventas anteriores se conservan.`, 'Quitar producto');
      if (!ok) return;
      // Se libera el código para poder reutilizarlo en otro producto
      await ejecutar('UPDATE productos SET activo = 0, codigo = NULL WHERE id = ?', [p.id]);
      cerrar();
      toast('Producto quitado');
      await pintar();
    }

    cerrar = hoja(nuevo ? 'Nuevo producto' : 'Editar producto',
      h('div', { class: 'cuerpo' },
        campo('Nombre', nombre),
        campo('Código de barras', h('div', { class: 'buscador' }, codigo, botonEscaner({
          titulo: 'Escanear código del producto', ayuda: 'Escanea el código de barras que trae el producto.',
          alLeer: async (c) => {
            const [otro] = await consultar('SELECT nombre FROM productos WHERE codigo = ? COLLATE NOCASE AND activo = 1 AND id IS NOT ?', [c, p?.id ?? null]);
            if (otro) toast(`Aviso: ese código ya lo tiene "${otro.nombre}"`, 'error');
            codigo.value = c;
            return false;
          },
        }, 'Escanear')), 'Escribe tu propio código o escanea el que trae el producto. Así podrás venderlo con la cámara.'),
        campo('Marca', marca),
        campo('Categoría', categoria),
        nuevaCat,
        h('div', { class: 'rejilla' }, campo('Costo', costo), campo('Margen de ganancia (%)', margen)),
        campo('Precio de venta', precio, 'Se calcula con el costo y el margen. Si escribes el precio, el margen se ajusta. Al cambiar el costo en Inventario, el precio sigue este margen.'),
        ganancia,
        h('div', { class: 'rejilla' },
          nuevo ? campo('Cantidad inicial', stockInicial) : null,
          campo('Stock mínimo', stockMinimo, 'Avisa cuando baje de este número.')),
        campo('Ubicación en almacén', ubicacion),
        h('label', { class: 'etiqueta' }, exento, ' Exento de ITBIS (no cobra impuesto)'),
        h('div', { class: 'fotobloque' }, vistaFoto, h('label', { class: 'btn' }, 'Elegir foto', archivo)),
        nuevo ? null : h('p', { class: 'ayuda' }, `Stock actual: ${p.stock_actual}. Para cambiarlo usa Inventario, así queda registrado.`),
        error,
        h('div', { class: 'acciones' },
          nuevo ? null : h('button', { class: 'btn peligro', onClick: quitar }, 'Quitar producto'),
          h('button', { class: 'btn primario', onClick: guardar }, 'Guardar producto'))));
  }

  raiz.replaceChildren(
    h('header', { class: 'barra' },
      h('h1', {}, 'Productos'),
      h('button', { class: 'btn claro', onClick: () => formulario() }, 'Nuevo producto')),
    h('div', { class: 'filtros' }, h('div', { class: 'buscador' }, buscador, botonEscaner({
      titulo: 'Buscar por código', ayuda: 'Escanea el código del producto',
      alLeer: (c) => { buscador.value = c; buscador.dispatchEvent(new Event('input')); return false; },
    })), selCat),
    lista);
  await cargarCategorias();
  await pintar();
}
