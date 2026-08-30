/**
 * Type declaration for the PDF.js worker module.
 *
 * pdfjs-dist ships types for its main entry but not for the worker bundle, so
 * importing it is otherwise an implicit-`any` error under `strict`.
 *
 * The shape is narrowed to the one thing PDF.js actually looks for on that
 * module: its fake-worker path reads
 * `globalThis.pdfjsWorker.WorkerMessageHandler`. Declaring the module as a bare
 * `any` would compile equally well and tell a reader nothing about why the
 * import exists - see resume-parser/pdf/extract.ts for the full explanation.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: {
    setup(handler: unknown, port: unknown): void;
  };
}
