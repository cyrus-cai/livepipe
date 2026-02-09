import { NextResponse } from "next/server";
import { triggerOnce } from "@/lib/pipeline";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    console.log(`[api/trigger] received trigger from ${body.source ?? "unknown"}`);

    const result = await triggerOnce();

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error("[api/trigger] error:", error);
    return NextResponse.json(
      { ok: false, error: String(error) },
      { status: 500 }
    );
  }
}
