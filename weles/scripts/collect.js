// Collect all browser fingerprint signals for diagnostics.
// Returns a JSON-serializable object with everything anti-bot systems can see.

function __welesCollectEnvironment() {
  const env = {};

  // Navigator
  const nav = {};
  const navProps = [
    'userAgent', 'appVersion', 'platform', 'vendor', 'product',
    'productSub', 'language', 'languages', 'hardwareConcurrency',
    'deviceMemory', 'maxTouchPoints', 'cookieEnabled', 'doNotTrack',
    'webdriver', 'pdfViewerEnabled', 'connection'
  ];
  for (const p of navProps) {
    try {
      const v = navigator[p];
      nav[p] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
    } catch(e) { nav[p] = 'ERROR: ' + e.message; }
  }
  try { nav.plugins = Array.from(navigator.plugins).map(p => p.name); } catch(e) {}
  try { nav.mimeTypes = Array.from(navigator.mimeTypes).map(m => m.type); } catch(e) {}
  env.navigator = nav;

  // Screen & window
  env.screen = {
    width: screen.width, height: screen.height,
    availWidth: screen.availWidth, availHeight: screen.availHeight,
    colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
    devicePixelRatio: window.devicePixelRatio,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    outerWidth: window.outerWidth, outerHeight: window.outerHeight,
  };

  // WebGL
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      env.webgl = {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        version: gl.getParameter(gl.VERSION),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        extensions: gl.getSupportedExtensions(),
      };
    }
  } catch(e) { env.webgl = 'ERROR: ' + e.message; }

  // Canvas fingerprint
  try {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 50;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top'; ctx.font = '14px Arial';
    ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069'; ctx.fillText('fingerprint', 2, 15);
    ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.fillText('fingerprint', 4, 17);
    env.canvas = { dataURL: c.toDataURL().substring(0, 100) + '...' };
  } catch(e) { env.canvas = 'ERROR: ' + e.message; }

  // AudioContext
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    env.audio = {
      sampleRate: ac.sampleRate, state: ac.state,
      baseLatency: ac.baseLatency, outputLatency: ac.outputLatency,
      channelCount: ac.destination.channelCount,
      maxChannelCount: ac.destination.maxChannelCount,
    };
    ac.close();
  } catch(e) { env.audio = 'ERROR: ' + e.message; }

  // Fonts
  try {
    const baseFonts = ['monospace', 'sans-serif', 'serif'];
    const testFonts = [
      'Arial', 'Courier New', 'Georgia', 'Helvetica', 'Times New Roman',
      'Verdana', 'Comic Sans MS', 'Impact', 'Lucida Console',
      'Trebuchet MS', 'Palatino Linotype', 'Segoe UI',
    ];
    const span = document.createElement('span');
    span.style.fontSize = '72px'; span.style.position = 'absolute';
    span.style.left = '-9999px'; span.textContent = 'mmmmmmmmmmlli';
    document.body.appendChild(span);
    const baseWidths = {};
    for (const bf of baseFonts) { span.style.fontFamily = bf; baseWidths[bf] = span.offsetWidth; }
    const detected = [];
    for (const tf of testFonts) {
      for (const bf of baseFonts) {
        span.style.fontFamily = '"' + tf + '",' + bf;
        if (span.offsetWidth !== baseWidths[bf]) { detected.push(tf); break; }
      }
    }
    document.body.removeChild(span);
    env.fonts = detected;
  } catch(e) { env.fonts = 'ERROR: ' + e.message; }

  // WebRTC
  try {
    env.webrtc = {
      RTCPeerConnection: !!window.RTCPeerConnection,
      RTCDataChannel: !!window.RTCDataChannel,
      RTCSessionDescription: !!window.RTCSessionDescription,
    };
  } catch(e) { env.webrtc = 'ERROR: ' + e.message; }

  // Timezone & locale
  env.timezone = {
    offset: new Date().getTimezoneOffset(),
    name: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  };

  // Features
  env.features = {
    serviceWorker: 'serviceWorker' in navigator,
    webgl2: !!window.WebGL2RenderingContext,
    sharedWorker: !!window.SharedWorker,
    indexedDB: !!window.indexedDB,
    openDatabase: !!window.openDatabase,
    cpuClass: navigator.cpuClass, oscpu: navigator.oscpu,
    buildID: navigator.buildID,
    notification: !!window.Notification,
    bluetooth: !!navigator.bluetooth, usb: !!navigator.usb,
    serial: !!navigator.serial, hid: !!navigator.hid,
    credentials: !!navigator.credentials, storage: !!navigator.storage,
  };

  // Automation signals
  env.automation = {
    webdriver: navigator.webdriver,
    __webdriver_script_fn: !!window.__webdriver_script_fn,
    domAutomation: !!window.domAutomation,
    domAutomationController: !!window.domAutomationController,
    _phantom: !!window._phantom, callPhantom: !!window.callPhantom,
    __nightmare: !!window.__nightmare, _selenium: !!window._selenium,
    __fxdriver_unwrapped: !!window.__fxdriver_unwrapped,
    __driver_evaluate: !!window.__driver_evaluate,
    __webdriver_evaluate: !!window.__webdriver_evaluate,
  };

  return env;
}
