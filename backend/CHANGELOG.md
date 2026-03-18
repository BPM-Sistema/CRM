# Changelog

## 2026-03-18 — Incidente: fail-open de testing mode en arranque frío

**Severidad:** Alta
**Impacto:** 1 mensaje WhatsApp enviado a cliente real en vez de número de testing
**Pedido afectado:** #29164 (Antonio Oscar Geiges, +542494626477)
**Plantilla:** pedido_creado_wanda_v2
**Timestamp:** 2026-03-18T04:09:58Z

### Root cause

`getTestingConfig()` retornó `null` por error transitorio de DB/cache frío al arrancar el worker.
El código usaba `testingConfig?.enabled` — cuando `testingConfig` es `null`, el optional chaining
evalúa a `undefined`, el `if` es falso, y el mensaje pasa directo al cliente real sin filtrar.

### Fix

Cambiado a check explícito `testingConfig === null` en ambos paths de envío:
- `workers/whatsapp.worker.js` — throw error (BullMQ reintenta 3x, luego failed job)
- `lib/whatsapp-helpers.js` — return skipped con reason `testing_config_unavailable`

Commit: `3c69e6d` — "fix: fail-safe WhatsApp testing mode — block send if config unreadable"

### Paths auditados

| Path | Archivo | Protección |
|------|---------|------------|
| Worker BullMQ | `workers/whatsapp.worker.js:46` | throw → retry 3x |
| Fallback sync | `lib/whatsapp-helpers.js:43` | return skipped |
| Remitos directo | `lib/whatsapp-helpers.js:43` | mismo archivo |

No existen otros paths a Botmaker API fuera de estos 2 archivos.

### Validación

- Reproducido localmente: `null` config → viejo código envía, nuevo código bloquea
- 9 call sites en index.js + 1 en remitos.js — todos pasan por paths protegidos
- Solo 2 archivos hacen POST a `api.botmaker.com` — ambos con fail-safe
