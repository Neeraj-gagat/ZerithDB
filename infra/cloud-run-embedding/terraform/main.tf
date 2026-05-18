# ============================================================
# Google Artifact Registry — Docker image repository
# ============================================================
resource "google_artifact_registry_repository" "embedding_repo" {
  location      = var.gcp_region
  repository_id = "zerithdb-ai"
  description   = "Docker images for ZerithDB AI services"
  format        = "DOCKER"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"

    most_recent_versions {
      keep_count = 5
    }
  }
}

# ============================================================
# Cloud Run Service — Embedding API
# ============================================================
resource "google_cloud_run_v2_service" "embedding_service" {
  name     = var.service_name
  location = var.gcp_region

  deletion_protection = false

  template {
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = "${var.gcp_region}-docker.pkg.dev/${var.gcp_project_id}/${google_artifact_registry_repository.embedding_repo.repository_id}/${var.service_name}:${var.image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      env {
        name  = "EMBEDDING_MODEL"
        value = var.embedding_model
      }

      # Cloud Run startup probe
      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 10
        period_seconds        = 5
        failure_threshold     = 10
      }

      # Cloud Run liveness probe
      liveness_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        period_seconds = 30
      }
    }

    max_instance_request_concurrency = var.concurrency
  }
}

# ============================================================
# IAM — Public access (optional, controlled by variable)
# ============================================================
resource "google_cloud_run_v2_service_iam_member" "public_access" {
  count = var.allow_unauthenticated ? 1 : 0

  project  = google_cloud_run_v2_service.embedding_service.project
  location = google_cloud_run_v2_service.embedding_service.location
  name     = google_cloud_run_v2_service.embedding_service.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
