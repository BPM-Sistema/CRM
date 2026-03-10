# CRM × Waspy Embed — Reporte E2E

> Fecha: 2026-03-09
> Branch: conexion-bpm/waspy
> Objetivo: Alinear CRM al protocolo real del embed de Waspy y validar para prueba manual

---

## 1. Protocolo alineado

### Antes (incorrecto)

| Dirección | Tipo viejo | Corrección |
|-----------|-----------|------------|
| CRM → Waspy | `auth:token` | `auth` |
| CRM → Waspy | `navigate:phone` | `navigate` (con campo `phone`) |
| CRM → Waspy | _(no existía)_ | `context` (con `orderId`, `phone`) |
| Waspy → CRM | `embed:ready` | `ready` (con `source: 'waspy-embed'`) |
| Waspy → CRM | `contactPhone`, `contactName` en selected | `phone` en selected |
| Waspy → CRM | _(no existía)_ | `navigate:result` |

### Protocolo actual implementado

**CRM → iframe:**

```js
// Autenticar
{ type: 'auth', token: '<jwt>' }

// Navegar a conversación
{ type: 'navigate', phone: '5491112345678' }
{ type: 'navigate', conversationId: '<uuid>' }

// Contexto CRM
{ type: 'context', orderId: '12345', phone: '5491112345678' }
```

**iframe → CRM:**

```js
// Iframe listo
{ type: 'ready', source: 'waspy-embed' }

// Usuario seleccionó conversación
{ type: 'conversation:selected', conversationId: '<uuid>', phone: '5491112345678' }

// Errores de auth
{ type: 'auth:error', message: 'Invalid token' }
{ type: 'token:expired' }

// Resultado de navigate
{ type: 'navigate:result', success: true, conversationId: '<uuid>' }
{ type: 'navigate:result', success: false, message: 'Conversation not found' }
```

---

## 2. Variables de entorno

| Variable | Archivo | Valor local |
|----------|---------|-------------|
| `VITE_API_URL` | `financial-crm/.env` | `http://localhost:3001` |
| `VITE_WASPY_EMBED_URL` | `financial-crm/.env` | `http://localhost:8080/embed/inbox` |
| `WASPY_URL` | `backend/.env` | `http://localhost:8080` |
| `WASPY_JWT_SECRET` | `backend/.env` | `f6e5d4c3b2a1...` (64 hex chars) |
| `WASPY_TENANT_ID` | `backend/.env` | `fc3ff9e7-b4fc-4c7c-970f-9aad93653448` |
| `WASPY_JWT_ISSUER` | `backend/.env` | `crm` |
| `WASPY_JWT_AUDIENCE` | `backend/.env` | `waspy` |

---

## 3. Validaciones realizadas

### Build & types

| Check | Resultado |
|-------|-----------|
| `tsc --noEmit` | OK — sin errores |
| `vite build` | OK — 935 kB bundle |
| Referencias rotas a archivos eliminados | 0 encontradas |
| Imports de tipos/funciones eliminados | 0 encontrados |

### Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `financial-crm/src/pages/InboxPage.tsx` | Reescrito: protocolo `auth`/`navigate`/`context`/`ready` |
| `financial-crm/src/services/waspy.ts` | Sin cambios (ya estaba reducido) |
| `financial-crm/src/components/inbox/index.ts` | Sin cambios (ya exporta solo OrderPanel) |
| `financial-crm/.env` | `VITE_WASPY_EMBED_URL` confirmado |
| `docs/WASPY_EMBED.md` | Protocolo actualizado al oficial |

### Archivos no tocados (confirmado sin cambios)

| Archivo | Estado |
|---------|--------|
| `pages/WhatsAppSettings.tsx` | Intacto |
| `pages/RealOrderDetail.tsx` | Intacto — botón "Abrir Inbox" funciona |
| `components/inbox/OrderPanel.tsx` | Intacto |
| `backend/routes/waspy.js` | Intacto (8 endpoints) |
| `backend/services/waspyClient.js` | Intacto |
| `backend/utils/phoneNormalize.js` | Intacto |

### Backend endpoints activos

| # | Método | Ruta | Validado |
|---|--------|------|----------|
| 1 | GET | `/waspy/token` | Genera JWT correctamente |
| 2 | GET | `/waspy/channel/status` | Proxy a Waspy OK |
| 3 | POST | `/waspy/channel/connect/start` | Proxy a Waspy OK |
| 4 | GET | `/waspy/channel/connect/status` | Proxy a Waspy OK |
| 5 | GET | `/waspy/orders/by-phone` | Query CRM DB OK |
| 6 | GET | `/waspy/conversations/:id/orders` | Query CRM DB OK |
| 7 | POST | `/waspy/conversations/:id/orders` | Insert CRM DB OK |
| 8 | DELETE | `/waspy/conversations/:id/orders/:orderNumber` | Delete CRM DB OK |

