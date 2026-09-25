import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type {
  CliBackendLiveSessionHandle,
  CliBackendPlugin,
} from "../../plugins/cli-backend.types.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { createCliLiveSessionCapability } from "../cli-runner/cli-live-session-registry.js";
import { executePreparedCliRun } from "../cli-runner/execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
} from "../cli-runner/execute.test-support.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "../cli-runner/types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const { runCliAgentMock } = vi.hoisted(() => ({
  runCliAgentMock: vi.fn(async (_params: RunCliAgentParams) => ({
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "native-session", provider: "claude-cli", model: "opus" },
    },
  })),
}));

vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));

const { testing } = await import("./compact.js");

function registerBackend(overrides: Partial<CliBackendPlugin> = {}) {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () =>
      [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          config: {
            command: "claude",
            args: ["-p"],
            resumeArgs: ["-p", "--resume", "{sessionId}"],
            input: "stdin",
            output: "jsonl",
            sessionMode: "existing",
          },
          bundleMcp: false,
          pluginId: "anthropic",
          ownsNativeCompaction: true,
          manualCompaction: {
            buildPrompt: (instructions?: string) =>
              instructions ? `/compact ${instructions}` : "/compact",
            input: "arg",
            validateOutput: () => ({ ok: true }),
          },
          ...overrides,
        },
      ] as never,
    resolvePluginSetupCliBackend: () => undefined,
  });
}

function compactParams(overrides: Record<string, unknown> = {}) {
  const dir = tempDirs.make("openclaw-compact-native-cli-");
  const cliSessionBinding = {
    sessionId: "native-session",
    authProfileId: "anthropic:subscription",
  };
  const sessionEntry = { execHost: "node", execNode: "paired-node" };
  return {
    sessionId: "openclaw-session",
    sessionKey: "agent:main:main",
    sessionTarget: {
      agentId: "main",
      sessionId: "openclaw-session",
      sessionKey: "agent:main:main",
      storePath: join(dir, "openclaw.sqlite"),
    },
    sessionFile: "agent:main:main",
    agentId: "main",
    workspaceDir: join(dir, "workspace"),
    agentDir: join(dir, "agent"),
    config: {},
    provider: "anthropic",
    model: "opus",
    trigger: "manual",
    cliSessionId: "native-session",
    cliSessionBinding,
    sessionEntry,
    customInstructions: "keep decisions",
    preparedModelRuntime: {},
    ...overrides,
  } as never;
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  runCliAgentMock.mockClear();
  supervisorSpawnMock.mockReset();
});

