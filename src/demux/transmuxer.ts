import type { HlsEventEmitter } from '../events';
import { Events } from '../events';
import { ErrorTypes, ErrorDetails } from '../errors';
import Decrypter from '../crypt/decrypter';
import AACDemuxer from '../demux/aacdemuxer';
import MP4Demuxer from '../demux/mp4demuxer';
import TSDemuxer, { TypeSupported } from '../demux/tsdemuxer';
import MP3Demuxer from '../demux/mp3demuxer';
import MP4Remuxer from '../remux/mp4-remuxer';
import PassThroughRemuxer from '../remux/passthrough-remuxer';
import ChunkCache from './chunk-cache';
import { appendUint8Array } from '../utils/mp4-tools';
import { logger } from '../utils/logger';
import type { Demuxer, DemuxerResult, KeyData } from '../types/demuxer';
import type { Remuxer } from '../types/remuxer';
import type { TransmuxerResult, ChunkMetadata } from '../types/transmuxer';
import type { HlsConfig } from '../config';
import type { LevelKey } from '../loader/level-key';
import type { PlaylistLevelType } from '../types/loader';

let now;
// performance.now() not available on WebWorker, at least on Safari Desktop
try {
  now = self.performance.now.bind(self.performance);
} catch (err) {
  logger.debug('Unable to use Performance API on this environment');
  now = self.Date.now;
}

type MuxConfig =
  | { demux: typeof TSDemuxer; remux: typeof MP4Remuxer }
  | { demux: typeof MP4Demuxer; remux: typeof PassThroughRemuxer }
  | { demux: typeof AACDemuxer; remux: typeof MP4Remuxer }
  | { demux: typeof MP3Demuxer; remux: typeof MP4Remuxer };

const muxConfig: MuxConfig[] = [
  { demux: MP4Demuxer, remux: PassThroughRemuxer },
  { demux: TSDemuxer, remux: MP4Remuxer },
  { demux: AACDemuxer, remux: MP4Remuxer },
  { demux: MP3Demuxer, remux: MP4Remuxer },
];

let minProbeByteLength = 1024;
muxConfig.forEach(({ demux }) => {
  minProbeByteLength = Math.max(minProbeByteLength, demux.minProbeByteLength);
});

export default class Transmuxer {
  private observer: HlsEventEmitter;
  private typeSupported: TypeSupported;
  private config: HlsConfig;
  private vendor: string;
  private id: PlaylistLevelType;
  private demuxer?: Demuxer;
  private remuxer?: Remuxer;
  private decrypter?: Decrypter;
  private probe!: Function;
  private decryptionPromise: Promise<TransmuxerResult> | null = null;
  private transmuxConfig!: TransmuxConfig;
  private currentTransmuxState!: TransmuxState;
  private cache: ChunkCache = new ChunkCache();

  constructor(
    observer: HlsEventEmitter,
    typeSupported: TypeSupported,
    config: HlsConfig,
    vendor: string,
    id: PlaylistLevelType
  ) {
    this.observer = observer;
    this.typeSupported = typeSupported;
    this.config = config;
    this.vendor = vendor;
    this.id = id;
  }

  configure(transmuxConfig: TransmuxConfig) {
    this.transmuxConfig = transmuxConfig;
    if (this.decrypter) {
      this.decrypter.reset();
    }
  }

