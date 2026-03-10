# Auditoría Técnica — Integración CRM × Waspy

> Fecha: 2026-03-08
> Objetivo: Analizar el CRM para integrar Waspy como motor de WhatsApp
> Modo: Solo lectura — sin modificaciones de código

---

## SECCIÓN 1 — ARQUITECTURA DEL PROYECTO

### Stack

| Capa | Tecnología |
|------|-----------|
| Frontend | React 18 + Vite 5 + TypeScript |
| UI | Tailwind CSS 3 (componentes custom, NO shadcn/MUI) |
| Routing | React Router DOM 6 |
| Backend | Express.js (JavaScript puro, no TypeScript) |
| Base de datos | PostgreSQL (Supabase) |
| ORM | Queries SQL directas con `pg` pool |
| Auth | JWT (jsonwebtoken) + bcrypt |

### Estructura de carpetas

```
CRM/
├── backend/                    ← Express API (puerto 3000)
│   ├── index.js                ← Monolito: todas las rutas (~3500 líneas)
│   ├── db.js                   ← Pool de PostgreSQL
│   ├── middleware/
│   │   └── auth.js             ← JWT verify + permisos
│   ├── routes/
│   │   └── auth.js             ← Login, registro, gestión usuarios
│   ├── services/
│   │   ├── orderSync.js        ← Polling Tienda Nube
│   │   └── syncQueue.js        ← Cola de sincronización
│   ├── utils/
│   │   └── orderVerification.js
│   ├── migrations/             ← SQL puro
│   └── scripts/
│
├── financial-crm/              ← Frontend React
│   ├── src/
│   │   ├── App.tsx             ← Rutas + AuthProvider
│   │   ├── pages/              ← 13 páginas
│   │   ├── components/
│   │   │   ├── layout/         ← Layout, Sidebar, Header
│   │   │   ├── ui/             ← Button, Card, Badge, Modal, Table...
│   │   │   ├── dashboard/
│   │   │   ├── orders/
│   │   │   └── receipts/
│   │   ├── contexts/
│   │   │   └── AuthContext.tsx  ← Estado global de auth
│   │   ├── services/
│   │   │   └── api.ts          ← Cliente HTTP (fetch nativo, ~1200 líneas)
│   │   ├── types/
│   │   │   └── index.ts
│   │   └── utils/
│   └── package.json
│
└── my-org/                     ← Config organizacional
```

### Servicios externos

- **Tienda Nube API** — Pedidos, productos, webhooks
- **Supabase** — PostgreSQL hosted
- **No hay Redis, no hay BullMQ, no hay WebSocket**

---

## SECCIÓN 2 — AUTENTICACIÓN ACTUAL

### Flujo de login

```
LoginPage.tsx → POST /auth/login → bcrypt.compare → jwt.sign → token
                                                                  ↓
                                              localStorage['auth_token']
                                              localStorage['auth_user']
```

### Generación del token

**Archivo:** `backend/middleware/auth.js`

```javascript
function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '24h' });
}
```

### Claims del JWT

| Claim | Valor |
|-------|-------|
| `userId` | UUID del usuario |
| `exp` | 24 horas |

**No incluye:** email, role, permissions, tenantId.

### Validación

- Middleware `authenticate` en `backend/middleware/auth.js`
- Extrae token de `Authorization: Bearer <token>`
- Verifica con `jwt.verify(token, JWT_SECRET)`
- Carga usuario + permisos de la DB en cada request
- Adjunta `req.user` con: id, name, email, role_id, is_active, permissions[], permissionsHash

### Detección de cambios de permisos

- El backend envía `X-Permissions-Hash` en cada response
- El frontend compara con el hash almacenado
- Si cambia, refresca permisos via `GET /auth/me`

### Observaciones para Waspy

- El JWT actual solo tiene `userId` — **insuficiente para Waspy**
- No hay `tenantId`, `role`, ni `email` en el token
- Se necesitará un endpoint nuevo que genere un JWT específico para Waspy

---

## SECCIÓN 3 — MODELO DE USUARIOS

