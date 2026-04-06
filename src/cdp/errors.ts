export class CDPError extends Error { constructor(msg: string) { super(msg); this.name = 'CDPError'; } }
export class CDPTimeoutError extends CDPError { constructor(msg = 'Timeout') { super(msg); this.name = 'CDPTimeoutError'; } }
export class CDPNavigationError extends CDPError { constructor(msg: string) { super(msg); this.name = 'CDPNavigationError'; } }
export class CDPTargetClosedError extends CDPError { constructor(msg = 'Target closed') { super(msg); this.name = 'CDPTargetClosedError'; } }