  push(
    data: ArrayBuffer,
    decryptdata: LevelKey | null,
    chunkMeta: ChunkMetadata,
    state?: TransmuxState
  ): TransmuxerResult | Promise<TransmuxerResult> {
    const stats = chunkMeta.transmuxing;
    stats.executeStart = now();

    let uintData: Uint8Array = new Uint8Array(data);
    const { cache, config, currentTransmuxState, transmuxConfig } = this;
    if (state) {
      this.currentTransmuxState = state;
    }

    const keyData = getEncryptionType(uintData, decryptdata);
    if (keyData && keyData.method === 'AES-128') {
      const decrypter = this.getDecrypter();
      // Software decryption is synchronous; webCrypto is not
      if (config.enableSoftwareAES) {
        // Software decryption is progressive. Progressive decryption may not return a result on each call. Any cached
        // data is handled in the flush() call
        const decryptedData = decrypter.softwareDecrypt(
          uintData,
          keyData.key.buffer,
          keyData.iv.buffer
        );
        if (!decryptedData) {
          stats.executeEnd = now();
          return emptyResult(chunkMeta);
        }
        uintData = new Uint8Array(decryptedData);
      } else {
        this.decryptionPromise = decrypter
          .webCryptoDecrypt(uintData, keyData.key.buffer, keyData.iv.buffer)
          .then((decryptedData): TransmuxerResult => {
            // Calling push here is important; if flush() is called while this is still resolving, this ensures that
            // the decrypted data has been transmuxed
            const result = this.push(
              decryptedData,
              null,
              chunkMeta
            ) as TransmuxerResult;
            this.decryptionPromise = null;
            return result;
          });
        return this.decryptionPromise!;
      }
    }

    const {
      contiguous,
      discontinuity,
      trackSwitch,
      accurateTimeOffset,
      timeOffset,
      initSegmentChange,
    } = state || currentTransmuxState;
    const {
      audioCodec,
      videoCodec,
      defaultInitPts,
      duration,
      initSegmentData,
    } = transmuxConfig;

    // Reset muxers before probing to ensure that their state is clean, even if flushing occurs before a successful probe
    if (discontinuity || trackSwitch || initSegmentChange) {
      this.resetInitSegment(initSegmentData, audioCodec, videoCodec, duration);
    }

    if (discontinuity || initSegmentChange) {
      this.resetInitialTimestamp(defaultInitPts);
    }

    if (!contiguous) {
      this.resetContiguity();
    }

    if (this.needsProbing(uintData, discontinuity, trackSwitch)) {
      if (cache.dataLength) {
        const cachedData = cache.flush();
        uintData = appendUint8Array(cachedData, uintData);
      }
      this.configureTransmuxer(uintData, transmuxConfig);
    }

    const result = this.transmux(
      uintData,
      keyData,
      timeOffset,
      accurateTimeOffset,
      chunkMeta
    );
    const currentState = this.currentTransmuxState;

    currentState.contiguous = true;
    currentState.discontinuity = false;
    currentState.trackSwitch = false;

    stats.executeEnd = now();
    return result;
  }

  // Due to data caching, flush calls can produce more than one TransmuxerResult (hence the Array type)
  flush(
    chunkMeta: ChunkMetadata
  ): TransmuxerResult[] | Promise<TransmuxerResult[]> {
    const stats = chunkMeta.transmuxing;
    stats.executeStart = now();

    const { decrypter, cache, currentTransmuxState, decryptionPromise } = this;

    if (decryptionPromise) {
      // Upon resolution, the decryption promise calls push() and returns its TransmuxerResult up the stack. Therefore
      // only flushing is required for async decryption
      return decryptionPromise.then(() => {
        return this.flush(chunkMeta);
      });
    }

    const transmuxResults: TransmuxerResult[] = [];
    const { timeOffset } = currentTransmuxState;
    if (decrypter) {
      // The decrypter may have data cached, which needs to be demuxed. In this case we'll have two TransmuxResults
      // This happens in the case that we receive only 1 push call for a segment (either for non-progressive downloads,
      // or for progressive downloads with small segments)
      const decryptedData = decrypter.flush();
      if (decryptedData) {
        // Push always returns a TransmuxerResult if decryptdata is null
        transmuxResults.push(
          this.push(decryptedData, null, chunkMeta) as TransmuxerResult
        );
      }
    }

    const bytesSeen = cache.dataLength;
    cache.reset();
    const { demuxer, remuxer } = this;
    if (!demuxer || !remuxer) {
      // If probing failed, and each demuxer saw enough bytes to be able to probe, then Hls.js has been given content its not able to handle
      if (bytesSeen >= minProbeByteLength) {
        this.observer.emit(Events.ERROR, Events.ERROR, {
          type: ErrorTypes.MEDIA_ERROR,
          details: ErrorDetails.FRAG_PARSING_ERROR,
          fatal: true,
          reason: 'no demux matching with content found',
        });
      }
      stats.executeEnd = now();
      return [emptyResult(chunkMeta)];
    }

    const demuxResultOrPromise = demuxer.flush(timeOffset);
    if (isPromise(demuxResultOrPromise)) {
      // Decrypt final SAMPLE-AES samples
      return demuxResultOrPromise.then((demuxResult) => {
        this.flushRemux(transmuxResults, demuxResult, chunkMeta);
        return transmuxResults;
      });
    }

    this.flushRemux(transmuxResults, demuxResultOrPromise, chunkMeta);
    return transmuxResults;
  }