### Tabla `users`

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role_id UUID REFERENCES roles(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Tabla `user_permissions`

```sql
CREATE TABLE user_permissions (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, permission_id)
);
```

### Usuario por defecto

- Email: `admin@petlove.com`
- Password: `admin123`
- Role: `admin`

### Observaciones

- **No hay campo `organization_id` ni `tenant_id`**
- Los usuarios no pertenecen a una organización — es single-tenant
- El `role_id` es legacy; los permisos se cargan directamente de `user_permissions`

---

## SECCIÓN 4 — MULTI-TENANCY

### Resultado: **NO ES MULTI-TENANT**

El CRM opera con un solo store de Tienda Nube:

```javascript
const storeId = process.env.TIENDANUBE_STORE_ID;  // Ej: 4735703
const token = process.env.TIENDANUBE_ACCESS_TOKEN;
```

- **No hay** `tenant_id`, `organization_id`, `store_id` en ninguna tabla
- Todas las queries operan sobre tablas globales sin filtro de tenant
- Un solo `TIENDANUBE_STORE_ID` en las variables de entorno

### Implicancia para Waspy

Waspy es multi-tenant. Se necesita decidir:

| Opción | Descripción |
|--------|-------------|
| **A. Tenant fijo** | Crear un solo tenant en Waspy con el `TIENDANUBE_STORE_ID` como identificador |
| **B. Hardcodear** | Usar un `tenantId` fijo en la config del CRM |

**Recomendación:** Opción A — crear un tenant en Waspy con `slug = TIENDANUBE_STORE_ID` y usar ese ID en todos los requests.

---

## SECCIÓN 5 — MODELO DE PEDIDOS

### Tabla `orders_validated`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `order_number` | VARCHAR(100) | **PK** — Identificador único |
| `tn_order_id` | BIGINT | ID de Tienda Nube |
| `customer_name` | VARCHAR(255) | Nombre del cliente |
| `customer_email` | VARCHAR(255) | Email del cliente |
| `customer_phone` | VARCHAR(50) | Teléfono del cliente |
| `monto_tiendanube` | DECIMAL | Monto total |
| `total_pagado` | DECIMAL | Total pagado |
| `saldo` | DECIMAL | Saldo pendiente |
| `estado_pago` | VARCHAR(20) | pendiente, parcial, total, confirmado_total... |
| `estado_pedido` | VARCHAR(20) | pendiente_pago, a_imprimir, armado, enviado... |
| `shipping_type` | TEXT | Método de envío |
| `shipping_tracking` | TEXT | Número de tracking |
| `shipping_address` | JSONB | Dirección completa |
| `note` | TEXT | Nota del cliente |
| `owner_note` | TEXT | Nota interna |
| `tn_created_at` | TIMESTAMP | Fecha original en TN |

### Tabla `order_products`

| Campo | Tipo |
|-------|------|
| `order_number` | FK → orders_validated |
| `product_id` | BIGINT |
| `variant_id` | TEXT |
| `name` | TEXT |
| `quantity` | INTEGER |
| `price` | DECIMAL(12,2) |
| `sku` | TEXT |

### Identificación de pedidos

- **PK:** `order_number` (ej: "123456")
- **Secundario:** `tn_order_id` (ID numérico de Tienda Nube)
- **Para Waspy:** usar `order_number` como `external_order_id`

---

## SECCIÓN 6 — MODELO DE CLIENTES

### Resultado: **NO HAY TABLA DE CLIENTES**

Los datos del cliente están **embebidos en `orders_validated`**:
- `customer_name`
- `customer_email`
- `customer_phone`

### Extracción del teléfono (desde webhook de TN)

```javascript
const customerPhone =
  pedido.contact_phone ||
  pedido.customer?.phone ||
  pedido.shipping_address?.phone ||
  pedido.customer?.default_address?.phone ||
  null;
```

### Formato de teléfono

- **Almacenado:** Tal cual viene de Tienda Nube (generalmente E.164: `+5491155551234`)
- **Sin normalización:** No hay librería de validación (libphonenumber)
- **Sin limpieza:** Se guarda como string crudo
- **Para búsqueda:** Se usa `ILIKE` (substring case-insensitive)

### Implicancia para Waspy

- Waspy normaliza teléfonos argentinos (`+549XXXXXXXXXX` → `+54XXXXXXXXXX`)
- El CRM guarda el formato original de TN
- **Riesgo:** Mismatch entre el teléfono en el CRM y el `waId` de Waspy
- **Solución:** Normalizar al buscar — comparar últimos 10 dígitos o usar la misma función de normalización de Waspy

---

## SECCIÓN 7 — SISTEMA DE UI

### Framework UI

- **Tailwind CSS 3** — Utility-first
- **Componentes custom** en `components/ui/`: Button, Card, Badge, Modal, Table, Input, Select, Tabs
- **Iconos:** Lucide React
- **Charts:** Recharts

### Layout principal

```
┌─────────────────────────────────────────────┐
│ ┌──────────┐ ┌────────────────────────────┐ │
│ │          │ │ Header (sticky, blur)      │ │
│ │ Sidebar  │ ├────────────────────────────┤ │
│ │ (64px)   │ │                            │ │
│ │          │ │ Content (page)             │ │
│ │ - Dashboard  │                          │ │
│ │ - Pedidos    │                          │ │
│ │ - Comprobantes│                         │ │
│ │ - Admin ▼    │                          │ │
│ │   - Usuarios │                          │ │
│ │   - Financ.  │                          │ │
│ │   - Actividad│                          │ │
│ │   - Sync     │                          │ │
│ │          │ │                            │ │
│ └──────────┘ └────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### Dónde agregar el Inbox

1. **Sidebar:** Agregar item "WhatsApp" o "Inbox" con icono `MessageSquare` de Lucide
2. **Ruta:** `/inbox` en `App.tsx`
3. **Página:** `src/pages/InboxPage.tsx`
4. **Componentes:** `src/components/inbox/` (ConversationList, ChatWindow, OrderPanel)
5. **Permiso:** `inbox.view` (nuevo)

---

## SECCIÓN 8 — SISTEMA DE API

### Cliente HTTP

**Archivo:** `financial-crm/src/services/api.ts` (~1200 líneas)

- **Usa `fetch` nativo** (no Axios, no tRPC)
- Wrapper `authFetch()` que inyecta `Authorization: Bearer <token>`
- Base URL: `VITE_API_URL` (default: `http://localhost:3000`)
- Maneja 401 automáticamente (redirect a login)

### Patrón de consumo

```typescript
export async function fetchOrders(params): Promise<PaginatedResponse<Order>> {
  const response = await authFetch(`/orders?${queryString}`);
  if (!response.ok) throw new Error('...');
  return response.json();
}
```

### Para Waspy

Se necesitará un segundo cliente API:

```typescript
// services/waspy.ts
const WASPY_URL = import.meta.env.VITE_WASPY_URL; // ej: http://localhost:3001

export async function waspyFetch(path: string, options?: RequestInit) {
  const waspyToken = await getWaspyToken(); // JWT generado por el CRM
  return fetch(`${WASPY_URL}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${waspyToken}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}
