# sound-forge

Render [jsfxr](https://sfxr.me) JSON recipes to FLAC (via ffmpeg) or WAV.

```bash
npm run render -- recipes/coin.json -o out      # one recipe
npm run examples                                # every file in recipes/ -> out/
cat sound.json | npm run render -- - -f wav     # from stdin
npm run build && node dist/cli.js --help        # compiled version
```

Options: `-o/--out-dir`, `-f/--format flac|wav`, `--print-b58` (prints an sfxr.me link for each sound).

## Recipe format

A file holds one recipe or an array of them. A raw sfxr.me "serialize" export
(top-level `p_*` keys) also works as-is.

```jsonc
{
  "name": "coin",                 // output filename (default: recipe filename)
  "preset": "pickupCoin",         // OR "b58": "<sfxr.me share string>" — optional base
  "seed": 7,                      // makes presets / noise reproducible
  "mutations": 0,                 // apply jsfxr mutate() N times
  "params": {                     // overrides, same keys as sfxr.me JSON
    "wave_type": "square",        // square | sawtooth | sine | noise (or 0-3)
    "p_base_freq": 0.5,           // p_* in [0,1]; signed ones in [-1,1]
    "sound_vol": 0.25
  },
  "output": {
    "format": "flac",             // flac (default) | wav
    "bitDepth": 16,               // 16 (default) | 24 | 8 (wav only)
    "sampleRate": 44100,          // resampled if it differs from params.sample_rate
    "normalize": -1,              // peak-normalize to dBFS (true = -1)
    "padEnd": 0.1                 // seconds of trailing silence
  }
}
```

## Layers (mixing)

A recipe with `layers` mixes other sounds instead of synthesising one. It
can't be combined with `preset`, `b58`, `seed`, `mutations` or `params`.

```jsonc
{
  "name": "cast-firebolt",
  "layers": [
    { "sound": "shots.json#wand-shot", "gain": -3 },               // another file, by recipe name
    { "sound": "spells.json#firebolt", "offset": 0.03, "gain": -2 },
    { "sound": "#cast-ice-flechette" },                             // same file
    { "sound": { "preset": "laserShoot", "seed": 5 } }              // inline recipe
  ],
  "output": { "normalize": -1 }
}
```

- `sound`: `"file.json#name"` (path relative to the recipe file), `"#name"`
  (same file), `"file.json"` (a file holding a single recipe), or an inline recipe.
- `offset`: start time in seconds (default 0). `gain`: dB (default 0).
- Each layer is rendered with its own `output` options (`normalize`, `padEnd`,
  …), exactly like its standalone file, then resampled to the mix rate
  (`output.sampleRate`, default 44100) and summed.
- Layers can themselves be layered recipes; reference cycles are reported.
- Sums above full scale are clipped with a warning — use `output.normalize`.

See `recipes/mixes.json` for examples.

Presets: `pickupCoin laserShoot explosion powerUp hitHurt jump blipSelect synth tone click random`.

If ffmpeg is not on `PATH`, FLAC requests fall back to WAV with a warning.
