// conta-ui-bancos.js - pestaña Bancos: cuentas, depósitos/retiros/cheques/transferencias y conciliación
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { consultar } from './database.js';
import {
  listarBancos, crearBanco, hacerPredeterminado, TIPOS_MOV_BANCO, registrarMovBanco, anularMovBanco, movimientosBanco,
  calcularConciliacion, prepararConciliacion, listarConciliaciones, finalizarConciliacion, deshacerConciliacion, listarCuentas, fechaHoy,
} from './conta-db.js';
import { listarTiposCuenta, asignarTipoCuenta } from './banco-db.js';
import { selectDe } from './cxp-docs.js';
import { campo, numero, fechaInput, texto, selectCuentas, tabla, vacio, fechaCorta, limpiar } from './conta-ui-comun.js';

export async function vistaBancos(raiz, opciones = {}) {
  const modoConc = opciones.modo === 'conciliacion';
  const bancos = await listarBancos();
  const tiposCuenta = await listarTiposCuenta();
  const saldos = await Promise.all(bancos.map((b) => movimientosBanco(b.id).then((m) => m.saldoLibros).catch(() => 0)));

  function nuevaCuenta() {
    const nombre = texto('', 'Ej. Popular corriente');
    const banco = texto('', 'Banco');
    const num = texto('', 'Número de cuenta (opcional)');
    const tipoC = selectDe(tiposCuenta.filter((t) => t.activo).map((t) => [t.id, t.nombre]), { vacioTexto: 'Sin tipo', etiqueta: 'Tipo de cuenta' });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja('Nueva cuenta bancaria', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), campo('Banco', banco), campo('Número', num), campo('Tipo de cuenta', tipoC), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try { await crearBanco({ nombre: nombre.value, banco: banco.value, numero: num.value, tipo_cuenta_id: Number(tipoC.value) || null }); cerrar(); toast('Cuenta creada'); await vistaBancos(raiz, opciones); }
        catch (e) { error.textContent = limpiar(e); }
      } }, 'Crear'))));
  }

  raiz.replaceChildren(
    modoConc ? h('p', { class: 'ayuda' }, 'Elige la cuenta y concilia su estado de cuenta contra tus libros. Lo que marques como ya reflejado por el banco deja de estar en tránsito.') : h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: nuevaCuenta }, 'Nueva cuenta bancaria')),
    bancos.length ? h('div', { class: 'lista' }, bancos.map((b, i) => h('button', { class: 'fila inventario', onClick: () => detalle(b) },
      h('span', { class: 'datos' }, h('strong', {}, b.nombre), h('small', {}, `${b.banco || 'Banco'}${b.numero ? ` · ${b.numero}` : ''}${b.tipo_cuenta ? ` · ${b.tipo_cuenta}` : ''}${b.predeterminada ? ' · predeterminada' : ''}`)),
      h('span', { class: 'precio' }, dinero(saldos[i])))))
      : vacio('Aún no hay cuentas bancarias. Crea una para registrar depósitos, cheques y conciliar. Los cobros con tarjeta, transferencia o cheque de las ventas ya se cargan al banco predeterminado.'));

  async function detalle(b) {
    const info = await movimientosBanco(b.id);
    const cont = h('div', { class: 'cuerpo' });
    const tipoSel = selectDe(tiposCuenta.filter((t) => t.activo || t.id === b.tipo_cuenta_id).map((t) => [t.id, t.nombre]), { valor: b.tipo_cuenta_id ?? '', vacioTexto: 'Sin tipo', etiqueta: 'Tipo de cuenta' });
    tipoSel.addEventListener('change', async () => { await asignarTipoCuenta(b.id, Number(tipoSel.value) || null); toast('Tipo guardado'); });
    const hist = await listarConciliaciones(b.id);

    const movs = await consultar("SELECT * FROM banco_movs WHERE banco_id = ? AND estado = 'vigente' ORDER BY fecha DESC, id DESC LIMIT 30", [b.id]);

    cont.append(
      h('div', { class: 'totales' }, h('div', {}, h('span', {}, 'Saldo en libros'), h('span', {}, dinero(info.saldoLibros))), h('div', {}, h('span', {}, 'Saldo conciliado'), h('span', {}, dinero(info.saldoConciliado)))),
      campo('Tipo de cuenta', tipoSel),
      h('div', { class: 'acciones' },
        h('button', { class: 'btn primario', onClick: () => { cerrar(); nuevoMov(b); } }, 'Registrar movimiento'),
        b.predeterminada ? null : h('button', { class: 'btn', onClick: async () => { await hacerPredeterminado(b.id); cerrar(); toast('Cuenta predeterminada'); await vistaBancos(raiz, opciones); } }, 'Usar para cobros con tarjeta/transferencia')),
      h('h3', { class: 'seccion' }, 'Conciliación'),
      h('p', { class: 'ayuda' }, hist[0] ? `Última conciliación: al ${fechaCorta(hist[0].fecha_corte)}.` : 'Aún no has conciliado esta cuenta.'),
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: () => { cerrar(); conciliar(b); } }, 'Nueva conciliación')),
      hist.length ? h('div', { class: 'lista' }, hist.map((c, i) => h('button', { class: 'fila inventario', onClick: () => { cerrar(); verConciliacion(b, c, i === 0); } },
        h('span', { class: 'datos' }, h('strong', {}, `Al ${fechaCorta(c.fecha_corte)}`), h('small', {}, `${c.n_conciliados} movimientos · hecha ${fechaCorta((c.creado || '').slice(0, 10))}`)),
        h('span', { class: 'precio' }, dinero(c.saldo_extracto))))) : null,
      h('h3', { class: 'seccion' }, 'Últimos movimientos registrados aquí'),
      movs.length ? h('div', { class: 'lista' }, movs.map((m) => h('div', { class: 'fila inventario' },
        h('span', { class: 'datos' }, h('strong', {}, `${TIPOS_MOV_BANCO[m.tipo]} · ${m.numero}`), h('small', {}, `${fechaCorta(m.fecha)}${m.referencia ? ` · ${m.referencia}` : ''}`)),
        h('span', { class: 'precio' }, dinero(m.monto)),
        h('button', { class: 'btn chico', onClick: async () => {
          if (!(await confirmar('Anular movimiento', `Se anulará ${m.numero}.`, 'Anular'))) return;
          try { await anularMovBanco(m.id); cerrar(); toast('Movimiento anulado'); await vistaBancos(raiz, opciones); } catch (e) { toast(limpiar(e), 'error'); }
        } }, 'Anular'))))
        : vacio('Sin movimientos manuales.'));
    const cerrar = hoja(b.nombre, cont);
  }

  // ---- Conciliación bancaria: estado de cuenta contra libros, a una fecha de corte ----
  async function conciliar(b) {
    const fecha = fechaInput(fechaHoy());
    const extracto = numero('');
    const nota = texto('', 'Opcional');
    const error = h('p', { class: 'error', role: 'alert' });
    const panel = h('div', { class: 'totales' });
    const lista = h('div', { class: 'lista' });
    const botonFin = h('button', { class: 'btn primario', onClick: finalizar }, 'Finalizar conciliación');
    const marcas = new Set();
    let info = { movimientos: [] };

    async function cargar() {
      info = await prepararConciliacion(b.id, fecha.value || fechaHoy());
      const pend = info.movimientos.filter((m) => !m.conciliado);
      for (const k of [...marcas]) if (!pend.some((m) => m.key === k)) marcas.delete(k);
      lista.replaceChildren(...(pend.length ? pend.map((m) => h('label', { class: 'fila inventario' },
        h('input', { type: 'checkbox', checked: marcas.has(m.key), 'aria-label': `Aparece en el estado de cuenta: ${m.concepto}`,
          onChange: (e) => { if (e.target.checked) marcas.add(m.key); else marcas.delete(m.key); calcular(); } }),
        h('span', { class: 'datos' }, h('strong', {}, m.concepto), h('small', {}, fechaCorta(m.fecha))),
        h('span', { class: m.entra ? 'precio' : 'precio deuda' }, m.entra ? `+${dinero(m.entra)}` : `-${dinero(m.sale)}`)))
        : [vacio('No hay movimientos pendientes a esa fecha.')]));
      calcular();
    }
    const renglon = (a, v, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, v));
    function calcular() {
      const e = parseFloat(extracto.value);
      if (!Number.isFinite(e)) {
        panel.replaceChildren(renglon('Saldo según libros', dinero(calcularConciliacion(info.movimientos, marcas, 0).saldoLibros)));
        botonFin.disabled = true; return;
      }
      const c = calcularConciliacion(info.movimientos, marcas, e);
      panel.replaceChildren(
        renglon('Saldo según el estado de cuenta', dinero(c.saldoExtracto)),
        renglon('+ Depósitos en tránsito', dinero(c.depositosTransito)),
        renglon('- Cheques y retiros en circulación', `- ${dinero(c.chequesTransito)}`),
        renglon('= Saldo bancario ajustado', dinero(c.saldoAjustado), 'gran'),
        renglon('Saldo según libros', dinero(c.saldoLibros), 'gran'),
        renglon('Diferencia', c.cuadra ? '0.00 ✓ cuadra' : dinero(c.diferencia), c.cuadra ? '' : 'deuda'));
      botonFin.disabled = !c.cuadra;
    }
    async function finalizar() {
      error.textContent = '';
      try {
        await finalizarConciliacion({ banco_id: b.id, fecha_corte: fecha.value, saldo_extracto: extracto.value, marcas: [...marcas], notas: nota.value });
        cerrar(); toast('Conciliación guardada'); await vistaBancos(raiz, opciones);
      } catch (e) { error.textContent = limpiar(e); }
    }
    extracto.addEventListener('input', calcular);
    fecha.addEventListener('change', cargar);
    const cerrar = hoja(`Conciliar · ${b.nombre}`, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, 'Marca lo que YA aparece en tu estado de cuenta del banco. Lo que no marques queda "en tránsito" (cheques o depósitos que el banco aún no refleja). Si no cuadra, falta registrar algo que el banco hizo (comisión, interés, nota de débito o crédito): usa "Registrar movimiento", vuelve y concilia.'),
      h('div', { class: 'rejilla' }, campo('Fecha de corte del estado de cuenta', fecha), campo('Saldo final del estado de cuenta', extracto)),
      lista, panel, campo('Nota', nota), error,
      h('div', { class: 'acciones' },
        h('button', { class: 'btn', onClick: () => { cerrar(); nuevoMov(b); } }, 'Registrar movimiento'),
        botonFin)));
    await cargar();
  }

  function verConciliacion(b, c, ultima) {
    const renglon = (a, v, clase = '') => h('div', { class: clase }, h('span', {}, a), h('span', {}, v));
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(`Conciliación al ${fechaCorta(c.fecha_corte)}`, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' },
        renglon('Saldo según el estado de cuenta', dinero(c.saldo_extracto)),
        renglon('+ Depósitos en tránsito', dinero(c.depositos_transito)),
        renglon('- Cheques y retiros en circulación', `- ${dinero(c.cheques_transito)}`),
        renglon('= Saldo bancario ajustado', dinero(c.saldo_ajustado), 'gran'),
        renglon('Saldo según libros', dinero(c.saldo_libros), 'gran'),
        renglon('Movimientos conciliados', String(c.n_conciliados))),
      c.notas ? h('p', { class: 'ayuda' }, `Nota: ${c.notas}`) : null, error,
      ultima ? h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: async () => {
        if (!(await confirmar('Deshacer conciliación', 'Sus movimientos volverán a quedar pendientes de conciliar.', 'Deshacer'))) return;
        try { await deshacerConciliacion(c.id); cerrar(); toast('Conciliación deshecha'); await vistaBancos(raiz, opciones); } catch (e) { error.textContent = limpiar(e); }
      } }, 'Deshacer')) : null));
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
          cerrar(); toast('Movimiento registrado'); await vistaBancos(raiz, opciones);
        } catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar'))));
  }
}
