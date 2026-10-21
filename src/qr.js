// qr.js - generador de código QR (modo byte, corrección de errores L o M, versiones 1 a 40), sin dependencias.
// qrMatriz(texto) → matriz de booleanos (true = módulo oscuro). qrSvg(texto) → cadena SVG lista para insertar en la factura.

const ECC_POR_BLOQUE = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const BLOQUES = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};
const FORMATO_BITS = { L: 1, M: 0 };

// Módulos de datos (sin patrones de función) de una versión
function modulosDeDatos(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const n = Math.floor(v / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (v >= 7) r -= 36;
  }
  return r;
}
const palabrasDeDatos = (v, ecc) => Math.floor(modulosDeDatos(v) / 8) - ECC_POR_BLOQUE[ecc][v] * BLOQUES[ecc][v];

// ---------- Reed-Solomon sobre GF(256) ----------
function multiplicarGF(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function divisorRS(grado) {
  const r = new Array(grado).fill(0); r[grado - 1] = 1;
  let raiz = 1;
  for (let i = 0; i < grado; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = multiplicarGF(r[j], raiz); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    raiz = multiplicarGF(raiz, 2);
  }
  return r;
}
function restoRS(datos, divisor) {
  const r = divisor.map(() => 0);
  for (const b of datos) {
    const f = b ^ r.shift(); r.push(0);
    divisor.forEach((c, i) => { r[i] ^= multiplicarGF(c, f); });
  }
  return r;
}

// ---------- Codificación ----------
function bytesUtf8(texto) { return [...new TextEncoder().encode(texto)]; }

function palabrasCodigo(bytes, v, ecc) {
  const bits = [];
  const poner = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  poner(0b0100, 4); poner(bytes.length, v < 10 ? 8 : 16);
  bytes.forEach((b) => poner(b, 8));
  const capacidad = palabrasDeDatos(v, ecc) * 8;
  poner(0, Math.min(4, capacidad - bits.length));
  poner(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacidad; pad ^= 0xec ^ 0x11) poner(pad, 8);
  const datos = [];
  for (let i = 0; i < bits.length; i += 8) datos.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  // Bloques con su corrección de errores, entrelazados
  const nBloques = BLOQUES[ecc][v]; const eccLen = ECC_POR_BLOQUE[ecc][v];
  const total = Math.floor(modulosDeDatos(v) / 8);
  const cortos = nBloques - (total % nBloques); const largoCorto = Math.floor(total / nBloques);
  const div = divisorRS(eccLen);
  const bloques = []; let k = 0;
  for (let i = 0; i < nBloques; i++) {
    const n = largoCorto - eccLen + (i < cortos ? 0 : 1);
    const d = datos.slice(k, k + n); k += n;
    const e = restoRS(d, div);
    if (i < cortos) d.push(0); // relleno para alinear; se omite al entrelazar
    bloques.push({ d, e, sinRelleno: i < cortos });
  }
  const out = [];
  for (let i = 0; i < bloques[bloques.length - 1].d.length; i++) {
    bloques.forEach((b, j) => { if (!(i === largoCorto - eccLen && j < cortos)) out.push(b.d[i]); });
  }
  for (let i = 0; i < eccLen; i++) bloques.forEach((b) => out.push(b.e[i]));
  return out;
}

// ---------- Matriz ----------
function crearMatriz(v) {
  const n = v * 4 + 17;
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fn = Array.from({ length: n }, () => new Array(n).fill(false)); // módulos de función (no llevan datos)
  const poner = (x, y, oscuro) => { m[y][x] = oscuro; fn[y][x] = true; };
  // Patrones de sincronía
  for (let i = 0; i < n; i++) { poner(6, i, i % 2 === 0); poner(i, 6, i % 2 === 0); }
  // Buscadores
  const buscador = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)); const x = cx + dx; const y = cy + dy;
      if (x >= 0 && x < n && y >= 0 && y < n) poner(x, y, d !== 2 && d !== 4);
    }
  };
  buscador(3, 3); buscador(n - 4, 3); buscador(3, n - 4);
  // Alineación
  const pos = [];
  if (v > 1) {
    const cuenta = Math.floor(v / 7) + 2;
    const paso = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (cuenta * 2 - 2)) * 2;
    pos.push(6);
    for (let p = n - 7; pos.length < cuenta; p -= paso) pos.splice(1, 0, p);
  }
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) poner(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Reserva de formato y versión
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) fn[8][i] = true; if (!fn[i][8]) fn[i][8] = true; }
  for (let i = 0; i < 8; i++) { fn[8][n - 1 - i] = true; fn[n - 1 - i][8] = true; }
  poner(8, n - 8, true);
  if (v >= 7) {
    let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (v << 12) | r;
    for (let i = 0; i < 18; i++) {
      const b = ((bits >>> i) & 1) === 1; const a = n - 11 + (i % 3); const c = Math.floor(i / 3);
      poner(a, c, b); poner(c, a, b);
    }
  }
  return { n, m, fn };
}

