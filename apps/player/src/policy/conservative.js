export const POLICY_ID = 'conservative-throughput-v1';

export const POLICY_CONSTANTS = Object.freeze({
  fastAlpha: 0.5,
  slowAlpha: 0.2,
  normalSafety: 0.85,
  strictSafety: 0.7,
  minSampleMs: 50,
  upgradeConfirmations: 3,
  cleanAfterStall: 3,
  cleanAfterError: 2,
  fragmentsBetweenUpgrades: 2,
  lowBufferFloorSec: 4,
  highBufferFloorSec: 8,
});

export function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/** Request goodput includes time to first byte by design. */
export function requestGoodputBps(fragment, minSampleMs = POLICY_CONSTANTS.minSampleMs) {
  const bytes = fragment?.bytes;
  const startMs = fragment?.loadStartMs;
  const endMs = fragment?.loadEndMs;
  const elapsedMs = endMs - startMs;
  if (fragment?.type && fragment.type !== 'main') return null;
  if (fragment?.aborted || !Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(elapsedMs) || elapsedMs < minSampleMs) {
    return null;
  }
  return (8 * bytes * 1000) / elapsedMs;
}

export function validateLadder(rawLevels) {
  if (!Array.isArray(rawLevels) || rawLevels.length === 0) {
    throw new Error('invalid_ladder: no levels');
  }
  const levels = rawLevels.map((level, index) => ({
    index: Number.isInteger(level.index) ? level.index : index,
    bitrateBps: Number(level.bitrateBps ?? level.bitrate),
    width: Number(level.width),
    height: Number(level.height),
    codecs: String(level.codecs ?? ''),
  })).sort((a, b) => a.bitrateBps - b.bitrateBps);
  const codecFamily = levels[0].codecs.split(',')[0].trim();
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    if (!Number.isInteger(level.index) || level.index < 0 || !Number.isFinite(level.bitrateBps) || level.bitrateBps <= 0 ||
        !Number.isFinite(level.width) || level.width <= 0 || !Number.isFinite(level.height) || level.height <= 0 || !level.codecs) {
      throw new Error('invalid_ladder: invalid level fields');
    }
    if (index > 0) {
      const previous = levels[index - 1];
      if (level.bitrateBps <= previous.bitrateBps || level.width < previous.width || level.height < previous.height ||
          level.codecs.split(',')[0].trim() !== codecFamily) {
        throw new Error('invalid_ladder: not monotonic');
      }
    }
  }
  return levels;
}

function levelAtOrBelow(levels, budgetBps) {
  return levels.reduce((best, level) => level.bitrateBps <= budgetBps ? level : best, levels[0]);
}

export class ConservativeThroughputPolicy {
  constructor(constants = {}) {
    this.constants = { ...POLICY_CONSTANTS, ...constants };
    this.levels = [];
    this.fastBps = null;
    this.slowBps = null;
    this.validSamples = 0;
    this.desiredLevel = null;
    this.upEvidence = 0;
    this.cleanRecoveryRemaining = 0;
    this.fragmentsSinceUpgrade = Number.POSITIVE_INFINITY;
    this.lastDurationSec = 2;
  }

  setLevels(rawLevels) {
    this.levels = validateLadder(rawLevels);
    const stillExists = this.levels.some((level) => level.index === this.desiredLevel);
    if (!stillExists) this.desiredLevel = this.levels[0].index;
    return this.levels;
  }

  onManifest(rawLevels) {
    this.setLevels(rawLevels);
    this.fastBps = null;
    this.slowBps = null;
    this.validSamples = 0;
    this.desiredLevel = this.levels[0].index;
    this.upEvidence = 0;
    this.cleanRecoveryRemaining = 0;
    this.fragmentsSinceUpgrade = Number.POSITIVE_INFINITY;
    this.lastDurationSec = 2;
    return this.decision(this.desiredLevel, 'startup_lowest', null, 0, null, null);
  }

  onRisk(signal, snapshot) {
    this.requireLevels();
    if (signal === 'waiting' || signal === 'buffer_stall') {
      this.upEvidence = 0;
      this.cleanRecoveryRemaining = this.constants.cleanAfterStall;
      return this.selectLowest('down_stall_lowest', snapshot.forwardBufferSec ?? 0);
    }
    this.upEvidence = 0;
    this.cleanRecoveryRemaining = Math.max(this.cleanRecoveryRemaining, this.constants.cleanAfterError);
    return this.evaluate(snapshot, { retry: true, relevantError: true, validSample: false });
  }

  onFragment(fragment, snapshot) {
    this.requireLevels();
    if (Number.isFinite(fragment.durationSec) && fragment.durationSec > 0) this.lastDurationSec = fragment.durationSec;
    const sample = requestGoodputBps(fragment, this.constants.minSampleMs);
    const retried = Number(fragment.retry ?? 0) > 0;
    const validSample = sample !== null;
    if (validSample) {
      this.fastBps = this.fastBps === null ? sample : this.constants.fastAlpha * sample + (1 - this.constants.fastAlpha) * this.fastBps;
      this.slowBps = this.slowBps === null ? sample : this.constants.slowAlpha * sample + (1 - this.constants.slowAlpha) * this.slowBps;
      this.validSamples += 1;
    }
    if (!validSample || retried) this.upEvidence = 0;
    // onFragment is called only from FRAG_BUFFERED. Count just clean, valid
    // main-media fragments so risk/error evaluations cannot advance the gate.
    if (validSample && fragment?.type === 'main' && !retried && !fragment.relevantError) {
      this.fragmentsSinceUpgrade += 1;
    }
    return this.evaluate(snapshot, { retry: retried, relevantError: Boolean(fragment.relevantError), validSample });
  }

