import { deleteStudy } from "@/lib/data";
import { errorResponse, jsonNoStore } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: import("next/server").NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await deleteStudy(id);
    return jsonNoStore({ deleted: true, id });
  } catch (error) {
    return errorResponse(error);
  }
}
