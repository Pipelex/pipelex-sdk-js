/**
 * The artifact stack — `locateArtifacts`, `collectArtifacts`, `artifactFilename`,
 * `resolveArtifacts`, `fetchArtifact` and `downloadArtifacts`. The pure helpers
 * are pinned on values; the three network operations take a fake client (the raw bulk resolve
 * call and the single-shot result lookup) and mock the fetch boundary with
 * `vi.spyOn(globalThis, "fetch")`, as every other suite does, so the object-store
 * exchange is exercised on real `Response` streams without a server. Downloads
 * write to a real temp directory, because the never-overwrite rule and the
 * partial-file cleanup are filesystem facts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BULK_RESOLVE_MAX_URIS,
  artifactFilename,
  collectArtifacts,
  downloadArtifacts,
  fetchArtifact,
  locateArtifacts,
  resolveArtifacts,
} from "../src/artifacts.js";
import type {
  ArtifactCapableClient,
  ArtifactLocation,
  BulkResolveStorageUrlsInput,
  BulkResolvedStorageUrls,
  ResolvedArtifact,
} from "../src/artifacts.js";
import {
  ApiResponseError,
  ArtifactAuthenticationError,
  ArtifactFetchError,
  ArtifactOperationError,
  RunFailedError,
  RunStillRunningError,
  ScopeUnavailableError,
} from "../src/errors.js";
import type { RunResults, RunResultState } from "../src/runs.js";

const RUN_ID = "01JRUN0000000000000000TEST";
const PICTURE_URI = "pipelex-storage://org/runs/01JRUN/outputs/illustration.png";
const REPORT_URI = "pipelex-storage://org/runs/01JRUN/outputs/report";
const INPUT_URI = "pipelex-storage://org/assets/brief.pdf";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

const FUTURE = new Date(Date.now() + 15 * 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

/** A resolved item for `uri`, minted on a distinct signed link per call. */
function resolvedItem(
  uri: string,
  overrides: Partial<Extract<ResolvedArtifact, { error: null }>> = {},
): ResolvedArtifact {
  return {
    uri,
    url: `https://store.example/${encodeURIComponent(uri)}?sig=${Math.random().toString(36).slice(2)}`,
    expires_at: FUTURE,
    content_type: uri.endsWith(".png")
      ? "image/png"
      : uri.endsWith(".pdf")
        ? "application/pdf"
        : null,
    error: null,
    ...overrides,
  };
}

function refusedItem(uri: string, code: string, detail: string): ResolvedArtifact {
  return { uri, url: null, expires_at: null, content_type: null, error: { code, detail } };
}

function apiError(status: number, code?: string): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    "http://localhost:8081",
    status,
    "Error",
    "",
    undefined,
    "refused",
    undefined,
    code,
  );
}

interface ResolveCall {
  input: BulkResolveStorageUrlsInput;
  signal: AbortSignal | undefined;
}

interface FakeClient extends ArtifactCapableClient {
  resolveCalls: ResolveCall[];
  resultCalls: string[];
}

/**
 * A client whose bulk resolve answers every reference with a fresh link (or the
 * item / throw the case scripts for it) and whose result lookup answers the
 * scripted state.
 */
function makeClient(
  options: {
    state?: RunResultState;
    /** Per-uri answer: an item, or an error to throw for the whole request that names it. */
    answers?: Record<string, ResolvedArtifact | Error>;
    /** Answers taken in order for successive calls, each an item map or an error to throw. */
    sequence?: (Record<string, ResolvedArtifact> | Error)[];
  } = {},
): FakeClient {
  const resolveCalls: ResolveCall[] = [];
  const resultCalls: string[] = [];
  return {
    resolveCalls,
    resultCalls,
    async resolveStorageUrls(input, callOptions) {
      resolveCalls.push({ input, signal: callOptions?.signal });
      let answers: Record<string, ResolvedArtifact | Error> = options.answers ?? {};
      if (options.sequence) {
        const step = options.sequence.shift();
        if (step instanceof Error) throw step;
        if (step) answers = step;
      }
      const items = input.uris.map((uri) => {
        const answer = answers[uri];
        if (answer instanceof Error) throw answer;
        return answer ?? resolvedItem(uri);
      });
      return { items } satisfies BulkResolvedStorageUrls;
    },
    async getRunResult(runId) {
      resultCalls.push(runId);
      return options.state ?? completed({ main_stuff: { url: PICTURE_URI } });
    },
  };
}

function completed(result: Partial<RunResults> & Record<string, unknown>): RunResultState {
  return {
    state: "completed",
    pipeline_run_id: RUN_ID,
    result: { pipeline_run_id: RUN_ID, main_stuff: null, ...result } as RunResults,
  };
}

/** A `Response` streaming `chunks` one by one, with the given headers. */
function streamed(
  chunks: Uint8Array[],
  init: { status?: number; headers?: Record<string, string>; hang?: boolean } = {},
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!);
        index += 1;
        return;
      }
      if (init.hang) {
        await new Promise<void>(() => undefined);
        return;
      }
      controller.close();
    },
  });
  return new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
}

/** A fetch that never answers — it rejects only when its signal aborts, as the real one does. */
function pendingUntilAborted(_url: URL, init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Mock the boundary with a per-URL handler; the resolved link (a `URL`) is the key. */
function mockFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => Promise.resolve(handler(input as URL, init ?? {})));
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pipelex-sdk-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ── locateArtifacts / collectArtifacts ───────────────────────────────

describe("locateArtifacts", () => {
  it("finds every reference once, in discovery order, with every path it sits at in walk order", () => {
    const value = {
      image: { url: PICTURE_URI, public_url: "https://signed.example/one.png" },
      pages: [{ url: PICTURE_URI }, { deeper: { url: REPORT_URI } }, INPUT_URI],
      text: "not a reference",
      count: 3,
      nothing: null,
    };

    expect(locateArtifacts(value)).toEqual([
      { uri: PICTURE_URI, found_at: ["$.image.url", "$.pages[0].url"] },
      { uri: REPORT_URI, found_at: ["$.pages[1].deeper.url"] },
      { uri: INPUT_URI, found_at: ["$.pages[2]"] },
    ]);
  });

  it("roots a path at $, the walked value itself", () => {
    expect(locateArtifacts(PICTURE_URI)).toEqual([{ uri: PICTURE_URI, found_at: ["$"] }]);
    expect(locateArtifacts({ url: PICTURE_URI })).toEqual([
      { uri: PICTURE_URI, found_at: ["$.url"] },
    ]);
    expect(locateArtifacts({ items: [{ url: PICTURE_URI }] })).toEqual([
      { uri: PICTURE_URI, found_at: ["$.items[0].url"] },
    ]);
  });

  it("writes an identifier key as .key and any other key as a JSON string in brackets", () => {
    const value = {
      _ok: PICTURE_URI,
      "a key": { url: REPORT_URI },
      "2nd": INPUT_URI,
      'say "hi"\\': "pipelex-storage://org/q.png",
      "": "pipelex-storage://org/empty.png",
    };

    expect(locateArtifacts(value).map((location) => location.found_at[0])).toEqual([
      "$._ok",
      '$["a key"].url',
      '$["2nd"]',
      '$["say \\"hi\\"\\\\"]',
      '$[""]',
    ]);
  });

  it("counts a string only when it IS a reference, and ignores everything else", () => {
    expect(locateArtifacts({ note: `Saved as ${REPORT_URI}.` })).toEqual([]);
    expect(locateArtifacts(["pipelex-storage://", "https://example.com/x.png"])).toEqual([]);
    expect(locateArtifacts(undefined)).toEqual([]);
    expect(locateArtifacts(42)).toEqual([]);
  });
});

