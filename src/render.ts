import path from "node:path";
import jsfxr, { type SynthParams } from "jsfxr";
import { buildParams, RecipeError, type Layer, type Recipe } from "./recipe.ts";
import type { RecipeLibrary } from "./library.ts";

export interface RenderResult {
  /** The synth parameters; absent for layered recipes. */
  params?: SynthParams;
  /** Mono float samples in [-1, 1]. */
  samples: Float32Array;
  sampleRate: number;
  /** Samples that exceeded full scale before clamping. */
  clipped: number;
  /** Samples clipped inside layers, before mixing. */
  layerClipped: number;
}

/** mulberry32: small, fast, good-enough PRNG for reproducible renders. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** jsfxr calls Math.random directly, so temporarily swap it for a seeded PRNG. */
function withSeed<T>(seed: number | undefined, fn: () => T): T {
  if (seed === undefined) return fn();
  const original = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

export interface RenderContext {
  /** Needed to resolve string layer references. */
  library?: RecipeLibrary;
  /** File the recipe came from; references resolve relative to it. */
  file?: string;
  /** Recipes currently being rendered, for cycle detection. */
  stack?: string[];
}

const DEFAULT_RATE = 44100;

export function renderRecipe(recipe: Recipe, ctx: RenderContext = {}): RenderResult {
  if (recipe.layers) {
    const sampleRate = recipe.output?.sampleRate ?? DEFAULT_RATE;
    const { samples, clipped } = mixLayers(recipe.layers, sampleRate, ctx);
    return { ...finish(recipe, samples, sampleRate), layerClipped: clipped };
  }
  return withSeed(recipe.seed, () => {
    const params = buildParams(recipe);
    const raw = new jsfxr.SoundEffect(params).getRawBuffer().normalized;
    // jsfxr always synthesises the same sample stream; sample_rate is the
    // rate it is played back at (sfxr.me behaviour), so honour it here.
    return { params, ...finish(recipe, Float32Array.from(raw), params.sample_rate), layerClipped: 0 };
  });
}

/** Applies a recipe's output options: resample, normalize, clamp, pad. */
function finish(recipe: Recipe, input: Float32Array, inputRate: number) {
  const opts = recipe.output ?? {};
  let samples = input;
  let sampleRate = inputRate;
  if (opts.sampleRate && opts.sampleRate !== sampleRate) {
    samples = resample(samples, sampleRate, opts.sampleRate);
    sampleRate = opts.sampleRate;
  }

  if (opts.normalize !== undefined && opts.normalize !== false) {
    const targetDb = opts.normalize === true ? -1 : opts.normalize;
    normalizePeak(samples, targetDb);
  }

  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (s > 1 || s < -1) {
      clipped++;
      samples[i] = s > 1 ? 1 : -1;
    }
  }

  if (opts.padEnd) {
    const padded = new Float32Array(samples.length + Math.round(opts.padEnd * sampleRate));
    padded.set(samples);
    samples = padded;
  }

  return { samples, sampleRate, clipped };
}

/** Renders each layer as its own recipe (with its own output options), then sums them. */
function mixLayers(layers: Layer[], sampleRate: number, ctx: RenderContext) {
  const stack = ctx.stack ?? [];
  const tracks = layers.map((layer) => {
    let recipe: Recipe;
    let file = ctx.file;
    let label: string;
    if (typeof layer.sound === "string") {
      if (!ctx.library || !ctx.file) throw new RecipeError(`cannot resolve "${layer.sound}" without a recipe file`);
      const entry = ctx.library.resolve(layer.sound, ctx.file);
      ({ recipe, file } = entry);
      label = `${entry.file === "-" ? "stdin" : path.resolve(entry.file)}#${entry.recipe.name ?? entry.outName}`;
      if (stack.includes(label)) throw new RecipeError(`layer cycle: ${[...stack, label].join(" -> ")}`);
    } else {
      recipe = layer.sound;
      label = `inline:${recipe.name ?? "?"}`;
    }
    const rendered = renderRecipe(recipe, { ...ctx, file, stack: [...stack, label] });
    const samples = rendered.sampleRate === sampleRate
      ? rendered.samples
      : resample(rendered.samples, rendered.sampleRate, sampleRate);
    return {
      samples,
      start: Math.round((layer.offset ?? 0) * sampleRate),
      gain: 10 ** ((layer.gain ?? 0) / 20),
      clipped: rendered.clipped + rendered.layerClipped,
    };
  });

  const length = Math.max(...tracks.map((t) => t.start + t.samples.length));
  const mix = new Float32Array(length);
  for (const t of tracks) {
    for (let i = 0; i < t.samples.length; i++) mix[t.start + i]! += t.samples[i]! * t.gain;
  }
  return { samples: mix, clipped: tracks.reduce((n, t) => n + t.clipped, 0) };
}

function normalizePeak(samples: Float32Array, targetDb: number): void {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak === 0) return;
  const gain = 10 ** (targetDb / 20) / peak;
  for (let i = 0; i < samples.length; i++) samples[i]! *= gain;
}

/** Windowed-sinc (Blackman) resampler with anti-aliasing when downsampling. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = toRate / fromRate;
  const outLength = Math.round(input.length * ratio);
  const output = new Float32Array(outLength);
  const cutoff = Math.min(1, ratio); // normalised to the input Nyquist
  const halfWidth = 16; // taps on each side, in units of the (scaled) kernel
  const radius = Math.ceil(halfWidth / cutoff);

  for (let i = 0; i < outLength; i++) {
    const center = i / ratio;
    const start = Math.max(0, Math.ceil(center - radius));
    const end = Math.min(input.length - 1, Math.floor(center + radius));
    let acc = 0;
    let norm = 0;
    for (let j = start; j <= end; j++) {
      const x = j - center;
      const sincArg = x * cutoff;
      const sinc = sincArg === 0 ? 1 : Math.sin(Math.PI * sincArg) / (Math.PI * sincArg);
      const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / radius) + 0.08 * Math.cos((2 * Math.PI * x) / radius);
      const k = sinc * w;
      acc += input[j]! * k;
      norm += k;
    }
    output[i] = norm === 0 ? 0 : acc / norm;
  }
  return output;
}
