/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the toast context and hook shared across the Console UI.
*/
import { createContext, useContext } from "react";

export type ToastTone = "success" | "error" | "info";

export interface ToastMessage {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

export type PushToast = (toast: Omit<ToastMessage, "id">) => void;

export const ToastContext = createContext<PushToast | null>(null);

export function useToast(): PushToast {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