describe("collectArtifacts", () => {
  it("finds every reference in a JSON-shaped value, once each, in discovery order", () => {
    const value = {
      image: { url: PICTURE_URI, public_url: "https://signed.example/one.png" },
      pages: [{ url: PICTURE_URI }, { deeper: { url: REPORT_URI } }, INPUT_URI],
      text: "not a reference",
      count: 3,
      nothing: null,
    };

    expect(collectArtifacts(value)).toEqual([PICTURE_URI, REPORT_URI, INPUT_URI]);
    expect(collectArtifacts(value)).toEqual(locateArtifacts(value).map((location) => location.uri));
  });

  it("counts a string only when it IS a reference, never text containing one", () => {
    expect(collectArtifacts(`see ${PICTURE_URI} for the picture`)).toEqual([]);
    expect(collectArtifacts({ note: `Saved as ${REPORT_URI}.` })).toEqual([]);
    expect(collectArtifacts(PICTURE_URI)).toEqual([PICTURE_URI]);
  });

  it("ignores the bare scheme, other schemes, and non-JSON values", () => {
    expect(collectArtifacts("pipelex-storage://")).toEqual([]);
    expect(collectArtifacts(["https://example.com/x.png", "data:image/png;base64,AAAA"])).toEqual(
      [],
    );
    expect(collectArtifacts(undefined)).toEqual([]);
    expect(collectArtifacts(42)).toEqual([]);
    expect(collectArtifacts(null)).toEqual([]);
  });
});

// ── artifactFilename ─────────────────────────────────────────────────

/** A location at one path, for the naming rule's tests. */
function at(path: string, uri = PICTURE_URI): ArtifactLocation {
  return { uri, found_at: [path] };
}

describe("artifactFilename", () => {
  it("names a reference that is the walked value, or its url, after the scope", () => {
    expect(artifactFilename(at("$"), "image/png", "main_stuff")).toBe("main_stuff.png");
    expect(artifactFilename(at("$.url"), "image/png", "main_stuff")).toBe("main_stuff.png");
    expect(artifactFilename(at("$.url"), "image/png", "working_memory")).toBe("working_memory.png");
  });

  it("names a list member after the envelope and its index", () => {
    expect(artifactFilename(at("$.items[0].url"), "image/png", "main_stuff")).toBe("items-0.png");
    expect(artifactFilename(at("$[2].url"), "image/png", "main_stuff")).toBe("2.png");
  });

  it("names a nested field after its whole path", () => {
    expect(artifactFilename(at("$.rooms[3].staged_photo.url"), "image/png", "main_stuff")).toBe(
      "rooms-3-staged_photo.png",
    );
  });

  it("drops only a final url key: another key, or a url key that is not final, is kept", () => {
    expect(artifactFilename(at("$.photo.src"), null, "main_stuff")).toBe("photo-src.png");
    expect(artifactFilename(at("$.photo.URL"), null, "main_stuff")).toBe("photo-URL.png");
    expect(artifactFilename(at("$.url.original"), null, "main_stuff")).toBe("url-original.png");
    expect(artifactFilename(at("$.links.url[0]"), null, "main_stuff")).toBe("links-url-0.png");
    expect(artifactFilename(at('$["url"]'), null, "main_stuff")).toBe("main_stuff.png");
  });

  it("reduces a key that is not an identifier to [A-Za-z0-9_], dashes and dots included", () => {
    expect(artifactFilename(at('$["a key"].url'), null, "main_stuff")).toBe("a_key.png");
    expect(artifactFilename(at('$["staged-photo.v2"].url'), null, "main_stuff")).toBe(
      "staged_photo_v2.png",
    );
    expect(artifactFilename(at('$["café 📷"].url'), null, "main_stuff")).toBe("caf___.png");
    expect(artifactFilename(at('$["2nd"]'), null, "main_stuff")).toBe("2nd.png");
    expect(artifactFilename(at('$[""].url'), null, "main_stuff")).toBe("main_stuff.png");
  });

  it("cannot name anything outside the target directory, nor a hidden file", () => {
    const hostile = [
      '$["../../etc/passwd"]',
      '$[".."].url',
      '$["."]',
      '$[".env"]',
      '$["a\\u0000b\\nc"]',
      '$["C:\\\\Windows"]',
    ];
    for (const path of hostile) {
      const name = artifactFilename(at(path, "pipelex-storage://x/.."), null, "main_stuff");

      expect(name).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9]+)?$/);
    }
    expect(artifactFilename(at('$["../../etc/passwd"]', REPORT_URI), null, "main_stuff")).toBe(
      "______etc_passwd",
    );
  });

  it("keeps the tail when the name is too long, dropping whole leading segments first", () => {
    const segments = Array.from({ length: 20 }, (_, i) => `segment_${String(i).padStart(2, "0")}`);
    const name = artifactFilename(at(`$.${segments.join(".")}.url`), null, "main_stuff");

    expect(name.length).toBeLessThanOrEqual(128);
    expect(name).toBe(`${segments.slice(9).join("-")}.png`);
  });

  it("cuts a single segment that is still too long, keeping the extension", () => {
    const long = "a".repeat(300);

    expect(artifactFilename(at(`$.short.${long}.url`), null, "main_stuff")).toBe(
      `${"a".repeat(124)}.png`,
    );
    expect(artifactFilename(at(`$.${long}`, REPORT_URI), null, "main_stuff")).toBe("a".repeat(128));
  });

  it("takes the extension from the storage key, then from the content type, else none", () => {
    expect(artifactFilename(at("$.cover.url"), "application/pdf", "main_stuff")).toBe("cover.png");
    expect(artifactFilename(at("$.cover.url", REPORT_URI), "application/pdf", "main_stuff")).toBe(
      "cover.pdf",
    );
    expect(
      artifactFilename(at("$.cover.url", REPORT_URI), "image/png; charset=binary", "main_stuff"),
    ).toBe("cover.png");
    expect(
      artifactFilename(at("$.cover.url", REPORT_URI), "application/x-unknown", "main_stuff"),
    ).toBe("cover");
    expect(artifactFilename(at("$.cover.url", REPORT_URI), null, "main_stuff")).toBe("cover");
  });

  it("reads the key's extension off its last segment, decoded, reduced and short", () => {
    const named = (uri: string, contentType: string | null = null): string =>
      artifactFilename(at("$.doc", uri), contentType, "main_stuff");

    expect(named("pipelex-storage://x/hello%20world.pdf?token=1#frag")).toBe("doc.pdf");
    expect(named("pipelex-storage://x/bad%zz.pdf")).toBe("doc.pdf");
    expect(named("pipelex-storage://x/photo.P-N_G")).toBe("doc.PNG");
    expect(named("pipelex-storage://a/..\\..\\secret.txt")).toBe("doc.txt");
    expect(named("pipelex-storage://x/.env")).toBe("doc");
    expect(named("pipelex-storage://x/report.")).toBe("doc");
    expect(named(`pipelex-storage://x/stem.${"z".repeat(300)}`)).toBe("doc");
    expect(named(`pipelex-storage://x/stem.${"z".repeat(300)}`, "text/csv")).toBe("doc.csv");
  });

  it("refuses a location whose first path is not in the walk's notation, or an unknown scope", () => {
    const refused = [
      { uri: PICTURE_URI, found_at: [] },
      at("rooms.url"),
      at("$.rooms["),
      at("$[-1]"),
      at('$["unterminated]'),
      at("$.a b"),
    ];
    for (const location of refused) {
      expect(() => artifactFilename(location, null, "main_stuff")).toThrow(ArtifactOperationError);
    }
    expect(() => artifactFilename(at("$.url"), null, "other" as never)).toThrow(
      ArtifactOperationError,
    );
  });

  it("refuses a location of the wrong shape, as a JavaScript caller can pass one", () => {
    const misshapen: unknown[] = [
      PICTURE_URI, // the old signature's bare uri
      { uri: PICTURE_URI },
      { uri: PICTURE_URI, found_at: "$.cover.url" }, // a string's first character is "$"
      { found_at: ["$.cover.url"] },
      { uri: 42, found_at: ["$.cover.url"] },
      null,
      undefined,
    ];
    for (const location of misshapen) {
      expect(() => artifactFilename(location as ArtifactLocation, null, "main_stuff")).toThrow(
        ArtifactOperationError,
      );
    }
  });

  it("suffixes a stem Windows reserves for a device, however it was reached", () => {
    expect(artifactFilename(at("$.aux.url"), null, "main_stuff")).toBe("aux_.png");
    expect(artifactFilename(at("$.NUL"), null, "main_stuff")).toBe("NUL_.png");
    expect(artifactFilename(at("$.Com1.url"), null, "main_stuff")).toBe("Com1_.png");
    expect(artifactFilename(at("$.lpt9", REPORT_URI), null, "main_stuff")).toBe("lpt9_");
    expect(artifactFilename(at('$[""].con.url'), null, "main_stuff")).toBe("con_.png");
    // The cap drops every leading segment and leaves the device name alone.
    expect(artifactFilename(at(`$.${"x".repeat(130)}.prn.url`), null, "main_stuff")).toBe(
      "prn_.png",
    );
    // Only the whole stem is a device name: a join or a longer word is not one.
    expect(artifactFilename(at("$.a.nul.url"), null, "main_stuff")).toBe("a-nul.png");
    expect(artifactFilename(at("$.auxiliary.url"), null, "main_stuff")).toBe("auxiliary.png");
    expect(artifactFilename(at("$.com10.url"), null, "main_stuff")).toBe("com10.png");
  });

  it("names every location locateArtifacts writes, through the round trip of its notation", () => {
    const value = {
      'say "hi"\\': { url: "pipelex-storage://org/a.png" },
      "line\nbreak": { url: "pipelex-storage://org/b.png" },
      "\u2028": { url: "pipelex-storage://org/c.png" },
      "[0]": { url: "pipelex-storage://org/d.png" },
    };

    expect(
      locateArtifacts(value).map((location) => artifactFilename(location, null, "main_stuff")),
    ).toEqual(["say__hi__.png", "line_break.png", "_.png", "_0_.png"]);
  });
});

