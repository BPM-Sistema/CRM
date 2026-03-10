# Reporte E2E - Integración CRM ↔ Waspy (Local)

**Fecha:** 2026-03-09
**Entorno:** macOS local
**Waspy:** http://localhost:8080
**CRM Backend:** http://localhost:3001 (PORT=3001, puerto 3000 ocupado por Waspy frontend)
**CRM Frontend:** http://localhost:5173

---

## 1. Servicios Levantados

| Servicio | Puerto | Estado |
|----------|--------|--------|
| Waspy API | 8080 | OK - `{"status":"ok"}` |
| Waspy Frontend | 3000 | OK (HTML) |
| CRM Backend | 3001 | OK - `Server running on port 3001` |
| CRM Frontend (Vite) | 5173 | OK (HTML) |

**Nota:** CRM backend se levantó con `PORT=3001` porque Waspy ya ocupaba el 3000.

---

## 2. Datos de Prueba

| Dato | Valor |
|------|-------|
| CRM User | admin@petlove.com (Administrador, rol admin) |
| Waspy Tenant | fd664703-0162-402f-bcf2-49bf378d3ee0 (Abi Saieg's Workspace) |
| Phone Number | +54 9 11 2334-1062 (phoneNumberId: 8b86c131-...) |
| Conversation ID | a9867826-f8c9-4192-bb60-f92edb0c73f9 |
| Contact | abi (+5491126032641) |
| Orders encontradas | #26328, #26326, #26131 |

---

## 3. JWT CRM → Waspy - PASS

```
GET /waspy/token → 200 OK
```

JWT decodificado:
```json
{
  "sub": "5cdabc1c-ddfc-45a1-a522-e2c5ee1244fd",
  "tenantId": "fd664703-0162-402f-bcf2-49bf378d3ee0",
  "role": "admin",
  "email": "admin@petlove.com",
  "name": "Administrador",
  "iss": "crm",
  "aud": "waspy",
  "exp": 1773029167
}
```

Todos los claims correctos. Waspy acepta el token.

---

## 4. Proxy CRM → Waspy - PASS

| Endpoint | Status | Resultado |
|----------|--------|-----------|
| `GET /waspy/me` | 200 | userId, tenantId, role=admin, authMethod=crm_jwt |
| `GET /waspy/channel/status` | 200 | connected=true, phoneNumber=+54 9 11 2334-1062, qualityRating=GREEN |
| `GET /waspy/conversations` | 200 | Lista de conversaciones con contactos reales |
| `GET /waspy/templates` | 200 | 2 templates: hello_world (en_US), test_imagen (es_AR), ambas approved |

Ningún secreto expuesto en respuestas. Error responses sin `detail` field.

---

## 5. Conversaciones y Mensajes - PASS

```
GET /waspy/conversations → 200
  Conversation: a9867826-... (abi, +5491126032641, status: open)

GET /waspy/conversations/a9867826-.../messages → 200
  Total messages: 34
  [inbound] text - "F"
  [outbound] image
  [inbound] text - "Hola"
```

Mensajes reales cargados correctamente con diferentes tipos.

---

## 6. Envío de Mensaje - PASS

```
POST /waspy/messages
Body: {
  conversationId: "a9867826-...",
  phoneNumberId: "8b86c131-...",
  to: "5491126032641",
  type: "text",
  content: { body: "Test E2E desde CRM proxy" }
}

Response: 200
  id: "534e239f-..."
  direction: "outbound"
  status: "queued"
  content: { body: "Test E2E desde CRM proxy" }
```

Mensaje encolado exitosamente en Waspy.

**Fix aplicado:** El frontend `sendMessage` ahora envía `phoneNumberId`, `to` y `content.body` (formato requerido por Waspy). El tipo `WaspyConversation` ahora incluye `phoneNumberId`.

---

## 7. Templates - PASS

```
GET /waspy/templates → 200
  hello_world (en_US) - approved - utility
  test_imagen (es_AR) - approved - marketing
```

Templates disponibles. Envío de template no probado por CLI porque requeriría una ventana de servicio activa, pero el proxy forwardea correctamente.

---

## 8. Pedidos por Teléfono - PASS

| Input | Resultado |
|-------|-----------|
| `+5491126032641` | 3 orders (#26328, #26326, #26131) |
| `1126032641` | 3 orders (mismo resultado) |
| `invalidphone` | 400: "Teléfono inválido" |

Normalización funciona con diferentes formatos. Teléfono inválido rechazado correctamente.

**Fix aplicado:** La query SQL usaba `normalized_phone` (columna inexistente en orders_validated). Cambiado a `customer_phone LIKE '%' || $1 || '%'` con últimos 8 dígitos.

---

## 9. Asociación Manual Chat ↔ Pedido - PASS

| Operación | Resultado |
|-----------|-----------|
| Link order #26328 | `{ ok: true }` |
| Link order #26326 | `{ ok: true }` - un chat puede tener varios pedidos |
| Duplicate link #26328 | `{ ok: true }` - no duplica (ON CONFLICT DO NOTHING) |
| GET linked orders | 2 orders (#26326, #26328) |
| DELETE unlink #26326 | `{ ok: true }` |
| GET after unlink | 1 order (#26328) |

Flujo completo funcionando.

---

## 10. Permisos - PASS (parcial)

| Test | Resultado |
|------|-----------|
| Sin Authorization header | 401: "Token de autenticación requerido" |
| Token inválido | 401: "Token inválido o expirado" |
| Admin con inbox.view | 200 en todos los endpoints |
| Admin con 50 permisos totales (6 Waspy) | Permisos asignados correctamente |

**Nota:** No se pudo probar 403 con usuario sin permisos porque las contraseñas de otros usuarios no son conocidas. El middleware `requirePermission` está validado por código.

---

## 11. Builds y Tests - PASS

| Check | Resultado |
|-------|-----------|
| TypeScript (`tsc --noEmit`) | Sin errores |
| Vite build | Exitoso (903 KB) |
| Backend tests (phoneNormalize) | 8/8 passing |
| Backend tests (waspyClient) | 5/5 passing |

---

## 12. Fixes Aplicados Durante E2E

| # | Fix | Archivo |
|---|-----|---------|
| 1 | Migración 017: removida columna `description` inexistente en tabla `permissions` | `backend/migrations/017_waspy_permissions.sql` |
| 2 | Query orders-by-phone: removida referencia a columna `normalized_phone` inexistente en `orders_validated`, se usa LIKE con últimos 8 dígitos | `backend/routes/waspy.js` |
| 3 | Frontend `sendMessage`: agregados campos `phoneNumberId`, `to`, `content.body` requeridos por Waspy | `financial-crm/src/services/waspy.ts` |
| 4 | Frontend `fetchConversations`: mapeo de respuesta Waspy (`contact.name`, `contact.phoneNumber`, `phoneNumberId`) al tipo local | `financial-crm/src/services/waspy.ts` |
| 5 | Frontend `fetchMessages`: mapeo de `content.body` → `content.text`, `createdAt` → `timestamp` | `financial-crm/src/services/waspy.ts` |
| 6 | Frontend `ChatWindow`: envía `phoneNumberId`, `to` y `content.body` al proxy | `financial-crm/src/components/inbox/ChatWindow.tsx` |
| 7 | Frontend `WaspyConversation` type: agregado `phoneNumberId` | `financial-crm/src/services/waspy.ts` |

---

## 13. Veredicto

### READY FOR LOCAL MANUAL REVIEW

La integración CRM ↔ Waspy funciona end-to-end con datos reales:
- JWT generado y aceptado por Waspy
- Proxy funciona para todos los endpoints probados
- Conversaciones, mensajes, templates cargan correctamente
- Envío de mensaje funciona (queued en Waspy)
- Búsqueda de pedidos por teléfono funciona con normalización
- Asociación manual chat ↔ pedido funciona (link/unlink/múltiple)
- Auth enforcement funciona (401 sin token)
- Builds y tests pasan
