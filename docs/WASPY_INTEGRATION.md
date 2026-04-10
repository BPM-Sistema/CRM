# Integración Waspy (WhatsApp) — API Key

> Actualizado: 2026-03-09
> Modelo: API Key + Embed iframe

---

## 1. Arquitectura

```
┌──────────────────────────────────────────────────┐
│ CRM Frontend (React)                             │
├──────────────────────────────┬───────────────────┤
│  <iframe>                    │  OrderPanel (CRM) │
│  Waspy Inbox Embed           │  - Pedidos x tel  │
│  - Conversaciones            │  - Vincular/      │
│  - Chat + Templates          │    desvincular    │
│  - Media                     │  - Ver detalle    │
│  ← postMessage bridge →      │                   │
├──────────────────────────────┴───────────────────┤
│ CRM Backend (Express)                            │
│ - API Key → Waspy (stored in DB)                 │
│ - Embed token via Waspy API                      │
│ - Channel status / connect proxy                 │
│ - Order management (conversation_orders)         │
└──────────────────────────────────────────────────┘
```

El CRM **no** genera JWTs para Waspy. En su lugar:

1. Admin pega un API Key (`wspy_xxx`) generado en Waspy → se guarda en tabla `waspy_config`.
2. Para el iframe: CRM backend pide un JWT corto (15min) a Waspy via `POST /api/v1/integration/embed-token`.
3. Para llamadas API (channel status, etc): CRM backend usa el API Key directamente como Bearer token.

---

## 2. Configuración (waspy_config)

**Tabla `waspy_config`** (migración 030):

| Columna       | Tipo           | Descripción                              |
|---------------|----------------|------------------------------------------|
| `id`          | UUID PK        | Auto-generado                            |
| `api_key`     | TEXT NOT NULL   | API Key `wspy_xxxx` de Waspy             |
| `tenant_id`   | TEXT           | Auto-descubierto al verificar            |
| `tenant_name` | TEXT           | Auto-descubierto al verificar            |
| `waspy_url`   | TEXT NOT NULL   | URL base API Waspy (default `http://localhost:8080`) |
| `embed_url`   | TEXT NOT NULL   | URL del embed (default `http://localhost:3000/embed/inbox`) |
| `verified_at` | TIMESTAMPTZ    | Última verificación exitosa              |
| `created_at`  | TIMESTAMPTZ    | Fecha de creación                        |
| `updated_at`  | TIMESTAMPTZ    | Fecha de actualización                   |

Constraint: singleton index `ON ((true))` — solo puede haber una config activa.

**Flujo de conexión:**

1. Admin va a Configuración > WhatsApp en el CRM
2. En Waspy, va a Configuración > Integraciones y genera un API Key
3. Pega el API Key en el CRM y clickea "Conectar"
4. CRM backend llama `GET /api/v1/integration/tenant-info` con el API Key
5. Si es válido, guarda config en DB con tenant_id/name auto-descubiertos

---

## 3. Backend Endpoints

Archivo: `backend/routes/waspy.js`. Todas las rutas requieren `authenticate`.

| # | Método | Ruta | Permiso | Propósito |
|---|--------|------|---------|-----------|
| 1 | GET | `/waspy/token` | inbox.view/send | Pedir embed token a Waspy |
| 2 | GET | `/waspy/config` | whatsapp.connect/inbox.view | Config actual (sin API key completo) |
| 3 | POST | `/waspy/config` | whatsapp.connect | Guardar y verificar API Key |
| 4 | DELETE | `/waspy/config` | whatsapp.connect | Desconectar Waspy |
| 5 | GET | `/waspy/channel/status` | inbox.view | Estado del canal WhatsApp |
| 6 | POST | `/waspy/channel/connect/start` | whatsapp.connect | Iniciar conexión WA |
| 7 | GET | `/waspy/channel/connect/status` | whatsapp.connect | Estado de conexión WA |
| 8 | GET | `/waspy/orders/by-phone` | inbox.view | Buscar pedidos por teléfono |
| 9 | GET | `/waspy/conversations/:id/orders` | inbox.view | Pedidos vinculados |
| 10 | POST | `/waspy/conversations/:id/orders` | inbox.assign | Vincular pedido |
| 11 | DELETE | `/waspy/conversations/:id/orders/:orderNumber` | inbox.assign | Desvincular pedido |

