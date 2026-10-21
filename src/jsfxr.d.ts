// Minimal type declarations for the parts of jsfxr we use.
declare module "jsfxr" {
  export interface SynthParams {
    oldParams?: boolean;
    wave_type: number;
    p_env_attack: number;
    p_env_sustain: number;
    p_env_punch: number;
    p_env_decay: number;
    p_base_freq: number;
    p_freq_limit: number;
    p_freq_ramp: number;
    p_freq_dramp: number;
    p_vib_strength: number;
    p_vib_speed: number;
    p_arp_mod: number;
    p_arp_speed: number;
    p_duty: number;
    p_duty_ramp: number;
    p_repeat_speed: number;
    p_pha_offset: number;
    p_pha_ramp: number;
    p_lpf_freq: number;
    p_lpf_ramp: number;
    p_lpf_resonance: number;
    p_hpf_freq: number;
    p_hpf_ramp: number;
    sound_vol: number;
    sample_rate: number;
    sample_size: number;
  }

  export type PresetName =
    | "pickupCoin"
    | "laserShoot"
    | "explosion"
    | "powerUp"
    | "hitHurt"
    | "jump"
    | "blipSelect"
    | "synth"
    | "tone"
    | "click"
    | "random";

  export interface Params extends SynthParams {
    fromJSON(struct: Partial<SynthParams>): this;
    fromB58(encoded: string): this;
    toB58(): string;
    mutate(): void;
  }
  export type ParamsWithPresets = Params & { [K in PresetName]: () => Params };

  export interface RawBuffer {
    buffer: number[];
    /** Float samples, nominally in [-1, 1). */
    normalized: number[];
    clipped: number;
  }

  export interface SoundEffect {
    sampleRate: number;
    getRawBuffer(): RawBuffer;
  }

  export interface Jsfxr {
    sfxr: {
      b58decode(encoded: string): SynthParams;
      b58encode(params: Partial<SynthParams>): string;
    };
    parameters: { order: string[]; signed: string[] };
    Params: new () => ParamsWithPresets;
    SoundEffect: new (params: SynthParams | string) => SoundEffect;
    waveforms: { SQUARE: 0; SAWTOOTH: 1; SINE: 2; NOISE: 3 };
  }

  const jsfxr: Jsfxr;
  export default jsfxr;
}