function colocarDatos({ n, m, fn }, palabras) {
  let i = 0;
  for (let derecha = n - 1; derecha >= 1; derecha -= 2) {
    if (derecha === 6) derecha = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = derecha - j; const arriba = ((derecha + 1) & 2) === 0; const y = arriba ? n - 1 - vert : vert;
        if (!fn[y][x] && i < palabras.length * 8) { m[y][x] = ((palabras[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
  }
}

const MASCARAS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function formato({ n, m }, ecc, mascara) {
  const datos = (FORMATO_BITS[ecc] << 3) | mascara;
  let r = datos; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
  const bits = ((datos << 10) | r) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) m[8][n - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) m[n - 15 + i][8] = bit(i);
  m[n - 8][8] = true;
}

function penalizacion({ n, m }) {
  let total = 0;
  const lineas = (get) => {
    for (let a = 0; a < n; a++) {
      let color = false; let corrida = 0; const hist = [0, 0, 0, 0, 0, 0, 0];
      const ajustar = () => { hist.pop(); hist.unshift(corrida); };
      for (let b = 0; b < n; b++) {
        if (get(a, b) === color) { corrida++; if (corrida === 5) total += 3; else if (corrida > 5) total++; } else {
          ajustar(); // se cierra la corrida anterior
          if (!color && corrida > 0) {
            const n1 = hist[1]; const nucleo = n1 > 0 && hist[2] === n1 && hist[3] === n1 * 3 && hist[4] === n1 && hist[5] === n1;
            if (nucleo && hist[0] >= n1 * 4 && hist[6] >= n1) total += 40;
            if (nucleo && hist[6] >= n1 * 4 && hist[0] >= n1) total += 40;
          }
          color = get(a, b); corrida = 1;
        }
      }
    }
  };
  lineas((a, b) => m[a][b]); lineas((a, b) => m[b][a]);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) total += 3;
  const oscuros = m.reduce((s, f) => s + f.filter(Boolean).length, 0);
  total += (Math.ceil(Math.abs(oscuros * 20 - n * n * 10) / (n * n)) - 1) * 10;
  return total;
}

// Texto → matriz de módulos. `ecc`: 'L' (más pequeño) o 'M'.
export function qrMatriz(texto, ecc = 'L') {
  const bytes = bytesUtf8(String(texto));
  let v = 1;
  for (; ; v++) {
    if (v > 40) throw new Error('El texto es demasiado largo para un código QR.');
    const capBits = palabrasDeDatos(v, ecc) * 8;
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= capBits) break;
  }
  const palabras = palabrasCodigo(bytes, v, ecc);
  let mejor = null; let mejorPena = Infinity;
  for (let k = 0; k < 8; k++) {
    const base = crearMatriz(v);
    colocarDatos(base, palabras);
    for (let y = 0; y < base.n; y++) for (let x = 0; x < base.n; x++) if (!base.fn[y][x] && MASCARAS[k](x, y)) base.m[y][x] = !base.m[y][x];
    formato(base, ecc, k);
    const p = penalizacion(base);
    if (p < mejorPena) { mejorPena = p; mejor = base; }
  }
  return mejor.m;
}

// SVG con zona de silencio de 4 módulos
export function qrSvg(texto, { lado = 160, ecc = 'L' } = {}) {
  const m = qrMatriz(texto, ecc); const n = m.length; const q = 4;
  const rutas = [];
  m.forEach((fila, y) => { let x = 0; while (x < n) { if (!fila[x]) { x++; continue; } let w = 0; while (x + w < n && fila[x + w]) w++; rutas.push(`M${x + q},${y + q}h${w}v1h-${w}z`); x += w; } });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" width="${lado}" height="${lado}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${rutas.join('')}" fill="#000"/></svg>`;
}
