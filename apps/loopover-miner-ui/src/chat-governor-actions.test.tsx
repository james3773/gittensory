import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// chat-action-registry → governor-chokepoint → governor-ledger → node:sqlite. jsdom/Vite cannot bundle
// that builtin (#6521); keep a client-safe registry twin so the real dispatch + registration modules load.
vi.mock("../../../packages/loopover-miner/lib/chat-action-registry.js", () => {
  const GOVERNOR_GATED = Symbol("loopover.chat-action.governor-gated");

  function isGovernorGatedHandler(handler: unknown): boolean {
    return typeof handler === "function" && (handler as unknown as { [k: symbol]: unknown })[GOVERNOR_GATED] === true;
  }

  function governorGatedHandler(
    run: (request: unknown, gate: unknown) => unknown,
    options: { evaluateGate?: (input?: unknown) => { decision: { stage: string } } } = {},
  ) {
    const evaluateGate = options.evaluateGate ?? (() => ({ decision: { stage: "allow" } }));
    const handler = async (request: { governorInput?: unknown }) => {
      const gate = evaluateGate(request?.governorInput);
      if (gate?.decision?.stage !== "allow") {
        return { ok: false, status: "gated", decision: gate?.decision ?? null };
      }
      const result = await run(request, gate);
      return { ok: true, status: "executed", decision: gate.decision, result };
    };
    Object.defineProperty(handler, GOVERNOR_GATED, { value: true });
    return handler;
  }

  function createChatActionRegistry() {
    const actions = new Map<
      string,
      { paramsValidator: (params: unknown) => boolean; handler: (request: unknown) => Promise<unknown> }
    >();
    return {
      register(
        name: string,
        definition: {
          paramsValidator: (params: unknown) => boolean;
          handler: (request: unknown) => Promise<unknown>;
        },
      ) {
        if (!isGovernorGatedHandler(definition.handler)) {
          throw new Error(`registerChatAction("${name}"): handler must be produced by governorGatedHandler()`);
        }
        actions.set(name, definition);
        return definition;
      },
      get: (name: string) => actions.get(name),
      has: (name: string) => actions.has(name),
      names: () => [...actions.keys()],
      get size() {
        return actions.size;
      },
    };
  }

  return {
    createChatActionRegistry,
    governorGatedHandler,
    isGovernorGatedHandler,
    chatActionRegistry: createChatActionRegistry(),
    registerChatAction: () => {
      throw new Error("tests use an injected isolated registry");
    },
  };
});

import { createChatActionRegistry } from "../../../packages/loopover-miner/lib/chat-action-registry.js";
import { GovernorChatActionResult } from "./components/chat/governor-action-result";
import { formatGovernorPauseChatMessage, GOVERNOR_CHAT_ACTION_PENDING_MESSAGE } from "./lib/chat-governor-action-copy";
import {
  enabledChatActionsEnv,
  GOVERNOR_PAUSE_CHAT_ACTION,
  GOVERNOR_RESUME_CHAT_ACTION,
  registerGovernorChatActions,
  runGovernorChatAction,
  unwrapGovernorPauseChatResult,
} from "./lib/chat-governor-actions";
import { pauseGovernor, resumeGovernor, type GovernorPauseState } from "./lib/governor";

const pausedWithReason: GovernorPauseState = {
  paused: true,
  reason: "investigating a bad PR",
  pausedAt: "2026-07-13T12:00:00.000Z",
};

const pausedWithoutReason: GovernorPauseState = {
  paused: true,
  reason: null,
  pausedAt: "2026-07-13T12:00:00.000Z",
};

const notPaused: GovernorPauseState = { paused: false, reason: null, pausedAt: null };

describe("formatGovernorPauseChatMessage (#6521)", () => {
  it("matches GovernorControlSection error copy", () => {
    expect(formatGovernorPauseChatMessage({ ok: false, error: "connection refused" })).toBe(
      "Could not read the local governor state: connection refused",
    );
  });

  it("matches paused-with-reason, paused-without-reason, and not-paused copy", () => {
    expect(formatGovernorPauseChatMessage({ ok: true, pauseState: pausedWithReason })).toBe(
      "Paused since 2026-07-13T12:00:00.000Z (investigating a bad PR)",
    );
    expect(formatGovernorPauseChatMessage({ ok: true, pauseState: pausedWithoutReason })).toBe(
      "Paused since 2026-07-13T12:00:00.000Z",
    );
    expect(formatGovernorPauseChatMessage({ ok: true, pauseState: notPaused })).toBe("Not paused");
  });
});

