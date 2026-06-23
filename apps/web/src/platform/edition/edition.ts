/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file declares the active product edition for the web client.
*/
export type Edition = "community" | "enterprise";

export const edition: Edition = "community";

export function isCommunity(): boolean {
  return edition === "community";
}
