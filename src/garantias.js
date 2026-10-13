// garantias.js - control de garantías por producto/serie y reclamos
import { consultar, ejecutar } from './database.js';
import { botonEscaner } from './escaner.js';
import { h, hoja, toast, confirmar } from './ui.js';

const FILTROS = [['vigentes', 'Vigentes'], ['porvencer', 'Por vencer'], ['vencidas', 'Vencidas'], ['todas', 'Todas']];
const fechaCorta = (f) => (f || '').slice(0, 10).split('-').reverse().join('/');
const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// Estado visible de una garantía: anulada | vencida | porvencer | vigente
export function estadoGarantia(g, hoy = hoyISO()) {
  if (g.estado === 'anulada' || g.venta_estado === 'anulada') return { id: 'anulada', texto: 'Anulada', dias: null };
  const dias = diasEntre(hoy, g.vence);
  if (dias < 0) return { id: 'vencida', texto: `Venció hace ${-dias} d`, dias };
  if (dias <= 30) return { id: 'porvencer', texto: dias === 0 ? 'Vence hoy' : `Vence en ${dias} d`, dias };
  return { id: 'vigente', texto: `Vigente, ${dias} d`, dias };
}

const SQL = `SELECT g.*, p.nombre AS producto, v.numero AS venta_numero, v.estado AS venta_estado, v.fecha AS venta_fecha,
                    c.nombre AS cliente, c.telefono AS cliente_tel,
                    (SELECT COUNT(*) FROM garantia_reclamos r WHERE r.garantia_id = g.id AND r.estado = 'abierto') AS abiertos,
                    (SELECT COUNT(*) FROM garantia_reclamos r WHERE r.garantia_id = g.id) AS reclamos
               FROM garantias g
               JOIN productos p ON p.id = g.producto_id
               JOIN ventas v ON v.id = g.venta_id
          LEFT JOIN clientes c ON c.id = g.cliente_id`;

const renglon = (a, b, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, b));

