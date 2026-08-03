export type JsonSchema = Record<string, unknown>;

const strictObject = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const string = (options: Record<string, unknown> = {}): JsonSchema => ({ type: "string", ...options });

const questionBase = {
  ref: string({ pattern: "^[a-z][a-z0-9_]{0,31}$" }),
  title: string({ minLength: 3, maxLength: 240 }),
  required: { type: "boolean", const: true },
};

const surveyQuestionSchema: JsonSchema = {
  oneOf: [
    strictObject({
      ...questionBase,
      type: { type: "string", const: "multiple_choice" },
      description: string({ maxLength: 300 }),
      choices: { type: "array", items: string({ minLength: 1, maxLength: 100 }), minItems: 2, maxItems: 10 },
    }),
    strictObject({
      ...questionBase,
      type: { type: "string", const: "opinion_scale" },
      description: string({ maxLength: 300 }),
      scale: strictObject({
        min: { type: "integer", minimum: 0, maximum: 10 },
        max: { type: "integer", minimum: 1, maximum: 10 },
        leftLabel: string({ minLength: 1, maxLength: 60 }),
        rightLabel: string({ minLength: 1, maxLength: 60 }),
      }),
    }),
    strictObject({
      ...questionBase,
      type: { type: "string", const: "yes_no" },
      description: string({ maxLength: 300 }),
    }),
    strictObject({
      ...questionBase,
      type: { type: "string", const: "short_text" },
      description: { type: "string", const: "Do not include names or contact details." },
    }),
  ],
};

export const intakeOutputJsonSchema: JsonSchema = {
  oneOf: [
    strictObject({
      kind: { type: "string", const: "clarify" },
      question: string({ minLength: 3, maxLength: 200 }),
      missing: string({ minLength: 1, maxLength: 300 }),
    }),
    strictObject({
      kind: { type: "string", const: "ready" },
      brief: strictObject({
        title: string({ minLength: 3, maxLength: 80 }),
        researchGoal: string({ minLength: 5, maxLength: 1_000 }),
        targetAudience: string({ minLength: 2, maxLength: 500 }),
        context: string({ minLength: 1, maxLength: 1_000 }),
      }),
      survey: strictObject({
        title: string({ minLength: 3, maxLength: 80 }),
        intro: string({ minLength: 10, maxLength: 1_000 }),
        estimatedMinutes: { type: "integer", enum: [1, 2, 3, 4, 5] },
        questions: { type: "array", items: surveyQuestionSchema, minItems: 3, maxItems: 5 },
      }),
      audienceCriteria: {
        type: "array",
        items: string({ minLength: 1, maxLength: 200 }),
        minItems: 1,
        maxItems: 10,
      },
      unsupportedBooleanLogic: { type: "boolean" },
    }),
    strictObject({
      kind: { type: "string", const: "insufficient" },
      explanation: string({ minLength: 3, maxLength: 400 }),
    }),
  ],
};

const selectedFilterJsonSchema: JsonSchema = {
  oneOf: [
    strictObject({
      filterId: string({ minLength: 1 }),
      type: { type: "string", const: "select" },
      choiceIds: { type: "array", items: string({ minLength: 1 }), minItems: 1 },
    }),
    strictObject({
      filterId: string({ minLength: 1 }),
      type: { type: "string", const: "range" },
      min: { type: "number" },
      max: { type: "number" },
    }),
  ],
};

export const targetingOutputJsonSchema: JsonSchema = strictObject({
  requestedAudience: string({ minLength: 1, maxLength: 500 }),
  recruitedAudience: string({ minLength: 1, maxLength: 500 }),
  confidence: { type: "string", enum: ["high", "medium", "low"] },
  filters: { type: "array", items: selectedFilterJsonSchema, maxItems: 20 },
  proxies: {
    type: "array",
    maxItems: 10,
    items: strictObject({
      requested: string({ minLength: 1 }),
      closestSupported: string({ minLength: 1 }),
      limitation: string({ minLength: 1 }),
    }),
  },
  unsupportedCriteria: { type: "array", items: string({ minLength: 1 }), maxItems: 10 },
});

export const reportOutputJsonSchema: JsonSchema = strictObject({
  headline: string({ minLength: 3, maxLength: 180 }),
  summary: string({ minLength: 10, maxLength: 1_200 }),
  findings: { type: "array", items: string({ minLength: 3, maxLength: 400 }), minItems: 3, maxItems: 5 },
  implications: {
    type: "array",
    items: string({ minLength: 3, maxLength: 400 }),
    minItems: 2,
    maxItems: 4,
  },
  limitations: {
    type: "array",
    items: string({ minLength: 3, maxLength: 400 }),
    minItems: 1,
    maxItems: 3,
  },
});

export const readinessJsonSchema: JsonSchema = strictObject({ ok: { type: "boolean", const: true } });
