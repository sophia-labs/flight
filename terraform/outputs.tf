output "bucket" {
  value       = aws_s3_bucket.render.bucket
  description = "S3 bucket for render payloads and results"
}

output "instance_id" {
  value       = aws_instance.render.id
  description = "EC2 instance ID"
}

output "public_ip" {
  value       = aws_instance.render.public_ip
  description = "Public IP (SSH for monitoring)"
}

output "payload_key" {
  value       = var.payload_key
  description = "S3 key of the uploaded payload"
}

output "result_key" {
  value       = var.result_key
  description = "S3 key of the rendered output"
}

output "s3_uri" {
  value       = "s3://${aws_s3_bucket.render.bucket}/${var.result_key}"
  description = "S3 URI to download the result"
}

output "security_group_id" {
  value       = aws_security_group.render.id
  description = "Security group used by render and bake instances"
}

output "instance_profile_name" {
  value       = aws_iam_instance_profile.render.name
  description = "IAM instance profile with S3 and SSM access"
}

output "render_base_ami_id" {
  value       = data.aws_ami.render.id
  description = "Latest AWS Deep Learning GPU AMI selected as the base"
}

output "render_ami_id" {
  value       = local.render_ami_id
  description = "AMI used for render instances"
}
