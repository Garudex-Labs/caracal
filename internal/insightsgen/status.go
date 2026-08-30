// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"strings"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// Availability reports whether insight generation is configured and usable,
// with the operator-facing reason when it is not. The reason strings are a
// CLI contract ("Insights is unavailable: {reason}").
func (e *Engine) Availability(ctx context.Context) (bool, string) {
	model := e.Config.String(ctx, "insights.model_sections", "")
	if model == "" {
		return false, "No model configured. Set insights.model_sections in admin settings."
	}

	// A direct API key skips the AWS credential checks.
	apiKey := e.Config.Secret(ctx, "insights.api_key")
	if strings.Contains(model, "anthropic") && apiKey == "" {
		awsKey := e.Config.String(ctx, "insights.aws_access_key_id", "")
		awsSecret := e.Config.String(ctx, "insights.aws_secret_access_key", "")
		if awsKey == "" {
			return false, "AWS access key not configured. Set insights.aws_access_key_id in admin settings."
		}
		if awsSecret == "" {
			return false, "AWS secret key not configured. Set insights.aws_secret_access_key in admin settings."
		}
		region := e.Config.String(ctx, "insights.aws_region", "")
		if region == "" {
			region = "us-east-1"
		}
		if err := e.checkAWSCredentials(ctx, region, awsKey, awsSecret); err != nil {
			errStr := err.Error()
			switch {
			case strings.Contains(errStr, "InvalidClientTokenId") || strings.Contains(errStr, "security token"):
				return false, "AWS access key is invalid. Update insights.aws_access_key_id in admin settings."
			case strings.Contains(errStr, "SignatureDoesNotMatch"):
				return false, "AWS secret key is invalid. Update insights.aws_secret_access_key in admin settings."
			case strings.Contains(errStr, "ExpiredToken"):
				return false, "AWS credentials have expired. Update credentials in admin settings."
			default:
				return false, "AWS credential check failed. Verify your access key and secret in admin settings."
			}
		}
	}
	return true, ""
}

func (e *Engine) checkAWSCredentials(ctx context.Context, region, accessKey, secretKey string) error {
	if e.checkCredentials != nil {
		return e.checkCredentials(ctx, region, accessKey, secretKey)
	}
	return stsCallerIdentity(ctx, region, accessKey, secretKey)
}

// stsCallerIdentity validates static credentials with one lightweight call.
func stsCallerIdentity(ctx context.Context, region, accessKey, secretKey string) error {
	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")))
	if err != nil {
		return err
	}
	_, err = sts.NewFromConfig(cfg).GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	return err
}