export async function vistaGarantias(raiz) {
  const estado = { filtro: 'vigentes', texto: '' };
  const segmento = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Estado' });
  const buscar = h('input', {
    class: 'campo', type: 'search', placeholder: 'Buscar por serie, producto, cliente o factura', autocomplete: 'off',
    onInput: (e) => { estado.texto = e.target.value.trim().toLowerCase(); pintar(); },
  });
  const resumen = h('p', { class: 'ayuda resumen-garantias' });
  const lista = h('div', { class: 'lista' });
  let todas = [];

  const pintarSegmento = () => segmento.replaceChildren(...FILTROS.map(([id, t]) =>
    h('button', {
      'aria-pressed': String(estado.filtro === id),
      onClick: () => { estado.filtro = id; pintarSegmento(); pintar(); },
    }, t)));

  async function cargar() {
    todas = await consultar(`${SQL} ORDER BY g.vence ASC, g.id DESC`);
    pintar();
  }

  function pintar() {
    const hoy = hoyISO();
    const con = todas.map((g) => ({ g, e: estadoGarantia(g, hoy) }));
    const n = (id) => con.filter((x) => x.e.id === id).length;
    resumen.textContent = `${n('vigente') + n('porvencer')} vigentes, ${n('porvencer')} por vencer, ${n('vencida')} vencidas.`;
    const visibles = con.filter(({ g, e }) => {
      if (estado.filtro === 'vigentes' && !['vigente', 'porvencer'].includes(e.id)) return false;
      if (estado.filtro === 'porvencer' && e.id !== 'porvencer') return false;
      if (estado.filtro === 'vencidas' && e.id !== 'vencida') return false;
      if (!estado.texto) return true;
      return [g.serie, g.producto, g.cliente, g.venta_numero].some((x) => (x || '').toLowerCase().includes(estado.texto));
    });
    lista.replaceChildren(...(visibles.length
      ? visibles.map(({ g, e }) => h('button', { class: 'fila inventario', onClick: () => detalle(g.id) },
          h('span', { class: 'datos' },
            h('strong', {}, g.producto),
            h('small', {}, [g.serie ? `Serie ${g.serie}` : null, g.cliente || 'Cliente general', g.venta_numero].filter(Boolean).join(', ')),
            g.abiertos ? h('small', { class: 'deuda' }, `${g.abiertos} reclamo${g.abiertos > 1 ? 's' : ''} abierto${g.abiertos > 1 ? 's' : ''}`) : null),
          h('span', { class: 'precio' }, fechaCorta(g.vence),
            h('small', { class: `bloque ${e.id === 'vencida' || e.id === 'anulada' ? 'deuda' : e.id === 'porvencer' ? '' : 'pagada'}` }, e.texto))))
      : [h('p', { class: 'vacio' }, todas.length
          ? 'No hay garantías con ese filtro.'
          : 'Aún no hay garantías. Al vender, escribe los meses de garantía en la línea del producto.')]));
  }

  async function detalle(id) {
    const [g] = await consultar(`${SQL} WHERE g.id = ?`, [id]);
    const reclamos = await consultar('SELECT * FROM garantia_reclamos WHERE garantia_id = ? ORDER BY id DESC', [id]);
    const e = estadoGarantia(g);
    let cerrar = () => {};
    const refrescar = async () => { cerrar(); await cargar(); await detalle(id); };

    function nuevoReclamo() {
      const problema = h('textarea', { class: 'campo', rows: '3', placeholder: 'Qué falla el cliente' });
      const error = h('p', { class: 'error', role: 'alert' });
      let cerrarR = () => {};
      const boton = h('button', { class: 'btn primario', onClick: async () => {
        if (!problema.value.trim()) { error.textContent = 'Describe el problema.'; problema.focus(); return; }
        boton.disabled = true;
        try {
          await ejecutar('INSERT INTO garantia_reclamos (garantia_id, problema) VALUES (?, ?)', [id, problema.value.trim()]);
          cerrarR();
          toast('Reclamo registrado');
          await refrescar();
        } catch (err) { boton.disabled = false; error.textContent = err.message || String(err); }
      } }, 'Guardar reclamo');
      cerrarR = hoja('Registrar reclamo', h('div', { class: 'cuerpo' },
        h('label', { class: 'etiqueta' }, 'Problema', problema), error, h('div', { class: 'acciones' }, boton)));
    }

    function resolver(r) {
      const texto = h('textarea', { class: 'campo', rows: '3', placeholder: 'Ej. Se cambió por uno nuevo, se reparó' });
      let cerrarR = () => {};
      const boton = h('button', { class: 'btn primario', onClick: async () => {
        boton.disabled = true;
        try {
          await ejecutar("UPDATE garantia_reclamos SET estado = 'resuelto', resolucion = ? WHERE id = ?", [texto.value.trim() || null, r.id]);
          cerrarR();
          toast('Reclamo resuelto');
          await refrescar();
        } catch (err) { boton.disabled = false; toast(err.message || 'No se pudo guardar', 'error'); }
      } }, 'Marcar resuelto');
      cerrarR = hoja('Resolver reclamo', h('div', { class: 'cuerpo' },
        h('p', { class: 'ayuda' }, r.problema),
        h('label', { class: 'etiqueta' }, 'Qué se hizo', texto), h('div', { class: 'acciones' }, boton)));
    }

    function editarSerie() {
      const serie = h('input', { class: 'campo', value: g.serie || '', placeholder: 'Nº de serie', autocomplete: 'off' });
      const escanear = botonEscaner({
        titulo: 'Escanear serie', ayuda: 'Escanea el número de serie del equipo.',
        alLeer: (c) => { serie.value = c; return false; },
      }, 'Escanear');
      let cerrarS = () => {};
      const boton = h('button', { class: 'btn primario', onClick: async () => {
        await ejecutar('UPDATE garantias SET serie = ? WHERE id = ?', [serie.value.trim() || null, id]);
        cerrarS();
        toast('Serie guardada');
        await refrescar();
      } }, 'Guardar');
      cerrarS = hoja('Número de serie', h('div', { class: 'cuerpo' },
        h('label', { class: 'etiqueta' }, 'Serie', h('div', { class: 'buscador' }, serie, escanear)),
        h('div', { class: 'acciones' }, boton)));
    }

    async function anular() {
      const ok = await confirmar('Anular garantía', 'La garantía dejará de contar como vigente. Se usa si se registró por error.', 'Anular garantía');
      if (!ok) return;
      await ejecutar("UPDATE garantias SET estado = 'anulada' WHERE id = ?", [id]);
      toast('Garantía anulada');
      await refrescar();
    }

    cerrar = hoja(g.producto,
      h('div', { class: 'cuerpo' },
        h('div', { class: 'totales' },
          renglon('Estado', e.texto, 'gran'),
          renglon('Serie', g.serie || 'Sin serie'),
          renglon('Cliente', g.cliente || 'Cliente general'),
          g.cliente_tel ? renglon('Teléfono', g.cliente_tel) : null,
          renglon('Factura', g.venta_numero),
          renglon('Garantía', `${g.meses} ${g.meses === 1 ? 'mes' : 'meses'}`),
          renglon('Desde', fechaCorta(g.inicio)),
          renglon('Hasta', fechaCorta(g.vence))),
        h('h3', {}, 'Reclamos'),
        reclamos.length
          ? h('ul', { class: 'historial detalle' }, reclamos.map((r) => h('li', {},
              h('span', {}, `${fechaCorta(r.fecha)}: ${r.problema}${r.resolucion ? ` → ${r.resolucion}` : ''}`),
              r.estado === 'abierto'
                ? h('button', { class: 'btn', onClick: () => resolver(r) }, 'Resolver')
                : h('small', { class: 'pagada' }, 'Resuelto'))))
          : h('p', { class: 'ayuda' }, 'Sin reclamos.'),
        h('div', { class: 'acciones' },
          g.estado !== 'anulada' && g.venta_estado !== 'anulada'
            ? h('button', { class: 'btn peligro', onClick: anular }, 'Anular') : null,
          h('button', { class: 'btn', onClick: editarSerie }, 'Editar serie'),
          h('button', { class: 'btn primario', onClick: nuevoReclamo }, 'Registrar reclamo'))));
  }

  raiz.replaceChildren(
    h('header', { class: 'barra' }, h('h1', {}, 'Garantías')),
    h('div', { class: 'filtros' }, h('div', { class: 'buscador' }, buscar, botonEscaner({
      titulo: 'Escanear serie', ayuda: 'Escanea el número de serie o el código del equipo.',
      alLeer: (c) => {
        buscar.value = c; estado.texto = c.toLowerCase();
        estado.filtro = 'todas'; pintarSegmento(); pintar();
        return false;
      },
    })), segmento, resumen),
    lista);
  pintarSegmento();
  await cargar();
}
