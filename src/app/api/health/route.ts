import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { getBridgeUrl } from "@/lib/env";

export const runtime = "nodejs";

export interface BridgeProbe {
  configured: boolean;
  reachable: boolean;
  latencyMs: number;
  version: string | null;
  checkedAt: string;
}

/**
 * Probes the FastAPI bridge's `/health` endpoint. The probe is the dashboard's
 * "System Status" signal and is wrapped so any failure (DNS, timeout, HTTP
 * error, malformed body) degrades to `reachable: false` — never a 500.
 */
async function probeBridge(): Promise<BridgeProbe> {
  const checkedAt = new Date().toISOString();
  const base = getBridgeUrl();
  if (!base) {
    return { configured: false, reachable: false, latencyMs: 0, version: null, checkedAt };
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${base}/health`, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) {
      return { configured: true, reachable: false, latencyMs: Date.now() - startedAt, version: null, checkedAt };
    }
    const body = (await response.json().catch(() => null)) as { version?: string } | null;
    return {
      configured: true,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      version: body && typeof body.version === "string" ? body.version : null,
      checkedAt,
    };
  } catch {
    return { configured: true, reachable: false, latencyMs: Date.now() - startedAt, version: null, checkedAt };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dashboard system health: gateway runtime status plus FastAPI bridge
 * connectivity. `systemStatus` is "operational" only when the bridge is
 * reachable (or this deployment is configured without a bridge).
 */
export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    await requireAdminRequest(request, "read_files");
    const bridge = await probeBridge();
    return success({
      systemStatus: bridge.configured ? (bridge.reachable ? "operational" : "degraded") : "operational",
      gateway: {
        runtime: "nodejs",
        uptimeSeconds: Math.round(process.uptime()),
        checkedAt: new Date().toISOString(),
      },
      bridge,
    }, requestId);
  }, { route: "health" });
}
