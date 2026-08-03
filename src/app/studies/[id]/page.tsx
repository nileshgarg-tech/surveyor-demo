import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { getPublicStudy } from "@/lib/data";
import { StudyDashboard } from "@/components/study-dashboard";

export const dynamic = "force-dynamic";

export default async function StudyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const study = await loadStudy(id);
  return <StudyDashboard initialStudy={study} />;
}

async function loadStudy(id: string) {
  try {
    return await getPublicStudy(id);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}
