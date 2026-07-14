/**
 * Consult — standalone multi-model Q&A orchestration (workspace-independent).
 *
 * Pure orchestration over a NARROW gateway interface (mirrors reformulate.ts's
 * ReformulateGateway) so this module never imports the heavy Gateway class and
 * is trivially testable with a fake. No DB, no HTTP, no auth — the route layer
 * owns persistence and access control; this file only turns a question + a set
 * of model slugs into answers.
 *
 * Fail-soft is the core contract: one model failing (throwing, timing out, or
 * returning empty) produces an errorMessage for THAT model only and never fails
 * the batch — the operator still gets every other model's answer.
 */

/** The single gateway method this service needs (structurally compatible with Gateway). */
export interface ConsultGateway {
  completeStreaming(
    request: {
      modelSlug: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      maxTokens?: number;
    },
    privacyOptions?: unknown,
    loggingOptions?: unknown,
    streamOptions?: { overallTimeoutMs?: number },
  ): Promise<{ content: string }>;
}

/** One model's output for a single round — content XOR errorMessage. */
export interface ConsultModelAnswer {
  modelSlug: string;
  content: string | null;
  errorMessage: string | null;
}

const ADVISOR_SYSTEM =
  "You are a concise infrastructure & software-architecture advisor. Answer the " +
  "operator's question directly: lead with a clear recommendation, then the key " +
  "trade-offs and caveats. Prefer specifics over generalities. Do not ask " +
  "clarifying questions — reason from the stated assumptions.";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 2048;
const TEMPERATURE = 0.4;
const EMPTY_ANSWER = "the model returned an empty answer";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Turn settled gateway results into fail-soft answers, order preserved. */
function finalizeAnswers(
  settled: PromiseSettledResult<{ content: string }>[],
  modelSlugs: string[],
): ConsultModelAnswer[] {
  return settled.map((r, i) => {
    const modelSlug = modelSlugs[i];
    if (r.status === "rejected") {
      return { modelSlug, content: null, errorMessage: errText(r.reason) };
    }
    const content = r.value.content?.trim();
    if (!content) {
      return { modelSlug, content: null, errorMessage: EMPTY_ANSWER };
    }
    return { modelSlug, content, errorMessage: null };
  });
}

/**
 * Ask each selected model the question INDEPENDENTLY, in parallel. Returns one
 * answer per input slug, in input order.
 */
export async function answerIndependently(
  gateway: ConsultGateway,
  question: string,
  modelSlugs: string[],
  opts: { timeoutMs?: number } = {},
): Promise<ConsultModelAnswer[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settled = await Promise.allSettled(
    modelSlugs.map((modelSlug) =>
      gateway.completeStreaming(
        {
          modelSlug,
          messages: [
            { role: "system", content: ADVISOR_SYSTEM },
            { role: "user", content: question },
          ],
          temperature: TEMPERATURE,
          maxTokens: MAX_TOKENS,
        },
        undefined,
        undefined,
        { overallTimeoutMs: timeoutMs },
      ),
    ),
  );
  return finalizeAnswers(settled, modelSlugs);
}

function buildDebatePrompt(
  question: string,
  self: string,
  others: Array<{ modelSlug: string; content: string }>,
): string {
  const peer = others.length
    ? others.map((o) => `### Peer model ${o.modelSlug} answered:\n${o.content}`).join("\n\n")
    : "(no other answers available)";
  return [
    `Original question:\n${question}`,
    "",
    "Your own previous answer:",
    self || "(you did not produce a usable answer)",
    "",
    "Other models' answers:",
    peer,
    "",
    "Now critique the other answers where you disagree, concede where they are " +
      "stronger, and give your refined final recommendation. Be explicit about what " +
      "you changed and why.",
  ].join("\n");
}

/**
 * One debate round: each model sees the OTHER models' latest answers (and its
 * own) and returns a refined recommendation. Same fail-soft contract.
 */
export async function debate(
  gateway: ConsultGateway,
  question: string,
  priorAnswers: ConsultModelAnswer[],
  modelSlugs: string[],
  opts: { timeoutMs?: number } = {},
): Promise<ConsultModelAnswer[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const byModel = new Map(priorAnswers.map((a) => [a.modelSlug, a]));
  const settled = await Promise.allSettled(
    modelSlugs.map((modelSlug) => {
      const self = byModel.get(modelSlug)?.content ?? "";
      const others = priorAnswers
        .filter((a) => a.modelSlug !== modelSlug && a.content)
        .map((a) => ({ modelSlug: a.modelSlug, content: a.content as string }));
      return gateway.completeStreaming(
        {
          modelSlug,
          messages: [
            { role: "system", content: ADVISOR_SYSTEM },
            { role: "user", content: buildDebatePrompt(question, self, others) },
          ],
          temperature: TEMPERATURE,
          maxTokens: MAX_TOKENS,
        },
        undefined,
        undefined,
        { overallTimeoutMs: timeoutMs },
      );
    }),
  );
  return finalizeAnswers(settled, modelSlugs);
}

/**
 * Build the editable objective handed to the consilium loop on step 3. Carries
 * the question plus each model's latest usable answer; the FE prefills this and
 * the operator may trim/edit before starting the loop.
 */
export function buildHandoffInstruction(
  question: string,
  answers: ConsultModelAnswer[],
): string {
  const usable = answers.filter((a) => a.content);
  const body = usable.length
    ? usable.map((a) => `## ${a.modelSlug}\n${a.content}`).join("\n\n")
    : "(no model answers were captured)";
  return [
    `# Consult question\n${question}`,
    "",
    "# Model answers",
    body,
    "",
    "# Task",
    "Using the question and the model answers above as context, implement the " +
      "recommended approach. Validate the assumptions against the actual repository " +
      "before making changes.",
  ].join("\n");
}
