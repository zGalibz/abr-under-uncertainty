
import { ConservativeThroughputPolicy, POLICY_ID } from './policy/conservative.js';
import { StallTracker } from './stall-tracker.js';
import { forwardBufferSeconds, playbackQuality } from './telemetry.js';

export const DEFAULT_POLICY_ID = 'default-hlsjs';
export const POLICY_IDS = Object.freeze([DEFAULT_POLICY_ID, POLICY_ID]);

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function levelData(level, index) {
  return {
    level: index,
    width: Math.max(1, Number(level.width) || 1),
    height: Math.max(1, Number(level.height) || 1),
    bitrateBps: Math.max(1, Math.round(Number(level.bitrate) || 1)),
    averageBitrateBps: numberOrNull(level.averageBitrate),
    codecs: String(level.codecs || 'unknown'),
  };
}

function mainFragment(fragment) {
  return fragment?.type === 'main' && Number.isInteger(fragment.sn);
}

/** Browser adapter: hls.js public events in, normalized telemetry and policy calls out. */
export class PlayerController {
  constructor({
    HlsClass,
    video,
    telemetry,
    onState = () => {},
    onTerminal = async () => {},
    monoNow = () => performance.now(),
    documentRef = globalThis.document,
  }) {
    this.HlsClass = HlsClass;
    this.video = video;
    this.telemetry = telemetry;
    this.onState = onState;
    this.onTerminal = onTerminal;
    this.monoNow = monoNow;
    this.documentRef = documentRef;

    this.listeners = [];
    this.mediaListeners = [];
    this.documentListeners = [];
    this.policy = null;
    this.policyReady = false;
    this.hls = null;
    this.levels = [];
    this.effectiveLevel = null;
    this.requestedLevel = null;
    this.stalls = new StallTracker();
    this.finished = false;
    this.sampleTimer = null;
    this.runState = 'IDLE';
  }

  async start({ manifestUrl, policyId }) {
    if (!POLICY_IDS.includes(policyId)) {
      throw new Error(`unknown policy: ${policyId}`);
    }

    if (!this.HlsClass?.isSupported?.()) {
      throw new Error('hls.js MSE support is unavailable; Chrome is required for measured runs');
    }

    this.policyId = policyId;
    this.runState = 'LOADING';
    this.policyReady = false;

    const custom = policyId === POLICY_ID;

    this.hls = new this.HlsClass({
      startLevel: custom ? 0 : -1,
      capLevelToPlayerSize: false,
    });

    this.resolvedConfig = {
      hlsJsVersion: this.HlsClass.version,
      startLevel: this.hls.config.startLevel,
      capLevelToPlayerSize: this.hls.config.capLevelToPlayerSize,
    };

    if (custom) {
      this.policy = new ConservativeThroughputPolicy();
    }

    this.bindHlsEvents();
    this.bindMediaEvents();
    this.bindDocumentEvents();

    this.hls.loadSource(manifestUrl);
    this.hls.attachMedia(this.video);

    this.sampleTimer = setInterval(() => this.emitSample(), 250);

    this.publish();

    await this.video.play();
  }

  bindHls(event, handler) {
    this.hls.on(event, handler);
    this.listeners.push([event, handler]);
  }

  bindMedia(event, handler) {
    this.video.addEventListener(event, handler);
    this.mediaListeners.push([event, handler]);
  }

  // A hidden tab is throttled by the browser, which would make the run unfair,
  // so visibility changes are evidence (the validator marks such a run
  // harness-invalid). A page that is already hidden at start is recorded too.
  bindDocumentEvents() {
    const doc = this.documentRef;
    if (typeof doc?.addEventListener !== 'function') return;

    const handler = () => {
      this.telemetry.emit('client.visibility_changed', { state: doc.visibilityState });
    };

    doc.addEventListener('visibilitychange', handler);
    this.documentListeners.push(['visibilitychange', handler]);

    if (doc.visibilityState !== 'visible') handler();
  }

