# ============================================================
# ZerithDB Embedding Service — Multi-stage Docker build
# ============================================================

# Stage 1: Install dependencies
FROM python:3.11-slim AS builder

WORKDIR /build
COPY app/requirements.txt .
RUN pip install --no-cache-dir --target=/deps -r requirements.txt

# Stage 2: Runtime
FROM python:3.11-slim

# Non-root user (Cloud Run best practice)
RUN useradd --create-home --uid 1000 appuser
USER appuser

WORKDIR /app

# Copy deps from builder stage
COPY --from=builder /deps /home/appuser/.local/lib/python3.11/site-packages
ENV PYTHONPATH="/home/appuser/.local/lib/python3.11/site-packages"

# Copy application code
COPY --chown=appuser:appuser app/ .

# Pre-download the model at build time (avoids cold-start download)
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

# Cloud Run injects PORT env var (default 8080)
ENV PORT=8080
EXPOSE 8080

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
