(function pageProxyBootstrap() {
  const REQUEST_TYPE = "MS_GSM_GOOGLE_AUDIO_REQUEST";
  const RESPONSE_TYPE = "MS_GSM_GOOGLE_AUDIO_RESPONSE";
  const pending = new Map();
  let nextRequestId = 1;
  const nativeFetch = window.fetch.bind(window);

  installBridge();
  patchAudioConstructor();
  patchMediaSrcSetters();
  patchFetch();
  patchXmlHttpRequest();

  function installBridge() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) {
        return;
      }

      const data = event.data;
      if (!data || data.type !== RESPONSE_TYPE || typeof data.requestId !== "number") {
        return;
      }

      const callback = pending.get(data.requestId);
      if (!callback) {
        return;
      }

      pending.delete(data.requestId);

      if (data.ok) {
        callback.resolve(data.result);
      } else {
        callback.reject(new Error(data.error || "Unknown probe error."));
      }
    });
  }

  function patchAudioConstructor() {
    const NativeAudio = window.Audio;
    window.Audio = function PatchedAudio(src) {
      const audio = new NativeAudio();
      if (typeof src === "string") {
        setAudioSource(audio, src);
      }
      return audio;
    };
    window.Audio.prototype = NativeAudio.prototype;
  }

  function patchMediaSrcSetters() {
    patchSrcSetter(HTMLMediaElement.prototype);
    patchSrcSetter(HTMLSourceElement.prototype);

    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function patchedSetAttribute(name, value) {
      if (
        name.toLowerCase() !== "src" ||
        typeof value !== "string" ||
        !isMediaSourceElement(this) ||
        !shouldProbeUrl(value)
      ) {
        return originalSetAttribute.call(this, name, value);
      }

      probeUrl(value).then((result) => {
        if (result?.kind === "decoded") {
          originalSetAttribute.call(this, name, result.objectUrl);
          if (this instanceof HTMLSourceElement) {
            this.parentElement?.load?.();
          }
          return;
        }

        originalSetAttribute.call(this, name, value);
      }).catch(() => {
        originalSetAttribute.call(this, name, value);
      });
    };
  }

  function patchSrcSetter(prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "src");
    if (!descriptor?.get || !descriptor?.set) {
      return;
    }

    Object.defineProperty(prototype, "src", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        return descriptor.get.call(this);
      },
      set(value) {
        if (typeof value !== "string" || !shouldProbeUrl(value)) {
          descriptor.set.call(this, value);
          return;
        }

        probeUrl(value).then((result) => {
          descriptor.set.call(this, result?.kind === "decoded" ? result.objectUrl : value);
          if (this instanceof HTMLSourceElement) {
            this.parentElement?.load?.();
          }
        }).catch(() => {
          descriptor.set.call(this, value);
        });
      }
    });
  }

  function patchFetch() {
    const originalFetch = window.fetch;

    window.fetch = async function patchedFetch(input, init) {
      const request = input instanceof Request ? input : null;
      const method = String(request?.method || init?.method || "GET").toUpperCase();
      const url = normalizeUrl(input instanceof Request ? input.url : input);

      if (method !== "GET" || !shouldProbeFetch(url, request, init)) {
        return originalFetch.call(this, input, init);
      }

      const result = await probeUrl(url);
      if (result?.kind !== "decoded") {
        return nativeFetch(input, init);
      }

      return new Response(result.blob.slice(0, result.blob.size, result.mimeType), {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": result.mimeType,
          "content-length": String(result.blob.size)
        }
      });
    };
  }

  function patchXmlHttpRequest() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, async = true, username, password) {
      this.__msGsmGoogleAudio = {
        method: String(method || "GET").toUpperCase(),
        url: normalizeUrl(url),
        async
      };
      return originalOpen.call(this, method, url, async, username, password);
    };

    XMLHttpRequest.prototype.send = function patchedSend(body) {
      const details = this.__msGsmGoogleAudio;
      if (!details || details.method !== "GET" || !details.async || !shouldProbeUrl(details.url)) {
        return originalSend.call(this, body);
      }

      probeUrl(details.url).then((result) => {
        if (result?.kind !== "decoded") {
          originalSend.call(this, body);
          return;
        }

        fulfillDecodedXhr(this, result);
      }).catch(() => {
        originalSend.call(this, body);
      });
    };
  }

  function fulfillDecodedXhr(xhr, result) {
    Promise.all([result.blob.arrayBuffer(), result.blob.text()]).then(([arrayBuffer, text]) => {
      defineValue(xhr, "readyState", 4);
      defineValue(xhr, "status", 200);
      defineValue(xhr, "statusText", "OK");
      defineValue(xhr, "responseURL", result.objectUrl);

      const responseType = xhr.responseType || "";
      if (responseType === "arraybuffer") {
        defineValue(xhr, "response", arrayBuffer);
      } else if (responseType === "blob") {
        defineValue(xhr, "response", result.blob);
      } else {
        defineValue(xhr, "response", text);
        defineValue(xhr, "responseText", text);
      }

      xhr.getAllResponseHeaders = () => `content-type: ${result.mimeType}\r\ncontent-length: ${result.blob.size}`;
      xhr.getResponseHeader = (name) => {
        const normalized = String(name).toLowerCase();
        if (normalized === "content-type") {
          return result.mimeType;
        }
        if (normalized === "content-length") {
          return String(result.blob.size);
        }
        return null;
      };

      xhr.dispatchEvent(new ProgressEvent("readystatechange"));
      xhr.dispatchEvent(new ProgressEvent("loadstart"));
      xhr.dispatchEvent(new ProgressEvent("progress", { lengthComputable: true, loaded: result.blob.size, total: result.blob.size }));
      xhr.dispatchEvent(new ProgressEvent("load"));
      xhr.dispatchEvent(new ProgressEvent("loadend"));
    }).catch(() => {
      xhr.dispatchEvent(new ProgressEvent("error"));
      xhr.dispatchEvent(new ProgressEvent("loadend"));
    });
  }

  function setAudioSource(audio, src) {
    if (!shouldProbeUrl(src)) {
      audio.src = src;
      return;
    }

    probeUrl(src).then((result) => {
      audio.src = result?.kind === "decoded" ? result.objectUrl : src;
    }).catch(() => {
      audio.src = src;
    });
  }

  function isMediaSourceElement(element) {
    return element instanceof HTMLMediaElement || element instanceof HTMLSourceElement;
  }

  function probeUrl(url) {
    const normalizedUrl = normalizeUrl(url);
    const requestId = nextRequestId++;

    return fetchBufferForProbe(normalizedUrl).then((buffer) => {
      const promise = new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
      });

      window.postMessage({
        type: REQUEST_TYPE,
        requestId,
        url: normalizedUrl,
        buffer
      }, "*");

      return promise;
    });
  }

  async function fetchBufferForProbe(url) {
    try {
      const response = await nativeFetch(url, {
        credentials: "include",
        cache: "default"
      });

      if (!response.ok) {
        return null;
      }

      return await response.arrayBuffer();
    } catch {
      return null;
    }
  }

  function shouldProbeFetch(url, request, init) {
    if (!shouldProbeUrl(url)) {
      return false;
    }

    const destination = request?.destination || "";
    if (destination === "audio") {
      return true;
    }

    const accept = findHeaderValue(request?.headers || init?.headers, "accept");
    if (typeof accept === "string" && accept.toLowerCase().includes("audio")) {
      return true;
    }

    return isLikelyGoogleAttachmentUrl(url);
  }

  function shouldProbeUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return isGoogleAttachmentHost(parsed.hostname);
    } catch {
      return false;
    }
  }

  function isGoogleAttachmentHost(hostname) {
    return hostname === "mail.google.com" ||
      hostname === "drive.google.com" ||
      hostname.endsWith(".googleusercontent.com") ||
      hostname.endsWith(".google.com");
  }

  function isLikelyGoogleAttachmentUrl(url) {
    const parsed = new URL(url, window.location.href);
    const path = parsed.pathname.toLowerCase();
    const full = `${path}?${parsed.searchParams.toString()}`.toLowerCase();

    return path.includes("/uc") ||
      path.includes("/attachment") ||
      path.includes("/download") ||
      path.includes("/open") ||
      full.includes("attid=") ||
      full.includes("view=att") ||
      full.includes("export=download") ||
      full.includes("mime=audio");
  }

  function findHeaderValue(headers, key) {
    if (!headers) {
      return null;
    }

    if (headers instanceof Headers) {
      return headers.get(key);
    }

    if (Array.isArray(headers)) {
      const match = headers.find(([name]) => String(name).toLowerCase() === key);
      return match ? match[1] : null;
    }

    if (typeof headers === "object") {
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === key) {
          return value;
        }
      }
    }

    return null;
  }

  function normalizeUrl(url) {
    return new URL(url, window.location.href).href;
  }

  function defineValue(target, name, value) {
    Object.defineProperty(target, name, {
      configurable: true,
      value
    });
  }
})();
