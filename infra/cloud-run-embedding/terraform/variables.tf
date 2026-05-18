# ============================================================
# Input variables for the Cloud Run embedding service
# ============================================================

variable "gcp_project_id" {
  description = "GCP project ID"
  type        = string
}

variable "gcp_region" {
  description = "GCP region for Cloud Run deployment"
  type        = string
  default     = "asia-south1"
}

variable "service_name" {
  description = "Name of the Cloud Run service"
  type        = string
  default     = "zerithdb-embedding-service"
}

variable "image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

variable "embedding_model" {
  description = "Sentence-transformers model name"
  type        = string
  default     = "all-MiniLM-L6-v2"
}

variable "memory" {
  description = "Memory allocation for the Cloud Run container"
  type        = string
  default     = "2Gi"
}

variable "cpu" {
  description = "CPU allocation for the Cloud Run container"
  type        = string
  default     = "2"
}

variable "max_instances" {
  description = "Maximum number of Cloud Run instances"
  type        = number
  default     = 3
}

variable "min_instances" {
  description = "Minimum number of Cloud Run instances (0 = scale to zero)"
  type        = number
  default     = 0
}

variable "concurrency" {
  description = "Max concurrent requests per container instance"
  type        = number
  default     = 10
}

variable "allow_unauthenticated" {
  description = "Allow unauthenticated access to the service"
  type        = bool
  default     = false
}
