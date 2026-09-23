/**
 * `uploadWithGrant` — the sender of an upload grant, and the browser-safe
 * `@pipelex/sdk/upload` entry. Pins: the PUT it sends (the grant's URL, its signed
 * headers unchanged, the file as the raw body, redirects refused), the mapping of
 * storage's refusals onto the input-preparation errors, a caller's abort passing
 * through untouched, and — by bundling the module for the browser with esbuild —
 * that its runtime import graph reaches no Node builtin and no `undici`.
 *
 * The function calls the global `fetch`, so these spy on it; the bodies are the
 * XML documents S3 answers with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { uploadWithGrant } from "../src/upload-grant.js";
import type { UploadGrant } from "../src/upload-grant.js";
import {
  InputPreparationError,
  RejectedAssetError,
  UploadTransportError,
} from "../src/upload-grant.js";
import * as mainEntry from "../src/index.js";

const GRANT: UploadGrant = {
  uri: "pipelex-storage://org_1/assets/5f0c.pdf",
  url: "https://pipelex-app-dev.s3.amazonaws.com/org_1/assets/5f0c.pdf?X-Amz-Signature=abc",
  headers: {
    "If-None-Match": "*",
    "Content-Type": "application/pdf",
    "x-amz-meta-uploaded-by": "user_1",
    "x-amz-meta-original-filename": "report.pdf",
    "x-amz-meta-byte-size": "5",
    "x-amz-meta-uploaded-at": "2026-09-23T10:00:00+00:00",
  },
  expires_at: "2026-09-23T10:05:00Z",
  max_bytes: 52428800,
};

/** The credential S3 echoes back inside a signature-mismatch body. It must never reach a message. */
const ECHOED_TOKEN = "IQoJb3JpZ2luX2VjEXAMPLESECRET";

