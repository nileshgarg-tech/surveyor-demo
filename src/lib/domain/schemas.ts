import { z } from "zod";

export const participantCountSchema = z.union([z.literal(5), z.literal(10), z.literal(20)]);
export type ParticipantCount = z.infer<typeof participantCountSchema>;

export const studyBriefSchema = z
  .object({
    title: z.string().trim().min(3).max(80),
    researchGoal: z.string().trim().min(5).max(1_000),
    targetAudience: z.string().trim().min(2).max(500),
    context: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type StudyBrief = z.infer<typeof studyBriefSchema>;

const questionBase = {
  ref: z.string().trim().regex(/^[a-z][a-z0-9_]{0,31}$/),
  title: z.string().trim().min(3).max(240),
  required: z.literal(true),
};

const describedQuestion = {
  ...questionBase,
  description: z.string().trim().min(1).max(300).optional(),
};

const multipleChoiceQuestionSchema = z
  .object({
    ...describedQuestion,
    type: z.literal("multiple_choice"),
    choices: z.array(z.string().trim().min(1).max(100)).min(2).max(10),
  })
  .strict()
  .superRefine((question, context) => {
    const normalized = question.choices.map((choice) => choice.toLocaleLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({ code: "custom", path: ["choices"], message: "Choices must be unique" });
    }
  });

const opinionScaleQuestionSchema = z
  .object({
    ...describedQuestion,
    type: z.literal("opinion_scale"),
    scale: z
      .object({
        min: z.number().int().min(0).max(10),
        max: z.number().int().min(1).max(10),
        leftLabel: z.string().trim().min(1).max(60),
        rightLabel: z.string().trim().min(1).max(60),
      })
      .strict(),
  })
  .strict()
  .superRefine((question, context) => {
    if (question.scale.max <= question.scale.min || question.scale.max - question.scale.min > 10) {
      context.addIssue({ code: "custom", path: ["scale"], message: "Scale bounds are invalid" });
    }
  });

const yesNoQuestionSchema = z
  .object({
    ...describedQuestion,
    type: z.literal("yes_no"),
  })
  .strict();

const shortTextQuestionSchema = z
  .object({
    ...questionBase,
    type: z.literal("short_text"),
    description: z.literal("Do not include names or contact details."),
  })
  .strict();

export const surveyQuestionSchema = z.union([
  multipleChoiceQuestionSchema,
  opinionScaleQuestionSchema,
  yesNoQuestionSchema,
  shortTextQuestionSchema,
]);
export type SurveyQuestion = z.infer<typeof surveyQuestionSchema>;

export const surveySpecSchema = z
  .object({
    title: z.string().trim().min(3).max(80),
    intro: z.string().trim().min(10).max(1_000),
    estimatedMinutes: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
    questions: z.array(surveyQuestionSchema).min(2).max(6),
  })
  .strict()
  .superRefine((survey, context) => {
    const refs = survey.questions.map((question) => question.ref);
    if (new Set(refs).size !== refs.length) {
      context.addIssue({ code: "custom", path: ["questions"], message: "Question refs must be unique" });
    }
    if (survey.questions.filter((question) => question.type === "short_text").length > 1) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Only one short-text question is allowed",
      });
    }
  });
export type SurveySpec = z.infer<typeof surveySpecSchema>;

export const normalizedCatalogChoiceSchema = z
  .object({
    id: z.union([z.string().min(1), z.number().int()]).transform(String),
    label: z.string().trim().min(1),
  })
  .strict();

export const normalizedCatalogFilterSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    question: z.string().trim().default(""),
    category: z.string().trim().default(""),
    type: z.enum(["select", "range"]),
    choices: z.array(normalizedCatalogChoiceSchema).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    raw: z.unknown().optional(),
  })
  .strict();
export type NormalizedCatalogFilter = z.infer<typeof normalizedCatalogFilterSchema>;

export const validatedProlificFilterSchema = z.discriminatedUnion("type", [
  z
    .object({
      filterId: z.string().min(1),
      type: z.literal("select"),
      choiceIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      filterId: z.string().min(1),
      type: z.literal("range"),
      min: z.number(),
      max: z.number(),
    })
    .strict(),
]);
export type ValidatedProlificFilter = z.infer<typeof validatedProlificFilterSchema>;

