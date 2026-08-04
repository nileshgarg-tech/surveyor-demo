import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  participantCountSchema,
  surveySpecSchema,
  type SurveySpec,
} from "@/lib/domain/schemas";
import {
  SHORT_TEXT_GUIDANCE,
  SHORT_TEXT_MAX_LENGTH,
  containsContactDetails,
  durationFloorMinutes,
  durationFloorSeconds,
  finalizeSurvey,
  readableAnswerSummary,
  validateAnswers,
} from "@/lib/domain/survey";
import {
  assertLaunchCost,
  formatUsd,
  maximumAllowedTimeMinutes,
  parseProviderCents,
  rewardCents,
  roughPreviewCents,
} from "@/lib/domain/money";

const closedSurvey: SurveySpec = {
  title: "Product feedback survey",
  intro: "Tell us how the current product experience works for you.",
  estimatedMinutes: 3,
  questions: [
    {
      ref: "priority",
      type: "multiple_choice",
      title: "What matters most?",
      required: true,
      choices: ["Speed", "Clarity", "Trust"],
    },
    { ref: "helpful", type: "yes_no", title: "Was the flow helpful?", required: true },
    {
      ref: "confidence",
      type: "opinion_scale",
      title: "How confident are you?",
      required: true,
      scale: { min: 1, max: 5, leftLabel: "Not confident", rightLabel: "Very confident" },
    },
  ],
};

const surveyWithShortText: SurveySpec = {
  ...closedSurvey,
  estimatedMinutes: 1,
  questions: [
    ...closedSurvey.questions,
    {
      ref: "comment",
      type: "short_text",
      title: "What should improve?",
      required: true,
      description: SHORT_TEXT_GUIDANCE,
    },
  ],
};

function caught(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("Expected an AppError.");
}

