// clientes.js - lista, detalle con deuda y formulario de clientes
import { consultar, ejecutar, redondear } from './database.js';
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { formularioAbono } from './cobros.js';
import { campoCondicion, textoCondicion } from './condicion.js';
import { hoyISO } from './fechas.js';

// Lo que debe una venta a crédito: total menos lo abonado
const SALDO = `(v.total - COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.venta_id = v.id), 0))`;

const CLIENTES = `
  SELECT c.*,
    (SELECT COUNT(*) FROM ventas v WHERE v.cliente_id = c.id AND v.estado = 'completada') AS compras,
    (SELECT COALESCE(SUM(v.total), 0) FROM ventas v WHERE v.cliente_id = c.id AND v.estado = 'completada') AS total,
    (SELECT COALESCE(SUM(${SALDO}), 0) FROM ventas v
      WHERE v.cliente_id = c.id AND v.estado = 'completada' AND v.metodo_pago = 'credito') AS deuda
  FROM clientes c`;

const renglon = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));

// Se exporta para poder crear un cliente al vuelo desde la pantalla de ventas.
// alGuardar recibe el id del cliente guardado.
export function formularioCliente(c = null, alGuardar = () => {}) {
  const nuevo = !c;
  let cerrar = () => {};

  const campo = (etiqueta, input) => h('label', { class: 'etiqueta' }, etiqueta, input);
  const nombre = h('input', { class: 'campo', value: c?.nombre ?? '', autocomplete: 'off' });
  const telefono = h('input', { class: 'campo', type: 'tel', inputmode: 'tel', value: c?.telefono ?? '' });
  const direccion = h('input', { class: 'campo', value: c?.direccion ?? '' });
  const notas = h('textarea', { class: 'campo', rows: '2' }, c?.notas ?? '');
  const condicion = campoCondicion(c);
  const error = h('p', { class: 'error', role: 'alert' });

  async function guardar() {
    error.textContent = '';
    const n = nombre.value.trim();
    if (!n) { error.textContent = 'Escribe el nombre del cliente.'; nombre.focus(); return; }
    const cond = condicion.valores();
    if (cond.error) { error.textContent = cond.error; cond.foco?.focus(); return; }
    const valores = [n, telefono.value.trim() || null, direccion.value.trim() || null, notas.value.trim() || null, cond.condicion, cond.dias];
    try {
      let id = c?.id;
      if (nuevo) {
        const r = await ejecutar('INSERT INTO clientes (nombre, telefono, direccion, notas, condicion, dias_credito) VALUES (?,?,?,?,?,?)', valores);
        id = r?.changes?.lastId;
        if (!id) id = (await consultar('SELECT last_insert_rowid() AS id'))[0].id;
      } else {
        await ejecutar('UPDATE clientes SET nombre=?, telefono=?, direccion=?, notas=?, condicion=?, dias_credito=? WHERE id=?', [...valores, id]);
      }
      cerrar();
      toast(nuevo ? 'Cliente guardado' : 'Cambios guardados');
      await alGuardar(id);
    } catch (e) {
      error.textContent = `No se pudo guardar: ${e.message || e}`;
    }
  }

  async function quitar() {
    const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM ventas WHERE cliente_id = ?', [c.id]);
    if (n > 0) {
      error.textContent = `No se puede quitar: tiene ${n} ${n === 1 ? 'venta registrada' : 'ventas registradas'}.`;
      return;
    }
    const ok = await confirmar('Quitar cliente', `Se eliminará a "${c.nombre}".`, 'Quitar cliente');
    if (!ok) return;
    await ejecutar('DELETE FROM clientes WHERE id = ?', [c.id]);
    cerrar();
    toast('Cliente quitado');
    await alGuardar(null);
  }

  cerrar = hoja(nuevo ? 'Nuevo cliente' : 'Editar cliente',
    h('div', { class: 'cuerpo' },
      campo('Nombre', nombre),
      campo('Teléfono', telefono),
      campo('Dirección', direccion),
      campo('Notas', notas),
      condicion.el,
      error,
      h('div', { class: 'acciones' },
        nuevo ? null : h('button', { class: 'btn peligro', onClick: quitar }, 'Quitar cliente'),
        h('button', { class: 'btn primario', onClick: guardar }, 'Guardar cliente'))));
}

