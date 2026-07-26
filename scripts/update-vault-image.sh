#!/bin/bash
# Update vault search container image with latest database
# Usage: ./update-vault-image.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_DIR="/tmp/vault-image"
DB_SOURCE="$SCRIPT_DIR/infrastructure/cloud-functions/deploy/learning_base/vault.db"
IMAGE_TAG="asia-south1-docker.pkg.dev/omniclaw-personal-assistant/cloud-run-source-deploy/serve-vault-search:full-db"

echo "=== Updating Vault Search Container Image ==="

# Create temp directory
rm -rf "$IMAGE_DIR"
mkdir -p "$IMAGE_DIR"

# Copy database and application
cp "$DB_SOURCE" "$IMAGE_DIR/vault.db"
cp "$SCRIPT_DIR/infrastructure/cloud-functions/deploy/serve_vault_search_v6.py" "$IMAGE_DIR/app.py"

# Create Dockerfile
cat > "$IMAGE_DIR/Dockerfile" << 'EOF'
FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir flask google-cloud-storage
COPY app.py .
COPY vault.db /tmp/vault.db
EXPOSE 8080
CMD ["python", "app.py"]
EOF

# Build and push
echo "Building container image..."
cd "$IMAGE_DIR"
gcloud builds submit \
  --tag "$IMAGE_TAG" \
  . 2>&1 | tail -5

echo ""
echo "=== Deploying to Cloud Run ==="
gcloud run deploy serve-vault-search \
  --image "$IMAGE_TAG" \
  --platform managed \
  --region asia-south1 \
  --memory 1G \
  --cpu 1 \
  --port 8080 \
  --timeout 900 \
  --no-traffic \
  --quiet 2>&1

echo ""
echo "Waiting for revision to be ready..."
sleep 30

echo ""
echo "=== Switching traffic ==="
gcloud run services update-traffic serve-vault-search \
  --platform managed \
  --region asia-south1 \
  --to-latest \
  2>&1 | tail -5

echo ""
echo "=== Verifying ==="
curl -s https://serve-vault-search-338789220059.asia-south1.run.app/stats

echo ""
echo "=== Done ==="