  private flushRemux(
    transmuxResults: TransmuxerResult[],
    demuxResult: DemuxerResult,
    chunkMeta: ChunkMetadata
  ) {
    const { audioTrack, videoTrack, id3Track, textTrack } = demuxResult;
    const { accurateTimeOffset, timeOffset } = this.currentTransmuxState;
    logger.log(
      `[transmuxer.ts]: Flushed fragment ${chunkMeta.sn}${
        chunkMeta.part > -1 ? ' p: ' + chunkMeta.part : ''
      } of level ${chunkMeta.level}`
    );
    const remuxResult = this.remuxer!.remux(
      audioTrack,
      videoTrack,
      id3Track,
      textTrack,
      timeOffset,
      accurateTimeOffset,
      true,
      this.id
    );
    transmuxResults.push({
      remuxResult,
      chunkMeta,
    });

    chunkMeta.transmuxing.executeEnd = now();
  }

  resetInitialTimestamp(defaultInitPts: number | undefined) {
    const { demuxer, remuxer } = this;
    if (!demuxer || !remuxer) {
      return;
    }
    demuxer.resetTimeStamp(defaultInitPts);
    remuxer.resetTimeStamp(defaultInitPts);
  }

  resetContiguity() {
    const { demuxer, remuxer } = this;
    if (!demuxer || !remuxer) {
      return;
    }
    demuxer.resetContiguity();
    remuxer.resetNextTimestamp();
  }

  resetInitSegment(
    initSegmentData: Uint8Array | undefined,
    audioCodec: string | undefined,
    videoCodec: string | undefined,
    trackDuration: number
  ) {
    const { demuxer, remuxer } = this;
    if (!demuxer || !remuxer) {
      return;
    }
    demuxer.resetInitSegment(
      initSegmentData,
      audioCodec,
      videoCodec,
      trackDuration
    );
    remuxer.resetInitSegment(initSegmentData, audioCodec, videoCodec);
  }

  destroy(): void {
    if (this.demuxer) {
      this.demuxer.destroy();
      this.demuxer = undefined;
    }
    if (this.remuxer) {
      this.remuxer.destroy();
      this.remuxer = undefined;
    }
  }

  private transmux(
    data: Uint8Array,
    keyData: KeyData | null,
    timeOffset: number,
    accurateTimeOffset: boolean,
    chunkMeta: ChunkMetadata
  ): TransmuxerResult | Promise<TransmuxerResult> {
    let result: TransmuxerResult | Promise<TransmuxerResult>;
    if (keyData && keyData.method === 'SAMPLE-AES') {
      result = this.transmuxSampleAes(
        data,
        keyData,
        timeOffset,
        accurateTimeOffset,
        chunkMeta
      );
    } else {
      result = this.transmuxUnencrypted(
        data,
        timeOffset,
        accurateTimeOffset,
        chunkMeta
      );
    }
    return result;
  }

  private transmuxUnencrypted(
    data: Uint8Array,
    timeOffset: number,
    accurateTimeOffset: boolean,
    chunkMeta: ChunkMetadata
  ): TransmuxerResult {
    const { audioTrack, videoTrack, id3Track, textTrack } = (
      this.demuxer as Demuxer
    ).demux(data, timeOffset, false, !this.config.progressive);
    const remuxResult = this.remuxer!.remux(
      audioTrack,
      videoTrack,
      id3Track,
      textTrack,
      timeOffset,
      accurateTimeOffset,
      false,
      this.id
    );
    return {
      remuxResult,
      chunkMeta,
    };
  }

  private transmuxSampleAes(
    data: Uint8Array,
    decryptData: KeyData,
    timeOffset: number,
    accurateTimeOffset: boolean,
    chunkMeta: ChunkMetadata
  ): Promise<TransmuxerResult> {
    return (this.demuxer as Demuxer)
      .demuxSampleAes(data, decryptData, timeOffset)
      .then((demuxResult) => {
        const remuxResult = this.remuxer!.remux(
          demuxResult.audioTrack,
          demuxResult.videoTrack,
          demuxResult.id3Track,
          demuxResult.textTrack,
          timeOffset,
          accurateTimeOffset,
          false,
          this.id
        );
        return {
          remuxResult,
          chunkMeta,
        };
      });
  }

