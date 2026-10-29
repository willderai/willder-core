// The videos the landing page plays: the silent clip behind each step of "How Willder
// works", the launch film and the product demo.
//
// The one rule this file enforces: every video names its files, its poster and a text
// alternative in one place, so a page cannot play a file without saying what it shows.
//
// The posters are small WebP frames in public/video and load from this site. The video
// files do not live in this repository: they are web encodes cut from the content masters
// and served from a public Vercel Blob store kept only for marketing media, never the
// private store that holds customer files (lib/blob-storage.ts). Until SITE_VIDEO_ORIGIN
// names that store, every step shows its poster and no film or demo player is offered.

/**
 * The public Blob store that serves the files, as an origin:
 * `https://<store id>.public.blob.vercel-storage.com`. null until the files are uploaded.
 * The Content-Security-Policy's media-src is built from this value (next.config.ts).
 */
export const SITE_VIDEO_ORIGIN: string | null = null;

/**
 * The public Blob store that serves the launch film's HLS ladder, or null until the ladder is
 * uploaded.
 * While null the film plays from the MP4 files exactly as before, and the
 * Content-Security-Policy is unchanged.
 */
export const HLS_ORIGIN: string | null = null;

/**
 * The ladder's content-addressed folder in that store, as the encode prints it.
 * A new encode is a new folder, so every file under one is cached as immutable.
 */
export const HLS_FILM_PATH = "landing/hls/film-HASH";

/** Below this width the page serves a step clip's phone cut and the films' 720p files (Tailwind's `sm`). */
export const PHONE_MEDIA = "(max-width: 39.999rem)";

/**
 * Where the launch film's 3840x2160 file is worth its size: a wide high density screen,
 * or a screen wide enough to show 4K pixels one to one. Everywhere else takes 1080p.
 */
export const UHD_MEDIA = "(min-width: 90rem) and (min-resolution: 2dppx), (min-width: 160rem)";

/** One encoded file. Browsers take the first `<source>` whose media and type they accept. */
export type VideoFile = {
  src: string;
  type: "video/mp4";
  /** Serve this file only where the media query matches. */
  media?: string;
  /** The picture's height, where a player may need to pick the lightest file (components/film-stream.ts). */
  height?: number;
};

/** A still frame with its intrinsic size, so the page reserves its box before it loads. */
export type Poster = { src: string; width: number; height: number };

/** The silent clip behind one step of "How Willder works": a wide cut and a phone cut. */
export type StepClip = {
  /** Empty until the files are hosted: the step then shows its poster only. */
  files: readonly VideoFile[];
  poster: Poster;
  phonePoster: Poster;
  /** What the clip shows, at both widths, for anyone who cannot see it. */
  description: string;
};

/**
 * An adaptive (HLS) cut of a video: a ladder of renditions the player switches between as the
 * connection allows. `master` lists every rendition; `capped` stops at 720p, for devices with
 * little memory or few cores and for visitors on a slow or metered connection.
 */
export type HlsStream = { master: string; capped: string };

/** A full video a visitor chooses to watch. */
export type FeatureVideo = {
  title: string;
  /** Empty until the files are hosted: no control opens it then. */
  files: readonly VideoFile[];
  /**
   * The adaptive cut, tried before `files` when set; `files` stay the fallback if it fails.
   * Unset until the ladder is uploaded (HLS_ORIGIN), and the player then behaves as before.
   */
  hls?: HlsStream;
  poster: Poster;
  /** Whether the video has a sound track; the player is muted otherwise. */
  hasSound: boolean;
  /** What the video shows, beat by beat: its text alternative. */
  description: string;
};

const BLOB_ORIGIN = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com$/;

/**
 * `origin` checked as a public Blob store origin, or null when no store is set.
 * Throws for anything else, so a wrong value fails the build rather than a visitor's player.
 */
export function videoOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  if (!BLOB_ORIGIN.test(origin)) {
    throw new Error(
      `SITE_VIDEO_ORIGIN ${JSON.stringify(origin)} is not a public Vercel Blob origin. Use https://<store id>.public.blob.vercel-storage.com with no path or trailing slash, or null (lib/site-videos.ts).`,
    );
  }
  return origin;
}

const ORIGIN = videoOrigin(SITE_VIDEO_ORIGIN);

const HLS = videoOrigin(HLS_ORIGIN);

/**
 * The Content-Security-Policy media-src directive: this site, plus the store when one is set.
 * With an HLS store, hls.js fetches the segments itself and plays them through Media Source
 * Extensions, whose media is a blob: URL, so blob: and that store are allowed too.
 */
export function videoMediaSrc(origin: string | null, hlsOrigin: string | null = null): string {
  const sources = ["'self'", ...(origin ? [origin] : [])];
  if (hlsOrigin) {
    if (!sources.includes(hlsOrigin)) sources.push(hlsOrigin);
    sources.push("blob:");
  }
  return `media-src ${sources.join(" ")}`;
}

