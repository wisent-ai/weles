/** Types for the baseline write-back, which is authored as an ES module. */

export type VersionDeclaration = {
  schema: 'weles.version-change.v1';
  current: string;
  candidate: string;
  breaking: boolean;
  reason: string;
};

export type AdoptedDocuments = {
  baseline: { surface: string[]; version: string; source: string };
  declaration: VersionDeclaration;
};
export type BaselineAdoption = {
  schema: 'weles.baseline-adoption.v1';
  baseline: string;
  declaration: string;
  previous: string | null;
  corrected: string | null;
  released: string;
  surfaceEntries: number;
};
export function adoptedDocuments(request: {
  publishedSurface: { surface?: unknown };
  released: string;
  reason: string;
  /** The published artifact the surface was read from, its first word a marker. */
  source: string;
  /** The version the baseline records, or null when there is no baseline. */
  recorded: string | null;
  correcting?: string;
}): AdoptedDocuments;
export function adoptBaseline(request: {
  publishedSurfacePath: string;
  released: string;
  reason: string;
  source: string;
  correcting?: string;
  root?: string;
  baselinePath?: string;
  declarationPath?: string;
}): Promise<BaselineAdoption>;
