#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# CRM → GCP Cutover Commands (reconciled with real infra)
#
# Real infrastructure:
#   Project: tidal-cipher-486519-k0
#   API:     petlove-backend (Cloud Run, LIVE)
#   Workers: crm-workers (Cloud Run, LIVE)
#   Web:     crm-web (Cloud Run, TO CREATE)
#   Redis:   crm-redis (10.10.0.3, LIVE)
#   VPC:     crm-vpc-connector (10.9.0.0/28, LIVE)
#   DB:      crm-postgres (Cloud SQL, CREATED)
#   Bucket:  tidal-cipher-486519-k0-crm-storage (GCS, CREATED)
#
# This script handles:
#   1. Deploy frontend (crm-web) — NEW
#   2. Switch API + Workers to Cloud SQL + GCS — CUTOVER
#   3. Verify everything
#
# IMPORTANT:
#   - Run setup.sh first
#   - Run migrations on Cloud SQL first
#   - Run storage migration first
#   - This script changes PRODUCTION env vars
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="tidal-cipher-486519-k0"
REGION="us-central1"
DB_INSTANCE="crm-postgres"
BUCKET="tidal-cipher-486519-k0-crm-storage"

CONN_NAME=$(gcloud sql instances describe "$DB_INSTANCE" --project="$PROJECT_ID" \
  --format="value(connectionName)" 2>/dev/null)

if [ -z "$CONN_NAME" ]; then
  echo "ERROR: Cloud SQL instance $DB_INSTANCE not found. Run setup.sh first."
  exit 1
fi

echo "═══ CRM GCP Cutover ═══"
echo "Cloud SQL: $CONN_NAME"
echo "Bucket:    $BUCKET"
echo ""

# ── 1. Deploy Frontend (crm-web) ───────────────────────────
echo "→ Step 1: Deploy frontend to Cloud Run..."
echo "  Building and deploying from financial-crm/Dockerfile..."
# gcloud run deploy --source uses the Dockerfile automatically.
# VITE_API_URL default in Dockerfile is https://api.bpmadministrador.com (correct).
cd "$(dirname "$0")/../../financial-crm"
gcloud run deploy crm-web \
  --source=. \
  --region="$REGION" \
  --memory=256Mi \
  --min-instances=0 \
  --max-instances=5 \
  --port=8080 \
  --allow-unauthenticated \
  --project="$PROJECT_ID"
cd -

WEB_URL=$(gcloud run services describe crm-web \
  --region="$REGION" --project="$PROJECT_ID" \
  --format="value(status.url)" 2>/dev/null)
echo "  ✅ Frontend deployed: $WEB_URL"

# Verify SPA routing
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$WEB_URL/orders/12345" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo "  ✅ SPA routing OK ($WEB_URL/orders/12345 → 200)"
else
  echo "  ⚠️  SPA routing returned HTTP $HTTP_CODE"
fi

# ── 2. Switch petlove-backend to Cloud SQL + GCS ───────────
echo ""
echo "→ Step 2: Switch API (petlove-backend) to Cloud SQL + GCS..."
echo "  ⚠️  THIS CHANGES PRODUCTION. Press Ctrl+C to abort."
read -p "  Continue? [y/N] " -r
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "  Aborted."
  exit 0
fi

gcloud run services update petlove-backend \
  --region="$REGION" \
  --add-cloudsql-instances="$CONN_NAME" \
  --update-env-vars="DB_HOST=/cloudsql/$CONN_NAME,DB_PORT=,DB_USER=crm_app,DB_NAME=crm_db,GCS_BUCKET=$BUCKET" \
  --update-secrets="DB_PASSWORD=crm-cloudsql-password:latest" \
  --project="$PROJECT_ID"

echo "  ✅ petlove-backend switched to Cloud SQL + GCS"

# ── 3. Switch crm-workers to Cloud SQL + GCS ───────────────
echo ""
echo "→ Step 3: Switch Workers (crm-workers) to Cloud SQL + GCS..."

gcloud run services update crm-workers \
  --region="$REGION" \
  --add-cloudsql-instances="$CONN_NAME" \
  --update-env-vars="DB_HOST=/cloudsql/$CONN_NAME,DB_PORT=,DB_USER=crm_app,DB_NAME=crm_db,GCS_BUCKET=$BUCKET" \
  --update-secrets="DB_PASSWORD=crm-cloudsql-password:latest" \
  --project="$PROJECT_ID"

echo "  ✅ crm-workers switched to Cloud SQL + GCS"

# ── 4. Verify ──────────────────────────────────────────────
echo ""
echo "→ Step 4: Verifying..."

# API health
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://api.bpmadministrador.com/health" 2>/dev/null || echo "000")
echo "  API health: HTTP $HTTP_CODE"

# Web health
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$WEB_URL/" 2>/dev/null || echo "000")
echo "  Web health: HTTP $HTTP_CODE"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "Cutover complete."
echo ""
echo "Services:"
echo "  API:      https://api.bpmadministrador.com (petlove-backend)"
echo "  Workers:  crm-workers (internal)"
echo "  Web:      $WEB_URL (crm-web)"
echo ""
echo "NEXT STEPS:"
echo "  1. Verify deep health: curl -H 'Authorization: Bearer TOKEN' https://api.bpmadministrador.com/health/deep"
echo "  2. Test upload flow in panel"
echo "  3. Map domain: gcloud beta run domain-mappings create --service=crm-web --domain=www.bpmadministrador.com --region=$REGION --project=$PROJECT_ID"
echo "  4. Update DNS for www.bpmadministrador.com to point to Cloud Run"
echo ""
echo "ROLLBACK (if needed):"
echo "  # DB → Supabase:"
echo "  gcloud run services update petlove-backend --region=$REGION --update-env-vars='DB_HOST=aws-0-us-west-2.pooler.supabase.com,DB_PORT=5432,DB_USER=postgres.olvipgcbxgspwwxzmhfi,DB_NAME=postgres' --update-secrets='DB_PASSWORD=crm-db-password:latest' --remove-cloudsql-instances=$CONN_NAME --project=$PROJECT_ID"
echo "  # Storage → Supabase:"
echo "  gcloud run services update petlove-backend --region=$REGION --remove-env-vars=GCS_BUCKET --project=$PROJECT_ID"
echo "═══════════════════════════════════════════════════════"
