# ZerithDB Cloud Run Embedding Service

Minimal FastAPI service for generating text embeddings, deployable to Google Cloud Run via Terraform.

## Quick Start (Local)

```bash
# Build
docker build -t zerithdb-embedding .

# Run
docker run --rm -p 8080:8080 zerithdb-embedding

# Test
curl http://localhost:8080/health
curl -X POST http://localhost:8080/embed \
  -H "Content-Type: application/json" \
  -d '{"texts": ["hello world"]}'
```

## Deploy to Cloud Run

See the full deployment guide: [docs/deploy-cloud-run.md](../../docs/deploy-cloud-run.md)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (used by Cloud Run probes) |
| `POST` | `/embed` | Generate embeddings for a list of texts |

### `POST /embed`

**Request:**
```json
{
  "texts": ["ZerithDB is a local-first database", "Hello world"]
}
```

**Response:**
```json
{
  "embeddings": [[0.012, -0.034, ...], [0.056, 0.078, ...]],
  "model": "all-MiniLM-L6-v2",
  "dimensions": 384
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | Sentence-transformers model name |
| `PORT` | `8080` | Server port (auto-set by Cloud Run) |

## Directory Structure

```
cloud-run-embedding/
├── app/
│   ├── main.py              # FastAPI application
│   └── requirements.txt     # Python dependencies
├── terraform/
│   ├── main.tf              # Cloud Run + Artifact Registry
│   ├── variables.tf         # Input variables
│   ├── outputs.tf           # Deployment outputs
│   ├── providers.tf         # Google provider config
│   └── terraform.tfvars.example
├── Dockerfile               # Multi-stage build
├── .dockerignore
└── README.md                # This file
```
