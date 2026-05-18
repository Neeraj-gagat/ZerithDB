output "service_url" {
  description = "URL of the deployed Cloud Run embedding service"
  value       = google_cloud_run_v2_service.embedding_service.uri
}

output "artifact_registry_url" {
  description = "Artifact Registry repository URL for pushing images"
  value       = "${var.gcp_region}-docker.pkg.dev/${var.gcp_project_id}/${google_artifact_registry_repository.embedding_repo.repository_id}"
}

output "docker_push_command" {
  description = "Command to push the Docker image"
  value       = "docker push ${var.gcp_region}-docker.pkg.dev/${var.gcp_project_id}/${google_artifact_registry_repository.embedding_repo.repository_id}/${var.service_name}:${var.image_tag}"
}
