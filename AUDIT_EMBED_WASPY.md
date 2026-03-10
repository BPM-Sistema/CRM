# Auditoría: Migrar de Inbox CRM Nativo a Embed de Waspy

> Fecha: 2026-03-09
> Objetivo: Evaluar qué conservar, qué eliminar y cómo integrar un embed/iframe de Waspy
> Modo: Solo lectura — sin modificaciones de código

---

## SECCIÓN 1 — INVENTARIO DEL INBOX CRM ACTUAL

### A. Frontend (~2,400 líneas)

| Archivo | Líneas | Descripción |
|---------|--------|-------------|
| `financial-crm/src/pages/InboxPage.tsx` | 248 | Página principal: layout 3 columnas, polling 15s, channel status, URL params `?phone=` |
| `financial-crm/src/pages/WhatsAppSettings.tsx` | 340 | Admin: conexión WhatsApp, estado del canal, flujo OAuth |
| `financial-crm/src/components/inbox/ConversationList.tsx` | 180 | Lista de conversaciones: búsqueda, avatares, unread badges, preview |
| `financial-crm/src/components/inbox/ChatWindow.tsx` | 347 | Ventana de chat: mensajes (7 tipos), status icons, polling 10s |
| `financial-crm/src/components/inbox/MessageInput.tsx` | 125 | Input de texto: auto-grow, Enter para enviar, botón templates |
| `financial-crm/src/components/inbox/OrderPanel.tsx` | 247 | Panel derecho: pedidos por teléfono + linking manual |
| `financial-crm/src/components/inbox/TemplatePicker.tsx` | 307 | Modal: búsqueda de templates, parámetros, preview, envío |
| `financial-crm/src/components/inbox/index.ts` | 6 | Barrel export |
| `financial-crm/src/services/waspy.ts` | 275 | Cliente API: 13 funciones, tipos TypeScript, authFetch |

**Integración en orden existente:**
- `RealOrderDetail.tsx` (líneas 585-601): Botón "Abrir Inbox" → navega a `/inbox?phone={phone}`

**Navegación:**
- `Sidebar.tsx` (líneas 76-81): Item "Inbox" con icono MessageCircle, permisos `['inbox.view', 'inbox.send']`
- `App.tsx` (línea 45): Ruta `/inbox` → `<InboxPage />`

### B. Backend (~400 líneas)

| Archivo | Líneas | Descripción |
|---------|--------|-------------|
| `backend/routes/waspy.js` | 263 | 15 endpoints (11 proxy a Waspy + 4 CRM para pedidos) |
| `backend/services/waspyClient.js` | 140 | Generación JWT + cliente HTTP para Waspy API |
| `backend/utils/phoneNormalize.js` | 70 | Normalización de teléfonos argentinos → `54XXXXXXXXXX` |

**15 endpoints:**

| # | Método | Ruta | Permiso | Tipo |
|---|--------|------|---------|------|
| 1 | GET | `/waspy/token` | inbox.view/send | Genera JWT para Waspy |
| 2 | GET | `/waspy/me` | inbox.view | Proxy → perfil usuario |
| 3 | GET | `/waspy/channel/status` | inbox.view | Proxy → estado canal |
| 4 | GET | `/waspy/conversations` | inbox.view | Proxy → lista conversaciones |
| 5 | GET | `/waspy/conversations/:id/messages` | inbox.view | Proxy → mensajes |
| 6 | POST | `/waspy/messages` | inbox.send | Proxy → enviar mensaje |
| 7 | GET | `/waspy/templates` | templates.view/send | Proxy → templates |
| 8 | POST | `/waspy/templates/send` | templates.send | Proxy → enviar template |
| 9 | GET | `/waspy/conversations/:id/context` | inbox.view | Proxy → contexto |
| 10 | POST | `/waspy/channel/connect/start` | whatsapp.connect | Proxy → iniciar conexión |
| 11 | GET | `/waspy/channel/connect/status` | whatsapp.connect | Proxy → estado conexión |
| 12 | GET | `/waspy/orders/by-phone` | inbox.view | **CRM** → buscar pedidos por tel |
| 13 | GET | `/waspy/conversations/:id/orders` | inbox.view | **CRM** → pedidos vinculados |
| 14 | POST | `/waspy/conversations/:id/orders` | inbox.assign | **CRM** → vincular pedido |
| 15 | DELETE | `/waspy/conversations/:id/orders/:orderNumber` | inbox.assign | **CRM** → desvincular pedido |

