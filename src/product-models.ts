/**
 * Pipelex-product wire models — the snake_case JSON shapes the hosted-product
 * routes (`/v1/me`, `/v1/methods`, `/v1/organizations`, `/v1/billing/*`,
 * `/v1/pipelex-api-keys`, `/v1/gateway-api-key`, `/v1/onboarding/submit`,
 * `/v1/resolve-storage-url`, `/v1/upload`, `/v1/runs`) speak.
 *
 * These are the management surface a consumer (today `pipelex-app`) hand-rolls.
 * The wire is snake_case; any camelCase remap is a consumer's UI concern and
 * stays in the consumer. Each model holds only the fields the product actually
 * consumes — not a speculative mirror of every server field.
 */

import type { RunStatus } from "./runs.js";

// ── User profile (`/v1/me`) ─────────────────────────────────────────────

export interface UserProfile {
  email: string;
  user_id: string;
  full_name: string;
  /** ISO timestamp the user completed onboarding; absent/null until they do. */
  onboarding_completed_at?: string | null;
}

// ── Methods catalog (`/v1/methods`) ──────────────────────────────────────

export interface MethodData {
  method_id: string;
  org_id: string;
  created_by_user_id: string;
  name: string;
  /** The `.mthds` bundle source. */
  mthds: string;
  input_data?: Record<string, unknown> | null;
  /** Legacy persisted output spec; optional. */
  pipe_output?: Record<string, unknown> | null;
  /**
   * Server-derived from the bundle's top-level `description` — read-side only,
   * present on GET/list responses, absent from the write contract.
   */
  description?: string | null;
  created_at: string;
  updated_at: string;
}

/** The create/update payload — a rename is a `PUT` with a changed `name`. */
export interface MethodWriteInput {
  name: string;
  mthds: string;
  input_data?: Record<string, unknown> | null;
}

// ── Organizations (`/v1/organizations`) ──────────────────────────────────

export interface Membership {
  org_id: string;
  /** Null for the implicit personal org (no backing WorkOS organization). */
  workos_organization_id: string | null;
  name: string;
  is_personal: boolean;
  role_in_org: "admin" | "member";
}

export interface MembershipsResponse {
  memberships: Membership[];
  active_org_feature_flags: string[];
}

// ── Billing (`/v1/billing/*`) ────────────────────────────────────────────

export interface SubscriptionResponse {
  plan: string | null;
  status: string | null;
  can_use_service: boolean;
  renews_at?: string | null;
  ends_at?: string | null;
}

export interface PlanView {
  slug: string;
  name: string;
  price_display: string;
  monthly_price_cents: number;
  period: string;
  features: string[];
  highlight: boolean;
  is_current: boolean;
}

export interface InvoiceView {
  id: string;
  created_at: string;
  status: string;
  amount_cents: number;
  currency: string;
  card_brand: string | null;
  card_last_four: string | null;
  refunded: boolean;
  download_url: string | null;
}

export interface CheckoutResponse {
  checkout_url?: string;
}

export interface ChangePlanResponse {
  plan?: string;
  status?: string;
  charged_immediately?: boolean;
  resumed?: boolean;
}

export interface BillingPortalResponse {
  portal_url?: string;
}

// ── Pipelex API keys (`/v1/pipelex-api-keys`, `plx_sk_…`) ────────────────

export interface PipelexApiKey {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

/** The create/rotate response — the plaintext `api_key` is returned ONCE. */
export interface PipelexApiKeyCreated {
  api_key: string;
  id: string;
  label: string;
  prefix: string;
  created_at: string;
}

export interface PipelexApiKeyList {
  keys: PipelexApiKey[];
}

// ── Gateway API key (`/v1/gateway-api-key`, Portkey/LLM inference key) ────

export interface GatewayApiKey {
  gateway_api_key: string;
  budget_usd?: number;
}

export interface GatewayApiKeyStatus {
  /** Null until a gateway key has been provisioned. */
  gateway_api_key: string | null;
}

// ── Onboarding (`/v1/onboarding/submit`) ─────────────────────────────────

export type OnboardingRole = "developer" | "founder" | "data_scientist" | "researcher" | "other";
export type OnboardingCurrentTool =
  "langchain" | "crewai" | "llamaindex" | "custom" | "none" | "other";
export type OnboardingInputType =
  "documents" | "images" | "videos" | "audio" | "structured_data" | "text";
export type OnboardingHeardFrom =
  "twitter" | "youtube" | "hackernews" | "discord" | "friend" | "google" | "conference" | "other";

export interface OnboardingSubmission {
  role: OnboardingRole;
  company?: string;
  use_case: string;
  process_to_transform: string;
  input_types: OnboardingInputType[];
  material_domain: string;
  current_tool: OnboardingCurrentTool;
  current_tool_other?: string;
  heard_from: OnboardingHeardFrom;
}

// ── Storage (`/v1/resolve-storage-url`, `/v1/upload`) ────────────────────

export interface ResolvedStorageUrl {
  url: string;
  expires_at: string;
  content_type: string | null;
}

/** Upload payload — base64 `data` (the multipart hop is browser→BFF only). */
export interface UploadInput {
  filename: string;
  data: string;
  content_type: string;
}

export interface UploadedFile {
  uri: string;
  filename: string;
}

// ── Runs list / update (`/v1/runs`) ──────────────────────────────────────
//
// The run-lifecycle status/results/start routes already live on the client
// (`runs.ts`); these are the remaining catalog-style list + admin-update routes.

/** Per-pipe progress marker surfaced in a run's `pipe_statuses` map. */
export type PipeStatus = "scheduled" | "running" | "succeeded" | "failed" | "skipped";

export interface PipelineRun {
  pipeline_run_id: string;
  method_id: string;
  pipe_code: string;
  workflow_id?: string | null;
  status: RunStatus;
  result_url?: string | null;
  pipe_statuses?: Record<string, PipeStatus> | null;
  created_at: string;
  finished_at?: string | null;
}

/** The admin/manual run-status patch — `status` is a free string here. */
export interface UpdateRunInput {
  status: string;
  result_url?: string;
  finished_at?: string;
}
