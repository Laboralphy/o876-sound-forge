import jsfxr, { type PresetName, type SynthParams } from "jsfxr";

export const WAVE_TYPES = { square: 0, sawtooth: 1, sine: 2, noise: 3 } as const;
export type WaveName = keyof typeof WAVE_TYPES;

export const PRESETS: readonly PresetName[] = [
  "pickupCoin", "laserShoot", "explosion", "powerUp", "hitHurt",
  "jump", "blipSelect", "synth", "tone", "click", "random",
];

export type OutputFormat = "flac" | "wav";

export interface OutputOptions {
  /** Defaults to "flac" (falls back to "wav" if ffmpeg is unavailable). */
  format?: OutputFormat;
  /** Output sample rate. Defaults to the synth's sample_rate (44100). */
  sampleRate?: number;
  /** 8 (wav only), 16 or 24. Defaults to 16. */
  bitDepth?: 8 | 16 | 24;
  /** Peak-normalize to this level in dBFS (true = -1 dBFS). */
  normalize?: boolean | number;
  /** Silence (in seconds) appended after the sound. */
  padEnd?: number;
}

export type RecipeParams = Partial<Omit<SynthParams, "wave_type">> & {
  wave_type?: number | WaveName;
};

export interface Recipe {
  /** Used as the output file name. */
  name?: string;
  /** Start from a jsfxr preset (randomised; use `seed` to make it reproducible). */
  preset?: PresetName;
  /** Start from an sfxr.me share string (base58). */
  b58?: string;
  /** Seed for jsfxr's randomness (presets, noise waveform). */
  seed?: number;
  /** Apply jsfxr's `mutate()` this many times after the base is built. */
  mutations?: number;
  /** Parameter overrides, applied last. Same keys as sfxr.me's "serialize" JSON. */
  params?: RecipeParams;
  /** Mix other sounds instead of synthesising one. Excludes preset/b58/seed/mutations/params. */
  layers?: Layer[];
  output?: OutputOptions;
}

export interface Layer {
  /**
   * An inline recipe, or a reference to one: "file.json#name" (path relative
   * to the referencing file), "#name" (same file) or "file.json" (single-recipe file).
   */
  sound: string | Recipe;
  /** Start time in seconds (default 0). */
  offset?: number;
  /** Gain in dB (default 0). */
  gain?: number;
}

const SYNTH_KEYS = ["preset", "b58", "seed", "mutations", "params"] as const;
const LAYER_KEYS = new Set(["sound", "offset", "gain"]);

const UNSIGNED_KEYS = [
  "p_env_attack", "p_env_sustain", "p_env_punch", "p_env_decay",
  "p_base_freq", "p_freq_limit", "p_vib_strength", "p_vib_speed",
  "p_arp_speed", "p_duty", "p_repeat_speed", "p_lpf_freq",
  "p_lpf_resonance", "p_hpf_freq",
] as const;
const SIGNED_KEYS = jsfxr.parameters.signed;
const OTHER_KEYS = ["wave_type", "sound_vol", "sample_rate", "sample_size", "oldParams"];
const PARAM_KEYS = new Set<string>([...UNSIGNED_KEYS, ...SIGNED_KEYS, ...OTHER_KEYS]);
const RECIPE_KEYS = new Set(["name", ...SYNTH_KEYS, "layers", "output"]);

export class RecipeError extends Error {}

/**
 * Accepts either a Recipe or a raw sfxr.me "serialize" JSON object
 * (top-level p_* keys), and returns a validated Recipe.
 */
export function normalizeRecipe(input: unknown, where: string): Recipe {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RecipeError(`${where}: recipe must be a JSON object`);
  }
  const obj = input as Record<string, unknown>;
  const looksRaw = Object.keys(obj).some((k) => k.startsWith("p_") || k === "wave_type");
  const recipe: Recipe = looksRaw ? { params: obj as RecipeParams } : (obj as Recipe);

  if (!looksRaw) {
    for (const k of Object.keys(obj)) {
      if (!RECIPE_KEYS.has(k)) throw new RecipeError(`${where}: unknown recipe key "${k}"`);
    }
  }
  if (recipe.preset !== undefined && !PRESETS.includes(recipe.preset)) {
    throw new RecipeError(`${where}: unknown preset "${recipe.preset}" (expected one of ${PRESETS.join(", ")})`);
  }
  if (recipe.preset !== undefined && recipe.b58 !== undefined) {
    throw new RecipeError(`${where}: use either "preset" or "b58", not both`);
  }
  if (recipe.layers !== undefined) {
    const conflict = SYNTH_KEYS.find((k) => recipe[k] !== undefined);
    if (conflict) throw new RecipeError(`${where}: "layers" cannot be combined with "${conflict}"`);
    recipe.layers = validateLayers(recipe.layers, where);
  }
  validateParams(recipe.params ?? {}, where);
  validateOutput(recipe.output ?? {}, where);
  return recipe;
}

