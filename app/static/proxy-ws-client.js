(function () {
  const config = window.__QUEQIAO_PROXY__ || {};
  const statusEl = document.querySelector("#status");
  const stage = document.querySelector("#stage");
  const state = {
    socket: null,
    pending: new Map(),
    requestId: 0,
    objectUrls: [],
    currentUrl: config.initialUrl || "",
    idleTimer: 0,
    released: false,
  };
  const idleMs = Math.max(0, Number(config.idleSeconds || 0)) * 1000;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function connect() {
    return new Promise((resolve, reject) => {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
      state.socket = socket;

      socket.addEventListener("open", () => {
        resetIdleTimer();
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
      socket.addEventListener("close", () => {
        if (state.released) return;
        for (const entry of state.pending.values()) {
          entry.reject(new Error("WebSocket 连接已断开"));
        }
        state.pending.clear();
        document.body.classList.remove("loaded");
        setStatus("透传通道已断开，请刷新重试");
      });
      socket.addEventListener("message", (event) => {
        resetIdleTimer();
        const message = JSON.parse(event.data);
        const entry = state.pending.get(message.request_id);
        if (!entry) return;
        state.pending.delete(message.request_id);
        if (message.ok) {
          entry.resolve(message.payload);
        } else {
          entry.reject(new Error(message.error || "透传请求失败"));
        }
      });
    });
  }

  function send(action, payload) {
    resetIdleTimer();
    const requestId = ++state.requestId;
    state.socket.send(
      JSON.stringify({
        action,
        request_id: requestId,
        payload: { ...payload, token: config.token },
      })
    );
    return new Promise((resolve, reject) => {
      state.pending.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (!state.pending.has(requestId)) return;
        state.pending.delete(requestId);
        reject(new Error("透传请求超时"));
      }, 20000);
    });
  }

  function wsRequest(url, options = {}) {
    return send("proxy.ws_request", {
      id: config.linkId,
      url: url || "",
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body || null,
      body_base64: Boolean(options.bodyBase64),
    });
  }

  function cleanupObjectUrls() {
    for (const url of state.objectUrls) {
      URL.revokeObjectURL(url);
    }
    state.objectUrls = [];
  }

  function releaseProxyResources(reason) {
    if (state.released) return;
    state.released = true;
    clearTimeout(state.idleTimer);
    for (const entry of state.pending.values()) {
      entry.reject(new Error("透传资源已释放"));
    }
    state.pending.clear();
    cleanupObjectUrls();
    if (state.socket && state.socket.readyState <= WebSocket.OPEN) {
      state.socket.close(1000, "idle release");
    }
    if (stage) {
      stage.removeAttribute("src");
      stage.removeAttribute("srcdoc");
    }
    document.body.classList.remove("loaded");
    if (reason === "idle") {
      setStatus("透传空闲时间过长，资源已释放。刷新页面可重新连接");
    }
  }

  function resetIdleTimer() {
    if (!idleMs || state.released) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => releaseProxyResources("idle"), idleMs);
  }

  function bindActivity(target) {
    for (const name of ["pointerdown", "mousemove", "keydown", "wheel", "touchstart"]) {
      target.addEventListener(name, resetIdleTimer, { passive: true, capture: true });
    }
  }

  function trackObjectUrl(url) {
    state.objectUrls.push(url);
    return url;
  }

  function contentTypeBase(contentType) {
    return String(contentType || "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
  }

  function sameOriginDocumentBase() {
    return new URL(`/proxy-ws/${config.linkId}/virtual/`, window.location.origin).href;
  }

  function base64ToBytes(value) {
    const binary = atob(value || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function responseText(response) {
    if (response.base64) {
      return new TextDecoder("utf-8").decode(base64ToBytes(response.body));
    }
    return response.body || "";
  }

  function responseBlob(response) {
    const type = contentTypeBase(response.content_type);
    if (response.base64) {
      return new Blob([base64ToBytes(response.body)], { type });
    }
    return new Blob([response.body || ""], { type });
  }

  function blobUrlForResponse(response) {
    return trackObjectUrl(URL.createObjectURL(responseBlob(response)));
  }

  function shouldSkipUrl(value) {
    const text = String(value || "").trim();
    return (
      !text ||
      text.startsWith("#") ||
      /^(data|blob|javascript|mailto|tel):/i.test(text)
    );
  }

  function absoluteUrl(value, baseUrl) {
    if (shouldSkipUrl(value)) return "";
    try {
      return new URL(value, baseUrl || state.currentUrl || window.location.href).href;
    } catch {
      return "";
    }
  }

  async function resourceToBlobUrl(value, baseUrl, accept) {
    const url = absoluteUrl(value, baseUrl);
    if (!url) return "";
    const response = await wsRequest(url, { headers: { Accept: accept || "*/*" } });
    if (!response.ok) return "";
    return blobUrlForResponse(response);
  }

  async function processCss(css, baseUrl) {
    const pattern = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    const parts = [];
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(css)) !== null) {
      parts.push(css.slice(lastIndex, match.index));
      const rawUrl = match[2];
      const blobUrl = await resourceToBlobUrl(rawUrl, baseUrl);
      parts.push(blobUrl ? `url("${blobUrl}")` : match[0]);
      lastIndex = pattern.lastIndex;
    }
    parts.push(css.slice(lastIndex));
    return parts.join("");
  }

  async function inlineStylesheets(doc, baseUrl) {
    const links = [...doc.querySelectorAll('link[rel~="stylesheet"][href]')];
    for (const link of links) {
      const href = absoluteUrl(link.getAttribute("href"), baseUrl);
      if (!href) continue;
      try {
        const response = await wsRequest(href, { headers: { Accept: "text/css,*/*;q=0.1" } });
        if (!response.ok) continue;
        const style = doc.createElement("style");
        style.textContent = await processCss(responseText(response), response.url || href);
        if (link.media) style.media = link.media;
        link.replaceWith(style);
      } catch {
        continue;
      }
    }

    const styleTags = [...doc.querySelectorAll("style")];
    for (const style of styleTags) {
      style.textContent = await processCss(style.textContent || "", baseUrl);
    }
  }

  async function rewriteAttributeResources(doc, baseUrl) {
    const attrTargets = [
      ["img[src]", "src", "image/*,*/*;q=0.1"],
      ["source[src]", "src", "*/*"],
      ["video[src]", "src", "video/*,*/*;q=0.1"],
      ["video[poster]", "poster", "image/*,*/*;q=0.1"],
      ["audio[src]", "src", "audio/*,*/*;q=0.1"],
      ["embed[src]", "src", "*/*"],
      ["iframe[src]", "src", "text/html,*/*;q=0.1"],
      ["object[data]", "data", "*/*"],
      ['link[rel~="icon"][href]', "href", "image/*,*/*;q=0.1"],
      ['link[rel="apple-touch-icon"][href]', "href", "image/*,*/*;q=0.1"],
      ['link[rel~="preload"][href]', "href", "*/*"],
      ['link[rel~="modulepreload"][href]', "href", "text/javascript,application/javascript,*/*;q=0.1"],
      ['link[rel~="prefetch"][href]', "href", "*/*"],
      ['link[rel~="manifest"][href]', "href", "application/manifest+json,application/json,*/*;q=0.1"],
    ];

    for (const [selector, attr, accept] of attrTargets) {
      const nodes = [...doc.querySelectorAll(selector)];
      await Promise.all(
        nodes.map(async (node) => {
          const blobUrl = await resourceToBlobUrl(node.getAttribute(attr), baseUrl, accept);
          if (blobUrl) node.setAttribute(attr, blobUrl);
        })
      );
    }

    const srcsetNodes = [...doc.querySelectorAll("[srcset]")];
    await Promise.all(
      srcsetNodes.map(async (node) => {
        const srcset = node.getAttribute("srcset") || "";
        const entries = await Promise.all(
          srcset.split(",").map(async (entry) => {
            const trimmed = entry.trim();
            if (!trimmed) return "";
            const [urlPart, ...descriptor] = trimmed.split(/\s+/);
            const blobUrl = await resourceToBlobUrl(urlPart, baseUrl, "image/*,*/*;q=0.1");
            return [blobUrl || urlPart, ...descriptor].join(" ");
          })
        );
        node.setAttribute("srcset", entries.filter(Boolean).join(", "));
      })
    );

    const styledNodes = [...doc.querySelectorAll("[style]")];
    await Promise.all(
      styledNodes.map(async (node) => {
        node.setAttribute("style", await processCss(node.getAttribute("style") || "", baseUrl));
      })
    );
  }

  async function rewriteScripts(doc, baseUrl) {
    const scripts = [...doc.querySelectorAll("script[src]")];
    for (const script of scripts) {
      const src = absoluteUrl(script.getAttribute("src"), baseUrl);
      if (!src) continue;
      try {
        const response = await wsRequest(src, {
          headers: { Accept: "text/javascript,application/javascript,*/*;q=0.1" },
        });
        if (!response.ok) continue;
        script.src = blobUrlForResponse(response);
        script.removeAttribute("integrity");
        script.removeAttribute("crossorigin");
      } catch {
        continue;
      }
    }
  }

  function installRuntime(doc, baseUrl, localBaseUrl) {
    const script = doc.createElement("script");
    script.textContent = `
      (function () {
        var targetBaseUrl = ${JSON.stringify(baseUrl)};
        var localBaseUrl = ${JSON.stringify(localBaseUrl)};
        function absolute(value) {
          try { return new URL(value, targetBaseUrl).href; } catch (_) { return value; }
        }
        function shouldSkip(value) {
          var text = String(value || "").trim();
          return !text || text.charAt(0) === "#" || /^(data|blob|javascript|mailto|tel):/i.test(text);
        }
        document.addEventListener("click", function (event) {
          var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
          if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          var target = (anchor.getAttribute("target") || "").toLowerCase();
          if (target && target !== "_self") return;
          event.preventDefault();
          parent.postMessage({ type: "queqiao:navigate", url: absolute(anchor.getAttribute("href")) }, "*");
        }, true);
        document.addEventListener("submit", function (event) {
          var form = event.target;
          if (!form || !form.action) return;
          event.preventDefault();
          var method = (form.method || "GET").toUpperCase();
          var data = new URLSearchParams(new FormData(form)).toString();
          var url = absolute(form.getAttribute("action") || document.URL);
          if (method === "GET" && data) url += (url.indexOf("?") === -1 ? "?" : "&") + data;
          parent.postMessage({
            type: "queqiao:navigate",
            url: url,
            method: method,
            body: method === "GET" ? null : data,
            headers: method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }
          }, "*");
        }, true);
        var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
        var pending = new Map();
        var resourcePending = new Map();
        var xhrPending = new Map();
        var requestId = 0;
        function headersToObject(headers) {
          var result = {};
          if (!headers) return result;
          try { new Headers(headers).forEach(function (value, key) { result[key] = value; }); } catch (_) {}
          return result;
        }
        function bytesFromBase64(value) {
          var binary = atob(value || "");
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          return bytes;
        }
        function responseContent(response) {
          return response.base64 ? bytesFromBase64(response.body) : (response.body || "");
        }
        function blobUrlForResponse(response) {
          return URL.createObjectURL(new Blob([responseContent(response)], {
            type: response.content_type || "application/octet-stream"
          }));
        }
        if (nativeFetch) {
          window.fetch = function (input, init) {
            init = init || {};
            var url = typeof input === "string" ? input : input.url;
            var body = init.body || null;
            if (body && typeof body !== "string" && !(body instanceof URLSearchParams)) {
              return nativeFetch(input, init);
            }
            return new Promise(function (resolve, reject) {
              var id = ++requestId;
              pending.set(id, { resolve: resolve, reject: reject });
              parent.postMessage({
                type: "queqiao:fetch",
                requestId: id,
                url: absolute(url),
                method: init.method || (input.method || "GET"),
                headers: headersToObject(init.headers || input.headers),
                body: body ? String(body) : null
              }, "*");
            });
          };
        }
        if (window.XMLHttpRequest) {
          window.XMLHttpRequest = function () {
            this.readyState = 0;
            this.status = 0;
            this.statusText = "";
            this.response = null;
            this.responseText = "";
            this.responseType = "";
            this.responseURL = "";
            this.timeout = 0;
            this.withCredentials = false;
            this._headers = {};
            this._responseHeaders = {};
            this._listeners = document.createDocumentFragment();
          };
          window.XMLHttpRequest.UNSENT = 0;
          window.XMLHttpRequest.OPENED = 1;
          window.XMLHttpRequest.HEADERS_RECEIVED = 2;
          window.XMLHttpRequest.LOADING = 3;
          window.XMLHttpRequest.DONE = 4;
          window.XMLHttpRequest.prototype.addEventListener = function () {
            this._listeners.addEventListener.apply(this._listeners, arguments);
          };
          window.XMLHttpRequest.prototype.removeEventListener = function () {
            this._listeners.removeEventListener.apply(this._listeners, arguments);
          };
          window.XMLHttpRequest.prototype.dispatchEvent = function (event) {
            this._listeners.dispatchEvent(event);
            var handler = this["on" + event.type];
            if (typeof handler === "function") handler.call(this, event);
          };
          window.XMLHttpRequest.prototype._setReadyState = function (readyState) {
            this.readyState = readyState;
            this.dispatchEvent(new Event("readystatechange"));
          };
          window.XMLHttpRequest.prototype.open = function (method, url, async) {
            if (async === false) throw new Error("同步 XMLHttpRequest 不支持 WS 透传");
            this._method = method || "GET";
            this._url = absolute(url || "");
            this._setReadyState(1);
          };
          window.XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
            this._headers[key] = value;
          };
          window.XMLHttpRequest.prototype.getResponseHeader = function (key) {
            return this._responseHeaders[String(key || "").toLowerCase()] || null;
          };
          window.XMLHttpRequest.prototype.getAllResponseHeaders = function () {
            var lines = [];
            for (var key in this._responseHeaders) lines.push(key + ": " + this._responseHeaders[key]);
            return lines.join("\\r\\n");
          };
          window.XMLHttpRequest.prototype.abort = function () {
            this._aborted = true;
            this.dispatchEvent(new Event("abort"));
            this.dispatchEvent(new Event("loadend"));
          };
          window.XMLHttpRequest.prototype.send = function (body) {
            if (body && typeof body !== "string" && !(body instanceof URLSearchParams)) {
              throw new Error("此请求体类型暂不支持 WS 透传");
            }
            var id = ++requestId;
            xhrPending.set(id, this);
            parent.postMessage({
              type: "queqiao:fetch",
              requestId: id,
              url: this._url,
              method: this._method || "GET",
              headers: this._headers,
              body: body ? String(body) : null,
              xhr: true
            }, "*");
          };
        }
        function rewriteDynamicResource(node, attr, accept) {
          if (!node || !node.getAttribute || node.__queqiaoRewriting) return;
          var value = node.getAttribute(attr);
          if (shouldSkip(value)) return;
          var id = ++requestId;
          resourcePending.set(id, { node: node, attr: attr });
          parent.postMessage({
            type: "queqiao:resource",
            requestId: id,
            url: absolute(value),
            accept: accept || "*/*"
          }, "*");
        }
        function scanDynamicResources(root) {
          if (!root || !root.querySelectorAll) return;
          var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll("[src],[poster],link[href]")));
          nodes.forEach(function (node) {
            var tag = (node.tagName || "").toLowerCase();
            if (node.hasAttribute && node.hasAttribute("src")) {
              rewriteDynamicResource(
                node,
                "src",
                tag === "img" ? "image/*,*/*;q=0.1" :
                tag === "script" ? "text/javascript,application/javascript,*/*;q=0.1" :
                tag === "iframe" ? "text/html,*/*;q=0.1" : "*/*"
              );
            }
            if (node.hasAttribute && node.hasAttribute("poster")) {
              rewriteDynamicResource(node, "poster", "image/*,*/*;q=0.1");
            }
            if (tag === "link" && node.hasAttribute("href")) {
              var rel = (node.getAttribute("rel") || "").toLowerCase();
              if (
                rel.indexOf("stylesheet") !== -1 ||
                rel.indexOf("icon") !== -1 ||
                rel.indexOf("preload") !== -1 ||
                rel.indexOf("prefetch") !== -1 ||
                rel.indexOf("manifest") !== -1
              ) {
                rewriteDynamicResource(
                  node,
                  "href",
                  rel.indexOf("stylesheet") !== -1 ? "text/css,*/*;q=0.1" :
                  rel.indexOf("icon") !== -1 ? "image/*,*/*;q=0.1" : "*/*"
                );
              }
            }
          });
        }
        if (window.MutationObserver) {
          new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
              if (mutation.type === "childList") {
                Array.prototype.forEach.call(mutation.addedNodes, scanDynamicResources);
              } else if (mutation.type === "attributes") {
                scanDynamicResources(mutation.target);
              }
            });
          }).observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["src", "href", "poster"]
          });
        }
        window.addEventListener("message", function (event) {
          var message = event.data || {};
          if (message.type === "queqiao:fetch-result") {
            var xhr = xhrPending.get(message.requestId);
            if (xhr) {
              xhrPending.delete(message.requestId);
              if (xhr._aborted) return;
              if (!message.ok) {
                xhr.status = 0;
                xhr._setReadyState(4);
                xhr.dispatchEvent(new Event("error"));
                xhr.dispatchEvent(new Event("loadend"));
                return;
              }
              var xhrResponse = message.response || {};
              xhr.status = xhrResponse.status || 200;
              xhr.statusText = xhrResponse.ok === false ? "Error" : "OK";
              xhr.responseURL = xhrResponse.url || xhr._url;
              xhr._responseHeaders = {};
              var headers = xhrResponse.headers || {};
              Object.keys(headers).forEach(function (key) {
                xhr._responseHeaders[key.toLowerCase()] = headers[key];
              });
              xhr._setReadyState(2);
              xhr._setReadyState(3);
              var content = responseContent(xhrResponse);
              if (xhr.responseType === "blob") {
                xhr.response = new Blob([content], { type: xhrResponse.content_type || "application/octet-stream" });
              } else if (xhr.responseType === "arraybuffer") {
                xhr.response = content.buffer ? content.buffer.slice(0) : new TextEncoder().encode(String(content)).buffer;
              } else if (xhr.responseType === "json") {
                xhr.responseText = typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
                try { xhr.response = JSON.parse(xhr.responseText); } catch (_) { xhr.response = null; }
              } else {
                xhr.responseText = typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
                xhr.response = xhr.responseText;
              }
              xhr._setReadyState(4);
              xhr.dispatchEvent(new Event("load"));
              xhr.dispatchEvent(new Event("loadend"));
              return;
            }
            var entry = pending.get(message.requestId);
            if (!entry) return;
            pending.delete(message.requestId);
            if (!message.ok) {
              entry.reject(new Error(message.error || "透传请求失败"));
              return;
            }
            var response = message.response || {};
            entry.resolve(new Response(responseContent(response), {
              status: response.status || 200,
              headers: response.headers || { "Content-Type": response.content_type || "text/plain" }
            }));
          }
          if (message.type === "queqiao:resource-result") {
            var resource = resourcePending.get(message.requestId);
            if (!resource) return;
            resourcePending.delete(message.requestId);
            if (!message.ok || !message.response) return;
            resource.node.__queqiaoRewriting = true;
            resource.node.setAttribute(resource.attr, blobUrlForResponse(message.response));
            resource.node.__queqiaoRewriting = false;
          }
        });
      })();
    `;
    (doc.head || doc.documentElement).prepend(script);
  }

  function normalizeDocument(doc, localBaseUrl) {
    for (const meta of [...doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')]) {
      meta.remove();
    }
    const existingBase = doc.querySelector("base");
    if (existingBase) {
      existingBase.href = localBaseUrl;
    } else {
      const base = doc.createElement("base");
      base.href = localBaseUrl;
      (doc.head || doc.documentElement).prepend(base);
    }
  }

  async function processHtml(html, baseUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const localBaseUrl = sameOriginDocumentBase();
    normalizeDocument(doc, localBaseUrl);
    installRuntime(doc, baseUrl, localBaseUrl);
    await inlineStylesheets(doc, baseUrl);
    await rewriteAttributeResources(doc, baseUrl);
    await rewriteScripts(doc, baseUrl);
    return `<!doctype html>\n${doc.documentElement.outerHTML}`;
  }

  async function navigate(url, options = {}) {
    document.body.classList.remove("loaded");
    setStatus("正在加载页面");
    cleanupObjectUrls();
    const response = await wsRequest(url || "", {
      method: options.method || "GET",
      headers: options.headers || { Accept: "text/html,*/*;q=0.1" },
      body: options.body || null,
    });
    state.currentUrl = response.url || url || config.initialUrl || "";
    const type = contentTypeBase(response.content_type);
    if (!type.includes("html")) {
      const blobUrl = blobUrlForResponse(response);
      stage.removeAttribute("srcdoc");
      stage.src = blobUrl;
      document.body.classList.add("loaded");
      return;
    }
    const html = await processHtml(responseText(response), state.currentUrl);
    stage.removeAttribute("src");
    stage.srcdoc = html;
    document.body.classList.add("loaded");
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== stage.contentWindow) return;
    const message = event.data || {};
    if (message.type === "queqiao:navigate") {
      try {
        await navigate(message.url, {
          method: message.method || "GET",
          body: message.body || null,
          headers: message.headers || { Accept: "text/html,*/*;q=0.1" },
        });
      } catch (error) {
        document.body.classList.remove("loaded");
        setStatus(error.message);
      }
    }
    if (message.type === "queqiao:fetch") {
      try {
        const response = await wsRequest(message.url, {
          method: message.method || "GET",
          headers: message.headers || {},
          body: message.body || null,
        });
        stage.contentWindow.postMessage(
          { type: "queqiao:fetch-result", requestId: message.requestId, ok: true, response },
          "*"
        );
      } catch (error) {
        stage.contentWindow.postMessage(
          { type: "queqiao:fetch-result", requestId: message.requestId, ok: false, error: error.message },
          "*"
        );
      }
    }
    if (message.type === "queqiao:resource") {
      try {
        const response = await wsRequest(message.url, {
          headers: { Accept: message.accept || "*/*" },
        });
        if (String(response.content_type || "").toLowerCase().includes("text/css")) {
          response.body = await processCss(responseText(response), response.url || message.url);
          response.base64 = false;
        }
        stage.contentWindow.postMessage(
          { type: "queqiao:resource-result", requestId: message.requestId, ok: true, response },
          "*"
        );
      } catch (error) {
        stage.contentWindow.postMessage(
          { type: "queqiao:resource-result", requestId: message.requestId, ok: false, error: error.message },
          "*"
        );
      }
    }
  });

  bindActivity(window);
  if (stage) {
    stage.addEventListener("load", () => {
      try {
        if (stage.contentWindow) bindActivity(stage.contentWindow);
        if (stage.contentDocument) bindActivity(stage.contentDocument);
      } catch {}
      resetIdleTimer();
    });
  }
  window.addEventListener("pagehide", () => releaseProxyResources("disconnect"));
  window.addEventListener("beforeunload", () => releaseProxyResources("disconnect"));
  window.addEventListener("storage", (event) => {
    if (event.key === "queqiao.proxy.release") {
      releaseProxyResources("manual");
      setStatus("透传资源已释放");
    }
  });

  connect()
    .then(() => navigate(config.initialUrl || ""))
    .catch((error) => setStatus(error.message));
})();
