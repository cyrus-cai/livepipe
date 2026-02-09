import { NextResponse } from "next/server";
import { isPipelineRunning } from "@/lib/pipeline";

export async function GET() {
  return NextResponse.json({
    running: isPipelineRunning(),
    message: isPipelineRunning()
      ? "Pipeline is running (managed by dev script)"
      : "Pipeline is not running — start with `pnpm run dev`",
  });
}

export async function POST() {
  return GET();
}
