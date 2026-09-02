// Gitclaw lifecycle glue — re-exports from the local runtime source.
// Per-repo customization (system prompts) lives in main.ts / qa_sdet.ts.

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
  REPO_ROOT,
} from "../src/index.ts";

export type {
  EventInfo,
  Finding,
  ReviewResult,
  ProjectConfig,
} from "../src/index.ts";