### C. Base de Datos

| Migración | Tabla/Cambio | Descripción |
|-----------|-------------|-------------|
| `028_conversation_orders.sql` | `conversation_orders` | Vinculación manual conversación↔pedido (conversation_id TEXT, order_number TEXT, created_by UUID, unique index) |
| `029_waspy_permissions.sql` | `permissions` + `role_permissions` | 6 permisos nuevos: inbox.view, inbox.send, inbox.assign, templates.view, templates.send, whatsapp.connect |

**Tabla `conversation_orders`:**
```
id              UUID PK
conversation_id TEXT NOT NULL        ← ID de Waspy
order_number    TEXT NOT NULL        ← Referencia a orders_validated
created_by      UUID FK → users(id) ← Quién vinculó
created_at      TIMESTAMPTZ
UNIQUE(conversation_id, order_number)
```

---

## SECCIÓN 2 — QUÉ QUEDÓ MAL O INCOMPLETO

### Diagnóstico honesto

El inbox CRM está **~80% completo** para funcionalidad básica, pero tiene limitaciones estructurales que lo hacen inferior al inbox nativo de Waspy:

#### Faltantes funcionales críticos

| Feature | Estado | Impacto |
|---------|--------|---------|
| **WebSocket / real-time** | ❌ Solo polling (10-15s) | Latencia de hasta 15s en mensajes nuevos |
| **Subida de media** | ❌ No implementado | No se pueden enviar imágenes/documentos/audio |
| **Typing indicators** | ❌ No implementado | No se ve "escribiendo..." |
| **Mark as read** | ❌ No integrado | Los mensajes no se marcan como leídos al verlos |
| **Búsqueda dentro del chat** | ❌ Solo búsqueda de conversaciones | No se puede buscar texto en mensajes |
| **Asignación de conversaciones** | ❌ Prop `canAssign` existe pero sin UI | No se puede asignar a un agente |
| **Emoji picker** | ❌ No implementado | Solo texto plano |
| **Rich text** | ❌ No implementado | Sin negrita, cursiva, links |

#### Por qué el inbox CRM se ve peor que el de Waspy

1. **Polling vs real-time**: Waspy usa WebSocket internamente → mensajes instantáneos. El CRM hace GET cada 10-15s.
2. **Media**: Waspy renderiza y permite enviar imágenes, videos, documentos con preview. El CRM solo muestra links.
3. **UX de chat**: Waspy tiene typing indicators, read receipts live, búsqueda dentro del chat, emoji picker.
4. **Responsive**: El layout de 3 columnas fijas no funciona en móvil.
5. **Features avanzadas**: Waspy soporta reacciones, forwards, notas internas, asignación de agentes.

#### Costo de dejarlo bien

Llevar el inbox CRM al nivel del inbox nativo de Waspy requeriría:
- Implementar WebSocket client (alto esfuerzo)
- Implementar subida de media (medio esfuerzo)
- Implementar typing indicators (medio esfuerzo)
- Implementar mark as read (bajo esfuerzo)
- Implementar búsqueda de mensajes (medio esfuerzo)
- Implementar emoji picker (bajo esfuerzo)
- Implementar asignación de agentes (medio esfuerzo)
- Responsive design (medio esfuerzo)

**Estimación: esfuerzo alto, con resultado siempre inferior al inbox nativo de Waspy que ya existe y se mantiene solo.**

