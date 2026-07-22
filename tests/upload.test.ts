/**
 * `uploadFile` — the single-asset upload convenience over the raw `upload()` wire
 * call. Pins: accepted asset forms (bytes everywhere, path Node-only), the
 * client-side record assembly (uri/filename/contentType/size), base64 correctness,
 * and the mapping of raw transport errors onto the semantic preparation errors.
 *
 * The function takes a client interface, so these inject a fake `upload` rather
 * than mocking fetch.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFile } from "../src/upload.js";
import type { UploadCapableClient } from "../src/upload.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  InvalidLocalSourceError,
  RejectedAssetError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
} from "../src/errors.js";

interface Captured {
  filename: string;
  data: string;
  content_type: string;
}

/** A fake client that records the wire body and returns a canned URI. */
function capturingClient(uri = "pipelex-storage://user/assets/abc.bin"): {
  client: UploadCapableClient;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const client: UploadCapableClient = {
    async upload(input) {
      calls.push(input);
      return { uri, filename: input.filename };
    },
  };
  return { client, calls };
}

/** A fake client whose upload always throws the given error. */
function throwingClient(error: unknown): UploadCapableClient {
  return {
    async upload() {
      throw error;
    },
  };
}

function apiError(status: number, serverMessage = "boom"): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    "https://api.pipelex.com/v1/upload",
    status,
    "Error",
    "",
    undefined,
    serverMessage,
    undefined,
    undefined,
  );
}

describe("uploadFile", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("uploads a Uint8Array, base64-encoding the bytes and returning a full record", async () => {
    const { client, calls } = capturingClient();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const record = await uploadFile(client, bytes, {
      filename: "blob.png",
      contentType: "image/png",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      filename: "blob.png",
      data: Buffer.from(bytes).toString("base64"),
      content_type: "image/png",
    });
    expect(record).toEqual({
      uri: "pipelex-storage://user/assets/abc.bin",
      filename: "blob.png",
      contentType: "image/png",
      size: 5,
    });
  });

  it("uploads an ArrayBuffer", async () => {
    const { client, calls } = capturingClient();
    const buffer = new Uint8Array([9, 8, 7]).buffer;

    const record = await uploadFile(client, buffer, { filename: "x.bin" });

    expect(calls[0]?.data).toBe(Buffer.from(new Uint8Array([9, 8, 7])).toString("base64"));
    expect(record.size).toBe(3);
  });

  it("derives filename and MIME from a File", async () => {
    const { client, calls } = capturingClient();
    const file = new File([new Uint8Array([1, 2])], "photo.jpg", { type: "image/jpeg" });

    const record = await uploadFile(client, file);

    expect(calls[0]?.filename).toBe("photo.jpg");
    expect(calls[0]?.content_type).toBe("image/jpeg");
    expect(record.filename).toBe("photo.jpg");
    expect(record.contentType).toBe("image/jpeg");
  });

  it("falls back to a default filename and guessed MIME for a nameless Blob", async () => {
    const { client, calls } = capturingClient();
    const blob = new Blob([new Uint8Array([1])], { type: "image/webp" });

    await uploadFile(client, blob);

    expect(calls[0]?.filename).toBe("upload.bin");
    expect(calls[0]?.content_type).toBe("image/webp");
  });

  it("reads a local path in Node, deriving filename from basename and MIME from extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plx-upload-"));
    tempDirs.push(dir);
    const path = join(dir, "diagram.png");
    await writeFile(path, new Uint8Array([10, 20, 30]));
    const { client, calls } = capturingClient();

    const record = await uploadFile(client, path);

    expect(calls[0]?.filename).toBe("diagram.png");
    expect(calls[0]?.content_type).toBe("image/png");
    expect(record.size).toBe(3);
  });

  it("raises InvalidLocalSourceError for a missing path", async () => {
    const { client } = capturingClient();
    await expect(uploadFile(client, "/no/such/file.png")).rejects.toBeInstanceOf(
      InvalidLocalSourceError,
    );
  });

  it("maps a 413 to RejectedAssetError carrying the filename and status", async () => {
    const client = throwingClient(apiError(413, "too big"));
    const bytes = new Uint8Array([1]);

    await expect(uploadFile(client, bytes, { filename: "big.pdf" })).rejects.toMatchObject({
      name: "RejectedAssetError",
      filename: "big.pdf",
      status: 413,
    });
    await expect(uploadFile(client, bytes, { filename: "big.pdf" })).rejects.toBeInstanceOf(
      RejectedAssetError,
    );
  });

  it("maps 401/403 to UploadAuthenticationError", async () => {
    for (const status of [401, 403]) {
      const client = throwingClient(apiError(status));
      await expect(uploadFile(client, new Uint8Array([1]))).rejects.toBeInstanceOf(
        UploadAuthenticationError,
      );
    }
  });

  it("maps a 404 to UnsupportedUploadCapabilityError", async () => {
    const client = throwingClient(apiError(404));
    await expect(uploadFile(client, new Uint8Array([1]))).rejects.toBeInstanceOf(
      UnsupportedUploadCapabilityError,
    );
  });

  it("maps other error statuses and unreachable hosts to UploadTransportError", async () => {
    const server = throwingClient(apiError(500));
    await expect(uploadFile(server, new Uint8Array([1]))).rejects.toBeInstanceOf(
      UploadTransportError,
    );

    const unreachable = throwingClient(
      new ApiUnreachableError("down", "https://api.pipelex.com", "ECONNREFUSED"),
    );
    await expect(uploadFile(unreachable, new Uint8Array([1]))).rejects.toBeInstanceOf(
      UploadTransportError,
    );
  });

  it("wraps an unexpected non-transport error as UploadTransportError, preserving the cause", async () => {
    // A malformed 2xx upload body surfaces from the client as a SyntaxError, not one of
    // the two mapped transport types — it must still land in the preparation-error family.
    const original = new SyntaxError("Unexpected token < in JSON");
    const client = throwingClient(original);

    await expect(uploadFile(client, new Uint8Array([1]))).rejects.toBeInstanceOf(
      UploadTransportError,
    );
    await expect(uploadFile(client, new Uint8Array([1]))).rejects.toMatchObject({
      cause: original,
    });
  });
});
