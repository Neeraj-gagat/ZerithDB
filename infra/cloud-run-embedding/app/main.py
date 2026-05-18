"""
ZerithDB AI Embedding Service
Minimal FastAPI app for generating text embeddings via Cloud Run.
"""

import os
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

logger = logging.getLogger("zerithdb-embedding")

# --- Configuration ---
MODEL_NAME = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
model: SentenceTransformer | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model on startup, release on shutdown."""
    global model
    logger.info(f"Loading embedding model: {MODEL_NAME}")
    model = SentenceTransformer(MODEL_NAME)
    logger.info("Model loaded successfully")
    yield
    model = None
    logger.info("Model unloaded")


app = FastAPI(
    title="ZerithDB Embedding Service",
    version="0.1.0",
    lifespan=lifespan,
)


# --- Schemas ---
class EmbedRequest(BaseModel):
    texts: list[str] = Field(
        ...,
        min_length=1,
        max_length=64,
        description="List of texts to embed (max 64)",
    )


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    dimensions: int


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool


# --- Routes ---
@app.post("/embed", response_model=EmbedResponse)
async def embed_texts(request: EmbedRequest):
    """Generate embeddings for a batch of input texts."""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    embeddings = model.encode(request.texts, normalize_embeddings=True)
    return EmbedResponse(
        embeddings=embeddings.tolist(),
        model=MODEL_NAME,
        dimensions=embeddings.shape[1],
    )


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check for Cloud Run readiness probe."""
    return HealthResponse(
        status="healthy",
        model_loaded=model is not None,
    )