---

## SECCIÓN 3 — QUÉ CONVIENE CONSERVAR

| Componente | Veredicto | Justificación |
|------------|-----------|---------------|
| `backend/routes/waspy.js` (endpoints 12-15) | **CONSERVAR** | Búsqueda de pedidos por teléfono y vinculación conversation↔order son features CRM-specific que Waspy no tiene |
| `backend/services/waspyClient.js` | **CONSERVAR** | Generación de JWT y cliente HTTP necesarios para autenticar con Waspy (incluso para el embed) |
| `backend/utils/phoneNormalize.js` | **CONSERVAR** | Normalización de teléfonos argentinos, útil para cualquier integración |
| `backend/migrations/028_conversation_orders.sql` | **CONSERVAR** | Tabla de vinculación conversación↔pedido sigue siendo útil |
| `backend/migrations/029_waspy_permissions.sql` | **CONSERVAR** | Permisos siguen controlando acceso al inbox (ahora embebido) |
| `WhatsAppSettings.tsx` | **CONSERVAR** | Página de configuración de conexión WhatsApp sigue siendo necesaria |
| `OrderPanel.tsx` | **CONSERVAR** | Panel de pedidos vinculados → se usa al lado del embed |
| `waspy.ts` (funciones de orders) | **CONSERVAR** | `fetchOrdersByPhone`, `fetchLinkedOrders`, `linkOrder`, `unlinkOrder` |
| Botón "Abrir Inbox" en `RealOrderDetail.tsx` | **CONSERVAR** | Navegación desde pedido al inbox con `?phone=` |
| Sidebar "Inbox" | **CONSERVAR** | Entrada de navegación, solo cambiaría el destino |
| Ruta `/inbox` en `App.tsx` | **CONSERVAR** | La ruta se mantiene, el contenido cambia |
| Permisos `inbox.view`, `inbox.send`, `inbox.assign` | **CONSERVAR** | Controlan acceso al inbox y operaciones |
| `whatsapp.connect` | **CONSERVAR** | Controla acceso a settings de WhatsApp |

---

## SECCIÓN 4 — QUÉ DEJAR DE USAR O ELIMINAR

| Componente | Veredicto | Razón | Impacto de eliminar |
|------------|-----------|-------|---------------------|
| `InboxPage.tsx` | **REESCRIBIR** | Reemplazar layout 3-columnas por embed + panel CRM | Bajo — se reusa la ruta, se cambia el contenido |
| `ConversationList.tsx` | **ELIMINAR** | Waspy embed ya tiene su propia lista | Nulo — funcionalidad duplicada |
| `ChatWindow.tsx` | **ELIMINAR** | Waspy embed ya tiene su propia ventana de chat | Nulo — funcionalidad duplicada |
| `MessageInput.tsx` | **ELIMINAR** | Waspy embed ya tiene su propio input | Nulo — funcionalidad duplicada |
| `TemplatePicker.tsx` | **ELIMINAR** | Waspy embed ya tiene template picker | Nulo — funcionalidad duplicada |
| `waspy.ts` (funciones de chat) | **ELIMINAR** | `fetchConversations`, `fetchMessages`, `sendMessage`, `fetchTemplates`, `sendTemplate`, `fetchConversationContext` ya no se llaman desde frontend | Nulo — el embed hace sus propios calls |
| Endpoints 2-9 (proxy Waspy) | **POSIBLEMENTE ELIMINAR** | Si el embed habla directo con Waspy, estos proxies ya no hacen falta para la UI | Bajo — verificar si el embed necesita proxy o habla directo |
| Endpoint 1 (`/waspy/token`) | **CONSERVAR** | El embed necesita un token para autenticarse con Waspy | Crítico si se elimina |
| `templates.view`, `templates.send` | **POSIBLEMENTE ELIMINAR** | Si el inbox Waspy maneja templates internamente, estos permisos CRM son redundantes | Bajo — Waspy usa sus propios roles |