function s3Error(code: string, message: string, extra = ""): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Error><Code>${code}</Code><Message>${message}</Message>${extra}` +
    "<RequestId>R1</RequestId><HostId>H1</HostId></Error>"
  );
}

function xmlResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/xml" } });
}

function pdfFile(): File {
  return new File([new Uint8Array([37, 80, 68, 70, 45])], "report.pdf", {
    type: "application/pdf",
  });
}

/** The error `uploadWithGrant` rejects with, for a fetch answering `response`. */
async function refusalFor(response: Response, file: Blob = pdfFile()): Promise<unknown> {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  return uploadWithGrant(GRANT, file).then(
    () => {
      throw new Error("expected uploadWithGrant to reject");
    },
    (error: unknown) => error,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uploadWithGrant — the PUT", () => {
  it("PUTs the file as the raw body to the grant's URL with its headers unchanged", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const file = pdfFile();

    const result = await uploadWithGrant(GRANT, file);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GRANT.url);
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual(GRANT.headers);
    expect(init.body).toBe(file);
    expect(init.redirect).toBe("manual");
    expect(result).toEqual({ uri: GRANT.uri });
  });

  it("accepts a nameless Blob", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const result = await uploadWithGrant(GRANT, new Blob([new Uint8Array([1, 2, 3])]));

    expect(result).toEqual({ uri: GRANT.uri });
  });

  it("forwards the caller's signal to the PUT", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const controller = new AbortController();

    await uploadWithGrant(GRANT, pdfFile(), { signal: controller.signal });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});

describe("uploadWithGrant — storage's refusals", () => {
  it("maps the 412 of a used grant onto RejectedAssetError", async () => {
    const error = await refusalFor(
      xmlResponse(
        412,
        s3Error(
          "PreconditionFailed",
          "At least one of the pre-conditions you specified did not hold",
        ),
      ),
    );

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect(error).toBeInstanceOf(InputPreparationError);
    const rejected = error as RejectedAssetError;
    expect(rejected.status).toBe(412);
    expect(rejected.code).toBe("grant_used");
    expect(rejected.filename).toBe("report.pdf");
    expect(rejected.message).toContain("412 PreconditionFailed");
    expect(rejected.message).toContain("already used");
    expect(rejected.message).toContain("may have stored the file");
  });

  it("maps a signature mismatch onto RejectedAssetError, keeping no part of the echoed request", async () => {
    const error = await refusalFor(
      xmlResponse(
        403,
        s3Error(
          "SignatureDoesNotMatch",
          "The request signature we calculated does not match the signature you provided. Check your key and signing method.",
          `<AWSAccessKeyId>ASIAEXAMPLE</AWSAccessKeyId><CanonicalRequest>PUT\n/org_1/assets/5f0c.pdf\nX-Amz-Security-Token=${ECHOED_TOKEN}</CanonicalRequest>`,
        ),
      ),
    );

    expect(error).toBeInstanceOf(RejectedAssetError);
    const rejected = error as RejectedAssetError;
    expect(rejected.status).toBe(403);
    expect(rejected.code).toBe("signature_mismatch");
    expect(rejected.message).toContain("403 SignatureDoesNotMatch");
    expect(rejected.message).toContain("size, content type or metadata");
    expect(rejected.message).not.toContain(ECHOED_TOKEN);
    expect(rejected.message).not.toContain("ASIAEXAMPLE");
    expect(rejected.cause).toBeUndefined();
  });

  it("says the grant expired when storage says so", async () => {
    const error = await refusalFor(
      xmlResponse(403, s3Error("AccessDenied", "Request has expired")),
    );

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).code).toBe("grant_expired");
    expect((error as RejectedAssetError).message).toContain(
      `the grant expired at ${GRANT.expires_at}`,
    );
  });

  it("names an unsigned header when storage refuses one", async () => {
    const error = await refusalFor(
      xmlResponse(
        403,
        s3Error("AccessDenied", "There were headers present in the request which were not signed"),
      ),
    );

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).code).toBe("unsigned_header");
    expect((error as RejectedAssetError).message).toContain("a header the grant did not sign");
  });

  it("relays storage's own message for any other 4xx", async () => {
    const error = await refusalFor(
      xmlResponse(
        400,
        s3Error("EntityTooSmall", "Your proposed upload is smaller than the minimum"),
      ),
    );

    expect(error).toBeInstanceOf(RejectedAssetError);
    const rejected = error as RejectedAssetError;
    expect(rejected.status).toBe(400);
    expect(rejected.code).toBe("store_refused");
    expect(rejected.message).toContain("400 EntityTooSmall");
    expect(rejected.message).toContain("smaller than the minimum");
  });

  it("decodes XML entities in storage's message", async () => {
    const error = await refusalFor(
      xmlResponse(400, s3Error("InvalidArgument", "Header &apos;x&apos; &amp; &lt;y&gt;")),
    );

    expect((error as RejectedAssetError).message).toContain("Header 'x' & <y>");
  });

  it("falls back to the status text on a body that is not S3's", async () => {
    const error = await refusalFor(new Response("nope", { status: 403, statusText: "Forbidden" }));

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).message).toContain("403 Forbidden");
  });

  it("names a nameless Blob by the object its grant names", async () => {
    const error = await refusalFor(
      xmlResponse(412, s3Error("PreconditionFailed", "pre-conditions")),
      new Blob([new Uint8Array([1])]),
    );

    expect((error as RejectedAssetError).filename).toBe("5f0c.pdf");
  });
});

describe("uploadWithGrant — transport failures", () => {
  it("maps a 5xx onto UploadTransportError", async () => {
    const error = await refusalFor(
      xmlResponse(503, s3Error("SlowDown", "Please reduce your request rate.")),
    );

    expect(error).toBeInstanceOf(UploadTransportError);
    expect(error).toBeInstanceOf(InputPreparationError);
    expect((error as UploadTransportError).status).toBe(503);
    expect((error as UploadTransportError).cause).toBeUndefined();
    expect((error as Error).message).toContain("503 SlowDown");
    expect((error as Error).message).toContain("Please reduce your request rate.");
  });

  it("maps storage timing out on the body onto UploadTransportError, since nothing was written", async () => {
    const error = await refusalFor(
      xmlResponse(
        400,
        s3Error(
          "RequestTimeout",
          "Your socket connection to the server was not read from or written to within the timeout period.",
        ),
      ),
    );

    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).status).toBe(400);
    expect((error as Error).message).toContain("400 RequestTimeout");
    expect((error as Error).message).toContain("wrote nothing");
    expect((error as Error).message).toContain(`expires at ${GRANT.expires_at}`);
  });

  it("refuses a redirect rather than following it", async () => {
    const error = await refusalFor(
      new Response(null, {
        status: 307,
        headers: { Location: "https://elsewhere.example/upload" },
      }),
    );

    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).status).toBe(307);
    expect((error as Error).message).toContain("redirect was refused");
  });

  it("maps an unreachable storage onto UploadTransportError, naming a refused cross-origin request", async () => {
    const cause = new TypeError("Failed to fetch");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(cause);

    const error = await uploadWithGrant(GRANT, pdfFile()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).cause).toBe(cause);
    expect((error as UploadTransportError).status).toBeUndefined();
    expect((error as Error).message).toContain("Failed to fetch");
    expect((error as Error).message).toContain("connect-src");
  });

  it("lets a caller's abort through unwrapped", async () => {
    const controller = new AbortController();
    const reason = new DOMException("The user cancelled.", "AbortError");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });

    const error = await uploadWithGrant(GRANT, pdfFile(), { signal: controller.signal }).catch(
      (e: unknown) => e,
    );

    expect(error).toBe(reason);
  });

  it("lets a caller's abort through unwrapped while storage's error body is still arriving", async () => {
    const controller = new AbortController();
    const reason = new DOMException("The user cancelled.", "AbortError");
    // Storage answered 403 and is still streaming its body when the caller aborts,
    // which errors the body stream with the abort's reason, as `fetch` does.
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("<Error><Code>AccessDenied</Code>"));
        controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 403 }));

    const pending = uploadWithGrant(GRANT, pdfFile(), { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(reason);

    expect(await pending).toBe(reason);
  });
});

describe("the @pipelex/sdk/upload entry", () => {
  const entry = fileURLToPath(new URL("../src/upload-grant.ts", import.meta.url));

  it("bundles for the browser with nothing marked external", async () => {
    // esbuild fails to resolve a Node builtin on the browser platform, and a dynamic
    // import with a literal specifier is bundled like a static one — so a reachable
    // `node:fs/promises` (upload.ts) or `undici` (artifacts.ts) fails this build.
    // Type-only imports are erased, as they are by every consumer's bundler.
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
    });

    expect(result.errors).toEqual([]);
    const code = result.outputFiles[0]!.text;
    expect(code).toContain("uploadWithGrant");
    expect(code).not.toMatch(/["']node:/);
    expect(code).not.toContain("undici");
    expect(code).not.toContain("PipelexApiClient");
  });

  it("is the ./upload subpath of the package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, Record<string, string>>;
    };

    expect(pkg.exports["./upload"]).toEqual({
      types: "./dist/upload-grant.d.ts",
      import: "./dist/upload-grant.js",
      default: "./dist/upload-grant.js",
    });
  });

  it("shares its function and error classes with the main entry", () => {
    expect(mainEntry.uploadWithGrant).toBe(uploadWithGrant);
    expect(mainEntry.RejectedAssetError).toBe(RejectedAssetError);
    expect(mainEntry.UploadTransportError).toBe(UploadTransportError);
    expect(mainEntry.InputPreparationError).toBe(InputPreparationError);
  });
});
