import {
  CapitalAllocatorDecision,
  CapitalAllocatorInstanceMeta,
  CapitalAllocationReason,
  GlobalCapitalAllocatorConfig,
} from '../../../libs/detector/src/capital/optional-capital-engine';
import { GlobalCapitalAllocatorOrchestrator } from '@barfinex/detector';

interface RaceRunResult {
  first: CapitalAllocatorDecision;
  second: CapitalAllocatorDecision;
  capNotional: number;
  symbolCapNotional: number;
}

const EPS = 1e-9;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function assertTrue(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertExposureCaps(decision: CapitalAllocatorDecision, capNotional: number, symbolCap: number): void {
  const totalExposureAfter = Number(decision.diagnostics.totalExposureAfter ?? 0);
  const symbolExposureAfter = Number(decision.diagnostics.symbolExposureAfter ?? 0);
  assertTrue(
    totalExposureAfter <= capNotional + EPS,
    `[cap-breach] totalExposureAfter=${totalExposureAfter} > cap=${capNotional} reason=${decision.reason}`,
  );
  assertTrue(
    symbolExposureAfter <= symbolCap + EPS,
    `[cap-breach] symbolExposureAfter=${symbolExposureAfter} > symbolCap=${symbolCap} reason=${decision.reason}`,
  );
}

function assertSecondDecisionShape(second: CapitalAllocatorDecision): void {
  const allowedScale = second.allowed && second.scaleFactor > 0 && second.scaleFactor < 1;
  const denied = !second.allowed && second.scaleFactor === 0;
  assertTrue(
    allowedScale || denied,
    `[second-invalid] expected scaled-or-deny, got allowed=${second.allowed} scale=${second.scaleFactor} reason=${second.reason}`,
  );
}

function assertNoDoubleFull(
  first: CapitalAllocatorDecision,
  second: CapitalAllocatorDecision,
  candidateNotional: number,
): void {
  const firstScaled = Number(first.diagnostics.scaledNotional ?? 0);
  const secondScaled = Number(second.diagnostics.scaledNotional ?? 0);
  const firstFull = Math.abs(firstScaled - candidateNotional) <= EPS;
  const secondFull = Math.abs(secondScaled - candidateNotional) <= EPS;
  assertTrue(
    !(firstFull && secondFull),
    `[race-breach] both decisions considered full allocation: first=${firstScaled}, second=${secondScaled}, candidate=${candidateNotional}`,
  );
}

async function runSingleRace(params: {
  runId: number;
  equity: number;
  candidateNotional: number;
  config: GlobalCapitalAllocatorConfig;
}): Promise<RaceRunResult> {
  const orchestrator = new GlobalCapitalAllocatorOrchestrator();
  const closeTime = Date.now() + params.runId;
  const symbol = 'BTCUSDT';
  const firstInstance: CapitalAllocatorInstanceMeta = {
    instanceId: 'detector-A',
    strategyId: 'follow-trend',
    detector: 'follow-trend',
  };
  const secondInstance: CapitalAllocatorInstanceMeta = {
    instanceId: 'detector-B',
    strategyId: 'follow-trend',
    detector: 'follow-trend',
  };

  const firstRequest = {
    config: params.config,
    candidate: {
      symbol,
      direction: 'LONG' as const,
      size: 1,
      notional: params.candidateNotional,
      closeTime,
      intentType: 'open' as const,
      correlationId: `race-${params.runId}-A`,
      idempotencyKey: `race-${params.runId}-A`,
    },
    activePositions: [],
    equity: params.equity,
    instance: firstInstance,
    reservationTtlMs: 30_000,
    idempotencyTtlMs: 60_000,
  };
  const secondRequest = {
    ...firstRequest,
    candidate: {
      ...firstRequest.candidate,
      correlationId: `race-${params.runId}-B`,
      idempotencyKey: `race-${params.runId}-B`,
    },
    instance: secondInstance,
  };

  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const firstPromise = (async () => {
    await gate;
    return orchestrator.evaluate(firstRequest);
  })();
  const secondPromise = (async () => {
    await gate;
    return orchestrator.evaluate(secondRequest);
  })();

  releaseGate();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  const capNotional = (params.equity * params.config.maxTotalExposurePct) / 100;
  const symbolCapNotional = (params.equity * params.config.maxExposurePerSymbolPct) / 100;
  return { first, second, capNotional, symbolCapNotional };
}

function assertRaceRun(result: RaceRunResult, candidateNotional: number): void {
  assertTrue(
    result.first.allowed && result.first.scaleFactor > 0,
    `[first-invalid] expected first to pass fully or partially, got allowed=${result.first.allowed} scale=${result.first.scaleFactor} reason=${result.first.reason}`,
  );
  assertSecondDecisionShape(result.second);
  assertNoDoubleFull(result.first, result.second, candidateNotional);
  assertExposureCaps(result.first, result.capNotional, result.symbolCapNotional);
  assertExposureCaps(result.second, result.capNotional, result.symbolCapNotional);
}

function toCompact(decision: CapitalAllocatorDecision): Record<string, unknown> {
  return {
    allowed: decision.allowed,
    scaleFactor: Number(decision.scaleFactor.toFixed(6)),
    reason: decision.reason,
    scaledNotional: Number((decision.diagnostics.scaledNotional ?? 0).toFixed(6)),
    totalExposureAfter: Number((decision.diagnostics.totalExposureAfter ?? 0).toFixed(6)),
    symbolExposureAfter: Number((decision.diagnostics.symbolExposureAfter ?? 0).toFixed(6)),
  };
}

async function runScenario(params: {
  scenarioName: string;
  rounds: number;
  config: GlobalCapitalAllocatorConfig;
  equity: number;
  candidateNotional: number;
}): Promise<void> {
  let secondScaled = 0;
  let secondDenied = 0;
  let secondReasons: Partial<Record<CapitalAllocationReason, number>> = {};
  let sample: RaceRunResult | null = null;

  for (let runId = 1; runId <= params.rounds; runId += 1) {
    const result = await runSingleRace({
      runId,
      equity: params.equity,
      candidateNotional: params.candidateNotional,
      config: params.config,
    });
    assertRaceRun(result, params.candidateNotional);
    sample = result;

    if (result.second.allowed && result.second.scaleFactor > 0 && result.second.scaleFactor < 1) {
      secondScaled += 1;
    } else if (!result.second.allowed) {
      secondDenied += 1;
    }
    const reason = result.second.reason;
    if (reason) {
      secondReasons = {
        ...secondReasons,
        [reason]: (secondReasons[reason] ?? 0) + 1,
      };
    }
  }

  console.log(
    JSON.stringify(
      {
        scenario: params.scenarioName,
        rounds: params.rounds,
        capNotional: Number(((params.equity * params.config.maxTotalExposurePct) / 100).toFixed(6)),
        symbolCapNotional: Number(
          ((params.equity * params.config.maxExposurePerSymbolPct) / 100).toFixed(6),
        ),
        candidateNotional: params.candidateNotional,
        secondScaled,
        secondDenied,
        secondReasons,
        sample: sample
          ? {
              first: toCompact(sample.first),
              second: toCompact(sample.second),
            }
          : null,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const rounds = readPositiveIntEnv('ALLOCATOR_RACE_ROUNDS', 200);
  const equity = 1_000;
  const candidateNotional = 80;
  const baseConfig = {
    enabled: true,
    maxTotalExposurePct: 10,
    maxExposurePerSymbolPct: 10,
  } satisfies Pick<
    GlobalCapitalAllocatorConfig,
    'enabled' | 'maxTotalExposurePct' | 'maxExposurePerSymbolPct'
  >;

  await runScenario({
    scenarioName: 'scale-mode',
    rounds,
    equity,
    candidateNotional,
    config: {
      ...baseConfig,
      breachAction: 'scale',
    },
  });

  await runScenario({
    scenarioName: 'deny-mode',
    rounds,
    equity,
    candidateNotional,
    config: {
      ...baseConfig,
      breachAction: 'deny',
    },
  });

  console.log('[allocator-race-prod] PASS');
}

main().catch((error: unknown) => {
  console.error(
    `[allocator-race-prod] FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