  // Nothing may follow client.finished in the evidence log, so every listener
  // is removed as soon as the run is terminal.
  detachListeners() {
    for (const [event, handler] of this.listeners) {
      this.hls?.off(event, handler);
    }

    for (const [event, handler] of this.mediaListeners) {
      this.video.removeEventListener(event, handler);
    }

    for (const [event, handler] of this.documentListeners) {
      this.documentRef?.removeEventListener?.(event, handler);
    }

    this.listeners = [];
    this.mediaListeners = [];
    this.documentListeners = [];
  }

  bindHlsEvents() {
    const E = this.HlsClass.Events;

    this.bindHls(E.MANIFEST_PARSED, (_event, data) => {
      this.levels = (data.levels || this.hls.levels || []).map(levelData);

      this.telemetry.emit('hls.manifest_parsed', {
        levels: this.levels,
        firstLevel: Math.max(0, Number(data.firstLevel) || 0),
      });

      if (this.policy) {
        try {
          const decision = this.policy.onManifest(this.levels);
          this.policyReady = true;
          this.applyDecision(decision);
        } catch (error) {
          void this.complete('fatal_error', error);
        }
      }

      this.runState = 'PLAYING';
      this.publish();
    });

    this.bindHls(E.LEVELS_UPDATED, (_event, data) => {
      this.levels = (data.levels || this.hls.levels || []).map(levelData);

      this.telemetry.emit('hls.levels_updated', {
        levels: this.levels,
      });

      if (this.policy && this.policyReady) {
        try {
          this.policy.setLevels(this.levels);
        } catch (error) {
          void this.complete('fatal_error', error);
        }
      }

      this.publish();
    });

    this.bindHls(E.LEVEL_SWITCHING, (_event, data) => {
      const level = this.levelFromEvent(data);
      this.requestedLevel = level.level;

      this.telemetry.emit('hls.level_switching', level, this.video.currentTime);
      this.publish();
    });

    this.bindHls(E.LEVEL_SWITCHED, (_event, data) => {
      const level = this.levelFromEvent(data);
      this.effectiveLevel = level.level;

      this.telemetry.emit('hls.level_switched', level, this.video.currentTime);
      this.publish();
    });

    this.bindHls(E.FRAG_LOADING, (_event, data) => {
      if (!mainFragment(data.frag)) return;

      this.telemetry.emit('hls.frag_loading', this.fragmentBase(data.frag));
    });

    this.bindHls(E.FRAG_LOADED, (_event, data) => {
      if (!mainFragment(data.frag)) return;

      const stats = data.frag.stats || data.stats || {};
      const loading = stats.loading || {};

      this.telemetry.emit('hls.frag_loaded', {
        level: data.frag.level,
        sn: data.frag.sn,
        bytes: Math.max(0, Math.trunc(stats.loaded || 0)),
        loadStartMs: Math.max(0, loading.start || 0),
        firstByteMs: Math.max(0, loading.first || loading.start || 0),
        loadEndMs: Math.max(0, loading.end || loading.start || 0),
      });
    });

    this.bindHls(E.FRAG_BUFFERED, (_event, data) => {
      if (!mainFragment(data.frag)) return;

      const stats = data.stats || data.frag.stats || {};
      const loading = stats.loading || {};

      this.telemetry.emit('hls.frag_buffered', {
        level: data.frag.level,
        sn: data.frag.sn,
        bytes: Math.max(0, Math.trunc(stats.loaded || 0)),
        bandwidthEstimateBps: numberOrNull(this.hls.bandwidthEstimate),
      });

      if (this.policy && this.policyReady) {
        this.applyDecision(
          this.policy.onFragment({
            bytes: stats.loaded,
            loadStartMs: loading.start,
            loadEndMs: loading.end,
            aborted: Boolean(stats.aborted),
            retry: Number(stats.retry) || 0,
            durationSec: data.frag.duration,
            type: data.frag.type,
          }, this.snapshot()),
        );
      }
    });

    this.bindHls(E.FRAG_CHANGED, (_event, data) => {
      if (!mainFragment(data.frag)) return;

      const level = this.levels.find((item) => item.level === data.frag.level);
      if (!level) return;

      this.telemetry.emit('hls.frag_changed', {
        level: level.level,
        sn: data.frag.sn,
        startSec: Math.max(0, data.frag.start || 0),
        durationSec: Math.max(Number.EPSILON, data.frag.duration || 0),
        bitrateBps: level.bitrateBps,
        width: level.width,
        height: level.height,
      }, this.video.currentTime);
    });

    this.bindHls(E.ERROR, (_event, data) => this.onHlsError(data));
  }

