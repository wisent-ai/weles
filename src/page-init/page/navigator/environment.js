// Environment signals beyond the navigator surface: timezone, plugins,
// connection, Bluetooth and keyboard presence, and the Intl locale. Loaded
// right after navigator.js by src/page-init/loader.ts; both read the same
// __weles and the same window.__welesDefine helper. The WebRTC leak guard is
// navigator/webrtc.js, loaded on every launch path. A patch that cannot
// install itself says so under the page-init failure marker Weles reads
// (src/page-init/failures.ts).

// --- Timezone ---
if (__weles.timezone && __weles.timezone.offset !== undefined) {
  const offset = __weles.timezone.offset;
  const tzFn = function () {
    return offset;
  };
  if (window.__welesNativeString)
    window.__welesNativeString(tzFn, 'getTimezoneOffset');
  Date.prototype.getTimezoneOffset = tzFn;
}

// --- navigator.plugins: include 'PDF Viewer' first ---
// PerimeterX bda diff (weles vs stock Chrome on linkedin.com/login) showed
// weles emits [Chrome PDF Viewer, Chromium PDF Viewer, ...]; real Chrome
// emits [PDF Viewer, Chrome PDF Viewer, Chromium PDF Viewer, ...]. PX serializes
// the plugin name list into the encrypted bda payload.
(function patchPlugins() {
  if (
    typeof navigator === 'undefined' ||
    typeof Plugin === 'undefined' ||
    typeof PluginArray === 'undefined'
  )
    return;
  try {
    const mt0 = {
      type: 'application/pdf',
      suffixes: 'pdf',
      description: 'Portable Document Format',
    };
    const mt1 = {
      type: 'text/pdf',
      suffixes: 'pdf',
      description: 'Portable Document Format',
    };
    const names =
      'PDF Viewer,Chrome PDF Viewer,Chromium PDF Viewer,Microsoft Edge PDF Viewer,WebKit built-in PDF'.split(
        ',',
      );
    // Each PDF plugin lists the same MIME types, indexed in order with its
    // length, as Chrome's PluginArray entries do.
    const mimeTypes = [mt0, mt1];
    const plugins = names.map((name) => {
      const p = Object.create(Plugin.prototype);
      Object.defineProperties(p, {
        name: { value: name, enumerable: true },
        filename: { value: 'internal-pdf-viewer', enumerable: true },
        description: { value: 'Portable Document Format', enumerable: true },
        length: { value: mimeTypes.length, enumerable: true },
      });
      mimeTypes.forEach((mimeType, index) =>
        Object.defineProperty(p, index, { value: mimeType, enumerable: true }),
      );
      return p;
    });
    const arr = Object.create(PluginArray.prototype);
    plugins.forEach((p, i) =>
      Object.defineProperty(arr, i, { value: p, enumerable: true }),
    );
    Object.defineProperty(arr, 'length', {
      value: plugins.length,
      enumerable: true,
    });
    const pluginsGet = function () {
      return arr;
    };
    if (window.__welesNativeString)
      window.__welesNativeString(pluginsGet, 'get plugins');
    Object.defineProperty(navigator, 'plugins', {
      get: pluginsGet,
      configurable: true,
      enumerable: true,
    });
  } catch (error) {
    console.debug(
      '__weles_page_init_failure__',
      JSON.stringify({
        patch: 'plugins',
        error: String((error && error.message) || error),
      }),
    );
  }
})();

// --- navigator.connection: the figures the device profile declares ---
// The network figures a page reads (downlink, effectiveType, rtt, saveData)
// come from the generated device's navigator.connection, so they agree with
// the rest of the emulated device. A profile that declares none leaves the
// browser's own figures and says so under the page-init failure marker.
(function patchConnection() {
  if (typeof navigator === 'undefined' || !navigator.connection) return;
  const declared = __weles.navigator && __weles.navigator.connection;
  if (!declared || typeof declared !== 'object') {
    console.debug(
      '__weles_page_init_failure__',
      JSON.stringify({
        patch: 'connection',
        error:
          'the device profile declares no navigator.connection figures; the browser reports its own',
      }),
    );
    return;
  }
  const apply = (target) => {
    for (const [name, value] of Object.entries(declared)) {
      const getter = function () {
        return value;
      };
      if (window.__welesNativeString)
        window.__welesNativeString(getter, 'get ' + name);
      Object.defineProperty(target, name, {
        get: getter,
        configurable: true,
        enumerable: true,
      });
    }
  };
  // Both the instance and its prototype: some code reads the getters off the
  // instance, and an iframe's NetworkInformation inherits from the prototype.
  try {
    apply(navigator.connection);
    apply(Object.getPrototypeOf(navigator.connection));
  } catch (error) {
    console.debug(
      '__weles_page_init_failure__',
      JSON.stringify({
        patch: 'connection',
        error: String((error && error.message) || error),
      }),
    );
  }
})();

