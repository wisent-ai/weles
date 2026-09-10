/** Types for the release judgements, which are authored as ES modules. */

export type SurfaceReport = {
  surface: string[];
  version: string;
};

export type VersionVerdict = {
  schema: 'weles.version-verdict.v1';
  released: string;
  declared: string;
  change: string;
  required: string;
  breakingDeclared: boolean;
  added: string[];
  removed: string[];
};

export type VersionInputs = {
  decision: { current: string; change: string; next: string; added: string[]; removed: string[] };
  baseline: { version: string };
  declaration: { schema: string; breaking: boolean; reason: string; current: string; candidate: string };
  manifest: { version: string };
};

export type ManifestVerdict = {
  schema: string;
  deploymentId: string;
  sourceRevision: string;
  sha256: string;
};

export function repositoryRoot(): string;
export function surface(root?: string): Promise<SurfaceReport>;
export function enforceVersion(inputs: VersionInputs): VersionVerdict;
export function validateCandidateManifest(request: {
  manifestPath: string;
  sourceRevision: string;
  candidateTag: string;
}): Promise<ManifestVerdict>;
export function readVersionInputs(paths: {
  decision: string;
  baseline: string;
  declaration: string;
  manifest: string;
}): Promise<VersionInputs>;