  bindMediaEvents() {
    this.bindMedia('play', () => {
      this.stalls.onPlayRequested(this.monoNow());

      this.telemetry.emit('media.play_requested', {
        muted: this.video.muted,
        autoplay: this.video.autoplay,
      });
    });

    this.bindMedia('playing', () => {
      const result = this.stalls.onPlaying(this.monoNow());

      this.telemetry.emit('media.playing', this.mediaState(), this.video.currentTime);

      if (result.stall) {
        this.noteStall(result.stall);
      }

      this.publish();
    });

    this.bindMedia('waiting', () => {
      const context = {
        intended: !this.video.paused,
        paused: this.video.paused,
        seeking: this.video.seeking,
        ended: this.video.ended,
        mediaTimeSec: this.video.currentTime,
      };

      const opened = this.stalls.onWaiting(this.monoNow(), context);

      this.telemetry.emit('media.waiting', this.mediaState(), this.video.currentTime);

      // Do not send startup waiting events to the policy before manifest processing.
      if (opened && this.policy && this.policyReady) {
        this.applyDecision(
          this.policy.onRisk('waiting', this.snapshot()),
        );
      }

      this.publish();
    });

    this.bindMedia('stalled', () => {
      this.telemetry.emit('media.stalled', this.mediaState(), this.video.currentTime);
    });

    this.bindMedia('pause', () => {
      const stall = this.stalls.onPauseOrSeek(this.monoNow(), 'pause');

      this.telemetry.emit('media.pause', {
        reason: this.video.ended ? 'ended' : 'user',
      }, this.video.currentTime);

      if (stall) {
        this.noteStall(stall);
      }
    });

    this.bindMedia('seeking', () => {
      const stall = this.stalls.onPauseOrSeek(this.monoNow(), 'seek');

      this.telemetry.emit('media.seeking', {
        targetTimeSec: this.video.currentTime,
      }, this.video.currentTime);

      if (stall) {
        this.noteStall(stall);
      }
    });

    this.bindMedia('seeked', () => {
      this.telemetry.emit('media.seeked', {
        targetTimeSec: this.video.currentTime,
      }, this.video.currentTime);
    });

    this.bindMedia('ratechange', () => {
      this.telemetry.emit('media.rate_changed', {
        playbackRate: this.video.playbackRate || 1,
      });
    });

    this.bindMedia('ended', () => {
      this.telemetry.emit('media.ended', {
        durationSec: Math.max(0, this.video.duration || 0),
      }, this.video.currentTime);

      void this.complete('ended');
    });

    this.bindMedia('error', () => {
      const error = this.video.error;

      this.telemetry.emit('media.error', {
        code: error?.code ?? null,
        message: error?.message || 'unknown media error',
      });

      void this.complete('fatal_error', error);
    });
  }

  onHlsError(data) {
    const status = data.response?.code ?? data.response?.status;

    this.telemetry.emit('hls.error', {
      fatal: Boolean(data.fatal),
      errorType: String(data.type || 'unknown'),
      details: String(data.details || 'unknown'),
      // A request that never got an HTTP response (aborted, network changed,
      // connection refused) reports code 0. That is "no status", not an HTTP
      // status: the schema allows 100-599 or null, and one invalid event makes
      // the server reject the whole batch, so the run could never finalize.
      httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    });

    const stalled =
      data.details === this.HlsClass.ErrorDetails?.BUFFER_STALLED_ERROR ||
      data.details === 'bufferStalledError';

    const fragFailure =
      mainFragment(data.frag) &&
      /fragLoad(Error|TimeOut)|network/i.test(String(data.details));

    if (this.policy && this.policyReady && (stalled || fragFailure)) {
      this.applyDecision(
        this.policy.onRisk(
          stalled ? 'buffer_stall' : 'frag_error',
          this.snapshot(),
        ),
      );
    }

    if (data.fatal) {
      void this.complete(
        'fatal_error',
        new Error(String(data.details || data.type || 'hls fatal error')),
      );
    }
  }

