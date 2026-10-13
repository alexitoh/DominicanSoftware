// escaner.js - lector de códigos de barras y QR con la cámara del celular
// Usa BarcodeDetector del navegador si existe; si no, la librería ZXing (se carga solo al usar el escáner).
import { h, toast } from './ui.js';

const FORMATOS = ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'qr_code', 'data_matrix'];

// Abre la cámara a pantalla completa.
// alLeer(codigo): si devuelve true el escáner sigue abierto (modo continuo); si no, se cierra.
// Devuelve una función para cerrarlo.
export function abrirEscaner({ titulo = 'Escanear código', ayuda = 'Apunta la cámara al código', alLeer }) {
  let activo = true;
  let flujo = null;
  let controlesZXing = null;
  let temporizador = null;
  let ultimo = { codigo: '', t: 0 };

  const video = h('video', { class: 'escaner-video', playsinline: '', muted: '', autoplay: '' });
  video.muted = true;
  const estado = h('p', { class: 'escaner-estado', role: 'status' }, 'Iniciando cámara...');
  const manual = h('input', {
    class: 'campo', placeholder: 'O escribe el código aquí', autocomplete: 'off', inputmode: 'text',
    onKeydown: (e) => { if (e.key === 'Enter') enviarManual(); },
  });
  const panel = h('div', { class: 'escaner' },
    h('header', { class: 'escaner-cab' },
      h('strong', {}, titulo),
      h('button', { class: 'btn claro', onClick: () => cerrar() }, 'Cerrar')),
    h('div', { class: 'escaner-visor' }, video, h('div', { class: 'escaner-marco', 'aria-hidden': 'true' })),
    h('p', { class: 'escaner-ayuda' }, ayuda),
    estado,
    h('div', { class: 'escaner-manual' }, manual, h('button', { class: 'btn primario', onClick: () => enviarManual() }, 'Usar')));
  document.body.append(panel);

  function cerrar() {
    if (!activo) return;
    activo = false;
    clearInterval(temporizador);
    try { controlesZXing?.stop(); } catch { /* sin acción */ }
    flujo?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    panel.remove();
  }

  async function recibir(texto) {
    const codigo = String(texto || '').trim();
    if (!activo || !codigo) return;
    const ahora = Date.now();
    if (codigo === ultimo.codigo && ahora - ultimo.t < 2500) return; // evita lecturas repetidas
    ultimo = { codigo, t: ahora };
    try { navigator.vibrate?.(60); } catch { /* sin acción */ }
    estado.textContent = `Leído: ${codigo}`;
    let seguir = false;
    try { seguir = await alLeer(codigo); } catch (e) { toast(e.message || String(e), 'error'); seguir = true; }
    if (!seguir) cerrar();
    else ultimo.t = Date.now();
  }

  function enviarManual() {
    const v = manual.value.trim();
    if (!v) return;
    manual.value = '';
    ultimo = { codigo: '', t: 0 };
    recibir(v);
  }

  const restricciones = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } };

  async function iniciar() {
    if (!navigator.mediaDevices?.getUserMedia) {
      estado.textContent = 'Este navegador no permite usar la cámara aquí (necesita conexión segura). Puedes escribir el código.';
      return;
    }
    try {
      if ('BarcodeDetector' in window) {
        let formatos = FORMATOS;
        try {
          const soportados = await window.BarcodeDetector.getSupportedFormats();
          formatos = FORMATOS.filter((f) => soportados.includes(f));
        } catch { /* usa la lista completa */ }
        const detector = new window.BarcodeDetector({ formats: formatos });
        flujo = await navigator.mediaDevices.getUserMedia(restricciones);
        if (!activo) { flujo.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = flujo;
        await video.play();
        estado.textContent = 'Buscando código...';
        let ocupado = false;
        temporizador = setInterval(async () => {
          if (ocupado || !activo || video.readyState < 2) return;
          ocupado = true;
          try {
            const r = await detector.detect(video);
            if (r.length) await recibir(r[0].rawValue);
          } catch { /* fotograma sin código */ } finally { ocupado = false; }
        }, 180);
      } else {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        const lector = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 150 });
        estado.textContent = 'Buscando código...';
        controlesZXing = await lector.decodeFromConstraints(restricciones, video, (resultado) => {
          if (resultado) recibir(resultado.getText());
        });
        if (!activo) controlesZXing.stop();
      }
    } catch (e) {
      const nombre = e?.name || '';
      estado.textContent = nombre === 'NotAllowedError' || nombre === 'SecurityError'
        ? 'No hay permiso para usar la cámara. Actívalo en los permisos de la app. Puedes escribir el código.'
        : nombre === 'NotFoundError'
          ? 'No se encontró una cámara. Puedes escribir el código.'
          : `No se pudo iniciar la cámara: ${e?.message || e}`;
    }
  }
  iniciar();
  return cerrar;
}

// Escanea un solo código y lo devuelve (o null si se cierra sin leer)
export function escanearUno(opciones = {}) {
  return new Promise((resolver) => {
    let leido = false;
    const cerrar = abrirEscaner({
      ...opciones,
      alLeer: (c) => { leido = true; resolver(c); return false; },
    });
    // Si el usuario cierra sin leer, el panel desaparece; lo detectamos para liberar la promesa
    const vigia = setInterval(() => {
      if (!document.querySelector('.escaner')) { clearInterval(vigia); if (!leido) resolver(null); }
    }, 300);
    void cerrar;
  });
}

// Botón "Escanear" para ponerlo junto a un campo. alLeer sigue las reglas de abrirEscaner.
export function botonEscaner(opciones, etiqueta = 'Escanear') {
  return h('button', {
    class: 'btn escanear', type: 'button', 'aria-label': 'Escanear con la cámara',
    onClick: () => abrirEscaner(opciones),
  }, etiqueta);
}
