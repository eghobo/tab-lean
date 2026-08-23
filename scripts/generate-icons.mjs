import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function insideRoundedRectangle(x, y, left, top, width, height, radius) {
  const nearestX = Math.max(left + radius, Math.min(x, left + width - radius));
  const nearestY = Math.max(top + radius, Math.min(y, top + height - radius));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function blendPixel(data, offset, color, alpha) {
  const inverse = 1 - alpha;
  data[offset] = Math.round(color[0] * alpha + data[offset] * inverse);
  data[offset + 1] = Math.round(color[1] * alpha + data[offset + 1] * inverse);
  data[offset + 2] = Math.round(color[2] * alpha + data[offset + 2] * inverse);
  data[offset + 3] = 255;
}

function makeIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 4;
  const background = [77, 103, 242];
  const bars = [
    { top: 0.235, opacity: 0.62 },
    { top: 0.438, opacity: 0.82 },
    { top: 0.641, opacity: 1 },
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      let backgroundHits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          if (insideRoundedRectangle(px, py, 0, 0, size, size, size * 0.265)) {
            backgroundHits += 1;
          }
        }
      }

      const coverage = backgroundHits / (samples * samples);
      pixels[offset] = background[0];
      pixels[offset + 1] = background[1];
      pixels[offset + 2] = background[2];
      pixels[offset + 3] = Math.round(coverage * 255);

      for (const bar of bars) {
        let barHits = 0;
        for (let sy = 0; sy < samples; sy += 1) {
          for (let sx = 0; sx < samples; sx += 1) {
            const px = x + (sx + 0.5) / samples;
            const py = y + (sy + 0.5) / samples;
            if (
              insideRoundedRectangle(
                px,
                py,
                size * 0.227,
                size * bar.top,
                size * 0.547,
                size * 0.125,
                size * 0.063,
              )
            ) {
              barHits += 1;
            }
          }
        }
        const barCoverage = (barHits / (samples * samples)) * bar.opacity;
        if (barCoverage > 0) blendPixel(pixels, offset, [255, 255, 255], barCoverage);
      }
    }
  }

  const rowLength = size * 4;
  const raw = Buffer.alloc((rowLength + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rawOffset = y * (rowLength + 1);
    raw[rawOffset] = 0;
    pixels.copy(raw, rawOffset + 1, y * rowLength, (y + 1) * rowLength);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(resolve(projectDirectory, `icons/icon-${size}.png`), makeIcon(size));
}

console.log("Generated Chrome icons at 16, 32, 48, and 128 pixels.");
