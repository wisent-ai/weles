// The parts of a browser page the credential capture reads: its pages, their
// frames, and the elements a credential may be shown in.

export type CredentialElement = {
  evaluate: <Value>(
    pageFunction: (element: Element) => Value,
  ) => Promise<Value>;
};

export type CredentialLocator = {
  all: () => Promise<CredentialElement[]>;
};

export type CredentialFrame = {
  url: () => string;
  locator: (selector: string) => CredentialLocator;
  getByLabel: (text: string, options: { exact: boolean }) => CredentialLocator;
  getByRole: (role: string, options: { name: string }) => CredentialLocator;
};

export type CredentialPage = {
  url: () => string;
  frames: () => CredentialFrame[];
  context?: () => { pages: () => CredentialPage[] };
};