function validateLayers(layers: unknown, where: string): Layer[] {
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new RecipeError(`${where}: "layers" must be a non-empty array`);
  }
  return layers.map((layer: unknown, i) => {
    const at = `${where}.layers[${i}]`;
    if (typeof layer !== "object" || layer === null || Array.isArray(layer)) {
      throw new RecipeError(`${at}: layer must be an object`);
    }
    const l = layer as Record<string, unknown>;
    for (const k of Object.keys(l)) {
      if (!LAYER_KEYS.has(k)) throw new RecipeError(`${at}: unknown layer key "${k}"`);
    }
    if (l.offset !== undefined && !(typeof l.offset === "number" && l.offset >= 0)) {
      throw new RecipeError(`${at}: offset must be a number >= 0`);
    }
    if (l.gain !== undefined && !(typeof l.gain === "number" && Number.isFinite(l.gain))) {
      throw new RecipeError(`${at}: gain must be a number (dB)`);
    }
    let sound: string | Recipe;
    if (typeof l.sound === "string") {
      if (!/^[^#]*(#.+)?$/.test(l.sound) || l.sound === "") throw new RecipeError(`${at}: invalid sound reference "${l.sound}"`);
      sound = l.sound;
    } else {
      sound = normalizeRecipe(l.sound, `${at}.sound`);
    }
    return { ...(l as Partial<Layer>), sound };
  });
}

function validateParams(params: RecipeParams, where: string): void {
  for (const [key, value] of Object.entries(params)) {
    if (!PARAM_KEYS.has(key)) throw new RecipeError(`${where}: unknown param "${key}"`);
    if (key === "oldParams") continue;
    if (key === "wave_type") {
      const ok = typeof value === "string" ? value in WAVE_TYPES : [0, 1, 2, 3].includes(value as number);
      if (!ok) throw new RecipeError(`${where}: wave_type must be 0-3 or one of ${Object.keys(WAVE_TYPES).join(", ")}`);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RecipeError(`${where}: param "${key}" must be a number`);
    }
    const signed = SIGNED_KEYS.includes(key);
    if (signed || (UNSIGNED_KEYS as readonly string[]).includes(key)) {
      const min = signed ? -1 : 0;
      if (value < min || value > 1) throw new RecipeError(`${where}: param "${key}" must be in [${min}, 1], got ${value}`);
    }
  }
  if (params.sample_size !== undefined && params.sample_size !== 8 && params.sample_size !== 16) {
    throw new RecipeError(`${where}: sample_size must be 8 or 16`);
  }
  if (params.sample_rate !== undefined && params.sample_rate <= 0) {
    throw new RecipeError(`${where}: sample_rate must be positive`);
  }
}

function validateOutput(out: OutputOptions, where: string): void {
  if (out.format !== undefined && out.format !== "flac" && out.format !== "wav") {
    throw new RecipeError(`${where}: output.format must be "flac" or "wav"`);
  }
  if (out.bitDepth !== undefined && ![8, 16, 24].includes(out.bitDepth)) {
    throw new RecipeError(`${where}: output.bitDepth must be 8, 16 or 24`);
  }
  if (out.sampleRate !== undefined && !(Number.isInteger(out.sampleRate) && out.sampleRate >= 8000)) {
    throw new RecipeError(`${where}: output.sampleRate must be an integer >= 8000`);
  }
  if (out.padEnd !== undefined && !(out.padEnd >= 0)) {
    throw new RecipeError(`${where}: output.padEnd must be >= 0`);
  }
}

/** Builds the final jsfxr parameter set for a recipe. */
export function buildParams(recipe: Recipe): SynthParams {
  const p = new jsfxr.Params();
  p.sound_vol = 0.25; // sfxr.me's default; jsfxr's Params() uses 0.5
  if (recipe.preset) {
    p[recipe.preset]();
  } else if (recipe.b58) {
    p.fromB58(recipe.b58);
  }
  for (let i = 0; i < (recipe.mutations ?? 0); i++) p.mutate();

  const { wave_type, ...rest } = recipe.params ?? {};
  p.fromJSON(rest);
  if (wave_type !== undefined) {
    p.wave_type = typeof wave_type === "string" ? WAVE_TYPES[wave_type] : wave_type;
  }
  return p;
}
