#!/usr/bin/env bash
set -euo pipefail
PROJECT="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT}"
REGION="${REGION:-us-east1}"
AGENT_EMAIL="${AGENT_EMAIL:?Set AGENT_EMAIL}"
GCLOUD="${GCLOUD:-gcloud}"
gc() { "$GCLOUD" --quiet --project="$PROJECT" "$@"; }
RUNTIME="senpilot-agent@$PROJECT.iam.gserviceaccount.com"
CALLER="senpilot-caller@$PROJECT.iam.gserviceaccount.com"
TAG=$(git rev-parse --short HEAD)
gc builds submit . --config=cloudbuild.yaml --region="$REGION" --substitutions="_REGION=$REGION,_TAG=$TAG" --service-account="projects/$PROJECT/serviceAccounts/senpilot-build@$PROJECT.iam.gserviceaccount.com" --gcs-source-staging-dir="gs://$PROJECT-builds/source"
gc run deploy senpilot-agent --region="$REGION" --image="$REGION-docker.pkg.dev/$PROJECT/senpilot/agent:$TAG" --service-account="$RUNTIME" --no-allow-unauthenticated --cpu=1 --memory=1Gi --concurrency=4 --min=0 --max=2 --timeout=900 --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,AGENT_EMAIL=$AGENT_EMAIL,CACHE_BACKEND=gcs,GCS_CACHE_BUCKET=$PROJECT-documents,GMAIL_TOPIC=projects/$PROJECT/topics/gmail-inbox,TASK_QUEUE=projects/$PROJECT/locations/$REGION/queues/filing-jobs,CALLER_SERVICE_ACCOUNT=$CALLER,GOOGLE_OAUTH_CREDENTIALS_PATH=/secrets/oauth/client.json,GOOGLE_OAUTH_TOKEN_PATH=/secrets/token/token.json" --set-secrets="DATABASE_URL=senpilot-database-url:latest,OPENAI_API_KEY=senpilot-openai-key:latest,/secrets/oauth/client.json=senpilot-google-oauth:latest,/secrets/token/token.json=senpilot-google-token:latest"
URL=$(gc run services describe senpilot-agent --region="$REGION" --format='value(status.url)')
gc run services update senpilot-agent --region="$REGION" --update-env-vars="SERVICE_URL=$URL"
gc run services add-iam-policy-binding senpilot-agent --region="$REGION" --member="serviceAccount:$CALLER" --role=roles/run.invoker >/dev/null
if gc pubsub subscriptions describe gmail-inbox-push >/dev/null 2>&1; then
  gc pubsub subscriptions modify-push-config gmail-inbox-push --push-endpoint="$URL/inbox" --push-auth-service-account="$CALLER" --push-auth-token-audience="$URL"
else
  gc pubsub subscriptions create gmail-inbox-push --topic=gmail-inbox --push-endpoint="$URL/inbox" --push-auth-service-account="$CALLER" --push-auth-token-audience="$URL" --ack-deadline=60 --min-retry-delay=10s --max-retry-delay=300s --message-retention-duration=1d
fi
if gc scheduler jobs describe maintain-agent --location="$REGION" >/dev/null 2>&1; then ACTION=update; else ACTION=create; fi
gc scheduler jobs "$ACTION" http maintain-agent --location="$REGION" --schedule='*/10 * * * *' --uri="$URL/maintain" --http-method=POST --message-body='{}' --headers=Content-Type=application/json --oidc-service-account-email="$CALLER" --oidc-token-audience="$URL" --attempt-deadline=180s
gc scheduler jobs run maintain-agent --location="$REGION"
echo "Deployed $URL"
