import { afterEach, expect, test } from "bun:test";
import { deploymentConfigUrl, gameBaseUrl, DEPLOYMENT_CONFIG_URL } from "../../src/deployment-config";
import { aotCache } from "../../src/worker/core/cpu/aot-cache";

const g = globalThis as { __bsGameBase?: unknown };
afterEach(() => { delete g.__bsGameBase; });

test("without a game base the deployment file stays at the build path", () => {
    expect(gameBaseUrl()).toBeNull();
    expect(deploymentConfigUrl()).toBe(DEPLOYMENT_CONFIG_URL);
});

test("a game base points the deployment file and shipped AOT packs at the game folder", () => {
    g.__bsGameBase = "https://example.test/spieltests/scp087-de-bs-20261120/index.html";
    expect(deploymentConfigUrl()).toBe("https://example.test/spieltests/scp087-de-bs-20261120/deployment.json");
    expect(aotCache.shippedUrl("app:su-scp087-bs1", "abcdef0123456789"))
        .toBe("https://example.test/spieltests/scp087-de-bs-20261120/aot/app-su-scp087-bs1/abcdef0123456789.bsaot");
});

test("an empty or non-string game base is ignored", () => {
    g.__bsGameBase = "";
    expect(gameBaseUrl()).toBeNull();
    g.__bsGameBase = 42;
    expect(deploymentConfigUrl()).toBe(DEPLOYMENT_CONFIG_URL);
});