  private configureTransmuxer(
    data: Uint8Array,
    transmuxConfig: TransmuxConfig
  ) {
    const { config, observer, typeSupported, vendor } = this;
    const {
      audioCodec,
      defaultInitPts,
      duration,
      initSegmentData,
      videoCodec,
    } = transmuxConfig;
    // probe for content type
    let mux;
    for (let i = 0, len = muxConfig.length; i < len; i++) {
      if (muxConfig[i].demux.probe(data)) {
        mux = muxConfig[i];
        break;
      }
    }
    if (!mux) {
      // If probing previous configs fail, use mp4 passthrough
      logger.warn(
        'Failed to find demuxer by probing frag, treating as mp4 passthrough'
      );
      mux = { demux: MP4Demuxer, remux: PassThroughRemuxer };
    }
    // so let's check that current remuxer and demuxer are still valid
    const demuxer = this.demuxer;
    const remuxer = this.remuxer;
    const Remuxer: MuxConfig['remux'] = mux.remux;
    const Demuxer: MuxConfig['demux'] = mux.demux;
    if (!remuxer || !(remuxer instanceof Remuxer)) {
      this.remuxer = new Remuxer(observer, config, typeSupported, vendor);
    }
    if (!demuxer || !(demuxer instanceof Demuxer)) {
      this.demuxer = new Demuxer(observer, config, typeSupported);
      this.probe = Demuxer.probe;
    }
    // Ensure that muxers are always initialized with an initSegment
    this.resetInitSegment(initSegmentData, audioCodec, videoCodec, duration);
    this.resetInitialTimestamp(defaultInitPts);
  }

  private needsProbing(
    data: Uint8Array,
    discontinuity: boolean,
    trackSwitch: boolean
  ): boolean {
    // in case of continuity change, or track switch
    // we might switch from content type (AAC container to TS container, or TS to fmp4 for example)
    return !this.demuxer || !this.remuxer || discontinuity || trackSwitch;
  }

  private getDecrypter(): Decrypter {
    let decrypter = this.decrypter;
    if (!decrypter) {
      decrypter = this.decrypter = new Decrypter(this.observer, this.config);
    }
    return decrypter;
  }
}

function getEncryptionType(
  data: Uint8Array,
  decryptData: LevelKey | null
): KeyData | null {
  let encryptionType: KeyData | null = null;
  if (
    data.byteLength > 0 &&
    decryptData != null &&
    decryptData.key != null &&
    decryptData.iv !== null &&
    decryptData.method != null
  ) {
    encryptionType = decryptData as KeyData;
  }
  return encryptionType;
}

const emptyResult = (chunkMeta): TransmuxerResult => ({
  remuxResult: {},
  chunkMeta,
});

export function isPromise<T>(p: Promise<T> | any): p is Promise<T> {
  return 'then' in p && p.then instanceof Function;
}

export class TransmuxConfig {
  public audioCodec?: string;
  public videoCodec?: string;
  public initSegmentData?: Uint8Array;
  public duration: number;
  public defaultInitPts?: number;

  constructor(
    audioCodec: string | undefined,
    videoCodec: string | undefined,
    initSegmentData: Uint8Array | undefined,
    duration: number,
    defaultInitPts?: number
  ) {
    this.audioCodec = audioCodec;
    this.videoCodec = videoCodec;
    this.initSegmentData = initSegmentData;
    this.duration = duration;
    this.defaultInitPts = defaultInitPts;
  }
}

export class TransmuxState {
  public discontinuity: boolean;
  public contiguous: boolean;
  public accurateTimeOffset: boolean;
  public trackSwitch: boolean;
  public timeOffset: number;
  public initSegmentChange: boolean;

  constructor(
    discontinuity: boolean,
    contiguous: boolean,
    accurateTimeOffset: boolean,
    trackSwitch: boolean,
    timeOffset: number,
    initSegmentChange: boolean
  ) {
    this.discontinuity = discontinuity;
    this.contiguous = contiguous;
    this.accurateTimeOffset = accurateTimeOffset;
    this.trackSwitch = trackSwitch;
    this.timeOffset = timeOffset;
    this.initSegmentChange = initSegmentChange;
  }
}
