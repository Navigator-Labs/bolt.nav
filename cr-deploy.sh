#!/bin/bash

# Deployment script for bolt.nav to Cloud Run
# Usage: ./cr-deploy.sh [build|push|deploy|all]

set -e

# Configuration
PROJECT_ID=${GOOGLE_CLOUD_PROJECT:-"navlabs-ai"}
REGION=${REGION:-"us-central1"}
SERVICE_NAME=${SERVICE_NAME:-"bolt-nav"}
ARTIFACT_REGISTRY=${ARTIFACT_REGISTRY:-"us-central1-docker.pkg.dev/navlabs-ai/bolt-nav"}
IMAGE_URI="$ARTIFACT_REGISTRY/$SERVICE_NAME:latest"

# Parse command line argument
COMMAND=${1:-"all"}

# Function to display usage
usage() {
    echo "Usage: $0 [build|push|deploy|all]"
    echo ""
    echo "Commands:"
    echo "  build   - Build the Docker image locally"
    echo "  push    - Push the Docker image to Artifact Registry"
    echo "  deploy  - Deploy the service to Cloud Run"
    echo "  all     - Run all steps (default)"
    echo ""
    echo "Configuration:"
    echo "  PROJECT_ID: $PROJECT_ID"
    echo "  REGION: $REGION"
    echo "  SERVICE_NAME: $SERVICE_NAME"
    echo "  ARTIFACT_REGISTRY: $ARTIFACT_REGISTRY"
    echo "  IMAGE_URI: $IMAGE_URI"
    exit 0
}

# Function to check required variables
check_requirements() {
    if [ -z "$PROJECT_ID" ]; then
        echo "❌ Error: GOOGLE_CLOUD_PROJECT environment variable is required"
        exit 1
    fi

    if [ -z "$ARTIFACT_REGISTRY" ]; then
        echo "❌ Error: ARTIFACT_REGISTRY environment variable is required"
        echo "Format: REGION-docker.pkg.dev/PROJECT_ID/REPO_NAME"
        exit 1
    fi
}

# Function to build Docker image
build_image() {
    echo "🏗️  Building Docker image..."
    echo "📦 Building: $IMAGE_URI"

    # Enable BuildKit features and use more memory
    export DOCKER_BUILDKIT=1
    docker buildx build \
        --platform linux/amd64 \
        --target bolt-ai-production \
        --build-arg BUILDKIT_INLINE_CACHE=1 \
        --memory=20g \
        --memory-swap=24g \
        -t "$IMAGE_URI" \
        .

    echo "✅ Build complete!"
}

# Function to push Docker image
push_image() {
    echo "📤 Pushing Docker image..."
    echo "📦 Pushing: $IMAGE_URI"

    docker push "$IMAGE_URI"

    echo "✅ Push complete!"
}

# Function to deploy to Cloud Run
deploy_service() {
    echo "🚀 Deploying to Cloud Run..."
    echo "📝 Note: This deployment expects the following secrets to be configured in Secret Manager:"
    echo "   - bolt-nav-anthropic-api-key (ANTHROPIC_API_KEY)"
   echo "   See CLOUD_RUN_SECRETS.md for setup instructions."
    echo ""

    gcloud run deploy "$SERVICE_NAME" \
        --service-account="vero-demo@navlabs-ai.iam.gserviceaccount.com" \
        --image="$IMAGE_URI" \
        --platform=managed \
        --region="$REGION" \
        --allow-unauthenticated \
        --memory=2Gi \
        --cpu=2 \
        --min-instances=0 \
        --max-instances=2 \
        --timeout=3600 \
        --set-env-vars="NODE_ENV=production,WRANGLER_SEND_METRICS=false" \
        --update-secrets=ANTHROPIC_API_KEY=bolt-nav-anthropic-api-key:latest \
        --set-env-vars="DEFAULT_NUM_CTX=${DEFAULT_NUM_CTX:-4096}" \
        --project="$PROJECT_ID" \
        --ingress="internal-and-cloud-load-balancing"

    echo "✅ Deployment complete!"

    # Get the service URL
    SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)" --project="$PROJECT_ID")
    echo "🌐 Service URL: $SERVICE_URL"
}

# Main execution based on command
case $COMMAND in
    "help" | "-h" | "--help")
        usage
        ;;
    "build")
        check_requirements
        build_image
        ;;
    "push")
        check_requirements
        push_image
        ;;
    "deploy")
        check_requirements
        deploy_service
        ;;
    "all")
        check_requirements
        echo "🏗️  Building and deploying bolt.nav to Cloud Run..."
        echo "Project: $PROJECT_ID"
        echo "Region: $REGION"
        echo "Service: $SERVICE_NAME"
        echo "Registry: $ARTIFACT_REGISTRY"
        echo ""
        build_image
        echo ""
        push_image
        echo ""
        deploy_service
        ;;
    *)
        echo "❌ Unknown command: $COMMAND"
        echo ""
        usage
        ;;
esac
