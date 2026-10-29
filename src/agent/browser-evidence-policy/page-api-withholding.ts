// The init script every page of an evidence context is loaded with: the browser
// APIs a browser-evidence run may not reach at all. It is serialized into the
// page, so it carries its own helpers and reaches the host only through the
// __welesRecordWithheldEdge binding the context installs.
export function initScript(policyVersion: string): void {
  const messageOf = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  // A report the binding could not take leaves the ledger short of an edge the
  // page reached; it is written to the page console, which the run captures.
  const reportFailed = (api: string, error: unknown) =>
    console.error(
      `[weles] withheld ${api} was not recorded: ${messageOf(error)}`,
    );
  const report = (category: string, api: string, reason?: string) => {
    const record = (
      globalThis as unknown as {
        __welesRecordWithheldEdge?: (edge: unknown) => unknown;
      }
    ).__welesRecordWithheldEdge;
    if (typeof record !== 'function') {
      reportFailed(
        api,
        new Error('the __welesRecordWithheldEdge binding is not installed'),
      );
      return;
    }
    try {
      Promise.resolve(
        record({ category, api, reason, source: 'page_api' }),
      ).catch((error: unknown) => reportFailed(api, error));
    } catch (error) {
      reportFailed(api, error);
    }
  };
  const denied = () =>
    new DOMException(
      'Withheld by Weles browser-evidence policy',
      'NotAllowedError',
    );
  // A withholding the page refused to install leaves that API reachable; the
  // ledger records it as unenforced, with the page's reason, as a refusal the
  // network route could not deliver is, instead of the run carrying a policy
  // version that covers it.
  const withhold = (api: string, install: () => void) => {
    try {
      install();
    } catch (error) {
      report('page_api_unenforced', api, messageOf(error));
    }
  };
  const replace = (owner: object, name: string, value: unknown) =>
    Object.defineProperty(owner, name, { configurable: false, value });

  // Every method `owner`'s interface declares (its prototype's own functions),
  // replaced by one that records the call and rejects it.
  const denyMethods = (owner: unknown, category: string, prefix: string) => {
    // Only an object carries methods; an absent API has nothing to withhold.
    if (Object(owner) !== owner) return;
    const target = owner as Record<string, unknown>;
    const proto = Object.getPrototypeOf(target) as object | null;
    if (!proto) return;
    for (const method of Object.getOwnPropertyNames(proto)) {
      if (method === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, method);
      if (!descriptor || typeof descriptor.value !== 'function') continue;
      withhold(`${prefix}.${method}`, () =>
        replace(target, method, async () => {
          report(category, `${prefix}.${method}`);
          throw denied();
        }),
      );
    }
  };
  // The error a denied position request reports: a real GeolocationPositionError
  // (its prototype carries the code constants) with code PERMISSION_DENIED.
  const positionDenied = (): GeolocationPositionError =>
    Object.assign(Object.create(GeolocationPositionError.prototype), {
      code: GeolocationPositionError.PERMISSION_DENIED,
      message: denied().message,
    });
  const withheldClass = (category: string, api: string) =>
    class Withheld {
      constructor() {
        report(category, api);
        throw denied();
      }
    };

  withhold('permissions.query', () => {
    if (!navigator.permissions) return;
    replace(
      navigator.permissions,
      'query',
      (descriptor: PermissionDescriptor) => {
        const name =
          descriptor && descriptor.name
            ? String(descriptor.name)
            : '(no permission named)';
        report(
          name === 'notifications'
            ? 'notification_api'
            : 'browser_permission_api',
          `permissions.query:${name}`,
        );
        return Promise.resolve({
          state: 'denied',
          onchange: null,
        } as PermissionStatus);
      },
    );
  });

  withhold('Notification', () =>
    replace(
      globalThis,
      'Notification',
      class WithheldNotification {
        static get permission(): NotificationPermission {
          return 'denied';
        }
        static async requestPermission(): Promise<NotificationPermission> {
          report('notification_api', 'Notification.requestPermission');
          return 'denied';
        }
        constructor() {
          report('notification_api', 'new Notification');
          throw denied();
        }
      },
    ),
  );

  denyMethods(navigator.mediaDevices, 'browser_permission_api', 'mediaDevices');

  withhold('geolocation', () => {
    const geo = navigator.geolocation;
    if (!geo) return;
    replace(
      geo,
      'getCurrentPosition',
      (_success: PositionCallback, failure?: PositionErrorCallback) => {
        report('browser_permission_api', 'geolocation.getCurrentPosition');
        failure?.(positionDenied());
      },
    );
    replace(
      geo,
      'watchPosition',
      (_success: PositionCallback, failure?: PositionErrorCallback) => {
        report('browser_permission_api', 'geolocation.watchPosition');
        failure?.(positionDenied());
        // No watch was started; the id names none.
        return Number();
      },
    );
  });

  const navigatorCapabilities = navigator as unknown as Record<string, unknown>;
  denyMethods(navigator.clipboard, 'browser_permission_api', 'clipboard');
  for (const device of ['usb', 'serial', 'bluetooth', 'hid']) {
    denyMethods(
      navigatorCapabilities[device],
      'browser_permission_api',
      device,
    );
  }
  denyMethods(
    navigator.credentials,
    'authentication_submission',
    'credentials',
  );
  denyMethods(
    navigatorCapabilities.serviceWorker,
    'network_policy',
    'serviceWorker',
  );
  withhold('navigator.share', () => {
    if (typeof navigatorCapabilities.share !== 'function') return;
    replace(navigator, 'share', async () => {
      report('system_ui', 'navigator.share');
      throw denied();
    });
  });

  // The File System Access pickers (show…Picker) and every RTCPeerConnection
  // constructor the page's global object carries, by the names it gives them.
  const globals = Object.getOwnPropertyNames(globalThis);
  for (const picker of globals.filter(
    (name) => name.startsWith('show') && name.endsWith('Picker'),
  )) {
    withhold(picker, () => {
      if (
        typeof (globalThis as unknown as Record<string, unknown>)[picker] !==
        'function'
      )
        return;
      replace(globalThis, picker, async () => {
        report('system_ui', picker);
        throw denied();
      });
    });
  }
  for (const rtcName of globals.filter((name) =>
    name.endsWith('RTCPeerConnection'),
  )) {
    withhold(rtcName, () =>
      replace(globalThis, rtcName, withheldClass('network_policy', rtcName)),
    );
  }

  withhold('PaymentRequest', () =>
    replace(
      globalThis,
      'PaymentRequest',
      withheldClass('purchase_subscription_payment', 'PaymentRequest'),
    ),
  );
  withhold('window.open', () =>
    replace(globalThis, 'open', () => {
      report('system_ui', 'window.open');
      return null;
    }),
  );
  withhold('navigator.registerProtocolHandler', () =>
    replace(navigator, 'registerProtocolHandler', () => {
      report('system_ui', 'navigator.registerProtocolHandler');
      throw denied();
    }),
  );

  Object.defineProperty(globalThis, '__welesBrowserEvidencePolicyVersion', {
    configurable: false,
    enumerable: false,
    value: policyVersion,
    writable: false,
  });
}
