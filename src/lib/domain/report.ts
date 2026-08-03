import { type ReportNarrative, type SurveyAnswers, type SurveySpec } from "@/lib/domain/schemas";

export type AggregateOption = { value: string; count: number; percentage: number };
export type QuestionAggregate = {
  ref: string;
  title: string;
  type: "multiple_choice" | "opinion_scale" | "yes_no";
  validTotal: number;
  options: AggregateOption[];
};

export type DeterministicAggregates = {
  sampleSize: number;
  questions: QuestionAggregate[];
};

export function calculateAggregates(
  survey: SurveySpec,
  responses: readonly SurveyAnswers[],
): DeterministicAggregates {
  const questions: QuestionAggregate[] = [];
  for (const question of survey.questions) {
    if (question.type === "short_text") continue;
    const values = responses
      .map((response) => response[question.ref])
      .filter((value): value is string | number => value !== undefined);
    const orderedValues =
      question.type === "multiple_choice"
        ? question.choices
        : question.type === "yes_no"
          ? ["Yes", "No"]
          : Array.from(
              { length: question.scale.max - question.scale.min + 1 },
              (_, index) => question.scale.min + index,
            );
    const counts = new Map<string, number>(orderedValues.map((value) => [String(value), 0]));
    for (const value of values) {
      const key = String(value);
      if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const validTotal = [...counts.values()].reduce((sum, count) => sum + count, 0);
    questions.push({
      ref: question.ref,
      title: question.title,
      type: question.type,
      validTotal,
      options: [...counts.entries()].map(([value, count]) => ({
        value,
        count,
        percentage: validTotal === 0 ? 0 : roundOneDecimal((count * 100) / validTotal),
      })),
    });
  }
  return { sampleSize: responses.length, questions };
}

export function fallbackNarrative(
  aggregates: DeterministicAggregates,
  completionReason: "target" | "manual",
): ReportNarrative {
  const leaders = aggregates.questions.map((question) => {
    const sorted = [...question.options].sort(
      (left, right) => right.count - left.count || left.value.localeCompare(right.value),
    );
    const leader = sorted[0];
    return leader
      ? `${leader.value} was the most common answer to “${question.title}” (${leader.count} of ${question.validTotal}, ${leader.percentage}%).`
      : `No valid answers were recorded for “${question.title}”.`;
  });
  return {
    headline: `What ${aggregates.sampleSize} participant${aggregates.sampleSize === 1 ? "" : "s"} told us`,
    summary: "These results describe this survey's observed participants and should be read directionally.",
    findings: pad(leaders, 3, "The observed sample was small, so individual answers have a visible effect."),
    implications: [
      "Use the strongest patterns as prompts for follow-up research, not as population estimates.",
      "Review the question-level distributions before making a decision.",
    ],
    limitations: [
      completionReason === "manual"
        ? `Collection was finished early with a frozen sample of ${aggregates.sampleSize}.`
        : `The sample contains ${aggregates.sampleSize} completed responses.`,
    ],
  };
}

function roundOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function pad(values: string[], minimum: number, fallback: string): [string, string, string, ...string[]] {
  const output = values.slice(0, 5);
  while (output.length < minimum) output.push(fallback);
  return output as [string, string, string, ...string[]];
}