export async function vistaClientes(raiz) {
  const estado = { texto: '', soloDeuda: false };
  const resumen = h('dl', { class: 'resumen' });
  const lista = h('div', { class: 'lista' });

  const buscador = h('input', {
    class: 'campo', type: 'search', placeholder: 'Buscar por nombre o teléfono',
    'aria-label': 'Buscar cliente',
    onInput: (e) => { estado.texto = e.target.value; pintar(); },
  });

  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Filtrar clientes' });
  const pintarSegmento = () => segmento.replaceChildren(...[[false, 'Todos'], [true, 'Con deuda']].map(([valor, t]) =>
    h('button', {
      'aria-pressed': String(estado.soloDeuda === valor),
      onClick: () => { estado.soloDeuda = valor; pintarSegmento(); pintar(); },
    }, t)));

  async function pintar() {
    const [r] = await consultar(
      `SELECT COALESCE(SUM(${SALDO}), 0) AS por_cobrar, COUNT(DISTINCT v.cliente_id) AS n
         FROM ventas v
        WHERE v.estado = 'completada' AND v.metodo_pago = 'credito' AND ${SALDO} > 0.005`);
    const [{ n: totalClientes }] = await consultar('SELECT COUNT(*) AS n FROM clientes');
    const dato = (et, val) => h('div', {}, h('dt', {}, et), h('dd', {}, val));
    resumen.replaceChildren(
      dato('Clientes', String(totalClientes)),
      dato('Con deuda', String(r.n)),
      dato('Por cobrar', dinero(r.por_cobrar)));

    const like = `%${estado.texto.trim()}%`;
    let filas = await consultar(`${CLIENTES} WHERE c.nombre LIKE ? OR c.telefono LIKE ? ORDER BY c.nombre`, [like, like]);
    if (estado.soloDeuda) filas = filas.filter((c) => c.deuda > 0.005);

    lista.replaceChildren(...(filas.length
      ? filas.map((c) => h('button', { class: 'fila inventario', onClick: () => detalleCliente(c.id) },
          h('span', { class: 'datos' },
            h('strong', {}, c.nombre),
            h('small', {}, c.telefono || 'Sin teléfono'),
            textoCondicion(c) ? h('small', {}, textoCondicion(c)) : null),
          h('span', { class: 'precio' }, dinero(c.total),
            h('small', { class: 'bloque' }, `${c.compras} ${c.compras === 1 ? 'compra' : 'compras'}`),
            c.deuda > 0.005 ? h('small', { class: 'bloque deuda' }, `Debe ${dinero(c.deuda)}`) : null)))
      : [h('p', { class: 'vacio' }, estado.soloDeuda
          ? 'Ningún cliente tiene deudas pendientes.'
          : estado.texto.trim()
            ? 'Ningún cliente coincide con la búsqueda.'
            : 'Aún no hay clientes. Toca "Nuevo cliente" para registrar el primero.')]));
  }

  async function detalleCliente(id) {
    const [c] = await consultar(`${CLIENTES} WHERE c.id = ?`, [id]);
    if (!c) return;
    const pendientes = (await consultar(
      `SELECT v.id, v.numero, v.fecha, v.total, (SELECT vence FROM cuentas_cobrar WHERE venta_id = v.id) AS vence,
              COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.venta_id = v.id), 0) AS pagado
         FROM ventas v
        WHERE v.cliente_id = ? AND v.estado = 'completada' AND v.metodo_pago = 'credito'
        ORDER BY v.id`, [id]))
      .map((v) => ({ ...v, saldo: redondear(v.total - v.pagado) }))
      .filter((v) => v.saldo > 0.005);

    let cerrar = () => {};
    const refrescar = async () => { cerrar(); await pintar(); await detalleCliente(id); };

    cerrar = hoja(c.nombre,
      h('div', { class: 'cuerpo' },
        h('p', { class: 'ayuda' }, [c.telefono, c.direccion].filter(Boolean).join(', ') || 'Sin datos de contacto'),
        textoCondicion(c) ? h('p', { class: 'ayuda' }, `Condición de pago: ${textoCondicion(c)}`) : null,
        h('div', { class: 'totales' },
          renglon('Compras', String(c.compras)),
          renglon('Total comprado', dinero(c.total)),
          renglon('Pendiente de pago', dinero(Math.max(0, c.deuda)), 'gran')),
        pendientes.length ? h('h3', {}, 'Ventas a crédito pendientes') : h('p', { class: 'ayuda' }, 'No tiene deudas pendientes.'),
        pendientes.length
          ? h('div', { class: 'carrito' }, pendientes.map((v) => h('div', { class: 'linea' },
              h('div', { class: 'linea-cab' }, h('strong', {}, v.numero), h('span', { class: 'deuda' }, dinero(v.saldo))),
              h('div', { class: 'linea-pie' },
                h('small', { class: v.vence && v.vence < hoyISO() ? 'deuda' : 'ayuda' },
                  `${v.fecha.slice(0, 10)}, total ${dinero(v.total)}${v.vence ? `, ${v.vence < hoyISO() ? 'vencida' : 'vence'} ${v.vence.split('-').reverse().join('/')}` : ''}`),
                h('button', { class: 'btn', onClick: () => formularioAbono(v, refrescar) }, 'Registrar abono')))))
          : null,
        h('div', { class: 'acciones' },
          h('button', { class: 'btn', onClick: () => { cerrar(); formularioCliente(c, pintar); } }, 'Editar cliente'))));
  }

  raiz.replaceChildren(
    h('header', { class: 'barra' },
      h('h1', {}, 'Clientes'),
      h('button', { class: 'btn claro', onClick: () => formularioCliente(null, pintar) }, 'Nuevo cliente')),
    resumen,
    h('div', { class: 'filtros' }, buscador, segmento),
    lista);
  pintarSegmento();
  await pintar();
}
