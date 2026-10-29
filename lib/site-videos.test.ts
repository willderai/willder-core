import { statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HLS_FILM_PATH,
  HLS_ORIGIN,
  LAUNCH_FILM,
  PHONE_MEDIA,
  PRODUCT_DEMO,
  SITE_VIDEO_CONNECT_SRC,
  SITE_VIDEO_MEDIA_SRC,
  SITE_VIDEO_ORIGIN,
  STEP_CLIPS,
  UHD_MEDIA,
  hlsStream,
  videoConnectSrc,
  videoMediaSrc,
  videoOrigin,
  type Poster,
} from "./site-videos";

// The posters ship from public/ and the film's is a candidate for the page's largest paint,
// so each stays a small still (docs: judgment "Speed": the hero asset under 150 KB).
const POSTER_BUDGET_BYTES = 60_000;

const posters: Array<[string, Poster]> = [
  ...Object.entries(STEP_CLIPS).flatMap(
    ([step, clip]): Array<[string, Poster]> => [
      [`${step} step`, clip.poster],
      [`${step} step, phone`, clip.phonePoster],
    ],
  ),
  ["launch film", LAUNCH_FILM.poster],
  ["product demo", PRODUCT_DEMO.poster],
];

describe("posters", () => {
  it.each(posters)("the %s poster exists in public/ within its budget", (_name, poster) => {
    const file = path.join(process.cwd(), "public", poster.src);
    expect(statSync(file).size).toBeLessThanOrEqual(POSTER_BUDGET_BYTES);
  });
});

describe("videoOrigin", () => {
  it("passes null through, so the page shows posters only", () => {
    expect(videoOrigin(null)).toBeNull();
  });

  it("accepts a public Vercel Blob store origin", () => {
    expect(videoOrigin("https://ab12cd.public.blob.vercel-storage.com")).toBe(
      "https://ab12cd.public.blob.vercel-storage.com",
    );
  });

  it.each([
    ["plain http", "http://ab12cd.public.blob.vercel-storage.com"],
    ["a trailing slash", "https://ab12cd.public.blob.vercel-storage.com/"],
    ["a path", "https://ab12cd.public.blob.vercel-storage.com/landing"],
    ["a private store", "https://ab12cd.private.blob.vercel-storage.com"],
    ["a lookalike host", "https://ab12cd.public.blob.vercel-storage.com.example.com"],
    ["another host", "https://cdn.example.com"],
    ["a site path", "/video"],
    ["a store name hidden in a path", "https://evil.example/x.public.blob.vercel-storage.com"],
    ["a dotted subdomain", "https://a.b.public.blob.vercel-storage.com"],
    ["a scheme prefix", "javascript:https://ab12cd.public.blob.vercel-storage.com"],
  ])("refuses %s, naming the accepted form", (_case, origin) => {
    expect(() => videoOrigin(origin)).toThrow(/public Vercel Blob origin/);
  });
});

describe("videoMediaSrc", () => {
  it("allows only this site while no store is set", () => {
    expect(videoMediaSrc(null)).toBe("media-src 'self'");
  });

  it("adds exactly the store's origin, not every Blob store", () => {
    expect(videoMediaSrc("https://ab12cd.public.blob.vercel-storage.com")).toBe(
      "media-src 'self' https://ab12cd.public.blob.vercel-storage.com",
    );
  });
});

describe("the store setting", () => {
  it("names files for every video exactly when a store is set, so without one the page renders posters and no Watch control", () => {
    for (const video of [...Object.values(STEP_CLIPS), LAUNCH_FILM, PRODUCT_DEMO]) {
      expect(video.files.length > 0).toBe(SITE_VIDEO_ORIGIN !== null);
    }
  });
});

describe("the launch film's files", () => {
  it.skipIf(SITE_VIDEO_ORIGIN === null)(
    "lists the phone and 4K files before the 1080p fallback, because a browser takes the first source whose media matches",
    () => {
      const names = LAUNCH_FILM.files.map((file) => [file.src.split("/").pop(), file.media]);
      expect(names).toEqual([
        ["film-720.mp4", PHONE_MEDIA],
        ["film-2160.mp4", UHD_MEDIA],
        ["film-1080.mp4", undefined],
      ]);
    },
  );

  it.skipIf(SITE_VIDEO_ORIGIN === null)(
    "says each file's height, so a stalled stream falls back to the 720p file and never a heavier one",
    () => {
      expect(LAUNCH_FILM.files.map((file) => file.height)).toEqual([720, 2160, 1080]);
    },
  );

  it("never sends the 4K file to a phone width", () => {
    expect(UHD_MEDIA).not.toMatch(/max-width/);
    for (const clause of UHD_MEDIA.split(",")) {
      const rem = Number(clause.match(/min-width: (\d+)rem/)?.[1]);
      expect(rem).toBeGreaterThanOrEqual(90);
    }
  });
});

describe("the launch film's adaptive cut", () => {
  it("is offered exactly when HLS_ORIGIN is set; while it is null the film, the demo and the policy are as before", () => {
    expect(LAUNCH_FILM.hls !== undefined).toBe(HLS_ORIGIN !== null);
    expect(PRODUCT_DEMO).not.toHaveProperty("hls");
    if (HLS_ORIGIN === null) {
      expect(LAUNCH_FILM).not.toHaveProperty("hls");
      expect(SITE_VIDEO_MEDIA_SRC).toBe(videoMediaSrc(SITE_VIDEO_ORIGIN));
      expect(SITE_VIDEO_MEDIA_SRC).not.toContain("blob:");
      expect(SITE_VIDEO_CONNECT_SRC).toEqual([]);
    }
  });

  it.skipIf(HLS_ORIGIN === null)("points at a content-addressed folder that build-hls.sh printed", () => {
    expect(HLS_FILM_PATH).toMatch(/^landing\/hls\/film-[0-9a-f]{12}$/);
  });

  it("names the full and the 720p-capped master playlists in the folder", () => {
    expect(hlsStream(STORE, "landing/hls/film-0123456789ab")).toEqual({
      master: `${STORE}/landing/hls/film-0123456789ab/master.m3u8`,
      capped: `${STORE}/landing/hls/film-0123456789ab/master-720.m3u8`,
    });
    expect(hlsStream(null, "landing/hls/film-0123456789ab")).toBeUndefined();
  });

  it("allows the HLS store and blob: media (Media Source Extensions) only once it is set", () => {
    expect(videoMediaSrc(STORE, STORE)).toBe(`media-src 'self' ${STORE} blob:`);
    expect(videoMediaSrc(STORE, OTHER)).toBe(`media-src 'self' ${STORE} ${OTHER} blob:`);
    expect(videoMediaSrc(STORE, null)).toBe(`media-src 'self' ${STORE}`);
    expect(videoConnectSrc(STORE)).toEqual([STORE]);
    expect(videoConnectSrc(null)).toEqual([]);
  });
});

const STORE = "https://ab12cd.public.blob.vercel-storage.com";
const OTHER = "https://ef34gh.public.blob.vercel-storage.com";