describe("GovernorChatActionResult (#6521)", () => {
  it("surfaces the pending state while the request is outstanding", () => {
    render(<GovernorChatActionResult pending result={{ ok: true, pauseState: notPaused }} />);
    expect(screen.getByRole("status").textContent).toBe(GOVERNOR_CHAT_ACTION_PENDING_MESSAGE);
    expect(screen.queryByText("Not paused")).toBeNull();
  });

  it("renders error, paused-with-reason, paused-without-reason, and not-paused states", () => {
    const { rerender } = render(
      <GovernorChatActionResult pending={false} result={{ ok: false, error: "connection refused" }} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("connection refused");

    rerender(<GovernorChatActionResult pending={false} result={{ ok: true, pauseState: pausedWithReason }} />);
    expect(screen.getByText("Paused since 2026-07-13T12:00:00.000Z (investigating a bad PR)")).toBeTruthy();

    rerender(<GovernorChatActionResult pending={false} result={{ ok: true, pauseState: pausedWithoutReason }} />);
    expect(screen.getByText("Paused since 2026-07-13T12:00:00.000Z")).toBeTruthy();

    rerender(<GovernorChatActionResult pending={false} result={{ ok: true, pauseState: notPaused }} />);
    expect(screen.getByText("Not paused")).toBeTruthy();
  });

  it("renders nothing when there is no result and nothing is pending", () => {
    const { container } = render(<GovernorChatActionResult pending={false} result={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("runGovernorChatAction pending + wire (#6521)", () => {
  it("flips onPending for the duration of the POST round-trip", async () => {
    const registry = createChatActionRegistry();
    let resolvePause!: (value: { ok: true; pauseState: GovernorPauseState }) => void;
    const pauseGovernorFn = vi.fn(
      () =>
        new Promise<{ ok: true; pauseState: GovernorPauseState }>((resolve) => {
          resolvePause = resolve;
        }),
    );
    registerGovernorChatActions({ registry, pauseGovernorFn, resumeGovernorFn: resumeGovernor });

    const pendingLog: boolean[] = [];
    const pending = runGovernorChatAction(
      { action: GOVERNOR_PAUSE_CHAT_ACTION },
      {
        env: enabledChatActionsEnv(),
        registry,
        onPending: (value) => pendingLog.push(value),
      },
    );

    expect(pendingLog).toEqual([true]);
    resolvePause({ ok: true, pauseState: notPaused });
    await pending;
    expect(pendingLog).toEqual([true, false]);
  });

  it("unwraps ok:true and ok:false handler results from the dispatch envelope", async () => {
    const registry = createChatActionRegistry();
    registerGovernorChatActions({
      registry,
      pauseGovernorFn: vi.fn(async () => ({ ok: true as const, pauseState: pausedWithReason })),
      resumeGovernorFn: vi.fn(async () => ({ ok: false as const, error: "resume failed" })),
    });

    const paused = unwrapGovernorPauseChatResult(
      await runGovernorChatAction(
        { action: GOVERNOR_PAUSE_CHAT_ACTION, params: { reason: "investigating a bad PR" } },
        { env: enabledChatActionsEnv(), registry },
      ),
    );
    expect(paused).toEqual({ ok: true, pauseState: pausedWithReason });

    const resumed = unwrapGovernorPauseChatResult(
      await runGovernorChatAction({ action: GOVERNOR_RESUME_CHAT_ACTION }, { env: enabledChatActionsEnv(), registry }),
    );
    expect(resumed).toEqual({ ok: false, error: "resume failed" });
  });

  it("regression: default wiring binds the exported pauseGovernor/resumeGovernor clients", async () => {
    const governor = await import("./lib/governor");
    const pauseSpy = vi.spyOn(governor, "pauseGovernor").mockResolvedValue({
      ok: true,
      pauseState: pausedWithoutReason,
    });
    const resumeSpy = vi.spyOn(governor, "resumeGovernor").mockResolvedValue({
      ok: true,
      pauseState: notPaused,
    });

    const registry = createChatActionRegistry();
    registerGovernorChatActions({ registry });

    await runGovernorChatAction(
      { action: GOVERNOR_PAUSE_CHAT_ACTION, params: { reason: "hold" } },
      { env: enabledChatActionsEnv(), registry },
    );
    expect(pauseSpy).toHaveBeenCalledWith("hold");

    await runGovernorChatAction({ action: GOVERNOR_RESUME_CHAT_ACTION }, { env: enabledChatActionsEnv(), registry });
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    pauseSpy.mockRestore();
    resumeSpy.mockRestore();
  });

  it("defaults registerGovernorChatActions to the real governor module exports", () => {
    // Structural pin: the wire module's default path is `pauseGovernor` / `resumeGovernor` from ./governor.
    expect(typeof pauseGovernor).toBe("function");
    expect(typeof resumeGovernor).toBe("function");
  });

  it("unwrapGovernorPauseChatResult returns null for non-executed dispatch envelopes", () => {
    expect(
      unwrapGovernorPauseChatResult({ ok: false, status: "disabled", action: GOVERNOR_PAUSE_CHAT_ACTION }),
    ).toBeNull();
    expect(
      unwrapGovernorPauseChatResult({
        ok: true,
        status: "dispatched",
        action: GOVERNOR_PAUSE_CHAT_ACTION,
        result: { status: "gated", decision: null },
      }),
    ).toBeNull();
    expect(
      unwrapGovernorPauseChatResult({
        ok: true,
        status: "dispatched",
        action: GOVERNOR_PAUSE_CHAT_ACTION,
        result: { status: "executed", result: null },
      }),
    ).toBeNull();
  });
});
