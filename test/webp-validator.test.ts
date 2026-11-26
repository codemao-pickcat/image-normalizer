import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  assertDecodableStaticWebp,
  assertValidStaticWebp,
  assertValidStaticWebpFile,
  stripStaticWebpMetadata,
} from "../src/webp-validator.js";
import { minimalLosslessWebp, riff } from "./support/webp.js";

describe("strict static WebP validation", () => {
  it("accepts a bounded lossless static frame", () => {
    expect(() =>
      assertValidStaticWebp(minimalLosslessWebp(4096, 4096)),
    ).not.toThrow();
  });

  it("rejects dimensions above the 4K boundary", () => {
    expect(() =>
      assertValidStaticWebp(minimalLosslessWebp(4097, 1)),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_IMAGE",
        details: { reason: "DIMENSIONS_EXCEEDED" },
      }),
    );
  });

  it.each([
    ["ANIM", "ANIMATED"],
    ["EXIF", "METADATA_PRESENT"],
    ["JUNK", "MALFORMED"],
  ])("rejects %s chunks with a stable reason", (type, reason) => {
    expect(() =>
      assertValidStaticWebp(riff([{ type, payload: new Uint8Array(6) }])),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_IMAGE",
        details: { reason },
      }),
    );
  });

  it("rejects non-zero bytes after the RIFF boundary", () => {
    const valid = minimalLosslessWebp();
    const appended = new Uint8Array(valid.byteLength + 1);
    appended.set(valid);
    appended[valid.byteLength] = 1;
    expect(() => assertValidStaticWebp(appended)).toThrowError(
      expect.objectContaining({ details: { reason: "MALFORMED" } }),
    );
  });

  it("rejects the VP8X animation flag as ANIMATED, not a static file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pickcat-webp-anim-"));
    const animatedPath = join(directory, "animated.webp");
    const animated = riff([
      {
        type: "VP8X",
        payload: Uint8Array.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      },
    ]);
    try {
      await writeFile(animatedPath, animated);
      await expect(
        assertValidStaticWebpFile(animatedPath),
      ).rejects.toMatchObject({
        code: "INVALID_IMAGE",
        details: { reason: "ANIMATED" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates a near-limit file through the random-access file seam", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pickcat-webp-test-"));
    const path = join(directory, "large.webp");
    const payload = new Uint8Array(9 * 1024 * 1024);
    payload.set(minimalLosslessWebp().subarray(20), 0);
    const large = riff([{ type: "VP8L", payload }]);

    try {
      await writeFile(path, large);
      await expect(assertValidStaticWebpFile(path)).resolves.toEqual({
        width: 1,
        height: 1,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("assertDecodableStaticWebp", () => {
  it("allows ICCP/EXIF on Sharp input while the stored-object check still rejects them", async () => {
    const withProfile = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: "red",
      },
    })
      .withMetadata({ icc: "srgb" })
      .webp({ quality: 80 })
      .toBuffer();
    expect(assertDecodableStaticWebp(withProfile)).toEqual({
      width: 8,
      height: 8,
    });
    expect(() => assertValidStaticWebp(withProfile)).toThrowError(
      expect.objectContaining({ details: { reason: "METADATA_PRESENT" } }),
    );
  });

  it("still rejects animation and oversize canvases", () => {
    expect(() =>
      assertDecodableStaticWebp(
        riff([
          {
            type: "VP8X",
            payload: Uint8Array.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
          },
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({ details: { reason: "ANIMATED" } }),
    );
    expect(() =>
      assertDecodableStaticWebp(minimalLosslessWebp(4097, 1)),
    ).toThrowError(
      expect.objectContaining({ details: { reason: "DIMENSIONS_EXCEEDED" } }),
    );
  });
});

describe("stripStaticWebpMetadata", () => {
  it("passes through a clean static frame", () => {
    const valid = minimalLosslessWebp();
    expect(stripStaticWebpMetadata(valid)).toBe(valid);
  });

  it("removes ICCP and EXIF left by color-profile WebP encoding", async () => {
    const withProfile = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: "red",
      },
    })
      .withMetadata({ icc: "srgb" })
      .webp({ quality: 80 })
      .toBuffer();
    expect(() => assertValidStaticWebp(withProfile)).toThrowError(
      expect.objectContaining({ details: { reason: "METADATA_PRESENT" } }),
    );
    const stripped = stripStaticWebpMetadata(withProfile);
    expect(assertValidStaticWebp(stripped)).toEqual({ width: 8, height: 8 });
    const metadata = await sharp(stripped).metadata();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });

  it("still rejects animation instead of stripping it", () => {
    expect(() =>
      stripStaticWebpMetadata(
        riff([
          {
            type: "VP8X",
            payload: Uint8Array.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
          },
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({ details: { reason: "ANIMATED" } }),
    );
  });
});