---

## 4. Bridge postMessage (CRM ↔ Waspy)

### CRM → iframe

| Mensaje | Cuándo | Payload |
|---------|--------|---------|
| `auth` | Iframe listo o token expirado | `{ type: 'auth', token: string }` |
| `navigate` | Abrir conversación por phone o id | `{ type: 'navigate', phone }` o `{ type: 'navigate', conversationId }` |
| `context` | Pasar contexto CRM al embed | `{ type: 'context', orderId, phone?, customerName? }` |

### iframe → CRM

| Mensaje | Cuándo | Payload |
|---------|--------|---------|
| `ready` | Iframe cargado | `{ type: 'ready', source: 'waspy-embed' }` |
| `conversation:selected` | Usuario selecciona conv | `{ type: 'conversation:selected', conversationId, phone? }` |
| `auth:error` | Token rechazado | `{ type: 'auth:error', message }` |
| `token:expired` | Token expiró | `{ type: 'token:expired' }` |
| `navigate:result` | Resultado de navigate | `{ type: 'navigate:result', success, conversationId?, message? }` |

### Seguridad

- El CRM valida `event.origin` contra el origin derivado de `config.embedUrl` (dinámico, desde DB).
- Token se envía via postMessage, **nunca** en la URL del iframe.
- Waspy debe configurar `frame-ancestors` para el dominio del CRM.

---

## 5. Variables de entorno

### Frontend (`financial-crm/.env`)

| Variable | Descripción |
|----------|-------------|
| `VITE_API_URL` | URL del backend CRM (`http://localhost:3001`) |

> `VITE_WASPY_EMBED_URL` ya **no se usa**. La URL del embed viene de la DB via `/waspy/config`.

### Backend (`backend/.env`)

> Las variables `WASPY_*` ya **no se usan**. Todo viene de la tabla `waspy_config`.
> Solo se necesitan las variables estándar del CRM (DB, TiendaNube, etc).

---

## 6. Mapeo de roles CRM → Waspy

| Rol CRM     | Rol Waspy   |
|-------------|-------------|
| `admin`     | `admin`     |
| `operador`  | `agent`     |
| `caja`      | `agent`     |
| `logistica` | `read_only` |
| `readonly`  | `read_only` |
| _(otro)_    | `agent`     |

Se usa al pedir embed token: `POST /integration/embed-token { role: 'agent' }`.

---

## 7. Permisos

### Activos

| Permiso | Uso |
|---------|-----|
| `inbox.view` | Ver inbox (embed) + channel status |
| `inbox.assign` | Vincular/desvincular pedidos |
| `whatsapp.connect` | Configurar conexión Waspy + WhatsApp |

### Deprecados (existen en DB, sin uso en frontend)

| Permiso | Razón |
|---------|-------|
| `inbox.send` | Waspy controla envío via su rol |
| `templates.view` | Waspy maneja templates internamente |
| `templates.send` | Waspy maneja templates internamente |

---

## 8. Componentes frontend

| Archivo | Estado |
|---------|--------|
| `pages/InboxPage.tsx` | Embed + OrderPanel, embedUrl dinámico desde config |
| `pages/WhatsAppSettings.tsx` | Sección "Conexión Waspy" + channel status + conexión WA |
| `components/inbox/OrderPanel.tsx` | Pedidos por teléfono + vinculados manualmente |
| `services/waspy.ts` | Config CRUD + token + channel + orders |

### Eliminados

`ChatWindow.tsx`, `ConversationList.tsx`, `MessageInput.tsx`, `TemplatePicker.tsx` — reemplazados por el embed.

---

## 9. Migraciones relevantes

| Archivo | Descripción |
|---------|-------------|
| `028_conversation_orders.sql` | Tabla `conversation_orders` |
| `029_waspy_permissions.sql` | Permisos inbox/templates/whatsapp |
| `030_waspy_config.sql` | Tabla `waspy_config` (API Key) |
