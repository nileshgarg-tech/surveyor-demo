import { AppError } from "@/lib/errors";
import {
  type SurveyAnswers,
  type SurveyQuestion,
  type SurveySpec,
  surveySpecSchema,
} from "@/lib/domain/schemas";

export const SHORT_TEXT_MAX_LENGTH = 280;
export const SHORT_TEXT_GUIDANCE = "Do not include names or contact details.";

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const urlPattern = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|org|net|io|co|edu|gov)\b/i;
const phonePattern = /(?:\+?\d[\s().-]*){7,}/;

export function containsContactDetails(value: string): boolean {
  return emailPattern.test(value) || urlPattern.test(value) || phonePattern.test(value);
}

export function durationFloorSeconds(questions: readonly SurveyQuestion[]): number {
  const shortTextCount = questions.filter((question) => question.type === "short_text").length;
  const closedCount = questions.length - shortTextCount;
  return 45 + closedCount * 25 + shortTextCount * 75 + 45;
}

export function durationFloorMinutes(questions: readonly SurveyQuestion[]): number {
  return Math.ceil(durationFloorSeconds(questions) / 60);
}

export function finalizeSurvey(input: unknown): SurveySpec {
  const survey = surveySpecSchema.parse(input);
  const floor = durationFloorMinutes(survey.questions);
  const finalMinutes = Math.max(survey.estimatedMinutes, floor);
  if (finalMinutes > 5) {
    throw new AppError(
      "BAD_REQUEST",
      "This survey cannot be completed honestly within five minutes. Shorten it and try again.",
      { status: 422 },
    );
  }
  return { ...survey, estimatedMinutes: finalMinutes as 1 | 2 | 3 | 4 | 5 };
}

export function validateAnswers(survey: SurveySpec, input: unknown): SurveyAnswers {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("BAD_REQUEST", "Answers must be an object.", { status: 400 });
  }

  const raw = input as Record<string, unknown>;
  const expectedRefs = new Set(survey.questions.map((question) => question.ref));
  const unknownRefs = Object.keys(raw).filter((ref) => !expectedRefs.has(ref));
  if (unknownRefs.length > 0) {
    throw new AppError("BAD_REQUEST", "The submission contains unknown answers.", { status: 422 });
  }

  const output: SurveyAnswers = {};
  for (const question of survey.questions) {
    const value = raw[question.ref];
    if (value === undefined || value === null || value === "") {
      throw new AppError("BAD_REQUEST", `Please answer “${question.title}”.`, { status: 422 });
    }
    output[question.ref] = validateAnswer(question, value);
  }
  return output;
}

function validateAnswer(question: SurveyQuestion, value: unknown): string | number {
  switch (question.type) {
    case "multiple_choice": {
      if (typeof value !== "string" || !question.choices.includes(value)) {
        throw new AppError("BAD_REQUEST", `Choose a valid answer for “${question.title}”.`, {
          status: 422,
        });
      }
      return value;
    }
    case "yes_no": {
      if (value !== "Yes" && value !== "No") {
        throw new AppError("BAD_REQUEST", `Choose Yes or No for “${question.title}”.`, {
          status: 422,
        });
      }
      return value;
    }
    case "opinion_scale": {
      const numeric = typeof value === "number" ? value : Number.NaN;
      if (!Number.isInteger(numeric) || numeric < question.scale.min || numeric > question.scale.max) {
        throw new AppError("BAD_REQUEST", `Choose a valid scale value for “${question.title}”.`, {
          status: 422,
        });
      }
      return numeric;
    }
    case "short_text": {
      if (typeof value !== "string") {
        throw new AppError("BAD_REQUEST", `Enter a valid answer for “${question.title}”.`, {
          status: 422,
        });
      }
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.length > SHORT_TEXT_MAX_LENGTH) {
        throw new AppError("BAD_REQUEST", "Short-text answers must be 1–280 characters.", {
          status: 422,
        });
      }
      if (containsContactDetails(trimmed)) {
        throw new AppError(
          "BAD_REQUEST",
          "Please remove email addresses, phone numbers, and links from your answer.",
          { status: 422 },
        );
      }
      return trimmed;
    }
  }
}

export function readableAnswerSummary(survey: SurveySpec, answers: SurveyAnswers): string {
  return survey.questions
    .map((question) => `${question.title}: ${String(answers[question.ref] ?? "")}`)
    .join("\n");
}
