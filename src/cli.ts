#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import jsfxr from "jsfxr";
import { RecipeError, type OutputFormat } from "./recipe.ts";
import { RecipeLibrary } from "./library.ts";
import { renderRecipe } from "./render.ts";
import { hasFfmpeg, writeAudio } from "./encode.ts";

const USAGE = `Usage: sound-forge [options] <recipe.json | -> ...

Renders jsfxr JSON recipes to audio files. A recipe file may hold a single
recipe or an array of recipes. "-" reads a recipe from stdin. A recipe with
"layers" mixes other recipes (inline or "file.json#name" references).

Options:
  -o, --out-dir <dir>     Output directory (default: next to the recipe, or cwd for stdin)
  -f, --format <fmt>      flac | wav — overrides the recipe's output.format
      --print-b58         Print each sound's sfxr.me share string
  -h, --help              Show this help`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "out-dir": { type: "string", short: "o" },
      format: { type: "string", short: "f" },
      "print-b58": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (values.format !== undefined && values.format !== "flac" && values.format !== "wav") {
    console.error(`--format must be "flac" or "wav"`);
    return 1;
  }

  const library = new RecipeLibrary();
  let failures = 0;
  for (const source of positionals) {
    let entries;
    try {
      entries = library.load(source, source === "-" ? await readStdin() : undefined);
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      failures++;
      continue;
    }

    const dir = source === "-" ? process.cwd() : path.dirname(source);
    for (const { recipe, outName, file } of entries) {
      try {
        let format: OutputFormat = (values.format as OutputFormat | undefined) ?? recipe.output?.format ?? "flac";
        if (format === "flac" && !hasFfmpeg()) {
          console.warn(`! ffmpeg not found, writing WAV instead of FLAC for "${outName}"`);
          format = "wav";
        }
        const bitDepth = recipe.output?.bitDepth ?? 16;
        if (format === "flac" && bitDepth === 8) {
          throw new RecipeError(`${outName}: bitDepth 8 is only supported for wav output`);
        }

        const result = renderRecipe(recipe, { library, file });
        const outDir = values["out-dir"] ?? dir;
        await mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, `${outName}.${format}`);
        await writeAudio(result.samples, result.sampleRate, outPath, format, bitDepth);

        const seconds = (result.samples.length / result.sampleRate).toFixed(3);
        console.log(`✓ ${outPath}  (${seconds}s, ${result.sampleRate} Hz, ${bitDepth}-bit)`);
        if (result.clipped > 0) {
          const fix = recipe.layers ? "lower layer gains" : "lower sound_vol";
          console.warn(`  ! ${result.clipped} samples clipped — ${fix} or use output.normalize`);
        }
        if (result.layerClipped > 0) {
          console.warn(`  ! ${result.layerClipped} samples clipped inside layers before mixing`);
        }
        if (values["print-b58"] && result.params) {
          console.log(`  https://sfxr.me/#${jsfxr.sfxr.b58encode(result.params)}`);
        }
      } catch (e) {
        console.error(`✗ ${outName}: ${(e as Error).message}`);
        failures++;
      }
    }
  }
  return failures > 0 ? 1 : 0;
}

process.exitCode = await main();
