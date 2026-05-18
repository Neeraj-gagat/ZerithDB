# Deploying the AI Embedding Service to Google Cloud Run

> Step-by-step guide to deploy ZerithDB's containerized Python FastAPI embedding service to GCP
> Cloud Run using Terraform.

---

## Prerequisites

| Tool                         | Min Version | Install                                                      |
| ---------------------------- | ----------- | ------------------------------------------------------------ |
| Google Cloud SDK (`gcloud`)  | latest      | [cloud.google.com/sdk](https://cloud.google.com/sdk/docs/install) |
| Terraform                    | >= 1.5.0    | [terraform.io](https://developer.hashicorp.com/terraform/downloads) |
| Docker                       | >= 24.x     | [docker.com](https://docs.docker.com/get-docker/)            |
| Python (optional, for local) | >= 3.11     | [python.org](https://www.python.org/downloads/)              |

You also need a GCP project with billing enabled.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│ Developer Machine                                                │
│                                                                  │
│  infra/cloud-run-embedding/                                      │
│  ├── app/main.py          ← FastAPI embedding service            │
│  ├── Dockerfile           ← Multi-stage build                    │
│  └── terraform/           ← Infrastructure as Code               │
└──────────┬───────────────────────────────────────────────────────┘
           │
           │ docker build + push
           ▼
┌──────────────────────────┐
│  Google Artifact Registry │ ← Stores Docker images
└──────────┬───────────────┘
           │
           │ terraform apply
           ▼
┌──────────────────────────┐
│  Google Cloud Run         │ ← Serverless container hosting
│                           │
│  GET  /health             │ ← Readiness probe
│  POST /embed              │ ← Embedding generation
└───────────────────────────┘
```

---

## Step 1: GCP Project Setup

Authenticate and enable the required APIs:

```bash
# Authenticate with GCP
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
```

---

## Step 2: Build the Docker Image

```bash
cd infra/cloud-run-embedding

# Build the image (this will also pre-download the ML model)
docker build -t zerithdb-embedding .
```

> **Note:** The first build takes 5-10 minutes because it downloads the `all-MiniLM-L6-v2` model
> (~80MB) and bakes it into the image. Subsequent builds use the Docker cache.

---

## Step 3: Test Locally

Before deploying, verify the service works locally:

```bash
# Run the container
docker run --rm -p 8080:8080 zerithdb-embedding

# In another terminal:

# Health check
curl http://localhost:8080/health
# Expected: {"status":"healthy","model_loaded":true}

# Generate embeddings
curl -X POST http://localhost:8080/embed \
  -H "Content-Type: application/json" \
  -d '{"texts": ["ZerithDB is a local-first database", "Hello world"]}'
# Expected: {"embeddings": [[...], [...]], "model": "all-MiniLM-L6-v2", "dimensions": 384}
```

---

## Step 4: Push to Google Artifact Registry

```bash
# Configure Docker to authenticate with Artifact Registry
gcloud auth configure-docker asia-south1-docker.pkg.dev

# Tag the image for Artifact Registry
docker tag zerithdb-embedding \
  asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/zerithdb-ai/zerithdb-embedding-service:latest

# Push
docker push \
  asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/zerithdb-ai/zerithdb-embedding-service:latest
```

> **Important:** The Artifact Registry repository (`zerithdb-ai`) is created by Terraform in the
> next step. If you want to push first, create it manually:
>
> ```bash
> gcloud artifacts repositories create zerithdb-ai \
>   --repository-format=docker \
>   --location=asia-south1
> ```

---

## Step 5: Deploy with Terraform

```bash
cd infra/cloud-run-embedding/terraform

# Copy the example config
cp terraform.tfvars.example terraform.tfvars

# Edit terraform.tfvars — set your GCP project ID
# nano terraform.tfvars  (or use your preferred editor)

# Initialize Terraform
terraform init

# Preview the changes
terraform plan

# Deploy
terraform apply
```

Terraform will create:

1. **Artifact Registry repository** (`zerithdb-ai`) — Docker image storage
2. **Cloud Run service** (`zerithdb-embedding-service`) — Serverless container
3. **IAM binding** (optional) — Public access if `allow_unauthenticated = true`

---

## Step 6: Verify the Deployment

```bash
# Get the service URL
SERVICE_URL=$(terraform output -raw service_url)
echo $SERVICE_URL

# Health check
curl $SERVICE_URL/health

# Test embedding
curl -X POST $SERVICE_URL/embed \
  -H "Content-Type: application/json" \
  -d '{"texts": ["test embedding from Cloud Run"]}'
```

---

## Environment Variables

| Variable          | Default           | Description                          |
| ----------------- | ----------------- | ------------------------------------ |
| `EMBEDDING_MODEL` | `all-MiniLM-L6-v2`| Sentence-transformers model name     |
| `PORT`            | `8080`            | Server port (auto-set by Cloud Run)  |

---

## Terraform Variables

| Variable                | Default                        | Description                                  |
| ----------------------- | ------------------------------ | -------------------------------------------- |
| `gcp_project_id`        | —                              | **Required.** Your GCP project ID            |
| `gcp_region`            | `asia-south1`                  | GCP region                                   |
| `service_name`          | `zerithdb-embedding-service`   | Cloud Run service name                       |
| `image_tag`             | `latest`                       | Docker image tag                             |
| `embedding_model`       | `all-MiniLM-L6-v2`            | Model to load                                |
| `memory`                | `2Gi`                          | Container memory                             |
| `cpu`                   | `2`                            | Container CPU                                |
| `max_instances`         | `3`                            | Max autoscaling instances                    |
| `min_instances`         | `0`                            | Min instances (0 = scale to zero)            |
| `concurrency`           | `10`                           | Max concurrent requests per instance         |
| `allow_unauthenticated` | `false`                        | Allow public access                          |

---

## Teardown

To remove all deployed resources:

```bash
cd infra/cloud-run-embedding/terraform
terraform destroy
```

---

## Troubleshooting

### Container crashes with exit code 137 (OOM)

The embedding model requires ~1.5GB RAM. Increase the memory allocation:

```hcl
# In terraform.tfvars
memory = "4Gi"
```

### Slow first request after deployment

The model loads into memory on the first request (cold start). To keep an instance warm:

```hcl
# In terraform.tfvars
min_instances = 1
```

### Docker push fails with "unauthorized"

Make sure you've configured Docker for Artifact Registry:

```bash
gcloud auth configure-docker asia-south1-docker.pkg.dev
```

### Terraform fails with "API not enabled"

Run the API enable commands from Step 1:

```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com
```

---

## What's Next

- **CI/CD:** Add a GitHub Actions workflow to auto-build and deploy on push to `main`
- **Monitoring:** Integrate Cloud Monitoring for latency/error dashboards
- **Auth:** Add API key or OAuth2 authentication middleware
- **GPU:** Use Cloud Run GPU (preview) for larger models

---

_Part of [ZerithDB](https://github.com/Zerith-Labs/ZerithDB) — the local-first, peer-to-peer
database platform._
