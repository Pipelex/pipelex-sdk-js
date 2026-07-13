/**
 * Local type shim for `@pipelex/tools-wasm` while the package is unpublished.
 *
 * The hook bundle resolves the real module at build time via an esbuild alias
 * pointing at the sibling checkout (`../vscode-pipelex/js/tools-wasm`); this
 * declaration lets `tsc` typecheck the hook source on machines without that
 * checkout. It mirrors the package's public surface (`dist/index.d.ts`) —
 * ⚠️ PUBLIC BINDING SURFACE, keep in sync. Delete this shim and add the npm
 * devDependency once `@pipelex/tools-wasm` is published.
 */
declare module "@pipelex/tools-wasm" {
  export type DiagnosticKind = "syntax" | "semantic" | "schema";

  export interface DiagnosticRange {
    start_offset: number;
    end_offset: number;
    start_line: number;
    start_col: number;
    end_line: number;
    end_col: number;
  }

  export interface Diagnostic {
    kind: DiagnosticKind;
    severity: string;
    message: string;
    location: string | null;
    range: DiagnosticRange | null;
  }

  export interface LintResult {
    diagnostics: Diagnostic[];
  }

  export interface FormatResult {
    formatted: string;
    changed: boolean;
    diagnostics: Diagnostic[];
  }

  export type FormatMthdsOptions = Record<string, string | number | boolean>;

  export function initialize(): Promise<void>;
  export function lintMthds(content: string): LintResult;
  export function formatMthds(content: string, options?: FormatMthdsOptions): FormatResult;
}
