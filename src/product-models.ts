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

import type { MethodFile } from "mthds/protocol";

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
  /**
   * Custom-PipeFunc Python sources, as `MethodFile[]` (`{ name, content }`). On
   * the wire this is the serialized `[{ name, content }]` catalog string (empty
   * `""` when the method has no custom Python); the client (de)serializes it via
   * `mthds/protocol`'s `parseMethodFiles`/`serializeMethodFiles`, so callers work
   * with the typed array. Empty array when the method has no custom Python.
   * Returned on both get and list.
   */
  python?: MethodFile[];
  input_data?: Record<string, unknown> | null;
  /** Legacy persisted output spec; optional. */
  pipe_output?: Record<string, unknown> | null;
  /**
   * Derived from the bundle's top-level `description`. Read-side only: the
   * server recomputes it from the bundle on every save, so it never appears on
   * the write contract.
   */
  description?: string | null;
  created_at: string;
  updated_at: string;
}

/** Where a method is in the erasure cascade; absent on a normal method. */
export type MethodDeletionState = "pending" | "in_progress" | "failed";

/**
 * One row of the method LIST — deliberately much smaller than `MethodData`.
 *
 * The list is served from a narrow DynamoDB index projection, so `mthds` and
 * `python` are **not here and never will be**. That is the whole point: the
 * previous list returned every method's full bundle, hit DynamoDB's 1 MB page
 * cap at a couple hundred methods and silently returned a SHORT ARRAY —
 * methods vanished from the UI with no error at all. Use `getMethod(id)` when
 * you need the bundle.
 *
 * `updated_at` is absent by design too. The catalog is ordered by `created_at`
 * (immutable — over a mutable sort key a cursor duplicates and skips rows), and
 * displaying a different timestamp from the one it sorts by makes "newest
 * first" unreadable.
 */
export interface MethodSummary {
  method_id: string;
  name: string;
  description?: string | null;
  created_at: string;
  /**
   * Set while an erasure cascade is running. A method mid-deletion stays IN the
   * list — so the UI can render it as "Deleting…" — while `getMethod` refuses
   * it with a 409.
   */
  deletion_state?: MethodDeletionState | null;
}

export interface ListMethodsQuery {
  /**
   * Case-insensitive substring match over a method's name and description,
   * applied SERVER-side across the whole catalog. Filtering one page
   * client-side would be searching 50 of 10,000 and calling it a search.
   */
  q?: string;
  /** Page size. The API defaults to 50 and caps at 200. */
  limit?: number;
  /** Opaque `nextCursor` from the previous page. */
  cursor?: string;
}

/**
 * One page of the method catalog, newest first.
 *
 * `nextCursor` is opaque — pass it straight back to `listMethods` to continue;
 * `null` means this was the last page. There is deliberately no total:
 * counting would mean reading the whole catalog, which is the cost paging
 * exists to avoid.
 */
export interface MethodPage {
  items: MethodSummary[];
  nextCursor: string | null;
}

/** The create/update payload — a rename is a `PUT` with a changed `name`. */
export interface MethodWriteInput {
  name: string;
  mthds: string;
  /**
   * Custom-PipeFunc Python as `MethodFile[]`. Three-way on a `PUT`: **omit**
   * (`undefined`) preserves the stored Python (the client sends nothing, the
   * server treats absent as "not sent"); an **empty array** `[]` clears it (the
   * client serializes to `""`); a **non-empty array** replaces it. It is a
   * replace, not a merge — send the full set on a save that intends to change it.
   */
  python?: MethodFile[];
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

/**
 * The runner's structured failure report, as stored on a terminal-failed run.
 *
 * The wire payload carries the full VERBOSE `ErrorReport`; these are the two
 * fields a consumer can rely on. Optional throughout: the shape is owned by the
 * runner, and a failure whose callback carried no report has none of it.
 */
export interface RunErrorReport {
  message?: string;
  error_type?: string;
  [key: string]: unknown;
}

export interface PipelineRun {
  pipeline_run_id: string;
  /** `null` on an ad-hoc run — one started from an inline bundle belongs to no
   *  stored method, and is reachable only by id. The API models this as
   *  `str | None`, so narrow it before using it as a key. */
  method_id: string | null;
  /** `null` when the runner resolved the pipe from the bundle's `main_pipe`
   *  rather than being told which one to run. */
  pipe_code: string | null;
  org_id?: string;
  /** Who started it — denormalised so attribution needs no extra lookup. */
  created_by_user_id?: string;
  workflow_id?: string | null;
  status: RunStatus;
  result_url?: string | null;
  pipe_statuses?: Record<string, PipeStatus> | null;
  created_at: string;
  finished_at?: string | null;
  /** Present only on a failed run whose completion callback carried a report.
   *  This is how a consumer tells the user WHY a run failed rather than showing
   *  a generic message. */
  error?: RunErrorReport | null;
}

/**
 * A single run, whole — `GET /v1/runs/{id}`.
 *
 * `mthds_contents` is what the run ACTUALLY executed, and it is the only record
 * of that: a caller may run an editor buffer that was never saved, so the stored
 * method can have moved on since — or never existed, for an ad-hoc run.
 *
 * Both fields are deliberately absent from the list and from the polled status
 * read: together they are the run's whole source, tens of KB, which would be
 * multiplied by the page size on one and by the poll rate on the other.
 */
export interface RunDetail extends PipelineRun {
  /** One entry PER `.mthds` FILE, not one bundle string — the same array shape
   *  the protocol's validate call takes and echoes back. A single-file method
   *  is an array of one. */
  mthds_contents?: string[] | null;
  /** The inputs the run was started with, as sent. */
  inputs?: Record<string, unknown> | null;
}

/** Query for one page of run history. */
export interface ListRunsQuery {
  /**
   * Only runs created at or after this INSTANT — ISO-8601 with a UTC offset
   * (`2026-06-02T00:00:00+09:00`). Inclusive. A bare `YYYY-MM-DD` or a naive
   * timestamp is rejected by the API: only the caller knows which timezone's
   * day it means, so convert your own day boundaries to instants.
   */
  createdFrom?: string;
  /** Only runs created at or before this instant. Same rules as `createdFrom`. */
  createdTo?: string;
  /** Page size. The API defaults to 50 and caps at 200. */
  limit?: number;
  /** Opaque `nextCursor` from the previous page. */
  cursor?: string;
}

/**
 * One page of run history, newest first.
 *
 * `nextCursor` is opaque — pass it straight back to `listRuns` to continue;
 * `null` means this was the last page. There is deliberately no total: counting
 * would mean reading the whole history, which is the cost paging exists to
 * avoid.
 */
export interface RunPage {
  items: PipelineRun[];
  nextCursor: string | null;
}

/** The admin/manual run-status patch — `status` is a free string here. */
export interface UpdateRunInput {
  status: string;
  result_url?: string;
  finished_at?: string;
}
