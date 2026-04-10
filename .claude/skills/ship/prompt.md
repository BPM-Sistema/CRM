# /ship — Safe Push & Deploy Monitor

**Toda la comunicacion con el usuario debe ser en ESPANOL.**

## Objetivo

Workflow seguro para pushear y monitorear el deploy via GitHub Actions:
1. Pull (rebase)
2. Detectar si hay GitHub Actions corriendo — esperar si hay
3. Pushear
4. Monitorear los workflows que se disparen hasta que terminen

## Informacion del Repo

- **Remote**: detectar con `git remote get-url origin`
- **Repo GH**: extraer owner/repo del remote URL (ej: `abisaieg/Waspy`)
- **Branch**: detectar con `git branch --show-current`
- **Workflows de deploy**: CI, Deploy API, Deploy Web, Deploy Worker

---

## Paso 0: Detectar repo y branch

```bash
REMOTE=$(git remote get-url origin)
REPO=$(echo "$REMOTE" | sed -E 's|.*github\.com[:/](.+)(\.git)?$|\1|' | sed 's/\.git$//')
BRANCH=$(git branch --show-current)
```

Mostrar:
```
Repo: [REPO]
Branch: [BRANCH]
```

---

## Paso 1: Git Pull (rebase)

```bash
git pull --rebase origin [BRANCH]
```

Si hay conflictos:
- Informar al usuario
- **NO continuar** — pedir que resuelva manualmente
- Salir del skill

Si esta limpio, continuar.

---

## Paso 2: Verificar cambios pendientes

Correr `git status --short`.

Si hay cambios sin commitear:
- Mostrar los archivos cambiados
- Si el usuario paso un argumento (mensaje de commit), usarlo para commitear
- Si no paso argumento, generar un mensaje de commit automaticamente basado en el `git diff --stat` y los nombres de archivos cambiados. Usar el formato convencional (feat:/fix:/chore:). NO preguntar al usuario — generar y commitear directamente.
- Detectar el nombre y email del usuario con `git config user.name` y `git config user.email`
- Agregar siempre al final del mensaje de commit:
  ```
  Authored-By: [nombre] <[email]>
  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
  ```
- Stage solo los archivos relevantes (no usar `git add -A` si hay archivos no relacionados como reportes .md, .env, etc.)

Si no hay cambios y no hay commits por pushear:
- Informar "No hay nada que pushear"
- Salir

Verificar que hay commits por pushear:
```bash
git log origin/[BRANCH]..HEAD --oneline
```

---

## Paso 3: Verificar GitHub Actions activos

```bash
gh run list --repo [REPO] --branch [BRANCH] --status in_progress --limit 5
gh run list --repo [REPO] --branch [BRANCH] --status queued --limit 5
```

Si hay workflows en `in_progress` o `queued`:
1. Informar al usuario:
   ```
   Hay deploy(s) activo(s):
   - [workflow_name] (run_id) — [status] — iniciado [time]
   
   Esperando a que terminen antes de pushear...
   ```

2. Esperar usando `gh run watch`:
   ```bash
   gh run watch [RUN_ID] --repo [REPO] --exit-status
   ```
   
   Si hay multiples runs activos, esperar al mas reciente.

3. Verificar resultado:
   - Si el deploy activo **fallo**: avisar al usuario pero continuar (el push puede ser el fix)
   - Si **paso**: continuar normalmente

Si NO hay workflows activos: continuar directamente.

---

## Paso 4: Pull final (por si cambio algo mientras esperaba)

```bash
git pull --rebase origin [BRANCH]
```

Si hay conflictos: abortar y avisar.

---

## Paso 5: Push

```bash
git push origin [BRANCH]
```

Capturar resultado. Si falla:
- Auth error: sugerir `gh auth login`
- Reject: sugerir `git pull --rebase`
- Otro: mostrar error

Si exitoso:
```
Push completado — [BRANCH] → origin
```

---

## Paso 6: Esperar que se disparen los workflows

Esperar 5 segundos para que GitHub registre los workflows:

```bash
sleep 5
gh run list --repo [REPO] --branch [BRANCH] --limit 5 --json databaseId,name,status,conclusion,createdAt
```

Identificar los runs que se dispararon despues del push (por `createdAt` reciente, ultimos 60 segundos).

Si no se disparo ningun workflow:
```
No se disparo ningun workflow de GitHub Actions.
(Puede que los archivos cambiados no matcheen ningun trigger)
```
Terminar.

---

## Paso 7: Monitorear workflows disparados

Para cada workflow que se disparo:

1. Mostrar que workflows se detectaron:
   ```
   Workflows disparados:
   - CI (#run_id)
   - Deploy Web (#run_id)
   - Deploy API (#run_id)
   ```

2. Monitorear con `gh run watch` el mas importante (prioridad: Deploy API > Deploy Web > Deploy Worker > CI):
   ```bash
   gh run watch [RUN_ID] --repo [REPO] --exit-status
   ```

3. Mientras espera, verificar los otros runs periodicamente:
   ```bash
   gh run view [RUN_ID] --repo [REPO] --json status,conclusion
   ```

4. Si algun workflow falla: reportar inmediatamente sin esperar los demas.

---

## Paso 8: Reporte final

```
=== Ship completado ===

Git:
  Branch: [BRANCH]
  Commits pusheados: [N]
  
Workflows:
  CI: [passed/failed/skipped]
  Deploy API: [passed/failed/skipped]  
  Deploy Web: [passed/failed/skipped]
  Deploy Worker: [passed/failed/skipped]

[Si todo paso:]
Todo deployed correctamente.

[Si algo fallo:]
ATENCION: [workflow] fallo. Revisar logs:
gh run view [RUN_ID] --repo [REPO] --log-failed
```

---

## Reglas

- **Siempre** hacer pull antes de push
- **Nunca** pushear si hay un deploy corriendo (esperar)
- **Nunca** hacer force push
- **Siempre** comunicar en espanol
- **No** modificar archivos del proyecto (esta skill solo hace git ops + monitoreo)
- **No** pedir mensaje de commit si no hay cambios sin commitear
- Si el usuario paso argumento al skill, usarlo como mensaje de commit
- Si un workflow tarda mas de 10 minutos, avisar pero seguir esperando
- Usar `--exit-status` en `gh run watch` para que devuelva exit code correcto

## Manejo de Errores

- Pull con conflictos: parar y avisar
- Push rechazado: sugerir pull --rebase
- gh CLI no disponible: avisar que instale `gh`
- Sin permisos en repo: avisar
- Workflow fallo: mostrar comando para ver logs
