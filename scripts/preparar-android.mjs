// Agrega el permiso de cámara al proyecto de Android (para escanear códigos). Es seguro ejecutarlo varias veces.
import fs from 'node:fs';

const ruta = 'android/app/src/main/AndroidManifest.xml';
if (!fs.existsSync(ruta)) {
  console.log('No existe el proyecto de Android todavía (usa npm run android:agregar primero).');
  process.exit(0);
}
let xml = fs.readFileSync(ruta, 'utf8');
const extra = [];
if (!xml.includes('android.permission.CAMERA')) extra.push('    <uses-permission android:name="android.permission.CAMERA" />');
if (!xml.includes('android.hardware.camera')) extra.push('    <uses-feature android:name="android.hardware.camera" android:required="false" />');
if (extra.length) {
  xml = xml.replace(/(\s*)<application/, `\n${extra.join('\n')}\n$1<application`);
  fs.writeFileSync(ruta, xml);
  console.log('Permiso de cámara agregado al AndroidManifest.xml');
} else {
  console.log('El permiso de cámara ya estaba.');
}
