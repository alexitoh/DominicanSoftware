# Servidor de Car Audio

Servidor sin dependencias externas (solo Node.js 22.13 o más nuevo). Hace dos cosas:

1. **Cuentas**: negocios, administrador y empleados (usuario o correo + contraseña, con hash scrypt).
2. **Sincronización**: guarda el estado de cada negocio y reparte los cambios entre sus dispositivos.
   Cada negocio solo ve sus propios datos. Si hay una carpeta `dist` (la web compilada), también la sirve.

## Variables

| Variable | Para qué | Por defecto |
|---|---|---|
| `PORT` | Puerto | 3000 |
| `DATA_DIR` | Carpeta de la base de datos (¡debe ser un disco persistente!) | `server/datos` |
| `JWT_SECRET` | Clave para firmar las sesiones | se crea sola en `DATA_DIR/secreto.txt` |
| `ALLOWED_ORIGINS` | Dirección permitida para la API desde otras páginas (CORS) | `*` |
| `STATIC_DIR` | Carpeta de la web compilada | `../dist` |

## Arrancar

```
npm run build     # (en la carpeta del proyecto) crea dist con la web
npm run servidor  # arranca en http://localhost:3000
```

## API (resumen)

`POST /api/registro`, `/api/login`, `/api/recuperar`, `/api/clave`, `/api/clave-temporal`,
`GET /api/yo`, `GET|POST /api/miembros`, `PATCH /api/miembros/:uid`, `POST /api/miembros/:uid/clave`,
`POST /api/sync`, `GET /api/salud`.

## Suspender un negocio (cuando vendas el sistema)

Cada negocio tiene `activo`, `plan` y `vence` en la tabla `negocios`. Con `activo = 0` sus usuarios reciben
"servicio suspendido" y no pueden sincronizar (siguen viendo sus datos locales). Ejemplo:

```
sqlite3 /data/caraudio.db "UPDATE negocios SET activo = 0 WHERE nombre = 'Cliente moroso'"
```

## Respaldo

Todo está en `DATA_DIR/caraudio.db`. Copia ese archivo (junto con `caraudio.db-wal` si existe) o usa
`sqlite3 caraudio.db ".backup respaldo.db"` para una copia consistente. En Railway activa los respaldos del volumen.