```

---

## SECCIÓN 9 — SISTEMA DE PERMISOS

### Roles existentes

| Rol CRM | Descripción | → Rol Waspy |
|---------|-------------|-------------|
| `admin` | Todos los permisos | `admin` |
| `operador` | Dashboard, pedidos, comprobantes | `agent` |
| `caja` | Dashboard, comprobantes, pagos | `agent` (limitado) |
| `logistica` | Dashboard, pedidos (print/update) | `read_only` |
| `readonly` | Solo lectura | `read_only` |

### Permisos actuales (módulos)

- `dashboard.view`
- `orders.*` (view, print, update_status, create_cash_payment)
- `receipts.*` (view, download, upload_manual, confirm, reject)
- `users.*` (view, create, edit, disable, assign_role)
- `activity.view`

### Permisos nuevos necesarios

- `inbox.view` — Ver inbox de WhatsApp
- `inbox.send` — Enviar mensajes
- `inbox.assign` — Asignar conversaciones
- `templates.view` — Ver templates
- `templates.create` — Crear templates
- `campaigns.view` — Ver campañas
- `campaigns.create` — Crear campañas

---

## SECCIÓN 10 — GENERACIÓN DE JWT PARA WASPY

### Estado actual

El JWT del CRM solo contiene `{ userId }`. Waspy necesita más información.

### JWT requerido por Waspy

```json
{
  "sub": "uuid-del-usuario",
  "tenantId": "uuid-del-tenant-en-waspy",
  "role": "admin|agent|read_only",
  "email": "user@example.com",
  "name": "Nombre del Usuario",
  "iss": "crm",
  "aud": "waspy"
}
```

### Dónde implementar

**Opción recomendada:** Nuevo endpoint en `backend/routes/auth.js`

```
GET /auth/waspy-token
  → authenticate middleware
  → genera JWT firmado con WASPY_JWT_SECRET
  → incluye tenantId, role mapeado, email, name
  → retorna { token: "..." }