// ── resolveArtifacts ─────────────────────────────────────────────────

describe("resolveArtifacts", () => {
  it("makes one bulk call for a list within the bound and answers in request order", async () => {
    const client = makeClient({
      answers: { [REPORT_URI]: refusedItem(REPORT_URI, "forbidden", "another org") },
    });
    const signal = new AbortController().signal;

    const items = await resolveArtifacts(client, [PICTURE_URI, REPORT_URI, PICTURE_URI], {
      signal,
    });

    expect(client.resolveCalls).toHaveLength(1);
    expect(client.resolveCalls[0]!.input).toEqual({ uris: [PICTURE_URI, REPORT_URI, PICTURE_URI] });
    expect(client.resolveCalls[0]!.signal).toBe(signal);
    expect(items.map((item) => item.uri)).toEqual([PICTURE_URI, REPORT_URI, PICTURE_URI]);
    expect(items[0]!.error).toBeNull();
    expect(items[1]!.error).toEqual({ code: "forbidden", detail: "another org" });
    expect(items[1]!.url).toBeNull();
  });

  it("chunks a longer list at the route's bound and concatenates the answers in order", async () => {
    const client = makeClient();
    const uris = Array.from({ length: 250 }, (_, i) => `pipelex-storage://org/f/${i}.png`);

    const items = await resolveArtifacts(client, uris);

    expect(client.resolveCalls.map((call) => call.input.uris.length)).toEqual([
      BULK_RESOLVE_MAX_URIS,
      BULK_RESOLVE_MAX_URIS,
      50,
    ]);
    expect(items.map((item) => item.uri)).toEqual(uris);
  });

  it("makes no request for an empty list", async () => {
    const client = makeClient();

    await expect(resolveArtifacts(client, [])).resolves.toEqual([]);
    expect(client.resolveCalls).toHaveLength(0);
  });

  it("refuses a malformed answer rather than misattributing verdicts", async () => {
    const client: Pick<ArtifactCapableClient, "resolveStorageUrls"> = {
      async resolveStorageUrls() {
        return { items: [resolvedItem(PICTURE_URI)] };
      },
    };

    await expect(resolveArtifacts(client, [PICTURE_URI, REPORT_URI])).rejects.toBeInstanceOf(
      ArtifactOperationError,
    );
  });

  it("lets a whole-request refusal propagate unchanged", async () => {
    const client = makeClient({ answers: { [PICTURE_URI]: apiError(404, "not_found") } });

    await expect(resolveArtifacts(client, [PICTURE_URI])).rejects.toBeInstanceOf(ApiResponseError);
  });
});

// ── fetchArtifact ────────────────────────────────────────────────────

