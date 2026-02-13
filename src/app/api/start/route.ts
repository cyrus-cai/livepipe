import { NextResponse } from "next/server";
import { getPipelineStatusSnapshot } from "@/lib/pipeline";

export async function GET() {
  return NextResponse.json(getPipelineStatusSnapshot());
}

export async function POST() {
  return GET();
}