  evaluate(snapshot, flags) {
    const current = this.currentLevel(snapshot);
    const estimateBps = this.estimateBps();
    const buffer = Math.max(0, Number(snapshot.forwardBufferSec) || 0);
    const lowBuffer = buffer < Math.max(this.constants.lowBufferFloorSec, this.lastDurationSec);
    const strict = lowBuffer || flags.retry || flags.relevantError;

    if (flags.validSample && !flags.retry && !flags.relevantError && this.cleanRecoveryRemaining > 0) {
      this.cleanRecoveryRemaining -= 1;
    }
    if (estimateBps === null) return this.decision(current.index, 'hold_no_estimate', null, buffer, null);

    const safetyFactor = strict ? this.constants.strictSafety : this.constants.normalSafety;
    const safeBudgetBps = safetyFactor * estimateBps;
    const safe = levelAtOrBelow(this.levels, safeBudgetBps);
    const currentRank = this.levels.findIndex((level) => level.index === current.index);
    const safeRank = this.levels.findIndex((level) => level.index === safe.index);

    if (currentRank > safeRank) {
      this.upEvidence = 0;
      const reason = lowBuffer ? 'down_low_buffer' : (flags.retry || flags.relevantError ? 'down_retry_or_error' : 'down_throughput');
      return this.setDesired(safe.index, reason, buffer, safetyFactor);
    }

    const next = this.levels[currentRank + 1];
    if (!next) return this.decision(current.index, 'hold_safe', this.constants.normalSafety, buffer, this.constants.normalSafety * estimateBps);
    const upgradeBudget = this.constants.strictSafety * estimateBps;
    const qualifies = flags.validSample && !flags.retry && !flags.relevantError && next.bitrateBps <= upgradeBudget;
    this.upEvidence = qualifies ? this.upEvidence + 1 : 0;
    if (!qualifies) return this.decision(current.index, 'hold_upgrade_bandwidth', this.constants.strictSafety, buffer, upgradeBudget);
    if (this.cleanRecoveryRemaining > 0) return this.decision(current.index, 'hold_recovery', this.constants.strictSafety, buffer, upgradeBudget);
    if (this.upEvidence < this.constants.upgradeConfirmations) return this.decision(current.index, 'hold_upgrade_evidence', this.constants.strictSafety, buffer, upgradeBudget);
    const highBuffer = Math.max(this.constants.highBufferFloorSec, 2 * this.lastDurationSec);
    if (buffer < highBuffer) return this.decision(current.index, 'hold_upgrade_buffer', this.constants.strictSafety, buffer, upgradeBudget);
    if (this.fragmentsSinceUpgrade < this.constants.fragmentsBetweenUpgrades) return this.decision(current.index, 'hold_recovery', this.constants.strictSafety, buffer, upgradeBudget);
    this.fragmentsSinceUpgrade = 0;
    this.upEvidence = 0;
    return this.setDesired(next.index, 'up_confirmed_one_rung', buffer, this.constants.strictSafety);
  }

  selectLowest(reason, buffer) {
    return this.setDesired(this.levels[0].index, reason, buffer, this.constants.strictSafety);
  }

  setDesired(levelIndex, reason, buffer, safetyFactor) {
    const fromLevel = this.desiredLevel;
    this.desiredLevel = levelIndex;
    const fromRank = this.levels.findIndex((level) => level.index === fromLevel);
    const toRank = this.levels.findIndex((level) => level.index === levelIndex);
    if (levelIndex !== fromLevel && toRank >= 0 && fromRank >= 0 && toRank < fromRank) this.upEvidence = 0;
    return this.decision(levelIndex, reason, safetyFactor, buffer, safetyFactor === null ? null : safetyFactor * this.estimateBps(), fromLevel);
  }

  currentLevel(snapshot) {
    const candidate = [this.desiredLevel, snapshot?.requestedLevel, snapshot?.effectiveLevel].find((index) => this.levels.some((level) => level.index === index));
    if (candidate === undefined) this.desiredLevel = this.levels[0].index;
    return this.levels.find((level) => level.index === (candidate ?? this.desiredLevel));
  }

  estimateBps() {
    return this.fastBps === null || this.slowBps === null ? null : Math.min(this.fastBps, this.slowBps);
  }

  decision(toLevel, reason, safetyFactor, forwardBufferSec, safeBudgetBps, fromLevel = this.desiredLevel) {
    return {
      policyId: POLICY_ID,
      fromLevel: Number.isInteger(fromLevel) ? fromLevel : null,
      toLevel,
      reason,
      validSamples: this.validSamples,
      fastBps: finiteOrNull(this.fastBps),
      slowBps: finiteOrNull(this.slowBps),
      estimateBps: finiteOrNull(this.estimateBps()),
      safetyFactor: finiteOrNull(safetyFactor),
      safeBudgetBps: finiteOrNull(safeBudgetBps),
      forwardBufferSec: Math.max(0, forwardBufferSec),
      upEvidence: this.upEvidence,
    };
  }

  snapshot() {
    return {
      desiredLevel: this.desiredLevel,
      fastBps: finiteOrNull(this.fastBps),
      slowBps: finiteOrNull(this.slowBps),
      estimateBps: finiteOrNull(this.estimateBps()),
      validSamples: this.validSamples,
      upEvidence: this.upEvidence,
      cleanRecoveryRemaining: this.cleanRecoveryRemaining,
    };
  }

  requireLevels() {
    if (this.levels.length === 0) throw new Error('invalid_ladder: manifest has not been processed');
  }
}
