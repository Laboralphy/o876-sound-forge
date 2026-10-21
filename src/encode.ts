import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

export type BitDepth = 8 | 16 | 24;

/** Encodes mono float samples as a PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number, bitDepth: BitDepth): Buffer {
  const bytesPerSample = bitDepth / 8;
  const dataSize = samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(bytesPerSample, 32); // block align
  buf.writeUInt16LE(bitDepth, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  const max = 2 ** (bitDepth - 1) - 1;
  let offset = 44;
  for (const s of samples) {
    const clamped = Math.max(-1, Math.min(1, s));
    const v = Math.round(clamped * max);
    if (bitDepth === 8) buf.writeUInt8(v + 128, offset); // 8-bit WAV is unsigned
    else if (bitDepth === 16) buf.writeInt16LE(v, offset);
    else buf.writeIntLE(v, offset, 3);
    offset += bytesPerSample;
  }
  return buf;
}

let ffmpegAvailable: boolean | undefined;
export function hasFfmpeg(): boolean {
  ffmpegAvailable ??= spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  return ffmpegAvailable;
}

/** Converts an in-memory WAV to FLAC by piping it through ffmpeg. */
export function wavToFlac(wav: Buffer, outPath: string, bitDepth: 16 | 24): Promise<void> {
  const sampleFmt = bitDepth === 16 ? ["-sample_fmt", "s16"] : ["-sample_fmt", "s32", "-bits_per_raw_sample", "24"];
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "wav", "-i", "pipe:0",
    "-c:a", "flac", "-compression_level", "8", ...sampleFmt, outPath];
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`)),
    );
    proc.stdin.end(wav);
  });
}

export async function writeAudio(
  samples: Float32Array,
  sampleRate: number,
  outPath: string,
  format: "flac" | "wav",
  bitDepth: BitDepth,
): Promise<void> {
  const wav = encodeWav(samples, sampleRate, bitDepth);
  if (format === "wav") {
    await writeFile(outPath, wav);
  } else {
    if (bitDepth === 8) throw new Error("FLAC output requires bitDepth 16 or 24");
    await wavToFlac(wav, outPath, bitDepth);
  }
}