export const targetingPlanSchema = z
  .object({
    status: z.enum(["exact", "proxy", "unsupported"]),
    requestedAudience: z.string().trim().min(1).max(500),
    recruitedAudience: z.string().trim().min(1).max(500),
    confidence: z.enum(["high", "medium", "low"]),
    filters: z.array(validatedProlificFilterSchema).max(20),
    proxies: z
      .array(
        z
          .object({
            requested: z.string().trim().min(1),
            closestSupported: z.string().trim().min(1),
            limitation: z.string().trim().min(1),
          })
          .strict(),
      )
      .max(10),
    unsupportedCriteria: z.array(z.string().trim().min(1)).max(10),
    availability: z
      .object({
        reportedCount: z.number().int().min(0),
        privacyCensoredBelow25: z.boolean(),
        checkedAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    if (
      plan.status === "exact" &&
      (plan.confidence !== "high" || plan.proxies.length > 0 || plan.unsupportedCriteria.length > 0)
    ) {
      context.addIssue({ code: "custom", path: ["status"], message: "Exact targeting must be complete" });
    }
    if ((plan.proxies.length > 0 || plan.confidence !== "high") && plan.status === "exact") {
      context.addIssue({ code: "custom", path: ["status"], message: "Approximation must be marked proxy" });
    }
    if (plan.status === "proxy" && plan.proxies.length === 0) {
      context.addIssue({ code: "custom", path: ["proxies"], message: "Proxy targeting needs a limitation" });
    }
    if (plan.status === "unsupported" && plan.unsupportedCriteria.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["unsupportedCriteria"],
        message: "Unsupported targeting must identify every unsupported criterion",
      });
    }
    if (plan.availability.reportedCount === 0 && !plan.availability.privacyCensoredBelow25) {
      context.addIssue({
        code: "custom",
        path: ["availability", "privacyCensoredBelow25"],
        message: "A zero count must preserve Prolific's privacy-censored semantics",
      });
    }
  });
export type TargetingPlan = z.infer<typeof targetingPlanSchema>;

export const answerValueSchema = z.union([z.string(), z.number().int()]);
export const answersSchema = z.record(z.string(), answerValueSchema);
export type SurveyAnswers = z.infer<typeof answersSchema>;

export const reportNarrativeSchema = z
  .object({
    headline: z.string().trim().min(3).max(180),
    summary: z.string().trim().min(10).max(1_200),
    findings: z.array(z.string().trim().min(3).max(400)).min(3).max(5),
    implications: z.array(z.string().trim().min(3).max(400)).min(2).max(4),
    limitations: z.array(z.string().trim().min(3).max(400)).min(1).max(3),
  })
  .strict();
export type ReportNarrative = z.infer<typeof reportNarrativeSchema>;

export const studyStatusSchema = z.enum([
  "draft",
  "launching",
  "reconciling",
  "collecting",
  "ready_to_report",
  "reporting",
  "complete",
  "blocked",
  "abandoned",
  "cancelled",
]);
export type StudyStatus = z.infer<typeof studyStatusSchema>;

export const intakeMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type IntakeMessage = z.infer<typeof intakeMessageSchema>;

export const intakeStateSchema = z
  .object({
    messages: z.array(intakeMessageSchema).max(10),
    previousInteractionId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.messages.filter((message) => message.role === "user").length > 5) {
      context.addIssue({ code: "custom", path: ["messages"], message: "Maximum five user messages" });
    }
  });
export type IntakeState = z.infer<typeof intakeStateSchema>;

export const intakeModelResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("clarify"),
      question: z.string().trim().min(3).max(200),
      missing: z.string().trim().min(1).max(300),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ready"),
      brief: studyBriefSchema,
      survey: surveySpecSchema,
      audienceCriteria: z.array(z.string().trim().min(1)).min(1).max(10),
      unsupportedBooleanLogic: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("insufficient"),
      explanation: z.string().trim().min(3).max(400),
    })
    .strict(),
]);
export type IntakeModelResult = z.infer<typeof intakeModelResultSchema>;
