type AnyRecord = Record<string, any>;

function optionalRequire<T = AnyRecord>(moduleName: string): T | null {
  if (String(process.env.BARFINEX_DISABLE_SUBSCRIPTION_LIBS || '').toLowerCase() === 'true') {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(moduleName) as T;
  } catch {
    return null;
  }
}

const signalEnginePkg = optionalRequire<AnyRecord>('@barfinex/signal-engine');
const riskEnginePkg = optionalRequire<AnyRecord>('@barfinex/risk-engine');
const portfolioEnginePkg = optionalRequire<AnyRecord>('@barfinex/portfolio-engine');

export type SignalDirection = 'Up' | 'Down' | 'Neutral';
export type MLDirection = 'Up' | 'Down' | 'Neutral';
export type AggregateSignalScore = AnyRecord;
export type MLHookPolicy = any;
export type MLSignalResponse = any;
export type TrendSignalProfile = AnyRecord;
export type SignalFeatureSet = {
  interval: string;
  price: number;
  values: Record<string, number>;
};

export const SignalDirection: Record<'Up' | 'Down' | 'Neutral', SignalDirection> =
  (signalEnginePkg?.SignalDirection as Record<'Up' | 'Down' | 'Neutral', SignalDirection>) ?? {
  Up: 'Up',
  Down: 'Down',
  Neutral: 'Neutral',
};

export const MLDirection: Record<'Up' | 'Down' | 'Neutral', MLDirection> =
  (signalEnginePkg?.MLDirection as Record<'Up' | 'Down' | 'Neutral', MLDirection>) ?? {
  Up: 'Up',
  Down: 'Down',
  Neutral: 'Neutral',
};

export const DEFAULT_TREND_PROFILE = (signalEnginePkg?.DEFAULT_TREND_PROFILE as AnyRecord) ?? {
  weights: {
    trend: 0.4,
    momentum: 0.3,
    volatility: 0.3,
  },
};

export class TrendSignalEngine {
  private readonly impl: any;

  constructor(profile: TrendSignalProfile) {
    const Impl = signalEnginePkg?.TrendSignalEngine as any;
    this.impl = Impl ? new Impl(profile) : null;
  }

  evaluateInterval(featureSet: SignalFeatureSet, context?: AnyRecord): AggregateSignalScore {
    if (this.impl?.evaluateInterval) {
      return this.impl.evaluateInterval(featureSet, context);
    }
    const score = Number(featureSet?.values?.smaFast ?? 0) >= Number(featureSet?.values?.smaSlow ?? 0)
      ? 0.6
      : 0.4;
    return {
      direction: score >= 0.55 ? SignalDirection.Up : score <= 0.45 ? SignalDirection.Down : SignalDirection.Neutral,
      score,
      confidence: Math.abs(score - 0.5) * 2,
      diagnostics: { fallback: true },
    };
  }

  aggregate(scores: AggregateSignalScore[]): AggregateSignalScore {
    if (this.impl?.aggregate) {
      return this.impl.aggregate(scores);
    }
    const normalized = Array.isArray(scores) && scores.length > 0 ? scores : [];
    if (normalized.length === 0) {
      return {
        direction: SignalDirection.Neutral,
        score: 0.5,
        confidence: 0,
        diagnostics: { fallback: true },
      };
    }
    const avgScore =
      normalized.reduce((acc, item) => acc + Number(item?.score ?? 0.5), 0) / normalized.length;
    return {
      direction:
        avgScore >= 0.55
          ? SignalDirection.Up
          : avgScore <= 0.45
            ? SignalDirection.Down
            : SignalDirection.Neutral,
      score: avgScore,
      confidence: Math.abs(avgScore - 0.5) * 2,
      diagnostics: { fallback: true },
    };
  }
}

export function applyMLHook(
  ruleDecision: AggregateSignalScore,
  mlResponse: MLSignalResponse | null,
  policy: MLHookPolicy,
): AggregateSignalScore {
  const fn = signalEnginePkg?.applyMLHook as any;
  if (typeof fn === 'function') {
    return fn(ruleDecision, mlResponse, policy);
  }
  return ruleDecision;
}

export type RiskProfile = AnyRecord;
export type RiskDecision = AnyRecord;

export const DEFAULT_RISK_PROFILE = (riskEnginePkg?.DEFAULT_RISK_PROFILE as AnyRecord) ?? {
  maxLeverage: 1,
  riskPctFloor: 0.001,
  riskPctCeil: 0.01,
};

export class RiskEngine {
  private readonly impl: any;

  constructor(profile: RiskProfile) {
    const Impl = riskEnginePkg?.RiskEngine as any;
    this.impl = Impl ? new Impl(profile) : null;
  }

  evaluate(context: AnyRecord): RiskDecision {
    if (this.impl?.evaluate) {
      return this.impl.evaluate(context);
    }
    return {
      allowed: true,
      reason: 'fallback_open_core',
      size: Number((context as AnyRecord)?.size ?? 0),
      stopDistancePct: Number((context as AnyRecord)?.stopDistancePct ?? 0.01),
      riskAmount: Number((context as AnyRecord)?.riskAmount ?? 0),
      riskPct: Number((context as AnyRecord)?.riskPct ?? 0.002),
      diagnostics: { fallback: true },
    };
  }
}

export type PortfolioDecision = AnyRecord;

export class PortfolioEngine {
  private readonly impl: any;

  constructor() {
    const Impl = portfolioEnginePkg?.PortfolioEngine as any;
    this.impl = Impl ? new Impl() : null;
  }

  evaluate(params: AnyRecord): PortfolioDecision {
    if (this.impl?.evaluate) {
      return this.impl.evaluate(params);
    }
    return {
      allow: true,
      scaleFactor: 1,
      portfolioVolBefore: 0,
      portfolioVolAfter: 0,
      averageCorrelationToPortfolio: 0,
      diagnostics: ['fallback_open_core'],
      context: params,
    };
  }
}

export type CapitalAllocatorActivePosition = AnyRecord;
export type CapitalAllocatorCandidateTrade = AnyRecord;
export type CapitalAllocatorDecision = AnyRecord;
export type GlobalCapitalAllocatorConfig = AnyRecord;