/** The media-src directive next.config.ts sends. */
export const SITE_VIDEO_MEDIA_SRC = videoMediaSrc(ORIGIN, HLS);

/** What connect-src must add for hls.js to fetch the ladder: the HLS store, or nothing. */
export function videoConnectSrc(hlsOrigin: string | null): string[] {
  return hlsOrigin ? [hlsOrigin] : [];
}

/** The connect-src origins next.config.ts adds for the film. */
export const SITE_VIDEO_CONNECT_SRC = videoConnectSrc(HLS);

/** The adaptive cut at `path` in the store `origin`, or nothing while no store is set. */
export function hlsStream(origin: string | null, path: string): HlsStream | undefined {
  if (!origin) return undefined;
  return { master: `${origin}/${path}/master.m3u8`, capped: `${origin}/${path}/master-720.m3u8` };
}

/** The MP4 at `landing/<name>.mp4` in the store, or nothing while no store is set. */
function mp4(name: string, media?: string, height?: number): VideoFile[] {
  if (!ORIGIN) return [];
  return [
    {
      src: `${ORIGIN}/landing/${name}.mp4`,
      type: "video/mp4",
      ...(media ? { media } : {}),
      ...(height ? { height } : {}),
    },
  ];
}

const poster = (name: string, width: number, height: number): Poster => ({ src: `/video/${name}.webp`, width, height });

/**
 * The clips behind the three steps, each played once from the start, keyed by step.
 * Wide cuts are 1280x720, phone cuts the top 1080x1350 of the vertical demo at 720x900.
 * Each is a short cut of the product demo: save, connect, and control (the revoke, which has
 * no vertical cut, so phones show the other-scope beat instead).
 */
export const STEP_CLIPS = {
  save: {
    files: [...mp4("step-save-phone", PHONE_MEDIA), ...mp4("step-save")],
    poster: poster("step-save-poster", 1280, 720),
    phonePoster: poster("step-save-phone-poster", 720, 900),
    description:
      "Demo data: Claude Code saves “Launch moves to Friday.” to Willder with memory_ingest, and the reply says it is stored and readable now.",
  },
  connect: {
    files: [...mp4("step-read-phone", PHONE_MEDIA), ...mp4("step-read")],
    poster: poster("step-read-poster", 1280, 720),
    phonePoster: poster("step-read-phone-poster", 720, 900),
    description:
      "Demo data: Codex asks when the launch is, and its memory_query reads “Launch moves to Friday.” with the agent that wrote it, on its next call.",
  },
  control: {
    files: [...mp4("step-scope-phone", PHONE_MEDIA), ...mp4("step-revoke")],
    poster: poster("step-revoke-poster", 1280, 720),
    phonePoster: poster("step-scope-phone-poster", 720, 900),
    description:
      "Demo data. Wide screens: a token is revoked, its next call gets HTTP 401 “Invalid or unknown capability token.”, and the refusal is in the audit log. Phones: an agent on a Marketing token asks the same question and gets “No facts found.”",
  },
} as const satisfies Record<string, StepClip>;

/** The launch film, with sound, played on the page on request; its poster shows only in the player. 3840x2160 on large high density screens (UHD_MEDIA), 1920x1080, and 1280x720 on phones. */
export const LAUNCH_FILM: FeatureVideo = {
  title: "The Willder launch film",
  files: [
    ...mp4("film-720", PHONE_MEDIA, 720),
    ...mp4("film-2160", UHD_MEDIA, 2160),
    ...mp4("film-1080", undefined, 1080),
  ],
  ...(HLS ? { hls: hlsStream(HLS, HLS_FILM_PATH) } : {}),
  poster: poster("film-poster", 1280, 720),
  hasSound: true,
  description:
    "A film set to music, with no voice; its words carry it. Your agents did the work across multiple apps and multiple people, so it was explained again, built twice and leaked everywhere. Then Willder: controlled context that syncs your teams, one context for every agent and every teammate, and you decide what each one sees. A timeline shows who wrote a fact and who read it, and a person fixes it once. Build your system; be the wielder; what your team learns stays. It ends on the Willder logo, “Better Systems for Teams and Agents” and “Start free · willder.ai”.",
};

/** The product demo, in the dialog on request. Silent. 1920x1080, and 1280x720 on phones. */
export const PRODUCT_DEMO: FeatureVideo = {
  title: "Willder product demo",
  files: [...mp4("demo-720", PHONE_MEDIA), ...mp4("demo-1080")],
  poster: poster("demo-poster", 1280, 720),
  hasSound: false,
  description:
    "Silent, with demo data. Each agent gets its own token in Access. Claude Code saves “Launch moves to Friday.”; Codex reads it on its next call, with the agent that wrote it; a Codex session on a Marketing token asks the same question and gets “No facts found.”; Claude Code fixes the fact once to Monday and Codex's next read says Monday; the audit timeline shows who wrote the fact and who read it.",
};
