import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeRecipe, RecipeError, type Recipe } from "./recipe.ts";

export interface LoadedRecipe {
  recipe: Recipe;
  /** Output name: the recipe's `name`, else derived from the file name. */
  outName: string;
  /** File the recipe came from ("-" for stdin); layer references resolve relative to it. */
  file: string;
}

/** Loads recipe files (cached) and resolves layer references between them. */
export class RecipeLibrary {
  private cache = new Map<string, LoadedRecipe[]>();

  load(file: string, text?: string): LoadedRecipe[] {
    const key = file === "-" ? file : path.resolve(file);
    const cached = this.cache.get(key);
    if (cached) return cached;

    let json: unknown;
    try {
      json = JSON.parse(text ?? readFileSync(file, "utf8"));
    } catch (e) {
      throw new RecipeError(`${file}: ${e instanceof SyntaxError ? "invalid JSON" : "cannot read"} (${(e as Error).message})`);
    }
    const base = file === "-" ? "sound" : path.basename(file, path.extname(file));
    const items = Array.isArray(json) ? json : [json];
    const loaded = items.map((item, i) => {
      const where = Array.isArray(json) ? `${file}[${i}]` : file;
      const recipe = normalizeRecipe(item, where);
      const fallback = Array.isArray(json) ? `${base}-${i + 1}` : base;
      return { recipe, outName: sanitize(recipe.name ?? fallback), file };
    });
    this.cache.set(key, loaded);
    return loaded;
  }

  /** Resolves "file.json#name", "#name" or "file.json" relative to `fromFile`. */
  resolve(ref: string, fromFile: string): LoadedRecipe {
    const [filePart = "", name] = ref.split("#", 2);
    const baseDir = fromFile === "-" ? process.cwd() : path.dirname(fromFile);
    const file = filePart === "" ? fromFile : path.resolve(baseDir, filePart);
    const entries = this.load(file);
    if (name === undefined) {
      if (entries.length !== 1) {
        throw new RecipeError(`"${ref}": ${file} holds ${entries.length} recipes, add "#name" to pick one`);
      }
      return entries[0]!;
    }
    const match = entries.find((e) => e.recipe.name === name);
    if (!match) throw new RecipeError(`"${ref}": no recipe named "${name}" in ${file}`);
    return match;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, "_");
}
