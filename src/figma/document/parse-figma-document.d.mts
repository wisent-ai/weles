/**
 * The one parse of a Figma document, run by `weles design export-assets
 * --provider figma` and by `weles design parse-document --provider figma`.
 */

/** The paths `weles design parse-document` needs before the optional vocabulary. */
export declare const REQUIRED_PATHS: number;

/**
 * Parse `source` (JSON, or gzipped JSON when it ends in `.gz`) and write the
 * summary and the node index, and the vocabulary when `vocabularyPath` is
 * given.
 */
export declare function parseFigmaDocument(
  source: string,
  summaryPath: string,
  nodesPath: string,
  vocabularyPath?: string,
): void;
