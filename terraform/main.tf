terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  profile = var.aws_profile
  region  = var.region
}

# ── S3 bucket for payloads + results ──────────────────────────────────────
resource "aws_s3_bucket" "render" {
  bucket_prefix = "flight-render-"
  force_destroy = true
}

resource "aws_s3_bucket_lifecycle_configuration" "render" {
  bucket = aws_s3_bucket.render.id
  rule {
    id     = "expire-old"
    status = "Enabled"
    filter {}
    expiration { days = 7 }
  }
}

# ── IAM ───────────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "render_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "render_s3" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.render.arn}/*"]
  }
}

resource "aws_iam_role" "render" {
  name_prefix        = "flight-render-"
  assume_role_policy = data.aws_iam_policy_document.render_assume.json
}

resource "aws_iam_role_policy" "render_s3" {
  name   = "s3-access"
  role   = aws_iam_role.render.id
  policy = data.aws_iam_policy_document.render_s3.json
}

resource "aws_iam_role_policy_attachment" "render_ssm" {
  role       = aws_iam_role.render.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "render" {
  name_prefix = "flight-render-"
  role        = aws_iam_role.render.name
}

# ── Security group ────────────────────────────────────────────────────────
resource "aws_security_group" "render" {
  name_prefix = "flight-render-"
  description = "Blender render box"
  dynamic "ingress" {
    for_each = var.key_name == "" ? [] : [var.ssh_cidr]
    content {
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
      description = "SSH for monitoring"
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ── User data ─────────────────────────────────────────────────────────────
data "cloudinit_config" "render" {
  gzip          = false
  base64_encode = true
  part {
    content_type = "text/x-shellscript"
    content = templatefile("${path.module}/user-data.sh", {
      s3_bucket        = aws_s3_bucket.render.bucket
      s3_payload_key   = var.payload_key
      s3_result_key    = var.result_key
      blender_version  = var.blender_version
      render_samples   = var.render_samples
      setup_script_b64 = filebase64("${path.module}/render-host-setup.sh")
    })
  }
}

resource "aws_s3_object" "payload" {
  bucket       = aws_s3_bucket.render.id
  key          = var.payload_key
  source       = abspath(var.payload_path)
  source_hash  = filemd5(abspath(var.payload_path))
  content_type = "application/gzip"
}

# ── GPU render AMI ────────────────────────────────────────────────────────
data "aws_ami" "render" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)*"]
  }
}

locals {
  render_ami_id = var.ami_id == "" ? data.aws_ami.render.id : var.ami_id
}

# ── EC2 instance ──────────────────────────────────────────────────────────
resource "aws_instance" "render" {
  ami                                  = local.render_ami_id
  instance_type                        = var.instance_type
  iam_instance_profile                 = aws_iam_instance_profile.render.name
  vpc_security_group_ids               = [aws_security_group.render.id]
  key_name                             = var.key_name == "" ? null : var.key_name
  user_data_base64                     = data.cloudinit_config.render.rendered
  user_data_replace_on_change          = true
  instance_initiated_shutdown_behavior = "terminate"

  dynamic "instance_market_options" {
    for_each = var.spot_price == "" ? [] : [var.spot_price]
    content {
      market_type = "spot"
      spot_options {
        max_price                      = instance_market_options.value
        spot_instance_type             = "one-time"
        instance_interruption_behavior = "terminate"
      }
    }
  }
  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size_gb
  }

  depends_on = [aws_s3_object.payload]

  tags = { Name = "flight-blender-render" }
}