```

### Shared secret

- El CRM firma con `WASPY_JWT_SECRET`
- Waspy verifica con el mismo secret
- Alternativa: usar par de claves RSA (más seguro pero más complejo)

### Utilidades JWT existentes

- `backend/middleware/auth.js` ya usa `jsonwebtoken`
- Se puede reutilizar la misma librería con un secret diferente

---

## SECCIÓN 11 — PUNTOS DE INTEGRACIÓN CON WASPY

### 1. Cliente API Waspy (Frontend)

```
Crear: financial-crm/src/services/waspy.ts
Función: waspyFetch() con JWT de Waspy
Endpoints a consumir:
  - GET  /api/v1/conversations
  - GET  /api/v1/conversations/:id/messages
  - POST /api/v1/messages/send
  - GET  /api/v1/contacts
  - GET  /api/v1/templates
```

### 2. Sección Inbox (Frontend)

```
Crear: financial-crm/src/pages/InboxPage.tsx
Crear: financial-crm/src/components/inbox/
  - ConversationList.tsx   ← Lista de chats
  - ChatWindow.tsx         ← Ventana de mensajes
  - MessageInput.tsx       ← Input de mensaje + adjuntos
  - OrderPanel.tsx         ← Panel lateral: pedidos del cliente
  - TemplatePicker.tsx     ← Selector de templates
Modificar: App.tsx          ← Agregar ruta /inbox
Modificar: Sidebar.tsx      ← Agregar item de navegación
```

### 3. Botón "Conectar WhatsApp" (Settings)

```
Crear: financial-crm/src/pages/WhatsAppSettings.tsx
  - Configurar phoneNumberId
  - Configurar accessToken
  - Verificar webhook
Modificar: Sidebar.tsx → Agregar en sección Admin
```

### 4. Envío de mensajes desde pedidos

```
Modificar: financial-crm/src/pages/RealOrderDetail.tsx
  - Agregar botón "Enviar WhatsApp" junto al teléfono del cliente
  - Abre modal con input de mensaje o template picker
  - Envía via waspyFetch POST /api/v1/messages/send
```

### 5. Asociación conversación ↔ pedido

```
El vínculo es por teléfono:
  orders_validated.customer_phone ↔ Waspy contacts.phoneNumber

Flujo:
  1. Usuario abre conversación en inbox
  2. Frontend obtiene el phoneNumber del contacto de Waspy
  3. Busca en CRM: GET /orders?search={phone}
  4. Muestra pedidos en el panel lateral
  5. No se necesita tabla nueva — el match es por teléfono
```

### 6. Endpoint proxy (Backend)

```
Crear: backend/routes/waspy.js
  - GET  /waspy/token        ← Genera JWT para Waspy
  - GET  /waspy/orders/:phone ← Busca pedidos por teléfono
  - Proxy opcional para evitar CORS
