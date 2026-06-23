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
    signUpSubtitle: "Set up an installation and your first zone in minutes.",
    resetTitle: "Reset your password",
    resetSubtitle: "We will email you a link to choose a new password.",
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
  onboarding: {
    title: "Set up your installation",
    subtitle: "A few steps to a working Caracal control plane.",
    steps: {
      installation: "Installation",
      zone: "First Zone",
      admin: "Administrator",
      samples: "Sample Data",
      review: "Review",
    },
  },
  dashboard: {
    title: "Dashboard",
    quickActions: "Quick actions",
    recentActivity: "Recent activity",
    auditSummary: "Audit summary",
    health: "Health",
    recommendations: "Setup recommendations",
  },
} as const;
