// conta-ui-bancos.js - pestaña Bancos: cuentas, depósitos/retiros/cheques/transferencias y conciliación
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { consultar } from './database.js';
import {
  listarBancos, crearBanco, hacerPredeterminado, TIPOS_MOV_BANCO, registrarMovBanco, anularMovBanco, movimientosBanco,
  marcarConciliados, diferenciaConciliacion, listarCuentas, fechaHoy,
} from './conta-db.js';
import { campo, numero, fechaInput, texto, selectCuentas, tabla, vacio, fechaCorta, limpiar } from './conta-ui-comun.js';

export async function vistaBancos(raiz) {
  const bancos = await listarBancos();
  const saldos = await Promise.all(bancos.map((b) => movimientosBanco(b.id).then((m) => m.saldoLibros).catch(() => 0)));

  function nuevaCuenta() {
    const nombre = texto('', 'Ej. Popular corriente');
    const banco = texto('', 'Banco');
    const num = texto('', 'Número de cuenta (opcional)');
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja('Nueva cuenta bancaria', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), campo('Banco', banco), campo('Número', num), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try { await crearBanco({ nombre: nombre.value, banco: banco.value, numero: num.value }); cerrar(); toast('Cuenta creada'); await vistaBancos(raiz); }
        catch (e) { error.textContent = limpiar(e); }
      } }, 'Crear'))));
  }

  raiz.replaceChildren(
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: nuevaCuenta }, 'Nueva cuenta bancaria')),
    bancos.length ? h('div', { class: 'lista' }, bancos.map((b, i) => h('button', { class: 'fila inventario', onClick: () => detalle(b) },
      h('span', { class: 'datos' }, h('strong', {}, b.nombre), h('small', {}, `${b.banco || 'Banco'}${b.numero ? ` · ${b.numero}` : ''}${b.predeterminada ? ' · predeterminada' : ''}`)),
      h('span', { class: 'precio' }, dinero(saldos[i])))))
      : vacio('Aún no hay cuentas bancarias. Crea una para registrar depósitos, cheques y conciliar. Los cobros con tarjeta, transferencia o cheque de las ventas ya se cargan al banco predeterminado.'));

  async function detalle(b) {
    const info = await movimientosBanco(b.id);
    const cont = h('div', { class: 'cuerpo' });
    const marcas = new Set();
    const extracto = numero('');
    const resultado = h('p', { class: 'ayuda' });
    const mostrar = (m) => `${fechaCorta(m.fecha)} · ${m.concepto}`;

    function pintarConc() {
      const base = info.saldoConciliado;
      const marcado = [...marcas].reduce((s, k) => { const m = info.movimientos.find((x) => x.key === k); return s + (m ? m.entra - m.sale : 0); }, 0);
      const sConc = Math.round((base + marcado) * 100) / 100;
      const e = parseFloat(extracto.value);
      resultado.textContent = Number.isFinite(e)
        ? `Saldo conciliado: ${dinero(sConc)} · Diferencia contra el estado de cuenta: ${dinero(diferenciaConciliacion(sConc, e))}${Math.abs(diferenciaConciliacion(sConc, e)) < 0.005 ? ' ✓ cuadra' : ''}`
        : `Saldo conciliado: ${dinero(sConc)}. Escribe el saldo final de tu estado de cuenta para comparar.`;
    }
    extracto.addEventListener('input', pintarConc);

    const pend = info.movimientos.filter((m) => !m.conciliado);
    const filasPend = pend.map((m) => {
      const chk = h('input', { type: 'checkbox', 'aria-label': `Conciliar ${m.concepto}`, onChange: (e) => { if (e.target.checked) marcas.add(m.key); else marcas.delete(m.key); pintarConc(); } });
      return h('label', { class: 'fila inventario' }, chk, h('span', { class: 'datos' }, h('strong', {}, m.concepto), h('small', {}, fechaCorta(m.fecha))),
        h('span', { class: m.entra ? 'precio' : 'precio deuda' }, m.entra ? `+${dinero(m.entra)}` : `-${dinero(m.sale)}`));
    });

    const movs = await consultar("SELECT * FROM banco_movs WHERE banco_id = ? AND estado = 'vigente' ORDER BY fecha DESC, id DESC LIMIT 30", [b.id]);

    cont.append(
      h('div', { class: 'totales' }, h('div', {}, h('span', {}, 'Saldo en libros'), h('span', {}, dinero(info.saldoLibros))), h('div', {}, h('span', {}, 'Saldo conciliado'), h('span', {}, dinero(info.saldoConciliado)))),
      h('div', { class: 'acciones' },
        h('button', { class: 'btn primario', onClick: () => { cerrar(); nuevoMov(b); } }, 'Registrar movimiento'),
        b.predeterminada ? null : h('button', { class: 'btn', onClick: async () => { await hacerPredeterminado(b.id); cerrar(); toast('Cuenta predeterminada'); await vistaBancos(raiz); } }, 'Usar para cobros con tarjeta/transferencia')),
      h('h3', { class: 'seccion' }, 'Conciliación'),
      pend.length ? h('div', {}, h('div', { class: 'lista' }, filasPend),
        campo('Saldo final del estado de cuenta', extracto), resultado,
        h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
          if (!marcas.size) { toast('Marca los movimientos que aparecen en el estado de cuenta', 'error'); return; }
          await marcarConciliados(b.id, [...marcas]); cerrar(); toast('Conciliados'); await vistaBancos(raiz);
        } }, 'Conciliar marcados')))
        : vacio('No hay movimientos pendientes de conciliar.'),
      h('h3', { class: 'seccion' }, 'Últimos movimientos registrados aquí'),
      movs.length ? h('div', { class: 'lista' }, movs.map((m) => h('div', { class: 'fila inventario' },
        h('span', { class: 'datos' }, h('strong', {}, `${TIPOS_MOV_BANCO[m.tipo]} · ${m.numero}`), h('small', {}, `${fechaCorta(m.fecha)}${m.referencia ? ` · ${m.referencia}` : ''}`)),
        h('span', { class: 'precio' }, dinero(m.monto)),
        h('button', { class: 'btn chico', onClick: async () => {
          if (!(await confirmar('Anular movimiento', `Se anulará ${m.numero}.`, 'Anular'))) return;
          try { await anularMovBanco(m.id); cerrar(); toast('Movimiento anulado'); await vistaBancos(raiz); } catch (e) { toast(limpiar(e), 'error'); }
        } }, 'Anular'))))
        : vacio('Sin movimientos manuales.'));
    pintarConc();
    const cerrar = hoja(b.nombre, cont);
  }

  async function nuevoMov(b) {
    const cuentas = await listarCuentas(true);
    const otros = (await listarBancos()).filter((x) => x.id !== b.id && x.activo);
    const tipo = h('select', { class: 'campo' }, Object.entries(TIPOS_MOV_BANCO).map(([k, t]) => h('option', { value: k }, t)));
    const fecha = fechaInput(fechaHoy()), monto = numero(), ref = texto('', 'Ej. No. de cheque'), det = texto('', 'Descripción (opcional)');
    const contra = selectCuentas(cuentas, { vacioTexto: 'Cuenta contraria (por defecto: Caja)' });
    const destino = h('select', { class: 'campo' }, h('option', { value: '' }, '— Cuenta destino —'), otros.map((x) => h('option', { value: String(x.id) }, x.nombre)));
    const contraBox = campo('Cuenta contraria', contra, 'Depósito: de dónde vino el dinero. Retiro/cheque/comisión: en qué se usó.');
    const destBox = campo('Transferir a', destino);
    const error = h('p', { class: 'error', role: 'alert' });
    const ajustar = () => { destBox.hidden = tipo.value !== 'transferencia'; contraBox.hidden = tipo.value === 'transferencia'; };
    tipo.addEventListener('change', ajustar); ajustar();
    const cerrar = hoja(`Movimiento · ${b.nombre}`, h('div', { class: 'cuerpo' },
      campo('Tipo', tipo), h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('Monto', monto)), contraBox, destBox,
      campo('Referencia', ref), campo('Detalle', det), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try {
          await registrarMovBanco({ banco_id: b.id, fecha: fecha.value, tipo: tipo.value, monto: monto.value, contra_cuenta_id: Number(contra.value) || null, banco_destino_id: Number(destino.value) || null, referencia: ref.value, detalle: det.value });
          cerrar(); toast('Movimiento registrado'); await vistaBancos(raiz);
        } catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar'))));
  }
}