  applyDecision(decision) {
    // This is deliberately the sole custom-policy actuator. Baseline never reaches it.
    if (!this.policy || this.finished) return;

    this.requestedLevel = decision.toLevel;

    if (this.hls.loadLevel !== decision.toLevel) {
      this.hls.loadLevel = decision.toLevel;
    }

    this.telemetry.emit('abr.decision', decision);
    this.publish();
  }

  emitSample() {
    if (!this.finished) {
      this.telemetry.emit('media.sample', {
        currentTimeSec: Math.max(0, this.video.currentTime || 0),
        readyState: this.video.readyState,
        forwardBufferSec: forwardBufferSeconds(this.video),
        paused: this.video.paused,
        seeking: this.video.seeking,
        playbackRate: this.video.playbackRate || 1,
      }, this.video.currentTime);

      this.publish();
    }
  }

  noteStall(stall) {
    this.lastStall = stall;
    this.publish();
  }

  mediaState() {
    return {
      readyState: this.video.readyState,
      forwardBufferSec: forwardBufferSeconds(this.video),
    };
  }

  fragmentBase(frag) {
    return {
      level: frag.level,
      sn: frag.sn,
      startSec: Math.max(0, frag.start || 0),
      durationSec: Math.max(Number.EPSILON, frag.duration || 0),
      urlPath: new URL(
        frag.url,
        globalThis.location?.origin || 'http://127.0.0.1',
      ).pathname,
    };
  }

  levelFromEvent(data) {
    const level = this.levels.find((item) => item.level === data.level);

    return level || levelData(data, Math.max(0, Number(data.level) || 0));
  }

  snapshot() {
    return {
      requestedLevel: this.requestedLevel,
      effectiveLevel: this.effectiveLevel,
      forwardBufferSec: forwardBufferSeconds(this.video),
    };
  }

  dashboardState() {
    return {
      runState: this.runState,
      policyId: this.policyId,
      requestedLevel: this.requestedLevel,
      effectiveLevel: this.effectiveLevel,
      levels: this.levels,
      forwardBufferSec: forwardBufferSeconds(this.video),
      hlsEstimateBps: numberOrNull(this.hls?.bandwidthEstimate),
      policy: this.policy?.snapshot() || null,
      stalls: this.stalls.summary(),
      lastStall: this.lastStall || null,
      resolvedConfig: this.resolvedConfig,
    };
  }

  publish() {
    this.onState(this.dashboardState());
  }

  async complete(reason, error) {
    if (this.finished) return this.terminalPromise;

    this.finished = true;
    this.runState = error ? 'FAILED' : 'FINALIZING';

    clearInterval(this.sampleTimer);

    const openStall = this.stalls.onTerminal(this.monoNow(), reason);

    if (openStall) {
      this.noteStall(openStall);
    }

    const quality = playbackQuality(this.video);

    this.telemetry.emit('client.finished', {
      reason,
      ...quality,
    });

    this.detachListeners();
    this.hls?.stopLoad?.();

    this.terminalPromise = Promise.resolve(
      this.onTerminal({
        reason,
        error,
        summary: {
          ...this.stalls.summary(),
          ...quality,
        },
      }),
    ).finally(() => {
      this.runState = error ? 'FAILED' : 'COMPLETED';
      this.publish();
    });

    return this.terminalPromise;
  }

  destroy() {
    clearInterval(this.sampleTimer);

    this.detachListeners();
    this.hls?.destroy();
    this.hls = null;
    this.runState = 'IDLE';

    this.publish();
  }
}
