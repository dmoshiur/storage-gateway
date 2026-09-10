import { apiRoute } from "@/lib/api/route";
import { success } from "@/lib/api/response";
import { requireAdminRequest } from "@/lib/security/request-auth";
import { getBridgeUrl } from "@/lib/env";
import { bridgeUrlPointsAtRequest } from "@/lib/bridge/config";
import { version as appVersion } from "../../../../package.json";

export const runtime = "nodejs";

export interface BridgeProbe {
  configured: boolean;
  reachable: boolean;
  latencyMs: number;
  version: string | null;
  checkedAt: string;
  /** `embedded` = same Vercel deployment; `external` = legacy standalone bridge origin. */
  mode: "embedded" | "external";
}

/**
 * Probes bridge connectivity for the dashboard's "System Status" signal.
 *
 * The bridge is embedded in this same deployment, so the probe is local unless
 * an operator explicitly configured a *different* external bridge origin
 * (legacy standalone FastAPI host). Any failure (DNS, timeout, HTTP error,
 * malformed body) degrades to `reachable: false` — never a 500.
 */
async function probeBridge(request: Request): Promise<BridgeProbe> {
  const checkedAt = new Date().toISOString();
  const base = getBridgeUrl();
  if (!base || bridgeUrlPointsAtRequest(request, base)) {
    return { configured: true, reachable: true, latencyMs: 0, version: appVersion, checkedAt, mode: "embedded" };
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${base}/health`, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) {
      return { configured: true, reachable: false, latencyMs: Date.now() - startedAt, version: null, checkedAt, mode: "external" };
    }
    const body = (await response.json().catch(() => null)) as { version?: string } | null;
    return {
      configured: true,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      version: body && typeof body.version === "string" ? body.version : null,
      checkedAt,
      mode: "external",
    };
  } catch {
    return { configured: true, reachable: false, latencyMs: Date.now() - startedAt, version: null, checkedAt, mode: "external" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dashboard system health: gateway runtime status plus Storage Bridge
 * connectivity. `systemStatus` is "operational" only when the bridge is
 * reachable; the embedded bridge always is.
 */
export async function GET(request: Request) {
  return apiRoute(request, async (requestId) => {
    await requireAdminRequest(request, "read_files");
    const bridge = await probeBridge(request);
    return success({
      systemStatus: bridge.reachable ? "operational" : "degraded",
      gateway: {
        runtime: "nodejs",
        uptimeSeconds: Math.round(process.uptime()),
        checkedAt: new Date().toISOString(),
      },
      bridge,
    }, requestId);
  }, { route: "health" });
}
