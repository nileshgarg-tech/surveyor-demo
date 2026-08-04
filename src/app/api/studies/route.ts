import { errorResponse, jsonNoStore } from "@/lib/http";
import { getPublicStudiesList } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const studies = await getPublicStudiesList();
    return jsonNoStore({ studies });
  } catch (error) {
    return errorResponse(error);
  }
}
