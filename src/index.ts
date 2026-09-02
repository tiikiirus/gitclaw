// @gitclaw/runtime — barrel exports
// Project-agnostic Gitclaw runtime: event parsing, agent runner, review
// submission, and Cloudflare Worker LLM proxy.

// Lifecycle exports
export {
  parseEvent,
  buildStaticContext,
  createTools,
  runAgent,
  submitReview,
  submitPrReview,
  postIssueComment,
  parseJsonReview,
  parseJsonReviewSafe,
  isInsideRepo,
} from "./lifecycle";

// Re-export REPO_ROOT (constant, not a type)
export { REPO_ROOT } from "./lifecycle";

// Type exports from lifecycle
export type {
  EventInfo,
  Finding,
  ReviewResult,
  ProjectConfig,
} from "./lifecycle";

// Cloudflare Worker (default export)
export { default } from "./worker";

// Router exports
export { CascadeRouter } from "./router";
export type { RouterResult, Role } from "./router";