### Componentes a eliminar (después de migrar):

```
financial-crm/src/components/inbox/
├── ChatWindow.tsx          ← ELIMINAR
├── ConversationList.tsx    ← ELIMINAR
├── MessageInput.tsx        ← ELIMINAR
├── TemplatePicker.tsx      ← ELIMINAR
├── OrderPanel.tsx          ← CONSERVAR (se usa al lado del embed)
└── index.ts                ← ACTUALIZAR (solo exportar OrderPanel)
```

---

## SECCIÓN 5 — BACKEND CON EMBED

### A. Endpoints que siguen sirviendo

| Endpoint | Razón |
|----------|-------|
| `GET /waspy/token` | **CRÍTICO** — El embed necesita un JWT para autenticarse con Waspy |
| `GET /waspy/channel/status` | Útil para WhatsAppSettings y para mostrar banner de estado |
| `POST /waspy/channel/connect/start` | Necesario para flujo de conexión |
| `GET /waspy/channel/connect/status` | Necesario para flujo de conexión |
| `GET /waspy/orders/by-phone` | **Feature CRM** — Buscar pedidos por teléfono del contacto |
| `GET /waspy/conversations/:id/orders` | **Feature CRM** — Pedidos vinculados a conversación |
| `POST /waspy/conversations/:id/orders` | **Feature CRM** — Vincular pedido |
| `DELETE /waspy/conversations/:id/orders/:orderNumber` | **Feature CRM** — Desvincular pedido |

### B. Endpoints que probablemente ya no hacen falta

| Endpoint | Razón |
|----------|-------|
| `GET /waspy/me` | El embed maneja su propio perfil |
| `GET /waspy/conversations` | El embed lista conversaciones internamente |
| `GET /waspy/conversations/:id/messages` | El embed muestra mensajes internamente |
| `POST /waspy/messages` | El embed envía mensajes internamente |
| `GET /waspy/templates` | El embed maneja templates internamente |
| `POST /waspy/templates/send` | El embed envía templates internamente |
| `GET /waspy/conversations/:id/context` | El embed maneja contexto internamente |

**Nota:** No eliminar inmediatamente. Desactivar y verificar que el embed no los necesite antes de borrar.

---

## SECCIÓN 6 — PANTALLA EMBED + PANEL CRM

### Layout propuesto

```
┌────────────────────────────────────────────────────┐
│ Header CRM (existente)                             │
├────────────────────────────────────┬───────────────┤
│                                    │               │
│  IFRAME WASPY INBOX                │  PANEL CRM    │
│  (embed del inbox completo)        │               │
│                                    │  - Pedidos     │
│  - Lista de conversaciones         │    por teléfono│
│  - Chat window                     │  - Vincular   │
│  - Templates                       │    pedido     │
│  - Todo lo que Waspy ofrece        │  - Ver detalle│
│                                    │    de pedido  │
│                                    │               │
│  width: flex-1                     │  width: 320px │
│  height: calc(100vh - header)      │               │
│                                    │               │
├────────────────────────────────────┴───────────────┤
│ (sin footer)                                       │
└────────────────────────────────────────────────────┘
```

### Qué reutilizar del layout actual

- **InboxPage.tsx**: La estructura de 3 columnas se simplifica a 2 (embed + panel). Se reusa el contenedor `flex h-[calc(100vh-8rem)]`.
- **OrderPanel.tsx**: Se reutiliza tal cual al lado derecho del embed.
- **Ruta `/inbox`**: Se mantiene, se cambia el contenido.
- **URL params `?phone=`**: Se mantiene para pre-filtrar conversación en el embed.

### Cómo pasar datos al embed

