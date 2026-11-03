"use client";
import { createAuthClient } from "better-auth/react";
export const authClient = createAuthClient();

// Clear the router cache and in-memory chat state when the account changes.
export function reloadAfterAuth(destination: "/" | "/login") {
  window.location.assign(new URL(destination, window.location.origin).href);
}
