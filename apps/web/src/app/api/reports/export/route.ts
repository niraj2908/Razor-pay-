import { NextRequest, NextResponse } from "next/server";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";
import { validateDateRange } from "@/lib/recovery/overviewService";
import { getReportData } from "@/lib/reports/reportingService";
import { renderReportCsv } from "@/lib/reports/csvReport";
import { renderReportPdf } from "@/lib/reports/pdfReport";

// PDF rendering (pdfmake/PDFKit) and every underlying query need the Node
// runtime - identical reasoning to every other Prisma-touching route.
export const runtime = "nodejs";

/**
 * GET /api/reports/export?format=csv|pdf&since=...&until=... (Phase 28C).
 *
 * Same thin-route shape as /api/recovery/overview: authenticate -> resolve
 * the operator's OWN merchant (never a client-supplied merchantId) ->
 * validate the date range -> assemble the real report data -> render it in
 * the requested format. Contains no aggregation logic of its own - all of
 * that lives in `reportingService.ts`, shared with the on-screen /reports
 * page so the export can never show different numbers than the page it
 * was exported from.
 */
export async function GET(request: NextRequest) {
  const session = await authenticateOperator();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await resolveMerchantAccess(session.operator.id);
  if (!access) {
    console.error("[reports-export] operator has no resolvable merchant", { operatorId: session.operator.id });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  const params = request.nextUrl.searchParams;
  const format = params.get("format");
  if (format !== "csv" && format !== "pdf") {
    return NextResponse.json({ error: "validation_error", reason: "format_must_be_csv_or_pdf" }, { status: 400 });
  }

  const range = validateDateRange(params.get("since"), params.get("until"));
  if (!range.valid) {
    return NextResponse.json({ error: "validation_error", reason: range.reason }, { status: 400 });
  }

  try {
    const report = await getReportData(access.merchantId, { since: range.since, until: range.until });
    const filenameDate = report.generatedAt.slice(0, 10);

    if (format === "csv") {
      const csv = renderReportCsv(report);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="revenue-recovery-report-${filenameDate}.csv"`,
        },
      });
    }

    const pdfBuffer = await renderReportPdf(report);
    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="revenue-recovery-report-${filenameDate}.pdf"`,
      },
    });
  } catch (error) {
    console.error("[reports-export] unexpected failure", {
      operatorId: session.operator.id,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