// --- navigator.bluetooth / navigator.keyboard stubs ---
// Real Chrome 147 exposes Web Bluetooth + Keyboard Lock APIs on navigator.
// weles' chromium-build may compile without them depending on build flags;
// PerimeterX checks 'bluetooth' in navigator and 'keyboard' in navigator and
// flags absence as bot. Expose minimal objects matching real-Chrome shape;
// the methods are getter-only and never called by PX (it just probes presence).
(function exposeBluetoothKeyboard() {
  if (typeof navigator === 'undefined') return;
  try {
    if (!('bluetooth' in navigator)) {
      const bluetooth = Object.create(null);
      Object.defineProperty(bluetooth, 'getAvailability', {
        value: function () {
          return Promise.resolve(false);
        },
        configurable: false,
        enumerable: false,
      });
      Object.defineProperty(bluetooth, 'requestDevice', {
        value: function () {
          return Promise.reject(
            new DOMException(
              'Web Bluetooth API globally disabled.',
              'NotFoundError',
            ),
          );
        },
        configurable: false,
        enumerable: false,
      });
      const btGet = function () {
        return bluetooth;
      };
      if (window.__welesNativeString)
        window.__welesNativeString(btGet, 'get bluetooth');
      Object.defineProperty(navigator, 'bluetooth', {
        get: btGet,
        configurable: true,
        enumerable: true,
      });
    }
    if (!('keyboard' in navigator)) {
      const keyboard = Object.create(null);
      Object.defineProperty(keyboard, 'getLayoutMap', {
        value: function () {
          return Promise.resolve(new Map());
        },
        configurable: false,
        enumerable: false,
      });
      Object.defineProperty(keyboard, 'lock', {
        value: function () {
          return Promise.resolve(undefined);
        },
        configurable: false,
        enumerable: false,
      });
      Object.defineProperty(keyboard, 'unlock', {
        value: function () {
          return undefined;
        },
        configurable: false,
        enumerable: false,
      });
      const kbGet = function () {
        return keyboard;
      };
      if (window.__welesNativeString)
        window.__welesNativeString(kbGet, 'get keyboard');
      Object.defineProperty(navigator, 'keyboard', {
        get: kbGet,
        configurable: true,
        enumerable: true,
      });
    }
  } catch (error) {
    console.debug(
      '__weles_page_init_failure__',
      JSON.stringify({
        patch: 'bluetooth-keyboard',
        error: String((error && error.message) || error),
      }),
    );
  }
})();

// --- Intl locale ---
// Real Chrome's Intl.DateTimeFormat().resolvedOptions().locale ALWAYS matches
// navigator.language. ICU pulls from the same setting. weles can spoof
// navigator.language but Chromium's --lang flag doesn't always cascade to ICU
// (especially under xvfb-run on Linux, where the system locale leaks through).
// Force the locale to match navigator.language so PerimeterX/Akamai/DataDome
// don't see an en-US navigator with an en-GB Intl resolvedOptions.locale.
if (__weles.navigator && __weles.navigator.language) {
  const wantedLocale = __weles.navigator.language;
  const regNS = window.__welesNativeString;
  const orig = Intl.DateTimeFormat.prototype.resolvedOptions;
  const dtf = function () {
    const r = orig.call(this);
    return { ...r, locale: wantedLocale };
  };
  if (regNS) regNS(dtf, 'resolvedOptions');
  Intl.DateTimeFormat.prototype.resolvedOptions = dtf;
  if (Intl.NumberFormat?.prototype?.resolvedOptions) {
    const o = Intl.NumberFormat.prototype.resolvedOptions;
    const nf = function () {
      const r = o.call(this);
      return { ...r, locale: wantedLocale };
    };
    if (regNS) regNS(nf, 'resolvedOptions');
    Intl.NumberFormat.prototype.resolvedOptions = nf;
  }
  if (Intl.Collator?.prototype?.resolvedOptions) {
    const o = Intl.Collator.prototype.resolvedOptions;
    const cl = function () {
      const r = o.call(this);
      return { ...r, locale: wantedLocale };
    };
    if (regNS) regNS(cl, 'resolvedOptions');
    Intl.Collator.prototype.resolvedOptions = cl;
  }
}
