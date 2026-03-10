# Waspy Embed — Guía rápida

## Setup (para desarrolladores)

1. Levanta Waspy (API en `:8080`, web en `:3000`)
2. Levanta CRM backend en `:3001` y frontend en `:5173`
3. En Waspy: Configuración > Integraciones > Generar API Key
4. En CRM: Configuración > WhatsApp > Pegar API Key > Conectar
5. Ir a Inbox — el embed carga automáticamente

## Flujo técnico

```
InboxPage monta
  → fetchWaspyConfig() → obtiene embedUrl de DB
  → fetchWaspyToken() → CRM backend pide JWT a Waspy con API Key
  → Carga iframe con embedUrl
  → Escucha 'ready' del iframe
  → Envía 'auth' con JWT via postMessage
  → Si hay ?phone= → envía 'navigate'
  → Si hay ?order= → envía 'context'
  → Escucha 'conversation:selected' → muestra OrderPanel
```

## Troubleshooting

| Problema | Causa probable | Solución |
|----------|---------------|----------|
| "Waspy no configurado" | No hay API Key en DB | Settings > WhatsApp > Conectar |
| Iframe en blanco | embed_url incorrecto | Verificar URL en Settings |
| 401 en token | API Key revocado/inválido | Generar nuevo API Key en Waspy |
| Iframe no envía 'ready' | CORS/frame-ancestors | Verificar config de Waspy |
| OrderPanel no aparece | Waspy no envía conversation:selected | Verificar bridge en consola |
