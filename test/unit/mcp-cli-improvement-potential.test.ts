import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFixtureServer,
  runAsync,
  startFixtureServer,
} from "./support/mcp-cli-harness";

// #6748: shell CLI mirror of loopover_check_improvement_potential (slopRiskCli pattern — HTTP proxy to
// POST /v1/lint/improvement-potential). Asserts the CLI surfaces the fixture assessment and rejects bad flags.
describe("loopover-mcp CLI — improvement-potential (#6748)", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function env() {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer();
    return {
      LOOPOVER_API_URL: url,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_CONFIG_DIR: tempDir,
      LOOPOVER_API_TIMEOUT_MS: "1000",
    };
  }

  it("assesses improvement potential via the API and prints plain or json output", async () => {
    const e = await env();
    const plain = await runAsync(
      [
        "improvement-potential",
        "--changed-file",
        "src/widget.ts:80:2",
        "--test-file",
        "test/unit/widget.test.ts",
      ],
      e,
    );
    expect(plain).toMatch(/Improvement potential: 10 \(minor\)/);

    const json = JSON.parse(
      await runAsync(
        [
          "improvement-potential",
          "--changed-file",
          "src/widget.ts:80:2",
          "--test-file",
          "test/unit/widget.test.ts",
          "--json",
        ],
        e,
      ),
    ) as { improvementScore: number; band: string; findings: unknown[] };
    expect(json).toMatchObject({
      improvementScore: 10,
      band: "minor",
      findings: expect.any(Array),
    });
    expect(JSON.stringify(json)).not.toMatch(
      /wallet|hotkey|reward|trust score/i,
    );
  });

  it("accepts --patch-coverage-delta and rejects a non-finite value", async () => {
    const e = await env();
    const json = JSON.parse(
      await runAsync(
        ["improvement-potential", "--patch-coverage-delta", "4.5", "--json"],
        e,
      ),
    ) as {
      band: string;
    };
    expect(json.band).toBe("minor");

    await expect(
      runAsync(
        ["improvement-potential", "--patch-coverage-delta", "not-a-number"],
        e,
      ),
    ).rejects.toThrow(/patch-coverage-delta must be a finite number/);
  });

  it("prints help without calling the API", async () => {
    const e = await env();
    const help = await runAsync(["improvement-potential", "--help"], e);
    expect(help).toMatch(/POST \/v1\/lint\/improvement-potential/);
    expect(help).toMatch(/loopover_check_improvement_potential/);
  });
});