describe("survey structure, duration, and answer safety", () => {
  it("accepts only 5, 10, or 20 participants", () => {
    expect([5, 10, 20].map((count) => participantCountSchema.parse(count))).toEqual([5, 10, 20]);
    for (const count of [0, 1, 15, 25]) {
      expect(participantCountSchema.safeParse(count).success).toBe(false);
    }
  });

  it("enforces 2–6 required questions, unique refs, unique choices, and at most one short text", () => {
    expect(surveySpecSchema.parse(closedSurvey)).toEqual(closedSurvey);
    expect(
      surveySpecSchema.safeParse({ ...closedSurvey, questions: closedSurvey.questions.slice(0, 1) }).success,
    ).toBe(false);
    expect(
      surveySpecSchema.safeParse({
        ...closedSurvey,
        questions: [...closedSurvey.questions, { ...closedSurvey.questions[0], ref: "helpful" }],
      }).success,
    ).toBe(false);
    expect(
      surveySpecSchema.safeParse({
        ...closedSurvey,
        questions: [
          {
            ...closedSurvey.questions[0],
            choices: ["Speed", "speed"],
          },
          ...closedSurvey.questions.slice(1),
        ],
      }).success,
    ).toBe(false);
    expect(
      surveySpecSchema.safeParse({
        ...surveyWithShortText,
        questions: [
          ...surveyWithShortText.questions,
          { ...surveyWithShortText.questions[3], ref: "second_comment" },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires the fixed privacy label on the only short-text question", () => {
    expect(surveySpecSchema.parse(surveyWithShortText).questions[3]).toMatchObject({
      type: "short_text",
      description: "Do not include names or contact details.",
    });
    expect(
      surveySpecSchema.safeParse({
        ...surveyWithShortText,
        questions: [
          ...surveyWithShortText.questions.slice(0, 3),
          { ...surveyWithShortText.questions[3], description: "Write anything." },
        ],
      }).success,
    ).toBe(false);
  });

  it("applies the deterministic duration floor and never lowers the model estimate", () => {
    expect(durationFloorSeconds(closedSurvey.questions)).toBe(165);
    expect(durationFloorMinutes(closedSurvey.questions)).toBe(3);
    expect(durationFloorSeconds(surveyWithShortText.questions)).toBe(240);
    expect(durationFloorMinutes(surveyWithShortText.questions)).toBe(4);

    expect(finalizeSurvey({ ...closedSurvey, estimatedMinutes: 1 }).estimatedMinutes).toBe(3);
    expect(finalizeSurvey({ ...closedSurvey, estimatedMinutes: 5 }).estimatedMinutes).toBe(5);
    expect(finalizeSurvey(surveyWithShortText).estimatedMinutes).toBe(4);
  });

  it("validates every required answer and rejects unknown refs, invalid choices, and scale overflow", () => {
    const valid = validateAnswers(closedSurvey, {
      priority: "Clarity",
      helpful: "Yes",
      confidence: 4,
    });
    expect(valid).toEqual({ priority: "Clarity", helpful: "Yes", confidence: 4 });
    expect(readableAnswerSummary(closedSurvey, valid)).toContain("What matters most?: Clarity");

    expect(
      caught(() => validateAnswers(closedSurvey, { ...valid, extra: "not expected" })),
    ).toMatchObject({ code: "BAD_REQUEST", status: 422 });
    expect(caught(() => validateAnswers(closedSurvey, { ...valid, priority: "Other" }))).toMatchObject({
      code: "BAD_REQUEST",
      status: 422,
    });
    expect(caught(() => validateAnswers(closedSurvey, { ...valid, confidence: 6 }))).toMatchObject({
      code: "BAD_REQUEST",
      status: 422,
    });
    expect(caught(() => validateAnswers(closedSurvey, { ...valid, helpful: "" }))).toMatchObject({
      code: "BAD_REQUEST",
      status: 422,
    });
  });

  it.each([
    "contact me at person@example.com",
    "call +1 (312) 555-0101",
    "visit https://example.com/path",
    "see www.example.org",
    "my page is example.io",
  ])("detects obvious contact details in short text: %s", (value) => {
    expect(containsContactDetails(value)).toBe(true);
    expect(
      caught(() =>
        validateAnswers(surveyWithShortText, {
          priority: "Trust",
          helpful: "No",
          confidence: 2,
          comment: value,
        }),
      ),
    ).toMatchObject({ code: "BAD_REQUEST", status: 422 });
  });

  it("trims valid short text and enforces the 280-character limit", () => {
    expect(SHORT_TEXT_MAX_LENGTH).toBe(280);
    const answers = validateAnswers(surveyWithShortText, {
      priority: "Speed",
      helpful: "Yes",
      confidence: 5,
      comment: `  ${"a".repeat(280)}  `,
    });
    expect(answers.comment).toBe("a".repeat(280));
    expect(
      caught(() =>
        validateAnswers(surveyWithShortText, {
          priority: "Speed",
          helpful: "Yes",
          confidence: 5,
          comment: "a".repeat(281),
        }),
      ),
    ).toMatchObject({ code: "BAD_REQUEST", status: 422 });
  });
});

describe("integer money and participant-time rules", () => {
  it("computes reward and rough previews entirely in integer cents", () => {
    expect(rewardCents(3)).toBe(60);
    expect(rewardCents(1, 1_201)).toBe(21);
    expect(roughPreviewCents(5, 60)).toBe(400);
    expect(roughPreviewCents(10, 60)).toBe(800);
    expect(roughPreviewCents(20, 60)).toBe(1_600);
    expect(formatUsd(1_600)).toBe("$16.00");
    expect(formatUsd(-1)).toBe("N/A");
  });

  it("uses Prolific's documented maximum allowed time formula", () => {
    expect([1, 2, 3, 4, 5].map(maximumAllowedTimeMinutes)).toEqual([6, 9, 12, 14, 17]);
  });

  it("accepts only non-negative safe integer provider amounts", () => {
    expect(parseProviderCents(0)).toBe(0);
    expect(parseProviderCents("2500")).toBe(2_500);
    for (const value of [-1, 1.5, "1.5", "-1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(caught(() => parseProviderCents(value))).toMatchObject({ code: "SCHEMA_DRIFT" });
    }
  });

  it("permits a launch only when currency, study cap, event cap, and balance all pass", () => {
    const preflight = {
      authoritativeTotalCents: 2_500,
      currencyCode: "USD",
      availableBalanceCents: 10_000,
      checkedAt: "2026-08-03T12:00:00.000Z",
    };
    const limits = {
      expectedCurrency: "USD",
      maxStudyCents: 2_500,
      currentReservedCents: 4_000,
      lifetimeCommittedCents: 40_000,
      maxEventCents: 50_000,
    };
    expect(() => assertLaunchCost(preflight, limits)).not.toThrow();

    expect(
      caught(() => assertLaunchCost({ ...preflight, currencyCode: "GBP" }, limits)),
    ).toMatchObject({ code: "SETUP_REQUIRED" });
    expect(
      caught(() => assertLaunchCost({ ...preflight, authoritativeTotalCents: 2_501 }, limits)),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      caught(() =>
        assertLaunchCost(preflight, {
          ...limits,
          currentReservedCents: 7_501,
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      caught(() => assertLaunchCost({ ...preflight, availableBalanceCents: 2_499 }, limits)),
    ).toMatchObject({ code: "FORBIDDEN" });
  });
});

