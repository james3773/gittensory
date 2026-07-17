import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildStructuralImprovementAssessment } from "../../src/signals/improvement";
import { createTestEnv } from "../helpers/d1";

// #6748: POST /v1/lint/improvement-potential — the REST mirror bringing loopover_check_improvement_potential
// to the parity its same-tier sibling /v1/lint/slop-risk already has. The builder's own correctness is pinned
// independently by improvement.test.ts; these assert the ROUTE contract: schema parity with the MCP tool's
// shape, the assessment passed through unmodified, and 400s on invalid input.
const apiHeaders = (env: Env) => ({
  authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`,
  "content-type": "application/json",
});
const PATH = "/v1/lint/improvement-potential";
const post = (env: Env, body: unknown) =>
  createApp().request(
    PATH,
    { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) },
    env,
  );

describe("POST /v1/lint/improvement-potential (#6748)", () => {
  it("returns the shared builder's assessment for every arm", async () => {
    const env = createTestEnv();
    const cases = [
      {},
      { changedFiles: [{ path: "src/a.ts", additions: 10, deletions: 2 }] },
      {
        changedFiles: [{ path: "src/a.ts", additions: 10, deletions: 2 }],
        testFiles: ["test/a.test.ts"],
      },
      { patchCoverageDeltaPercent: 5 },
      {
        complexityDeltas: [
          {
            file: "src/a.ts",
            line: 1,
            name: "fn",
            before: 8,
            after: 3,
            delta: -5,
          },
        ],
      },
      {
        duplicationDeltas: [
          { file: "src/a.ts", line: 10, duplicateOfLine: 40, lines: 6 },
        ],
      },
    ];
    for (const body of cases) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      await expect(response.json()).resolves.toEqual(
        JSON.parse(JSON.stringify(buildStructuralImprovementAssessment(body))),
      );
    }
  });

  it("rejects an invalid or unparseable body with 400", async () => {
    const env = createTestEnv();
    for (const body of [
      { changedFiles: "nope" },
      { changedFiles: [{ path: "" }] },
      { tests: "free text is not an array" },
      { patchCoverageDeltaPercent: "high" },
      {
        complexityDeltas: [
          {
            file: "src/a.ts",
            line: 0,
            name: "fn",
            before: 1,
            after: 1,
            delta: 0,
          },
        ],
      },
    ]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "invalid_improvement_potential_request",
      });
    }
    const malformed = await createApp().request(
      PATH,
      {
        method: "POST",
        headers: apiHeaders(createTestEnv()),
        body: "{not json",
      },
      createTestEnv(),
    );
    expect(malformed.status).toBe(400);
  });

  it("uploads no source and leaks no private terms — path metadata only", async () => {
    const env = createTestEnv();
    const text = JSON.stringify(
      await (
        await post(env, {
          changedFiles: [{ path: "src/a.ts" }],
          testFiles: ["test/a.test.ts"],
        })
      ).json(),
    );
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward/i);
  });
});