```

---

## SECCIÓN 12 — RIESGOS TÉCNICOS

### 🔴 Críticos

| Riesgo | Detalle | Mitigación |
|--------|---------|------------|
| **Teléfonos inconsistentes** | CRM guarda `+5491155551234`, Waspy normaliza a `+541155551234` | Usar función de normalización compartida al buscar pedidos por teléfono |
| **No hay tabla de clientes** | Los datos están embebidos en orders — un cliente con 5 pedidos tiene 5 registros con su teléfono | Buscar con `DISTINCT customer_phone` o crear vista |

### 🟡 Moderados

| Riesgo | Detalle | Mitigación |
|--------|---------|------------|
| **JWT incompatible** | El JWT del CRM no tiene los claims que Waspy necesita | Crear endpoint dedicado `/auth/waspy-token` |
| **Sin WebSocket en CRM** | El CRM no tiene WS — el inbox necesita actualizaciones en tiempo real | Conectar directamente al WS de Waspy desde el frontend |
| **Sin Redis** | El CRM no usa Redis — Waspy lo requiere para BullMQ | Waspy corre como servicio separado con su propio Redis |
| **Backend monolítico** | `index.js` tiene ~3500 líneas — agregar más rutas lo complica | Crear `routes/waspy.js` separado |

### 🟢 Bajos

| Riesgo | Detalle | Mitigación |
|--------|---------|------------|
| **CORS** | El frontend del CRM debe poder llamar a Waspy | Configurar CORS en Waspy o usar proxy en el backend del CRM |
| **Auth doble** | El usuario tiene token del CRM y token de Waspy | El token de Waspy se genera automáticamente — transparente para el usuario |

---

## SECCIÓN 13 — PLAN DE IMPLEMENTACIÓN

### Fase 1 — Infraestructura (Backend CRM)

| Acción | Archivo |
|--------|---------|
| Crear endpoint `/auth/waspy-token` | `backend/routes/auth.js` |
| Crear rutas proxy Waspy | `backend/routes/waspy.js` (nuevo) |
| Registrar rutas en app | `backend/index.js` |
| Agregar env vars | `.env` → `WASPY_URL`, `WASPY_JWT_SECRET`, `WASPY_TENANT_ID` |
| Migración: permisos inbox | `backend/migrations/0XX_inbox_permissions.sql` |

### Fase 2 — Cliente API (Frontend CRM)

| Acción | Archivo |
|--------|---------|
| Crear cliente Waspy | `financial-crm/src/services/waspy.ts` (nuevo) |
| Agregar tipos WhatsApp | `financial-crm/src/types/whatsapp.ts` (nuevo) |
| Agregar env var | `.env` → `VITE_WASPY_URL` |

### Fase 3 — Inbox UI (Frontend CRM)

| Acción | Archivo |
|--------|---------|
| Página inbox | `src/pages/InboxPage.tsx` (nuevo) |
| Lista de conversaciones | `src/components/inbox/ConversationList.tsx` (nuevo) |
| Ventana de chat | `src/components/inbox/ChatWindow.tsx` (nuevo) |
| Input de mensaje | `src/components/inbox/MessageInput.tsx` (nuevo) |
| Panel de pedidos | `src/components/inbox/OrderPanel.tsx` (nuevo) |
| Selector de templates | `src/components/inbox/TemplatePicker.tsx` (nuevo) |
| Agregar ruta | `src/App.tsx` (modificar) |
| Agregar nav item | `src/components/layout/Sidebar.tsx` (modificar) |

### Fase 4 — Integración con pedidos

| Acción | Archivo |
|--------|---------|
| Endpoint buscar pedidos por teléfono | `backend/routes/waspy.js` |
| Botón WhatsApp en detalle de pedido | `src/pages/RealOrderDetail.tsx` (modificar) |
| Normalización de teléfonos | `backend/utils/phoneNormalize.js` (nuevo) |

### Fase 5 — Configuración WhatsApp

| Acción | Archivo |
|--------|---------|
| Página de configuración | `src/pages/WhatsAppSettings.tsx` (nuevo) |
| Agregar en sidebar admin | `src/components/layout/Sidebar.tsx` (modificar) |

---

## RESUMEN EJECUTIVO

| Aspecto | Estado actual | Acción requerida |
|---------|--------------|------------------|
| **Arquitectura** | Express + React, single-tenant | Compatible — Waspy corre como microservicio |
| **Auth** | JWT con solo `userId` | Crear endpoint que genere JWT con claims para Waspy |
| **Usuarios** | UUID + permisos directos | Mapear roles CRM → roles Waspy |
| **Multi-tenant** | No existe | Usar tenant fijo en Waspy |
| **Pedidos** | `orders_validated` con `customer_phone` | Match por teléfono normalizado |
| **Clientes** | Embebidos en pedidos (no hay tabla) | Buscar con `DISTINCT customer_phone` |
| **Teléfonos** | E.164 sin normalización | Agregar normalización argentina |
| **UI** | Tailwind custom, sidebar, layout estándar | Agregar página inbox + componentes |
| **API client** | Fetch nativo con `authFetch()` | Crear `waspyFetch()` paralelo |
| **Permisos** | 5 roles, permisos por módulo | Agregar módulo `inbox.*` |
| **WebSocket** | No existe | Conectar directo al WS de Waspy |
| **Redis** | No existe | Lo provee Waspy como servicio separado |
