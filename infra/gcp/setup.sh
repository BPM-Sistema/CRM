#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# CRM → GCP Infrastructure Setup (reconciled with real infra)
#
# Real project: tidal-cipher-486519-k0
# Region: us-central1
#
# ALREADY EXISTS (do NOT recreate):
#   - Cloud Run: petlove-backend, crm-workers
#   - Redis: crm-redis (10.10.0.3:6379)
#   - VPC connector: crm-vpc-connector (10.9.0.0/28)
#   - Secret Manager: 8 secrets (crm-*)
#   - Scheduler: sync-orders-cron
#   - Artifact Registry: cloud-run-source-deploy (auto)
#   - Service accounts: default compute, sis-bpmv2, crm-deploy
#
# THIS SCRIPT CREATES ONLY:
#   - Cloud SQL instance (crm-postgres)
#   - GCS bucket (tidal-cipher-486519-k0-crm-storage)
#   - Scheduler jobs: crm-reconcile, crm-cleanup
#   - Grant Cloud SQL client role to default compute SA
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="tidal-cipher-486519-k0"
REGION="us-central1"
DB_INSTANCE="crm-postgres"
DB_NAME="crm_db"
DB_USER="crm_app"
BUCKET_NAME="${PROJECT_ID}-crm-storage"
COMPUTE_SA="343336533491-compute@developer.gserviceaccount.com"

echo "═══ CRM GCP Setup (only missing resources) ═══"
echo "Project:  $PROJECT_ID"
echo "Region:   $REGION"
echo ""

# ── 1. Enable APIs ──────────────────────────────────────────
echo "→ Enabling Cloud SQL API (if not already)..."
gcloud services enable sqladmin.googleapis.com --project="$PROJECT_ID" 2>/dev/null

# ── 2. Cloud SQL ────────────────────────────────────────────
echo "→ Creating Cloud SQL instance..."
if gcloud sql instances describe "$DB_INSTANCE" --project="$PROJECT_ID" &>/dev/null; then
  echo "  (already exists)"
else
  gcloud sql instances create "$DB_INSTANCE" \
    --database-version=POSTGRES_16 \
    --edition=ENTERPRISE \
    --tier=db-g1-small \
    --region="$REGION" \
    --storage-auto-increase \
    --backup-start-time=03:00 \
    --availability-type=zonal \
    --project="$PROJECT_ID"
fi

echo "→ Creating database..."
gcloud sql databases create "$DB_NAME" \
  --instance="$DB_INSTANCE" \
  --project="$PROJECT_ID" 2>/dev/null || echo "  (database already exists)"

echo "→ Creating database user..."
DB_PASSWORD=$(openssl rand -base64 24)
gcloud sql users create "$DB_USER" \
  --instance="$DB_INSTANCE" \
  --password="$DB_PASSWORD" \
  --project="$PROJECT_ID" 2>/dev/null || echo "  (user already exists, password NOT changed)"

echo ""
echo "  ⚠️  SAVE THIS: DB_PASSWORD=$DB_PASSWORD"
echo ""

# Store password as secret for Cloud Run
echo "→ Storing Cloud SQL password in Secret Manager..."
echo -n "$DB_PASSWORD" | gcloud secrets create crm-cloudsql-password \
  --data-file=- --project="$PROJECT_ID" 2>/dev/null || \
echo -n "$DB_PASSWORD" | gcloud secrets versions add crm-cloudsql-password \
  --data-file=- --project="$PROJECT_ID" 2>/dev/null || \
echo "  (secret already exists — update manually if needed)"

# ── 3. Grant Cloud SQL client to default compute SA ─────────
echo "→ Granting cloudsql.client to compute SA..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$COMPUTE_SA" \
  --role="roles/cloudsql.client" --quiet 2>/dev/null

# ── 4. GCS bucket ───────────────────────────────────────────
echo "→ Creating GCS bucket..."
if gcloud storage buckets describe "gs://$BUCKET_NAME" --project="$PROJECT_ID" &>/dev/null; then
  echo "  (already exists)"
else
  gcloud storage buckets create "gs://$BUCKET_NAME" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --project="$PROJECT_ID"

  gcloud storage buckets add-iam-policy-binding "gs://$BUCKET_NAME" \
    --member="allUsers" --role="roles/storage.objectViewer"

  cat > /tmp/cors.json << 'CORS'
[{"origin":["https://www.bpmadministrador.com","https://api.bpmadministrador.com","http://localhost:5173"],"method":["GET"],"responseHeader":["Content-Type"],"maxAgeSeconds":3600}]
CORS
  gcloud storage buckets update "gs://$BUCKET_NAME" --cors-file=/tmp/cors.json
fi

# ── 5. Scheduler jobs (only missing ones) ───────────────────
echo "→ Creating scheduler jobs (if missing)..."

if ! gcloud scheduler jobs describe crm-reconcile --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  gcloud scheduler jobs create http crm-reconcile \
    --schedule="*/30 * * * *" \
    --uri="https://api.bpmadministrador.com/reconcile/cron" \
    --http-method=POST \
    --location="$REGION" \
    --oidc-service-account-email="$COMPUTE_SA" \
    --oidc-token-audience="https://api.bpmadministrador.com/reconcile/cron" \
    --headers="Content-Type=application/json" \
    --attempt-deadline=300s \
    --project="$PROJECT_ID"
else
  echo "  crm-reconcile already exists"
fi

if ! gcloud scheduler jobs describe crm-cleanup --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  gcloud scheduler jobs create http crm-cleanup \
    --schedule="0 3 * * *" \
    --uri="https://api.bpmadministrador.com/cleanup/cron" \
    --http-method=POST \
    --location="$REGION" \
    --oidc-service-account-email="$COMPUTE_SA" \
    --oidc-token-audience="https://api.bpmadministrador.com/cleanup/cron" \
    --headers="Content-Type=application/json" \
    --attempt-deadline=300s \
    --project="$PROJECT_ID"
else
  echo "  crm-cleanup already exists"
fi

# ── Summary ─────────────────────────────────────────────────
CONN_NAME=$(gcloud sql instances describe "$DB_INSTANCE" --project="$PROJECT_ID" \
  --format="value(connectionName)" 2>/dev/null || echo "$PROJECT_ID:$REGION:$DB_INSTANCE")

echo ""
echo "═══════════════════════════════════════════════════════"
echo "Setup complete."
echo ""
echo "Cloud SQL connection: /cloudsql/$CONN_NAME"
echo "GCS bucket: $BUCKET_NAME"
echo ""
echo "Next: run migrations against Cloud SQL, then switch env vars."
echo "See infra/gcp/deploy.sh for cutover commands."
echo "═══════════════════════════════════════════════════════"
