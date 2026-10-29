// --- OS-consistent navigator surface stubs, continued from surface.js ---
// The loader runs this right after navigator/surface.js: permissions,
// mediaCapabilities, gpu and maxTouchPoints, each matched to the target OS.
(function installNavigatorApiStubs() {
  try {
    const nav = __weles.navigator;
    const scr = __weles.screen;
    const targetOs = (nav.platform || '').toLowerCase().includes('mac')
      ? 'macos'
      : (nav.platform || '').toLowerCase().includes('win')
        ? 'windows'
        : 'linux';
    const regNS = window.__welesNativeString;
    const define = window.__welesDefine;

    // 3. navigator.permissions — real browsers expose a Permissions object with
    // query(). Empty {} is a bot tell.
    (function stubPermissions() {
      if (typeof navigator === 'undefined') return;
      try {
        const perms = Object.create(
          typeof Permissions !== 'undefined'
            ? Permissions.prototype
            : Object.prototype,
        );
        Object.defineProperties(perms, {
          query: {
            value: function (p) {
              const name = typeof p === 'string' ? p : p?.name;
              if (name === 'notifications')
                return Promise.resolve({ state: 'prompt', onchange: null });
              if (name === 'clipboard-read' || name === 'clipboard-write')
                return Promise.resolve({ state: 'prompt', onchange: null });
              if (name === 'geolocation')
                return Promise.resolve({ state: 'prompt', onchange: null });
              return Promise.resolve({ state: 'prompt', onchange: null });
            },
            configurable: true,
            enumerable: true,
          },
          addEventListener: {
            value: function () {},
            configurable: true,
            enumerable: true,
          },
          removeEventListener: {
            value: function () {},
            configurable: true,
            enumerable: true,
          },
        });
        const getPerms = function () {
          return perms;
        };
        if (regNS) regNS(getPerms, 'get permissions');
        Object.defineProperty(Navigator.prototype, 'permissions', {
          get: getPerms,
          configurable: true,
          enumerable: true,
        });
        try {
          Object.defineProperty(navigator, 'permissions', {
            get: getPerms,
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
      } catch {
        /* leave native permissions */
      }
    })();

    // 4. navigator.mediaCapabilities — real browsers expose MediaCapabilities
    // with decodingInfo/encodingInfo. Empty {} is a bot tell.
    (function stubMediaCapabilities() {
      if (typeof navigator === 'undefined') return;
      try {
        const caps = Object.create(
          typeof MediaCapabilities !== 'undefined'
            ? MediaCapabilities.prototype
            : Object.prototype,
        );
        Object.defineProperties(caps, {
          decodingInfo: {
            value: function () {
              return Promise.resolve({
                supported: false,
                smooth: false,
                powerEfficient: false,
              });
            },
            configurable: true,
            enumerable: true,
          },
          encodingInfo: {
            value: function () {
              return Promise.resolve({
                supported: false,
                smooth: false,
                powerEfficient: false,
              });
            },
            configurable: true,
            enumerable: true,
          },
        });
        const getCaps = function () {
          return caps;
        };
        if (regNS) regNS(getCaps, 'get mediaCapabilities');
        Object.defineProperty(Navigator.prototype, 'mediaCapabilities', {
          get: getCaps,
          configurable: true,
          enumerable: true,
        });
        try {
          Object.defineProperty(navigator, 'mediaCapabilities', {
            get: getCaps,
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
      } catch {
        /* leave native mediaCapabilities */
      }
    })();

    // 5. navigator.gpu — WebGPU adapter request. Empty {} is a bot tell.
    (function stubGpu() {
      if (typeof navigator === 'undefined') return;
      try {
        const gpu = Object.create(
          typeof GPU !== 'undefined' ? GPU.prototype : Object.prototype,
        );
        Object.defineProperties(gpu, {
          requestAdapter: {
            value: function () {
              return Promise.resolve(null);
            },
            configurable: true,
            enumerable: true,
          },
          getPreferredCanvasFormat: {
            value: function () {
              return 'rgba8unorm';
            },
            configurable: true,
            enumerable: true,
          },
          wgslLanguageFeatures: {
            value: {
              size: 0,
              has: function () {
                return false;
              },
              keys: function () {
                return [];
              },
              values: function () {
                return [];
              },
              entries: function () {
                return [];
              },
              forEach: function () {},
            },
            configurable: true,
            enumerable: true,
          },
        });
        const getGpu = function () {
          return gpu;
        };
        if (regNS) regNS(getGpu, 'get gpu');
        Object.defineProperty(Navigator.prototype, 'gpu', {
          get: getGpu,
          configurable: true,
          enumerable: true,
        });
        try {
          Object.defineProperty(navigator, 'gpu', {
            get: getGpu,
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
      } catch {
        /* leave native gpu */
      }
    })();

    // 6. maxTouchPoints consistency — Windows desktop should report 0 unless
    // the persona explicitly wants a touchscreen. Linux/macOS can stay at the
    // native value, but if the config value looks wrong for a desktop OS,
    // force it to 0.
    if (
      nav.maxTouchPoints !== undefined &&
      (targetOs === 'windows' || targetOs === 'linux') &&
      nav.maxTouchPoints > 0
    ) {
      const isDesktopScreen = scr && (scr.width || 0) >= 1024;
      if (isDesktopScreen) {
        const val = 0;
        define(Navigator.prototype, 'maxTouchPoints', function () {
          return val;
        });
      }
    }
  } catch {}
})();