describe("fetchArtifact", () => {
  it("resolves fresh, fetches the link with no headers and no redirects, and relays the store's response", async () => {
    const client = makeClient();
    const spy = mockFetch(() =>
      streamed([PNG_BYTES.slice(0, 4), PNG_BYTES.slice(4)], {
        headers: { "content-type": "image/png", etag: '"abc"' },
      }),
    );

    const response = await fetchArtifact(client, PICTURE_URI);

    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe(
      `https://store.example/${encodeURIComponent(PICTURE_URI)}`,
    );
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("etag")).toBe('"abc"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("throws the route's per-reference refusal as a typed fetch error", async () => {
    const client = makeClient({
      answers: { [REPORT_URI]: refusedItem(REPORT_URI, "invalid_storage_uri", "malformed") },
    });
    const spy = mockFetch(() => streamed([]));

    const failure = fetchArtifact(client, REPORT_URI);

    await expect(failure).rejects.toBeInstanceOf(ArtifactFetchError);
    await expect(failure).rejects.toMatchObject({ code: "invalid_storage_uri", uri: REPORT_URI });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a plain http link by default and accepts it with allowHttp", async () => {
    const client = makeClient({
      answers: { [PICTURE_URI]: resolvedItem(PICTURE_URI, { url: "http://store.local/obj" }) },
    });
    const spy = mockFetch(() => streamed([PNG_BYTES]));

    await expect(fetchArtifact(client, PICTURE_URI)).rejects.toMatchObject({
      code: "plain_http_refused",
    });
    expect(spy).not.toHaveBeenCalled();

    const response = await fetchArtifact(client, PICTURE_URI, { allowHttp: true });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("refuses a link that is not http(s), not a URL, or carries credentials, before any request", async () => {
    const spy = mockFetch(() => streamed([]));
    for (const url of ["file:///etc/passwd", "not a url", "https://user:pw@store.example/obj"]) {
      const client = makeClient({ answers: { [PICTURE_URI]: resolvedItem(PICTURE_URI, { url }) } });

      await expect(fetchArtifact(client, PICTURE_URI)).rejects.toMatchObject({
        code: "unsupported_url",
      });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps the store's statuses onto the codes: redirect, refused, vanished, fault", async () => {
    const cases: [number, string][] = [
      [302, "redirect_refused"],
      [401, "store_refused"],
      [403, "store_refused"],
      [404, "not_found"],
      [410, "not_found"],
      [503, "store_error"],
    ];
    for (const [status, code] of cases) {
      const client = makeClient();
      mockFetch(() => new Response(null, { status }));

      await expect(fetchArtifact(client, PICTURE_URI)).rejects.toMatchObject({ code, status });
      vi.restoreAllMocks();
    }
  });

  it("refuses a declared oversize from the headers without reading the body", async () => {
    const client = makeClient();
    const body = streamed([new Uint8Array(1024)], { headers: { "content-length": "1024" } });
    const cancel = vi.spyOn(body.body!, "cancel");
    mockFetch(() => body);

    await expect(fetchArtifact(client, PICTURE_URI, { maxBytes: 100 })).rejects.toMatchObject({
      code: "too_large",
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("errors the returned stream when the body crosses the cap mid-stream", async () => {
    const client = makeClient();
    mockFetch(() => streamed([new Uint8Array(80), new Uint8Array(80)]));

    const response = await fetchArtifact(client, PICTURE_URI, { maxBytes: 100 });
    const failure = response.arrayBuffer();

    await expect(failure).rejects.toBeInstanceOf(ArtifactFetchError);
    await expect(failure).rejects.toMatchObject({ code: "too_large" });
  });

  it("times out an exchange that outlives its budget", async () => {
    const client = makeClient();
    mockFetch(pendingUntilAborted);

    await expect(fetchArtifact(client, PICTURE_URI, { timeoutMs: 20 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("times out a body that stalls past the budget", async () => {
    const client = makeClient();
    mockFetch(() => streamed([PNG_BYTES], { hang: true }));

    const response = await fetchArtifact(client, PICTURE_URI, { timeoutMs: 30 });

    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: "timeout" });
  });

  it("propagates the caller's abort as-is", async () => {
    const client = makeClient();
    const controller = new AbortController();
    const reason = new Error("walked away");
    mockFetch(pendingUntilAborted);

    const pending = fetchArtifact(client, PICTURE_URI, { signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("propagates an abort that lands mid-request as-is", async () => {
    const client = makeClient();
    const controller = new AbortController();
    const reason = new Error("walked away");
    mockFetch((url, init) => {
      setTimeout(() => controller.abort(reason), 10);
      return pendingUntilAborted(url, init);
    });

    await expect(fetchArtifact(client, PICTURE_URI, { signal: controller.signal })).rejects.toBe(
      reason,
    );
  });

  it("propagates the caller's reason when the fetch rejects with a generic AbortError", async () => {
    const client = makeClient();
    const controller = new AbortController();
    const reason = new DOMException("caller timeout", "TimeoutError");
    // The abort lands once the fetch is in flight, and a browser rejects it with its
    // own AbortError rather than the signal's reason.
    mockFetch((_url, init) => {
      setTimeout(() => controller.abort(reason), 10);
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("The user aborted a request.", "AbortError")),
          { once: true },
        );
      });
    });

    await expect(fetchArtifact(client, PICTURE_URI, { signal: controller.signal })).rejects.toBe(
      reason,
    );
  });

  it("propagates the caller's reason when an abort cuts the body short with a generic AbortError", async () => {
    const client = makeClient();
    const controller = new AbortController();
    const reason = new DOMException("caller timeout", "TimeoutError");
    // The headers arrived; the body is still streaming when the caller aborts, and a
    // browser errors it with its own AbortError rather than the signal's reason.
    mockFetch((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(PNG_BYTES.subarray(0, 4));
          init.signal!.addEventListener(
            "abort",
            () => stream.error(new DOMException("The user aborted a request.", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "image/png" } });
    });

    const response = await fetchArtifact(client, PICTURE_URI, { signal: controller.signal });
    const reading = response.arrayBuffer();
    controller.abort(reason);

    await expect(reading).rejects.toBe(reason);
  });

  it("reports a transport failure as a network fault", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

    await expect(fetchArtifact(client, PICTURE_URI)).rejects.toMatchObject({ code: "network" });
  });

  it("refuses nonsense bounds before resolving anything", async () => {
    const client = makeClient();

    await expect(fetchArtifact(client, PICTURE_URI, { maxBytes: 0 })).rejects.toBeInstanceOf(
      ArtifactOperationError,
    );
    await expect(fetchArtifact(client, PICTURE_URI, { timeoutMs: -1 })).rejects.toBeInstanceOf(
      ArtifactOperationError,
    );
    // Past the longest delay a timer honours, which would otherwise fire at once.
    await expect(fetchArtifact(client, PICTURE_URI, { timeoutMs: 2 ** 31 })).rejects.toThrow(
      /"timeoutMs" must be a positive number no larger than 2147483647/,
    );
    expect(client.resolveCalls).toHaveLength(0);
  });

  it("refuses the opaque-redirect response a browser gives for a manual redirect", async () => {
    const client = makeClient();
    mockFetch(() =>
      Object.defineProperties(new Response(null), {
        type: { value: "opaqueredirect" },
        status: { value: 0 },
      }),
    );

    await expect(fetchArtifact(client, PICTURE_URI)).rejects.toMatchObject({
      code: "redirect_refused",
      status: undefined,
    });
  });

  it("drops a Content-Encoding the fetch already decoded, with the encoded length", async () => {
    const client = makeClient();
    mockFetch(() =>
      streamed([PNG_BYTES], {
        headers: { "content-type": "image/png", "content-encoding": "gzip", "content-length": "4" },
      }),
    );

    const response = await fetchArtifact(client, PICTURE_URI);

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("keeps an encoding the fetch does not decode, with its length, beside the still-encoded body", async () => {
    const client = makeClient();
    mockFetch(() =>
      streamed([PNG_BYTES], {
        headers: { "content-encoding": "gzip, zstd", "content-length": "8" },
      }),
    );

    const response = await fetchArtifact(client, PICTURE_URI);

    expect(response.headers.get("content-encoding")).toBe("gzip, zstd");
    expect(response.headers.get("content-length")).toBe("8");
  });
});

// ── downloadArtifacts ────────────────────────────────────────────────

describe("downloadArtifacts", () => {
  it("is Node-only and says so before touching the network", async () => {
    const client = makeClient();
    const versions = Object.getOwnPropertyDescriptor(process, "versions")!;
    Object.defineProperty(process, "versions", { value: {}, configurable: true });
    try {
      await expect(
        downloadArtifacts(client, { run_id: RUN_ID, dir: "irrelevant" }),
      ).rejects.toBeInstanceOf(ArtifactOperationError);
    } finally {
      Object.defineProperty(process, "versions", versions);
    }
    expect(client.resultCalls).toHaveLength(0);
  });

  it("takes exactly one of run_id or results", async () => {
    const client = makeClient();

    await expect(downloadArtifacts(client, { dir: "x" } as never)).rejects.toBeInstanceOf(
      ArtifactOperationError,
    );
    await expect(
      downloadArtifacts(client, {
        dir: "x",
        run_id: RUN_ID,
        results: { pipeline_run_id: RUN_ID, main_stuff: {} },
      } as never),
    ).rejects.toBeInstanceOf(ArtifactOperationError);
  });

  it("validates concurrency and the total cap", async () => {
    const client = makeClient();

    await expect(
      downloadArtifacts(client, { run_id: RUN_ID, dir: "x", concurrency: 0 }),
    ).rejects.toBeInstanceOf(ArtifactOperationError);
    await expect(
      downloadArtifacts(client, { run_id: RUN_ID, dir: "x", maxTotalBytes: 0 }),
    ).rejects.toBeInstanceOf(ArtifactOperationError);
  });

  it("throws RunStillRunningError, with the retry hint, for a run that has not finished", async () => {
    const client = makeClient({
      state: { state: "running", pipeline_run_id: RUN_ID, retry_after_seconds: 7 },
    });

    const failure = downloadArtifacts(client, { run_id: RUN_ID, dir: "x" });

    await expect(failure).rejects.toBeInstanceOf(RunStillRunningError);
    await expect(failure).rejects.toMatchObject({ runId: RUN_ID, retryAfterSeconds: 7 });
  });

  it("throws RunFailedError, with the run's report, for a run that ended without a result", async () => {
    const report = {
      error_type: "PipeRunError",
      message: "Pipe 'summarize' failed: boom",
      error_domain: "runtime",
      retryable: true,
    };
    const client = makeClient({
      state: {
        state: "failed",
        pipeline_run_id: RUN_ID,
        status: "FAILED",
        message: "Run finished with status FAILED: Pipe 'summarize' failed: boom",
        error: report,
      },
    });

    const failure = downloadArtifacts(client, { run_id: RUN_ID, dir: "x" });

    await expect(failure).rejects.toBeInstanceOf(RunFailedError);
    await expect(failure).rejects.toMatchObject({ runId: RUN_ID, status: "FAILED", error: report });
  });

  it("throws ScopeUnavailableError when the scope's artifact is null or missing", async () => {
    const client = makeClient({ state: completed({ main_stuff: { url: PICTURE_URI } }) });

    const missing = downloadArtifacts(client, {
      run_id: RUN_ID,
      dir: "x",
      scope: "working_memory",
    });
    await expect(missing).rejects.toBeInstanceOf(ScopeUnavailableError);
    await expect(missing).rejects.toMatchObject({ scope: "working_memory", runId: RUN_ID });

    const nulled = downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: null },
      dir: "x",
    });
    await expect(nulled).rejects.toMatchObject({ scope: "main_stuff", runId: RUN_ID });
  });

  it("answers an empty walk over a present scope as a verdict, touching nothing", async () => {
    const client = makeClient({ state: completed({ main_stuff: { text: "no files here" } }) });
    const spy = mockFetch(() => streamed([]));
    const dir = join(await makeTempDir(), "never-created");

    const verdict = await downloadArtifacts(client, { run_id: RUN_ID, dir });

    expect(verdict).toEqual({
      scope: "main_stuff",
      artifacts: [],
      saved_paths: [],
      all_saved: true,
    });
    expect(client.resolveCalls).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
    await expect(readdir(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-reads the results by run id, resolves the set in one bulk call, and saves every file", async () => {
    const client = makeClient({
      state: completed({
        main_stuff: {
          picture: { url: PICTURE_URI, public_url: "https://signed.example/embedded.png" },
          report: { url: REPORT_URI },
        },
      }),
    });
    const spy = mockFetch((url) =>
      url.pathname.includes("illustration")
        ? streamed([PNG_BYTES.slice(0, 3), PNG_BYTES.slice(3)], {
            headers: { "content-length": String(PNG_BYTES.byteLength) },
          })
        : streamed([PDF_BYTES]),
    );
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, { run_id: RUN_ID, dir });

    expect(client.resultCalls).toEqual([RUN_ID]);
    expect(client.resolveCalls).toHaveLength(1);
    expect(client.resolveCalls[0]!.input).toEqual({ uris: [PICTURE_URI, REPORT_URI] });
    // The embedded public_url is never fetched: every link comes from the resolve.
    for (const [url] of spy.mock.calls as [URL][]) {
      expect(url.hostname).toBe("store.example");
    }
    expect(verdict.scope).toBe("main_stuff");
    expect(verdict.all_saved).toBe(true);
    expect(verdict.aborted).toBeUndefined();
    expect(verdict.artifacts).toEqual([
      {
        uri: PICTURE_URI,
        found_at: ["$.picture.url"],
        path: join(dir, "picture.png"),
        content_type: "image/png",
        size: PNG_BYTES.byteLength,
        error: null,
      },
      {
        uri: REPORT_URI,
        found_at: ["$.report.url"],
        path: join(dir, "report"),
        content_type: null,
        size: 8,
        error: null,
      },
    ]);
    expect(verdict.saved_paths).toEqual([join(dir, "picture.png"), join(dir, "report")]);
    expect(new Uint8Array(await readFile(join(dir, "picture.png")))).toEqual(PNG_BYTES);
    expect(new Uint8Array(await readFile(join(dir, "report")))).toEqual(PDF_BYTES);
  });

  it("takes results in hand without re-reading, and creates the directory", async () => {
    const client = makeClient();
    mockFetch(() => streamed([PNG_BYTES]));
    const dir = join(await makeTempDir(), "nested", "out");

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: { items: [{ url: PICTURE_URI }] } },
      dir,
    });

    expect(client.resultCalls).toHaveLength(0);
    expect(verdict.saved_paths).toEqual([join(dir, "items-0.png")]);
  });

  it("walks working_memory off the parsed body when asked, echoed inputs included", async () => {
    const client = makeClient({
      state: completed({
        main_stuff: { url: PICTURE_URI },
        working_memory: {
          root: {
            brief: { concept: "native.Document", content: { url: INPUT_URI } },
            picture: { concept: "native.Image", content: { url: PICTURE_URI } },
          },
          aliases: { main_stuff: "picture" },
        },
      }),
    });
    mockFetch((url) => streamed([url.pathname.includes("brief") ? PDF_BYTES : PNG_BYTES]));
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      run_id: RUN_ID,
      dir,
      scope: "working_memory",
    });

    expect(verdict.scope).toBe("working_memory");
    expect(verdict.artifacts.map((artifact) => artifact.uri)).toEqual([INPUT_URI, PICTURE_URI]);
    expect(verdict.artifacts.map((artifact) => artifact.found_at)).toEqual([
      ["$.root.brief.content.url"],
      ["$.root.picture.content.url"],
    ]);
    expect(verdict.all_saved).toBe(true);
    expect(new Uint8Array(await readFile(join(dir, "root-brief-content.pdf")))).toEqual(PDF_BYTES);
  });

  it("never overwrites: a name already on disk gets a numeric suffix", async () => {
    const client = makeClient();
    mockFetch(() => streamed([PNG_BYTES]));
    const dir = await makeTempDir();
    await writeFile(join(dir, "main_stuff.png"), "keep me", "utf8");
    await writeFile(join(dir, "main_stuff-1.png"), "keep me too", "utf8");

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: { url: PICTURE_URI } },
      dir,
    });

    expect(verdict.saved_paths).toEqual([join(dir, "main_stuff-2.png")]);
    await expect(readFile(join(dir, "main_stuff.png"), "utf8")).resolves.toBe("keep me");
    await expect(readFile(join(dir, "main_stuff-1.png"), "utf8")).resolves.toBe("keep me too");
  });

  it("names a file after the field it fills and reports every path, on the saved and error arms", async () => {
    const client = makeClient({
      answers: { [REPORT_URI]: refusedItem(REPORT_URI, "forbidden", "another organization") },
    });
    mockFetch(() => streamed([PNG_BYTES]));
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: {
        pipeline_run_id: RUN_ID,
        main_stuff: {
          rooms: [
            { original_photo: { url: INPUT_URI }, staged_photo: { url: PICTURE_URI } },
            { original_photo: { url: REPORT_URI } },
          ],
          cover: { url: PICTURE_URI },
        },
      },
      dir,
    });

    expect(verdict.artifacts.map(({ uri, found_at, path }) => ({ uri, found_at, path }))).toEqual([
      {
        uri: INPUT_URI,
        found_at: ["$.rooms[0].original_photo.url"],
        path: join(dir, "rooms-0-original_photo.pdf"),
      },
      {
        uri: PICTURE_URI,
        found_at: ["$.rooms[0].staged_photo.url", "$.cover.url"],
        path: join(dir, "rooms-0-staged_photo.png"),
      },
      { uri: REPORT_URI, found_at: ["$.rooms[1].original_photo.url"], path: null },
    ]);
    expect((await readdir(dir)).sort()).toEqual([
      "rooms-0-original_photo.pdf",
      "rooms-0-staged_photo.png",
    ]);
  });

  it("tells apart two paths that reduce to one name with the suffix rule", async () => {
    const client = makeClient();
    mockFetch(() => streamed([PNG_BYTES]));
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: {
        pipeline_run_id: RUN_ID,
        main_stuff: {
          "staged photo": { url: PICTURE_URI },
          "staged-photo": { url: "pipelex-storage://org/runs/01JRUN/outputs/second.png" },
        },
      },
      dir,
      concurrency: 1,
    });

    expect(verdict.saved_paths).toEqual([
      join(dir, "staged_photo.png"),
      join(dir, "staged_photo-1.png"),
    ]);
  });

  it("saves every file under the name artifactFilename gives its location", async () => {
    const client = makeClient();
    mockFetch(() => streamed([PNG_BYTES]));
    const dir = await makeTempDir();
    const mainStuff = {
      'say "hi"\\': { url: "pipelex-storage://org/a.png" },
      "line\nbreak": [{ url: "pipelex-storage://org/b" }],
      url: "pipelex-storage://org/c.pdf",
    };

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: mainStuff },
      dir,
    });

    const expected = locateArtifacts(mainStuff).map((location, index) =>
      join(dir, artifactFilename(location, verdict.artifacts[index]!.content_type, "main_stuff")),
    );
    expect(verdict.saved_paths).toEqual(expected);
    expect(expected).toEqual([
      join(dir, "say__hi__.png"),
      join(dir, "line_break-0"),
      join(dir, "main_stuff.pdf"),
    ]);
  });

  it("refuses an unknown scope before reading anything", async () => {
    const client = makeClient();

    await expect(
      downloadArtifacts(client, { run_id: RUN_ID, dir: "x", scope: "everything" as never }),
    ).rejects.toBeInstanceOf(ArtifactOperationError);
    expect(client.resultCalls).toHaveLength(0);
  });

  it("keeps a per-reference resolve refusal as that item's error beside the saved ones", async () => {
    const client = makeClient({
      answers: { [REPORT_URI]: refusedItem(REPORT_URI, "forbidden", "another organization") },
    });
    mockFetch(() => streamed([PNG_BYTES]));
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }] },
      dir,
    });

    expect(verdict.all_saved).toBe(false);
    expect(verdict.artifacts[1]).toEqual({
      uri: REPORT_URI,
      found_at: ["$[1].url"],
      path: null,
      content_type: null,
      size: null,
      error: { code: "forbidden", detail: "another organization" },
    });
    expect(verdict.saved_paths).toEqual([join(dir, "0.png")]);
  });

  it("re-resolves a link that has expired by the time its worker reaches it", async () => {
    const fresh = resolvedItem(PICTURE_URI, { url: "https://store.example/fresh?sig=new" });
    const client = makeClient({
      sequence: [
        {
          [PICTURE_URI]: resolvedItem(PICTURE_URI, {
            expires_at: PAST,
            url: "https://store.example/stale",
          }),
        },
        { [PICTURE_URI]: fresh },
      ],
    });
    const spy = mockFetch(() => streamed([PNG_BYTES]));
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: { url: PICTURE_URI } },
      dir,
    });

    expect(client.resolveCalls.map((call) => call.input.uris)).toEqual([
      [PICTURE_URI],
      [PICTURE_URI],
    ]);
    expect((spy.mock.calls[0]![0] as URL).toString()).toBe(fresh.url);
    expect(verdict.all_saved).toBe(true);
  });

  it("marks an item whose expired link cannot be re-resolved, and goes on", async () => {
    const client = makeClient({
      sequence: [
        {
          [PICTURE_URI]: resolvedItem(PICTURE_URI, { expires_at: PAST }),
          [REPORT_URI]: resolvedItem(REPORT_URI),
        },
        apiError(500),
      ],
    });
    mockFetch(() => streamed([PDF_BYTES]));
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }] },
      dir,
      concurrency: 1,
    });

    expect(verdict.artifacts[0]!.error).toMatchObject({ code: "resolve_failed" });
    expect(verdict.artifacts[1]!.error).toBeNull();
    expect(verdict.all_saved).toBe(false);
  });

  it("re-resolves a refused reference as that item's error", async () => {
    const client = makeClient({
      sequence: [
        { [PICTURE_URI]: resolvedItem(PICTURE_URI, { expires_at: PAST }) },
        { [PICTURE_URI]: refusedItem(PICTURE_URI, "invalid_storage_uri", "gone bad") },
      ],
    });
    const spy = mockFetch(() => streamed([PNG_BYTES]));

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: { url: PICTURE_URI } },
      dir: await makeTempDir(),
    });

    expect(spy).not.toHaveBeenCalled();
    expect(verdict.artifacts[0]!.error).toEqual({
      code: "invalid_storage_uri",
      detail: "gone bad",
    });
  });

  it("throws a credential failure on the first resolve, carrying an all-aborted verdict", async () => {
    const client = makeClient({ sequence: [apiError(401)] });
    const spy = mockFetch(() => streamed([]));

    const failure = downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }] },
      dir: await makeTempDir(),
    });

    await expect(failure).rejects.toBeInstanceOf(ArtifactAuthenticationError);
    const error = (await failure.catch((err: unknown) => err)) as ArtifactAuthenticationError;
    expect(error.status).toBe(401);
    expect(error.cause).toBeInstanceOf(ApiResponseError);
    expect(error.verdict.all_saved).toBe(false);
    expect(error.verdict.aborted).toBeUndefined();
    expect(error.verdict.artifacts.map((artifact) => artifact.error?.code)).toEqual([
      "aborted",
      "aborted",
    ]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws a credential failure part-way through, carrying the verdict so far", async () => {
    const client = makeClient({
      sequence: [
        {
          [PICTURE_URI]: resolvedItem(PICTURE_URI),
          [REPORT_URI]: resolvedItem(REPORT_URI, { expires_at: PAST }),
          [INPUT_URI]: resolvedItem(INPUT_URI),
        },
        apiError(403),
      ],
    });
    mockFetch(() => streamed([PNG_BYTES]));
    const dir = await makeTempDir();

    const failure = downloadArtifacts(client, {
      results: {
        pipeline_run_id: RUN_ID,
        main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }, { url: INPUT_URI }],
      },
      dir,
      concurrency: 1,
    });

    const error = (await failure.catch((err: unknown) => err)) as ArtifactAuthenticationError;
    expect(error).toBeInstanceOf(ArtifactAuthenticationError);
    expect(error.status).toBe(403);
    expect(error.verdict.saved_paths).toEqual([join(dir, "0.png")]);
    expect(error.verdict.artifacts.map((artifact) => artifact.error?.code)).toEqual([
      undefined,
      "aborted",
      "aborted",
    ]);
    expect(error.verdict.artifacts[2]!.error!.detail).toMatch(/credential/);
    expect(error.verdict.artifacts[2]!.content_type).toBe("application/pdf");
  });

  it("lets a fetch already running finish when a re-resolve refuses the credential", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = makeClient({
      sequence: [
        {
          [PICTURE_URI]: resolvedItem(PICTURE_URI),
          [REPORT_URI]: resolvedItem(REPORT_URI, { expires_at: PAST }),
          [INPUT_URI]: resolvedItem(INPUT_URI),
        },
        apiError(401),
      ],
    });
    // The picture's body flows only once the re-resolve has been refused.
    const client: typeof base = {
      ...base,
      async resolveStorageUrls(input, options) {
        try {
          return await base.resolveStorageUrls(input, options);
        } catch (err) {
          setTimeout(release, 0);
          throw err;
        }
      },
    };
    mockFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller): Promise<void> {
              await gate;
              controller.enqueue(PNG_BYTES);
              controller.close();
            },
          }),
        ),
    );
    const dir = await makeTempDir();

    const error = (await downloadArtifacts(client, {
      results: {
        pipeline_run_id: RUN_ID,
        main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }, { url: INPUT_URI }],
      },
      dir,
      concurrency: 2,
    }).catch((err: unknown) => err)) as ArtifactAuthenticationError;

    expect(error).toBeInstanceOf(ArtifactAuthenticationError);
    expect(error.verdict.saved_paths).toEqual([join(dir, "0.png")]);
    expect(error.verdict.artifacts.map((artifact) => artifact.error?.code)).toEqual([
      undefined,
      "aborted",
      "aborted",
    ]);
    expect(await readFile(join(dir, "0.png"))).toEqual(Buffer.from(PNG_BYTES));
  });

  it("refuses a declared oversize and cuts an undeclared one mid-stream, unlinking the partial file", async () => {
    const client = makeClient();
    mockFetch((url) =>
      url.pathname.includes("illustration")
        ? streamed([new Uint8Array(1024)], { headers: { "content-length": "1024" } })
        : streamed([new Uint8Array(80), new Uint8Array(80)]),
    );
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }] },
      dir,
      maxBytes: 100,
    });

    expect(verdict.artifacts.map((artifact) => artifact.error?.code)).toEqual([
      "too_large",
      "too_large",
    ]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("enforces the total cap: the crossing item errors and the rest are skipped with the reason", async () => {
    const client = makeClient();
    mockFetch((url) =>
      url.pathname.includes("brief")
        ? streamed([new Uint8Array(60)], { headers: { "content-length": "60" } })
        : streamed([new Uint8Array(30), new Uint8Array(30)]),
    );
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: {
        pipeline_run_id: RUN_ID,
        main_stuff: [{ url: PICTURE_URI }, { url: INPUT_URI }, { url: REPORT_URI }],
      },
      dir,
      concurrency: 1,
      maxTotalBytes: 100,
    });

    // 60 bytes saved undeclared, then a declared 60 would cross, then the rest skipped.
    expect(verdict.artifacts[0]!.error).toBeNull();
    expect(verdict.artifacts[1]!.error).toMatchObject({ code: "total_limit_exceeded" });
    expect(verdict.artifacts[2]!.error).toMatchObject({ code: "total_limit_exceeded" });
    expect(verdict.artifacts[2]!.error!.detail).toMatch(/^Skipped/);
    expect(await readdir(dir)).toEqual(["0.png"]);
  });

  it("reserves a declared length, so parallel files never cut each other past the total cap", async () => {
    const client = makeClient();
    mockFetch(() =>
      streamed([new Uint8Array(35), new Uint8Array(35)], { headers: { "content-length": "70" } }),
    );
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }] },
      dir,
      concurrency: 2,
      maxTotalBytes: 100,
    });

    // Either file fits alone and both do not: one is saved whole, the other refused up front.
    const codes = verdict.artifacts.map((artifact) => artifact.error?.code ?? "saved").sort();
    expect(codes).toEqual(["saved", "total_limit_exceeded"]);
    expect(verdict.saved_paths).toHaveLength(1);
    expect((await readFile(verdict.saved_paths[0]!)).byteLength).toBe(70);
  });

  it("stops nothing else when an item is refused only against a file still in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = makeClient();
    mockFetch((url) => {
      if (url.pathname.includes("illustration")) {
        // The picture holds its 70 bytes of room while the report is weighed.
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller): Promise<void> {
              await gate;
              controller.enqueue(new Uint8Array(70));
              controller.close();
            },
          }),
          { headers: { "content-length": "70" } },
        );
      }
      // Released once the report has been weighed against the picture's reservation.
      if (url.pathname.includes("report")) setTimeout(release, 0);
      const size = url.pathname.includes("report") ? 50 : 20;
      return streamed([new Uint8Array(size)], { headers: { "content-length": String(size) } });
    });
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: {
        pipeline_run_id: RUN_ID,
        main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }, { url: INPUT_URI }],
      },
      dir,
      concurrency: 2,
      maxTotalBytes: 100,
    });

    expect(verdict.artifacts.map((artifact) => artifact.error?.code)).toEqual([
      undefined,
      "total_limit_exceeded",
      undefined,
    ]);
    expect(verdict.artifacts[1]!.error!.detail).not.toMatch(/^Skipped/);
  });

  it("gives a bodiless success's declared length back to the total cap", async () => {
    const client = makeClient();
    mockFetch((url) =>
      url.pathname.includes("illustration")
        ? new Response(null, { status: 204, headers: { "content-length": "90" } })
        : streamed([new Uint8Array(90)], { headers: { "content-length": "90" } }),
    );
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }] },
      dir,
      concurrency: 1,
      maxTotalBytes: 100,
    });

    expect(verdict.all_saved).toBe(true);
    expect(verdict.artifacts.map((artifact) => artifact.size)).toEqual([0, 90]);
  });

  it("gives an unlinked partial file's bytes back to the total cap", async () => {
    const client = makeClient();
    mockFetch((url) =>
      url.pathname.includes("illustration")
        ? streamed([new Uint8Array(60), new Uint8Array(60)])
        : streamed([new Uint8Array(80)]),
    );
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }] },
      dir,
      concurrency: 1,
      maxBytes: 100,
      maxTotalBytes: 100,
    });

    // The picture crosses its own cap after 60 bytes were written; those do not count against the report.
    expect(verdict.artifacts.map((artifact) => artifact.error?.code)).toEqual([
      "too_large",
      undefined,
    ]);
    expect(await readdir(dir)).toEqual(["1"]);
  });

  it("enforces the total cap mid-stream on an undeclared body, unlinking the partial file", async () => {
    const client = makeClient();
    mockFetch(() => streamed([new Uint8Array(60), new Uint8Array(60)]));
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: { url: PICTURE_URI } },
      dir,
      maxTotalBytes: 100,
    });

    expect(verdict.artifacts[0]!.error).toMatchObject({ code: "total_limit_exceeded" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps a store refusal or a vanished object as the item's error", async () => {
    const client = makeClient();
    mockFetch((url) => new Response(null, { status: url.pathname.includes("report") ? 404 : 403 }));

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }] },
      dir: await makeTempDir(),
    });

    expect(verdict.artifacts.map((artifact) => artifact.error?.code)).toEqual([
      "store_refused",
      "not_found",
    ]);
  });

  it("stops on the caller's abort: the in-flight file is unlinked, the rest marked, aborted set", async () => {
    const client = makeClient();
    const controller = new AbortController();
    mockFetch((url) => {
      if (url.pathname.includes("illustration")) {
        // First chunk arrives, then the body hangs until the caller aborts.
        setTimeout(() => controller.abort(), 20);
        return streamed([PNG_BYTES.slice(0, 4)], { hang: true });
      }
      return streamed([PDF_BYTES]);
    });
    const dir = await makeTempDir();

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: [{ url: PICTURE_URI }, { url: REPORT_URI }] },
      dir,
      concurrency: 1,
      signal: controller.signal,
    });

    expect(verdict.aborted).toBe(true);
    expect(verdict.all_saved).toBe(false);
    expect(verdict.artifacts.map((artifact) => artifact.error?.code)).toEqual([
      "aborted",
      "aborted",
    ]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("reports a file that cannot be created as write_failed, leaving nothing behind", async () => {
    const client = makeClient();
    mockFetch(() => streamed([PNG_BYTES]));
    const dir = await makeTempDir();
    // A read-only directory: exclusive creation fails with EACCES rather than
    // EEXIST, so the never-overwrite suffixing cannot rescue it.
    await chmod(dir, 0o500);
    try {
      const verdict = await downloadArtifacts(client, {
        results: { pipeline_run_id: RUN_ID, main_stuff: { url: PICTURE_URI } },
        dir,
      });

      expect(verdict.artifacts[0]!.error).toMatchObject({ code: "write_failed" });
      expect(verdict.all_saved).toBe(false);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it("throws for a directory that cannot be created", async () => {
    const client = makeClient();
    const file = join(await makeTempDir(), "a-file");
    await writeFile(file, "not a directory", "utf8");

    await expect(
      downloadArtifacts(client, {
        results: { pipeline_run_id: RUN_ID, main_stuff: { url: PICTURE_URI } },
        dir: join(file, "under-a-file"),
      }),
    ).rejects.toBeInstanceOf(ArtifactOperationError);
  });

  it("lets a deployment without the bulk route surface as the transport error", async () => {
    const client = makeClient({ sequence: [apiError(404, "not_found")] });

    await expect(
      downloadArtifacts(client, {
        results: { pipeline_run_id: RUN_ID, main_stuff: { url: PICTURE_URI } },
        dir: await makeTempDir(),
      }),
    ).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("runs the workers concurrently, bounded by concurrency", async () => {
    const client = makeClient();
    let inFlight = 0;
    let peak = 0;
    mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve(streamed([PNG_BYTES]));
          }, 10);
        }),
    );
    const uris = Array.from({ length: 6 }, (_, i) => `pipelex-storage://org/f/${i}.png`);

    const verdict = await downloadArtifacts(client, {
      results: { pipeline_run_id: RUN_ID, main_stuff: uris.map((url) => ({ url })) },
      dir: await makeTempDir(),
      concurrency: 2,
    });

    expect(peak).toBe(2);
    expect(verdict.all_saved).toBe(true);
    expect(verdict.artifacts.map((artifact) => artifact.uri)).toEqual(uris);
  });
});