```
Opción 1: URL params en el iframe
  src="https://waspy.app/embed/inbox?token={jwt}&phone={phone}&order={orderNumber}"

Opción 2: postMessage API
  iframe.contentWindow.postMessage({ type: 'SELECT_CONVERSATION', phone: '5491112345678' }, 'https://waspy.app')

Opción 3: URL hash
  src="https://waspy.app/embed/inbox#phone=5491112345678"
```

**Recomendación:** Verificar qué API de embed ofrece Waspy. Lo más probable es URL params para estado inicial + postMessage para comunicación bidireccional.

### Sincronización embed ↔ panel CRM

```
CRM → Embed:
  - Al navegar desde pedido: pasar phone al iframe via URL param
  - Al seleccionar pedido en panel: postMessage para abrir conversación

Embed → CRM:
  - Al seleccionar conversación: Waspy envía postMessage con { conversationId, contactPhone }
  - CRM recibe y actualiza OrderPanel con pedidos del contacto

Flujo:
  1. Usuario navega a /inbox?phone=5491112345678
  2. CRM genera JWT via GET /waspy/token
  3. CRM carga iframe con token + phone
  4. Waspy embed abre conversación del teléfono
  5. Waspy envía postMessage con conversationId
  6. CRM carga pedidos con fetchOrdersByPhone(phone) + fetchLinkedOrders(conversationId)
  7. Panel CRM muestra pedidos vinculados
```

---

## SECCIÓN 7 — ABRIR DESDE DETALLE DE PEDIDO

### Estado actual

`RealOrderDetail.tsx` (líneas 585-601):
```tsx
// Si el pedido tiene teléfono y usuario tiene permiso inbox.view
<Button onClick={() => navigate(`/inbox?phone=${encodeURIComponent(order.customer_phone!)}`)}>
  <MessageCircle /> Abrir Inbox
</Button>
```

### Datos disponibles en el detalle de pedido

- `order.customer_phone` — Teléfono del cliente
- `order.order_number` — Número de pedido
- `order.customer_name` — Nombre del cliente
- `order.customer_email` — Email del cliente

### Flujo propuesto con embed

1. Usuario hace clic en "Abrir Inbox" desde pedido #12345
2. Navega a `/inbox?phone=5491112345678&order=12345`
3. Nueva InboxPage:
   - Genera JWT
   - Carga iframe de Waspy con `?phone=5491112345678`
   - Panel CRM pre-carga pedido #12345 como contexto
4. Si Waspy soporta deep-link por teléfono, el embed abre la conversación directamente
5. Si no hay conversación para ese teléfono, Waspy puede ofrecer iniciar una nueva

### Qué se reutiliza

- ✅ El botón actual en `RealOrderDetail.tsx` funciona sin cambios
- ✅ La navegación con query params funciona sin cambios
- ✅ Solo cambia el contenido de `/inbox` (de inbox nativo a embed)

---

## SECCIÓN 8 — PERMISOS Y NAVEGACIÓN

### Permisos actuales

| Permiso | ¿Conservar? | Justificación |
|---------|-------------|---------------|
| `inbox.view` | **SÍ** | Controla si el usuario puede ver la página del inbox (embed incluido) |
| `inbox.send` | **POSIBLEMENTE NO** | Waspy maneja sus propios roles (admin/agent/read_only). El CRM ya mapea roles en el JWT. Permiso redundante. |
| `inbox.assign` | **SÍ** | Controla vinculación de pedidos, que es feature CRM (no Waspy) |
| `templates.view` | **POSIBLEMENTE NO** | Waspy maneja templates internamente |
| `templates.send` | **POSIBLEMENTE NO** | Waspy maneja templates internamente |
| `whatsapp.connect` | **SÍ** | Controla acceso a WhatsAppSettings |

### Simplificación sugerida

Con el embed, la granularidad de permisos se reduce porque Waspy controla internamente qué puede hacer cada rol:

**Permisos CRM mínimos con embed:**
- `inbox.view` → Puede ver la página con el embed
- `inbox.assign` → Puede vincular pedidos a conversaciones
- `whatsapp.connect` → Puede configurar la conexión WhatsApp