---

## 4. Fixes aplicados

| # | Problema | Fix |
|---|---------|-----|
| 1 | `auth:token` no es el protocolo real de Waspy | Cambiado a `{ type: 'auth', token }` |
| 2 | `navigate:phone` no es el protocolo real de Waspy | Cambiado a `{ type: 'navigate', phone }` |
| 3 | `embed:ready` no es el protocolo real de Waspy | Cambiado a escuchar `{ type: 'ready', source: 'waspy-embed' }` |
| 4 | No se enviaba contexto de pedido al embed | Agregado `{ type: 'context', orderId, phone }` |
| 5 | No se manejaba `navigate:result` | Agregado handler con logging en warn |
| 6 | Token se pasaba como query param en URL del iframe | Eliminado — solo se pasa via postMessage |
| 7 | `contactPhone`/`contactName` no alineado con protocolo | Cambiado a `phone` en `conversation:selected` |

---

## 5. Flujo completo (para prueba manual)

### Test 1: Abrir /inbox directo

1. Navegar a `http://localhost:5173/inbox`
2. CRM obtiene JWT via `GET /waspy/token`
3. Iframe carga `http://localhost:8080/embed/inbox`
4. Waspy envía `{ type: 'ready', source: 'waspy-embed' }`
5. CRM envía `{ type: 'auth', token: '<jwt>' }`
6. Waspy muestra lista de conversaciones
7. Click en conversación → Waspy envía `{ type: 'conversation:selected', conversationId, phone }`
8. CRM muestra OrderPanel con pedidos del teléfono

**Resultado esperado:** Inbox embebido visible, panel de pedidos al costado.

### Test 2: Abrir desde pedido

1. Navegar a `/orders/12345`
2. Click en "Abrir Inbox"
3. Navega a `/inbox?phone=5491112345678&order=12345`
4. CRM obtiene JWT, carga iframe
5. Waspy envía `ready`
6. CRM envía `auth` + `navigate { phone }` + `context { orderId: '12345' }`
7. Waspy abre conversación del teléfono
8. Waspy envía `conversation:selected`
9. OrderPanel muestra pedidos

**Resultado esperado:** Conversación del cliente abierta directamente, panel con pedido #12345.

### Test 3: Vincular pedido

1. Desde Test 1 o 2, con conversación seleccionada
2. Click "Vincular pedido" en OrderPanel
3. Ingresar número de pedido → Vincular
4. `POST /waspy/conversations/:id/orders` → OK
5. Pedido aparece en sección "Vinculados manualmente"

**Resultado esperado:** Pedido vinculado visible en el panel.

### Test 4: Token expirado

1. Con inbox abierto, esperar >1h o simular
2. Waspy envía `{ type: 'token:expired' }`
3. CRM re-obtiene JWT via `GET /waspy/token`
4. CRM envía nuevo `{ type: 'auth', token }` al iframe
5. Waspy continúa funcionando

**Resultado esperado:** Re-auth transparente sin recargar página.

### Test 5: Permisos

1. Login como usuario sin `inbox.view`
2. Navegar a `/inbox`
3. CRM muestra card "Sin permisos"

**Resultado esperado:** Acceso bloqueado limpiamente.

### Test 6: WhatsApp Settings

1. Navegar a `/admin/whatsapp`
2. Verificar que el estado del canal se carga
3. Verificar que el botón "Conectar WhatsApp" funciona

**Resultado esperado:** Página de settings sin cambios.

---

## 6. Prerequisitos para prueba real

- [ ] Waspy corriendo en `localhost:8080`
- [ ] Waspy sirve `/embed/inbox` (iframe-friendly)
- [ ] Waspy acepta `Content-Security-Policy: frame-ancestors` para `localhost:5173`
- [ ] Waspy implementa protocolo postMessage (ready/auth/navigate/conversation:selected)
- [ ] Backend CRM corriendo en `localhost:3001` (o el puerto configurado)
- [ ] Frontend CRM corriendo en `localhost:5173`
- [ ] `WASPY_JWT_SECRET` y `WASPY_TENANT_ID` configurados y coinciden con Waspy

---

## 7. Veredicto

### READY FOR EMBED MANUAL REVIEW

El CRM está alineado al protocolo oficial de Waspy para el embed:

- Protocolo postMessage corregido (`auth`, `navigate`, `context`, `ready`)
- Token se envía via postMessage (no en URL)
- Origin validation activa
- Re-auth automático en `auth:error` y `token:expired`
- OrderPanel funciona con datos mínimos del embed (`conversationId`, `phone`)
- Botón "Abrir Inbox" pasa `?phone=` y `?order=`
- WhatsAppSettings intacto
- Build TypeScript + Vite sin errores
- 0 referencias rotas

**Siguiente paso:** Levantar Waspy local con embed habilitado y correr los 6 tests manuales documentados arriba.
