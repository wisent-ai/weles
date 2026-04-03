// WebGL vendor/renderer spoofing WITHOUT breaking WebGL contexts.
// Only intercepts parameter queries, not context creation.

if (__weles.webgl) {
  const wgl = __weles.webgl;

  // Debug renderer info extension constants
  const UNMASKED_VENDOR = 0x9245;   // UNMASKED_VENDOR_WEBGL
  const UNMASKED_RENDERER = 0x9246; // UNMASKED_RENDERER_WEBGL
  const VENDOR = 0x1F00;
  const RENDERER = 0x1F01;

  // Intercept getParameter on both WebGL1 and WebGL2
  for (const proto of [
    WebGLRenderingContext.prototype,
    ...(window.WebGL2RenderingContext ? [WebGL2RenderingContext.prototype] : []),
  ]) {
    const origGetParam = proto.getParameter;
    proto.getParameter = function(pname) {
      switch (pname) {
        case UNMASKED_VENDOR:
          return wgl.unmaskedVendor || wgl.vendor || origGetParam.call(this, pname);
        case UNMASKED_RENDERER:
          return wgl.unmaskedRenderer || wgl.renderer || origGetParam.call(this, pname);
        case VENDOR:
          return wgl.vendor || origGetParam.call(this, pname);
        case RENDERER:
          return wgl.renderer || origGetParam.call(this, pname);
        default:
          // For any configured parameter overrides
          if (wgl.parameters && wgl.parameters[String(pname)] !== undefined) {
            return wgl.parameters[String(pname)];
          }
          return origGetParam.call(this, pname);
      }
    };
    window._nativeOverrides && window._nativeOverrides.add(proto.getParameter);
  }

  // Intercept getSupportedExtensions if configured
  if (wgl.extensions) {
    const exts = wgl.extensions;
    for (const proto of [
      WebGLRenderingContext.prototype,
      ...(window.WebGL2RenderingContext ? [WebGL2RenderingContext.prototype] : []),
    ]) {
      const orig = proto.getSupportedExtensions;
      proto.getSupportedExtensions = function() {
        return exts;
      };
      window._nativeOverrides && window._nativeOverrides.add(proto.getSupportedExtensions);
    }
  }
}

// --- Canvas fingerprint noise ---
if (__weles.canvas && __weles.canvas.noiseSeed) {
  const seed = __weles.canvas.noiseSeed;
  function rng(s) {
    return function() {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rand = rng(seed);
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    const ctx = this.getContext('2d');
    if (ctx) {
      try {
        const id = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < Math.min(id.data.length, 40); i += 4)
          id.data[i] = Math.max(0, Math.min(255, id.data[i] + (rand() > 0.5 ? 1 : -1)));
        ctx.putImageData(id, 0, 0);
      } catch(e) {}
    }
    return origToDataURL.apply(this, arguments);
  };
}

// --- Audio fingerprint noise ---
if (__weles.audio && __weles.audio.noiseSeed && window.OfflineAudioContext) {
  const as = __weles.audio.noiseSeed;
  function arng(s) {
    return function() {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const arand = arng(as);
  const origRender = OfflineAudioContext.prototype.startRendering;
  OfflineAudioContext.prototype.startRendering = function() {
    return origRender.call(this).then(function(buf) {
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < Math.min(d.length, 100); i++)
          d[i] += (arand() - 0.5) * 0.0001;
      }
      return buf;
    });
  };
}
