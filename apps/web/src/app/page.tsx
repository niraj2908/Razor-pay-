import { redirect } from "next/navigation";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";

/**
 * Root route (Phase 26 Phase C). Real screens now exist - this is a thin
 * redirect, not a page of its own. The Phase B design-system verification
 * scaffold that used to live here has served its purpose.
 */
export default async function RootPage() {
  const session = await authenticateOperator();
  redirect(session ? "/overview" : "/login");
}