**Permisos delegados a Waspy (via role en JWT):**
- admin → puede todo en Waspy
- agent → puede enviar mensajes, templates
- read_only → solo lectura

### Navegación

| Elemento | ¿Conservar? | Cambio |
|----------|-------------|--------|
| Sidebar "Inbox" | **SÍ** | Sin cambios, sigue apuntando a `/inbox` |
| Ruta `/inbox` | **SÍ** | El componente cambia internamente |
| Ruta `/admin/whatsapp` | **SÍ** | Sin cambios |
| Botón "Abrir Inbox" en pedido | **SÍ** | Sin cambios |

---

## SECCIÓN 9 — RIESGOS

### Severidad ALTA

| # | Riesgo | Descripción | Mitigación |
|---|--------|-------------|------------|
| 1 | **Auth / dominio del iframe** | Si Waspy está en otro dominio, el iframe puede tener restricciones de cookies, CORS, y `X-Frame-Options`. Si Waspy no permite ser embebido, el plan no funciona. | Verificar ANTES de implementar que Waspy soporte embed. Configurar `Content-Security-Policy frame-ancestors` en Waspy. |
| 2 | **Token leak en URL** | Si el JWT se pasa como query param del iframe src, queda en logs del servidor, historial del browser y referrer headers. | Usar postMessage para pasar el token después de cargar el iframe, no en la URL. |
| 3 | **Sincronización de contexto** | Si Waspy no expone eventos de selección de conversación via postMessage, el panel CRM no puede saber qué conversación está activa. | Verificar API de embed de Waspy. Si no existe, pedirla o usar alternativa. |

### Severidad MEDIA

| # | Riesgo | Descripción | Mitigación |
|---|--------|-------------|------------|
| 4 | **UX inconsistente** | El embed tiene estilos propios de Waspy (colores, tipografía, iconos) que pueden no coincidir con el CRM. | Verificar si Waspy permite theming del embed. Aceptar diferencia visual si es menor. |
| 5 | **Dos fuentes de verdad para pedidos** | El CRM tiene `conversation_orders` y Waspy podría tener su propio sistema de contexto. | Definir que el CRM es la fuente de verdad para pedidos. El embed solo muestra el chat. |
| 6 | **Performance del iframe** | Cargar Waspy como iframe agrega carga: otro bundle JS, otro render tree, más memoria. | Lazy-load el iframe. Monitorear performance. |
| 7 | **Código muerto** | Si no se limpia, quedan ~1,500 líneas de componentes de chat sin usar. | Eliminar componentes obsoletos en un PR separado después de migrar. |

### Severidad BAJA

| # | Riesgo | Descripción | Mitigación |
|---|--------|-------------|------------|
| 8 | **Permisos desalineados** | El CRM tiene `inbox.send` pero Waspy controla envío via su propio rol. Un usuario con permiso CRM pero sin rol Waspy (o viceversa) genera confusión. | Simplificar: el CRM controla acceso a la página, Waspy controla qué se puede hacer dentro. |
| 9 | **Offline / degraded** | Si Waspy está caído, el iframe muestra error genérico en vez de un mensaje CRM amigable. | Detectar iframe load errors y mostrar fallback CRM. |
| 10 | **Deep linking** | Si Waspy no soporta abrir una conversación específica por teléfono via URL, el botón "Abrir Inbox" no puede pre-seleccionar la conversación. | Verificar API de deep linking en Waspy. |

---

## SECCIÓN 10 — PLAN RECOMENDADO

### Paso 0: Verificaciones previas (BLOQUEANTE)

Antes de escribir código, verificar:

