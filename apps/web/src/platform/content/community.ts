/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file holds Community Edition interface copy in a structured, localizable shape.
*/
export const communityContent = {
  common: {
    productName: "Caracal",
    editionName: "Community Edition",
  },
  auth: {
    signInTitle: "Sign in to Caracal",
    signInSubtitle: "Operate your zones, policies, and agents from one place.",
    signUpTitle: "Create your Caracal account",
    signUpSubtitle: "Set up your profile and your first zone in minutes.",
    resetTitle: "Reset your password",
    resetSubtitle: "We will email you a link to choose a new password.",
    resetUnavailable:
      "Password reset is not available on this installation because no mail transport is configured. Ask your administrator to reset your password.",
    resetPasswordTitle: "Choose a new password",
    resetPasswordSubtitle: "Enter a new password for your account.",
    resetPasswordCta: "Update password",
    resetPasswordDone: "Your password has been updated. Sign in with your new password.",
    resetLinkInvalid: "This reset link is invalid or has expired. Request a new one.",
    newPasswordLabel: "New password",
    verifyEmailTitle: "Check your email",
    verifyEmailNotice: "We sent a verification link to",
    emailLabel: "Email",
    passwordLabel: "Password",
    nameLabel: "Name",
    signInCta: "Sign in",
    signUpCta: "Create account",
    resetCta: "Send reset link",
    toSignUp: "New to Caracal? Create an account",
    toSignIn: "Already have an account? Sign in",
    forgot: "Forgot your password?",
  },
} as const;