describe("native CLI manual compaction", () => {
  it.for([undefined, "channel-account"])(
    "retires the matching warm owner through the native command (account=%s)",
    async (agentAccountId, { onTestFinished }) => {
      registerBackend();
      const input: Parameters<typeof testing.compactNativeCliSession>[0]["compactParams"] =
        compactParams({ agentAccountId, sessionEntry: undefined });
      const admission = prepareSystemAgentRunAdmission({}, "warm-owner", "main", "compact-test");
      onTestFinished(admission.close);
      const warmContext = buildPreparedCliRunContext({
        agentId: input.agentId,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
      });
      warmContext.params.agentAccountId = agentAccountId;
      warmContext.params.admittedRunContext = await admission.admit("embedded");
      warmContext.effectiveAuthProfileId = input.cliSessionBinding?.authProfileId;
      const register = (context: PreparedCliRunContext) => {
        const capability = createCliLiveSessionCapability({
          context,
          argv: ["claude", "-p"],
          env: {},
          beginCapture: () => {},
          abortSignal: new AbortController().signal,
        });
        const handle: CliBackendLiveSessionHandle = {
          generation: context.params.agentAccountId ?? "unscoped",
          fingerprint: capability.fingerprint,
          isIdle: () => true,
          close: vi.fn(() => capability.remove(handle)),
          waitForExit: async () => {},
        };
        capability.register(handle);
        onTestFinished(async () => {
          handle.close("restart");
          await context.preparedBackend.closeLiveSession?.("restart");
        });
        return { capability, handle };
      };
      const warm = register(warmContext);
      const unrelated = register({
        ...warmContext,
        params: { ...warmContext.params, agentAccountId: "other-channel-account" },
        preparedBackend: { ...warmContext.preparedBackend, closeLiveSession: undefined },
      });
      // Preparation is outside this test's boundary. Pass only the command's actual
      // arguments into a fresh context; borrowing warmContext would hide dropped identity.
      runCliAgentMock.mockImplementationOnce(async (params) => {
        if (!params.preparedRunAdmission) {
          throw new Error("native compaction did not prepare run admission");
        }
        const context = buildPreparedCliRunContext({
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
        });
        context.params = {
          ...context.params,
          ...params,
          admittedRunContext: await params.preparedRunAdmission.admit("embedded"),
        };
        context.effectiveAuthProfileId = params.authProfileId;
        context.backendResolved.manualCompaction = {
          input: "arg",
          buildPrompt: () => "/compact",
          validateOutput: () => ({ ok: true }),
        };
        await executePreparedCliRun(context, params.cliSessionId);
        return {
          meta: {
            durationMs: 1,
            agentMeta: { sessionId: "native-session", provider: "claude-cli", model: "opus" },
          },
        };
      });
      supervisorSpawnMock.mockImplementationOnce(async () => {
        expect(warm.handle.close).toHaveBeenCalledOnce();
        expect(unrelated.handle.close).not.toHaveBeenCalled();
        return createManagedRun({
          ...createSuccessfulProcessExit(),
          stdout: `${JSON.stringify({ type: "result", result: "compacted" })}\n`,
        });
      });

      await expect(
        testing.compactNativeCliSession({ runtime: "claude-cli", compactParams: input }),
      ).resolves.toMatchObject({ ok: true, compacted: true });
      expect(supervisorSpawnMock).toHaveBeenCalledOnce();
      expect(warm.capability.current()).toBeUndefined();
      expect(unrelated.capability.current()).toBe(unrelated.handle);
    },
  );

  it("resumes the bound backend session with the backend-owned command", async () => {
    registerBackend();

    const result = await testing.compactNativeCliSession({
      runtime: "claude-cli",
      compactParams: compactParams(),
    });

    expect(result).toEqual({
      ok: true,
      compacted: true,
      reason: 'CLI backend "claude-cli" compacted its native session.',
    });
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedRunAdmission: expect.objectContaining({
          operationalRunInstance: expect.objectContaining({
            runId: "openclaw-session:native-compact",
          }),
        }),
        prompt: "/compact keep decisions",
        provider: "claude-cli",
        modelProvider: "anthropic",
        cliSessionId: "native-session",
        cliSessionBinding: {
          sessionId: "native-session",
          authProfileId: "anthropic:subscription",
        },
        authProfileId: "anthropic:subscription",
        sessionEntry: { execHost: "node", execNode: "paired-node" },
        controlOperation: "compact",
        disableCliLiveSession: true,
        cleanupCliLiveSessionOnRunEnd: true,
        allowEmptyAssistantReplyAsSilent: true,
      }),
    );
    const preparedRunAdmission = runCliAgentMock.mock.calls[0]?.[0]?.preparedRunAdmission;
    if (!preparedRunAdmission) {
      throw new Error("native compaction did not prepare run admission");
    }
    await expect(preparedRunAdmission.admit("embedded")).rejects.toThrow(
      "prepared execution context is already closed",
    );
  });

  it("fails explicitly when an owning backend has no resumable session", async () => {
    registerBackend();

    const result = await testing.compactNativeCliSession({
      runtime: "claude-cli",
      compactParams: compactParams({
        cliSessionId: undefined,
        cliSessionBinding: undefined,
      }),
    });

    expect(result).toMatchObject({ ok: false, compacted: false });
    expect(result?.reason).toContain("without a resumable native session");
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("leaves non-owning runtimes on the existing compaction path", async () => {
    registerBackend({ ownsNativeCompaction: false });

    await expect(
      testing.compactNativeCliSession({
        runtime: "claude-cli",
        compactParams: compactParams(),
      }),
    ).resolves.toBeUndefined();
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });
});