- [ ] Waspy soporta ser embebido en iframe (headers `X-Frame-Options` / `CSP`)
- [ ] Waspy tiene URL de embed (ej: `https://app.waspy.com/embed/inbox`)
- [ ] Waspy acepta token JWT via postMessage o URL param
- [ ] Waspy expone eventos via postMessage (conversación seleccionada, teléfono activo)
- [ ] Waspy soporta deep-link por teléfono (abrir conversación específica)
- [ ] Waspy permite theming o al menos fondo blanco compatible con el CRM

### Paso 1: Nueva InboxPage con embed

**Reescribir `InboxPage.tsx`:**

```
Layout: 2 columnas
├── Columna izquierda (flex-1): <iframe> del inbox de Waspy
└── Columna derecha (w-80): <OrderPanel /> existente
```

Lógica:
1. Verificar permiso `inbox.view`
2. Obtener JWT via `GET /waspy/token`
3. Renderizar iframe con URL del embed
4. Pasar token via postMessage
5. Si hay `?phone=` en URL, enviar al embed para abrir conversación
6. Escuchar postMessage del embed para actualizar OrderPanel

### Paso 2: Mantener OrderPanel

- Reutilizar `OrderPanel.tsx` sin cambios
- Se alimenta de los eventos del embed (conversationId, contactPhone)
- Funciones de vincular/desvincular pedidos siguen usando endpoints CRM (12-15)

### Paso 3: Mantener botón desde pedido

- `RealOrderDetail.tsx` no necesita cambios
- La navegación a `/inbox?phone={phone}` sigue funcionando
- La nueva InboxPage lee el query param y lo pasa al embed

### Paso 4: Mantener WhatsAppSettings

- `WhatsAppSettings.tsx` no necesita cambios
- Endpoints de conexión (10, 11) siguen sirviendo
- Ruta `/admin/whatsapp` se mantiene

### Paso 5: Limpiar código obsoleto

Después de verificar que el embed funciona:

**Eliminar:**
```
financial-crm/src/components/inbox/ChatWindow.tsx
financial-crm/src/components/inbox/ConversationList.tsx
financial-crm/src/components/inbox/MessageInput.tsx
financial-crm/src/components/inbox/TemplatePicker.tsx
```

**Actualizar:**
```
financial-crm/src/components/inbox/index.ts  → solo exportar OrderPanel
financial-crm/src/services/waspy.ts          → eliminar funciones de chat, conservar funciones de orders y token
```

**Desactivar (no eliminar aún):**
```
backend/routes/waspy.js → endpoints 2-9 (proxy de chat)
```

### Paso 6: Simplificar permisos

- Conservar: `inbox.view`, `inbox.assign`, `whatsapp.connect`
- Deprecar: `inbox.send`, `templates.view`, `templates.send` (delegados a Waspy via rol en JWT)

---

## RESUMEN EJECUTIVO

| Aspecto | Decisión |
|---------|----------|
| InboxPage | Reescribir: embed Waspy + OrderPanel |
| ConversationList, ChatWindow, MessageInput, TemplatePicker | Eliminar |
| OrderPanel | Conservar |
| WhatsAppSettings | Conservar |
| Botón "Abrir Inbox" en pedidos | Conservar sin cambios |
| Backend endpoints de chat (proxy) | Desactivar después de migrar |
| Backend endpoints de pedidos (12-15) | Conservar |
| Backend JWT + waspyClient | Conservar |
| Tabla conversation_orders | Conservar |
| Permisos inbox.view, inbox.assign, whatsapp.connect | Conservar |
| Permisos inbox.send, templates.* | Deprecar (Waspy controla internamente) |
| Sidebar, rutas, navegación | Conservar sin cambios |

**Beneficios del cambio:**
- Inbox con todas las features de Waspy (WebSocket, media, typing, search, etc.)
- Eliminación de ~1,500 líneas de código de chat reimplementado
- Mantenimiento delegado a Waspy (no hay que mantener el inbox en el CRM)
- El CRM se enfoca en lo que sabe hacer: gestión de pedidos + contexto

**Prerequisito crítico:** Verificar que Waspy soporte embed/iframe antes de implementar.
