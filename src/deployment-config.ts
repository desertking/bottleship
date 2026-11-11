/**
 * Per-DEPLOYMENT policy, fetched from deployment.json next to games-catalog.json.
 *
 * The browser gate in browser-support.ts is capability-based on purpose — any browser that
 * ships the required APIs passes. That is right for the emulator, but a specific deployment
 * (a partner demo stand) may need to admit only the browser it was actually rehearsed on,
 * regardless of what other engines advertise. That is a deployment decision, so it lives in
 * a file the operator writes, not in the engine's support logic.
 *
 * Absent file = no policy, which is what the public build serves.
 */

export interface DeploymentConfig {
    /** Browser names (as detectBrowserName reports them) allowed to run games here. */
    allowedBrowsers?: string[];
    /** Shown instead of the app when the browser is not on the list. */
    blockedMessage?: string;
    soundFonts?: string[];
    reExecImages?: string[];
    registryOnce?: boolean;
    version?: string;
    registry?: { root: string; path: string; values: { name: string; type: string; data: unknown }[] }[];
}

let cached: DeploymentConfig | null = null;

export const DEPLOYMENT_CONFIG_URL = "/deployment.json";

export function gameBaseUrl(): string | null {
    const base = (globalThis as { __bsGameBase?: unknown }).__bsGameBase;
    return typeof base === "string" && base.length > 0 ? base : null;
}

export function deploymentConfigUrl(): string {
    const base = gameBaseUrl();
    if (base) {
        try { return new URL("deployment.json", base).href; } catch { /* fall back to the build path */ }
    }
    return DEPLOYMENT_CONFIG_URL;
}

export async function loadDeploymentConfig(): Promise<DeploymentConfig> {
    if (cached) return cached;
    try {
        const resp = await fetch(deploymentConfigUrl());
        cached = resp.ok ? await resp.json() : {};
    } catch {
        cached = {};
    }
    return cached!;
}

/** null = allowed. A string = the reason to show instead of running anything. */
export function browserPolicyBlock(config: DeploymentConfig, detectedBrowser: string): string | null {
    const allowed = config.allowedBrowsers;
    if (!allowed?.length) return null;
    if (allowed.some((name) => name.toLowerCase() === detectedBrowser.toLowerCase())) return null;
    return config.blockedMessage
        ?? `This installation supports ${allowed.join(" / ")} only. Detected browser: ${detectedBrowser}.`;
}
