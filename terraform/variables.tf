variable "aws_profile" {
  description = "AWS CLI profile for credentials"
  type        = string
  default     = "terraform-user"
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type for Blender rendering"
  type        = string
  default     = "g5.xlarge"
}

variable "ami_id" {
  description = "Optional baked render AMI ID. Empty uses the latest AWS Deep Learning GPU AMI."
  type        = string
  default     = ""
}

variable "spot_price" {
  description = "Max spot price (empty = on-demand)"
  type        = string
  default     = ""
}

variable "payload_key" {
  description = "S3 key where Terraform uploads the render payload tarball"
  type        = string
}

variable "payload_path" {
  description = "Local render payload tarball path, relative to the Terraform working directory"
  type        = string
}

variable "result_key" {
  description = "S3 key to write the rendered output"
  type        = string
}

variable "blender_version" {
  description = "Blender version to install"
  type        = string
  default     = "4.2.0"
}

variable "render_samples" {
  description = "EEVEE samples per rendered frame"
  type        = number
  default     = 48
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size in GiB; GPU Deep Learning AMIs require at least 75 GiB"
  type        = number
  default     = 100
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH monitoring (empty disables SSH login)"
  type        = string
  default     = ""
}

variable "ssh_cidr" {
  description = "CIDR allowed to SSH into the render box when key_name is set"
  type        = string
  default     = "0.0.0.0/0"
}
