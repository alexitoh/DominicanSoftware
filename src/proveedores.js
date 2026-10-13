// proveedores.js - lista y formulario de proveedores
import { consultar, ejecutar } from './database.js';
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { campoCondicion, textoCondicion } from './condicion.js';

// Se exporta para poder crear un proveedor al vuelo desde la pantalla de compras.
// alGuardar recibe el id del proveedor guardado.
export function formularioProveedor(p = null, alGuardar = () => {}) {
  const nuevo = !p;
  let cerrar = () => {};

  const campo = (etiqueta, input) => h('label', { class: 'etiqueta' }, etiqueta, input);
  const nombre = h('input', { class: 'campo', value: p?.nombre ?? '', autocomplete: 'off' });
  const telefono = h('input', { class: 'campo', type: 'tel', inputmode: 'tel', value: p?.telefono ?? '' });
  const direccion = h('input', { class: 'campo', value: p?.direccion ?? '' });
  const notas = h('textarea', { class: 'campo', rows: '2' }, p?.notas ?? '');
  const condicion = campoCondicion(p);
  const error = h('p', { class: 'error', role: 'alert' });

  async function guardar() {
    error.textContent = '';
    const n = nombre.value.trim();
    if (!n) { error.textContent = 'Escribe el nombre del proveedor.'; nombre.focus(); return; }
    const cond = condicion.valores();
    if (cond.error) { error.textContent = cond.error; cond.foco?.focus(); return; }
    const valores = [n, telefono.value.trim() || null, direccion.value.trim() || null, notas.value.trim() || null, cond.condicion, cond.dias];
    try {
      let id = p?.id;
      if (nuevo) {
        const r = await ejecutar('INSERT INTO proveedores (nombre, telefono, direccion, notas, condicion, dias_credito) VALUES (?,?,?,?,?,?)', valores);
        id = r?.changes?.lastId;
        if (!id) id = (await consultar('SELECT last_insert_rowid() AS id'))[0].id;
      } else {
        await ejecutar('UPDATE proveedores SET nombre=?, telefono=?, direccion=?, notas=?, condicion=?, dias_credito=? WHERE id=?', [...valores, id]);
      }
      cerrar();
      toast(nuevo ? 'Proveedor guardado' : 'Cambios guardados');
      await alGuardar(id);
    } catch (e) {
      error.textContent = `No se pudo guardar: ${e.message || e}`;
    }
  }

  async function quitar() {
    const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM compras WHERE proveedor_id = ?', [p.id]);
    if (n > 0) {
      error.textContent = `No se puede quitar: tiene ${n} ${n === 1 ? 'compra registrada' : 'compras registradas'}.`;
      return;
    }
    const ok = await confirmar('Quitar proveedor', `Se eliminará a "${p.nombre}".`, 'Quitar proveedor');
    if (!ok) return;
    await ejecutar('DELETE FROM proveedores WHERE id = ?', [p.id]);
    cerrar();
    toast('Proveedor quitado');
    await alGuardar(null);
  }

  cerrar = hoja(nuevo ? 'Nuevo proveedor' : 'Editar proveedor',
    h('div', { class: 'cuerpo' },
      campo('Nombre', nombre),
      campo('Teléfono', telefono),
      campo('Dirección', direccion),
      campo('Notas', notas),
      condicion.el,
      error,
      h('div', { class: 'acciones' },
        nuevo ? null : h('button', { class: 'btn peligro', onClick: quitar }, 'Quitar proveedor'),
        h('button', { class: 'btn primario', onClick: guardar }, 'Guardar proveedor'))));
}

export async function vistaProveedores(raiz) {
  const lista = h('div', { class: 'lista' });
  let texto = '';

  const buscador = h('input', {
    class: 'campo', type: 'search', placeholder: 'Buscar por nombre o teléfono',
    'aria-label': 'Buscar proveedor',
    onInput: (e) => { texto = e.target.value; pintar(); },
  });

  async function pintar() {
    const like = `%${texto.trim()}%`;
    const filas = await consultar(
      `SELECT p.*,
         (SELECT COUNT(*) FROM compras c WHERE c.proveedor_id = p.id AND c.estado = 'completada') AS compras,
         (SELECT COALESCE(SUM(c.total), 0) FROM compras c WHERE c.proveedor_id = p.id AND c.estado = 'completada') AS total,
         (SELECT COALESCE(SUM(c.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos_compra WHERE compra_id = c.id)), 0)
            FROM cuentas_pagar a JOIN compras c ON c.id = a.compra_id
           WHERE c.proveedor_id = p.id AND c.estado = 'completada') AS deuda
         FROM proveedores p
        WHERE p.nombre LIKE ? OR p.telefono LIKE ?
        ORDER BY p.nombre`, [like, like]);

    lista.replaceChildren(...(filas.length
      ? filas.map((p) => h('button', { class: 'fila inventario', onClick: () => formularioProveedor(p, pintar) },
          h('span', { class: 'datos' },
            h('strong', {}, p.nombre),
            h('small', {}, p.telefono || 'Sin teléfono'),
            textoCondicion(p) ? h('small', {}, textoCondicion(p)) : null,
            p.deuda > 0.005 ? h('small', { class: 'deuda' }, `Le debes ${dinero(p.deuda)}`) : null),
          h('span', { class: 'precio' }, dinero(p.total),
            h('small', { class: 'bloque' }, `${p.compras} ${p.compras === 1 ? 'compra' : 'compras'}`))))
      : [h('p', { class: 'vacio' }, texto.trim()
          ? 'Ningún proveedor coincide con la búsqueda.'
          : 'Aún no hay proveedores. Toca "Nuevo proveedor" para registrar el primero.')]));
  }

  raiz.replaceChildren(
    h('header', { class: 'barra' },
      h('h1', {}, 'Proveedores'),
      h('button', { class: 'btn claro', onClick: () => formularioProveedor(null, pintar) }, 'Nuevo proveedor')),
    h('div', { class: 'filtros' }, buscador),
    lista);
  await pintar();
}
