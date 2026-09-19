#!/usr/bin/env bash
set -euo pipefail
PROJECT="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT}"
REGION="${REGION:-us-east1}"
GCLOUD="${GCLOUD:-gcloud}"
gc() { "$GCLOUD" --quiet --project="$PROJECT" "$@"; }
RUNTIME="senpilot-agent@$PROJECT.iam.gserviceaccount.com"
CALLER="senpilot-caller@$PROJECT.iam.gserviceaccount.com"
BUILDER="senpilot-build@$PROJECT.iam.gserviceaccount.com"
gc services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com cloudtasks.googleapis.com pubsub.googleapis.com cloudscheduler.googleapis.com iamcredentials.googleapis.com
for account in senpilot-agent senpilot-caller senpilot-build; do
  gc iam service-accounts describe "$account@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1 || gc iam service-accounts create "$account"
done
gc artifacts repositories describe senpilot --location="$REGION" >/dev/null 2>&1 || gc artifacts repositories create senpilot --repository-format=docker --location="$REGION"
gc artifacts repositories add-iam-policy-binding senpilot --location="$REGION" --member="serviceAccount:$BUILDER" --role=roles/artifactregistry.writer >/dev/null
gc projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$BUILDER" --role=roles/logging.logWriter --condition=None >/dev/null
for suffix in documents builds; do
  gc storage buckets describe "gs://$PROJECT-$suffix" >/dev/null 2>&1 || gc storage buckets create "gs://$PROJECT-$suffix" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
done
gc storage buckets add-iam-policy-binding "gs://$PROJECT-documents" --member="serviceAccount:$RUNTIME" --role=roles/storage.objectUser >/dev/null
gc storage buckets add-iam-policy-binding "gs://$PROJECT-builds" --member="serviceAccount:$BUILDER" --role=roles/storage.objectViewer >/dev/null
policy=$(mktemp)
trap 'rm -f "$policy"' EXIT
printf '%s' '{"rule":[{"action":{"type":"Delete"},"condition":{"age":2}}]}' > "$policy"
gc storage buckets update "gs://$PROJECT-documents" "gs://$PROJECT-builds" --lifecycle-file="$policy" --clear-soft-delete
gc pubsub topics describe gmail-inbox >/dev/null 2>&1 || gc pubsub topics create gmail-inbox
gc pubsub topics add-iam-policy-binding gmail-inbox --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher >/dev/null
gc tasks queues describe filing-jobs --location="$REGION" >/dev/null 2>&1 || gc tasks queues create filing-jobs --location="$REGION"
gc tasks queues update filing-jobs --location="$REGION" --max-concurrent-dispatches=1 --max-dispatches-per-second=1 --max-attempts=8 --min-backoff=30s --max-backoff=300s --max-retry-duration=3600s
gc tasks queues add-iam-policy-binding filing-jobs --location="$REGION" --member="serviceAccount:$RUNTIME" --role=roles/cloudtasks.enqueuer >/dev/null
gc iam service-accounts add-iam-policy-binding "$CALLER" --member="serviceAccount:$RUNTIME" --role=roles/iam.serviceAccountUser >/dev/null
NUMBER=$(gc projects describe "$PROJECT" --format='value(projectNumber)')
gc beta services identity create --service=pubsub.googleapis.com >/dev/null
gc iam service-accounts add-iam-policy-binding "$CALLER" --member="serviceAccount:service-$NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" --role=roles/iam.serviceAccountTokenCreator >/dev/null
for secret in senpilot-database-url senpilot-openai-key senpilot-google-oauth senpilot-google-token; do
  gc secrets add-iam-policy-binding "$secret" --member="serviceAccount:$RUNTIME" --role=roles/secretmanager.secretAccessor >/dev/null
done
echo 'Cloud infrastructure is ready.'
