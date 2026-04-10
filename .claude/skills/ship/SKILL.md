# /ship - Safe Push & Deploy Monitor

> Pull, esperar deploys activos, push, y monitorear GitHub Actions hasta que termine.

## Usage

```bash
/ship              # Full workflow: pull → wait → push → monitor
/ship "msg"        # Con mensaje de commit (si hay cambios sin commitear)
```

## What It Does

1. **Git Pull** - Trae cambios remotos (rebase)
2. **Check Active Deploys** - Revisa si hay GitHub Actions corriendo
3. **Wait** - Si hay un deploy activo, espera a que termine
4. **Push** - Pushea al remote
5. **Monitor** - Monitorea el GitHub Actions workflow que se dispara hasta que termine

## Key Features

- Safe: nunca pushea encima de un deploy en curso
- Monitoreo real: usa `gh run watch` para seguir el progreso
- Detecta conflictos antes de pushear
- Reporta resultado final del deploy
- Comunicacion en espanol

## Skill Definition

```yaml
name: ship
description: Safe push with GitHub Actions deploy monitoring
version: 1.0.0
author: Abi Saieg
invocable: true
```
