from __future__ import annotations

import json
import os
import re
import secrets
import base64
import hmac
import hashlib
import shlex
import threading
import time
from html import escape
from pathlib import Path
from typing import Any, Dict, Optional, Set
from urllib.parse import urljoin, urlparse, quote

import requests
from flask import Flask, Response, abort, jsonify, request, send_from_directory
from werkzeug.datastructures import Headers
from flask_sock import Sock

from . import db


BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
DATABASE = Path(os.environ.get("QUEQIAO_DATABASE", PROJECT_DIR / "data" / "queqiao.sqlite3"))
IMG_DIR = DATABASE.parent / "img"
SECRET_KEY = os.environ.get("QUEQIAO_SECRET_KEY", "dev-change-me")
ALLOWED_IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp"}
IMAGE_MAX_BYTES = int(os.environ.get("QUEQIAO_IMAGE_MAX_BYTES", str(8 * 1024 * 1024)))
WS_PROXY_MAX_BYTES = int(os.environ.get("QUEQIAO_WS_PROXY_MAX_BYTES", str(128 * 1024 * 1024)))
PROXY_IDLE_SECONDS = int(os.environ.get("QUEQIAO_PROXY_IDLE_SECONDS", "1800"))
CHROMIUM_AUTH_COOKIE = "queqiao_chromium_auth"
CHROMIUM_AUTH_TTL = int(os.environ.get("QUEQIAO_CHROMIUM_AUTH_TTL", "3600"))
ACTIVE_PROXY_SESSIONS: Set[requests.Session] = set()
PROXY_SESSION_LOCK = threading.Lock()
PROXY_RELEASE_GENERATION = 0


def create_app() -> Flask:
    app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="/static")
    app.config.update(SECRET_KEY=SECRET_KEY, JSON_AS_ASCII=False, MAX_CONTENT_LENGTH=IMAGE_MAX_BYTES + 1024 * 1024)
    db.init_db(DATABASE)
    sock = Sock(app)

    @app.after_request
    def add_security_headers(response: Response) -> Response:
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        return response

    @app.get("/")
    def index() -> Response:
        return send_from_directory(app.static_folder, "index.html")

    @app.errorhandler(413)
    def request_too_large(_: Exception) -> Response:
        return Response(f"图片不能超过 {IMAGE_MAX_BYTES // (1024 * 1024)}MB", status=413, mimetype="text/plain; charset=utf-8")

    @app.post("/img/upload")
    def upload_image() -> Response:
        token = request.args.get("token", "") or request.form.get("token", "")
        if db.user_for_token(DATABASE, token) is None:
            abort(401)
        upload = request.files.get("file")
        if upload is None or not upload.filename:
            abort(400, "缺少图片文件")
        ext = os.path.splitext(upload.filename)[1].lower().lstrip(".")
        if ext not in ALLOWED_IMAGE_EXT:
            abort(400, "不支持的图片格式")
        head = upload.stream.read(16)
        upload.stream.seek(0)
        if not is_allowed_image_signature(ext, head):
            abort(400, "图片内容与格式不匹配")
        IMG_DIR.mkdir(parents=True, exist_ok=True)
        filename = f"{secrets.token_hex(10)}.{ext}"
        try:
            save_limited_upload(upload, IMG_DIR / filename)
        except ValueError:
            abort(413)
        return jsonify({"url": f"/img/{filename}"})

    @app.get("/img/<path:filename>")
    def serve_image(filename: str) -> Response:
        return send_from_directory(str(IMG_DIR), filename)

    @app.get("/proxy-view/<int:link_id>/")
    def proxy_view(link_id: int) -> Response:
        token = request.args.get("token", "")
        if db.user_for_token(DATABASE, token) is None:
            abort(401)

        link = db.get_link(DATABASE, link_id)
        if link is None or not link["proxy_enabled"] or not link["internal_url"]:
            abort(404)

        title = escape(link["title"])
        external_url = escape(link["external_url"] or "未设置")
        internal_url = escape(link["internal_url"] or "未设置")
        target_url = escape(link["internal_url"] or "未设置")
        proxy_url = escape(f"/proxy-ws/{link_id}/?token={token}", quote=True)
        html = f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{title} - 透传模式</title>
    <link rel="icon" type="image/png" href="/static/logo.png">
    <link rel="apple-touch-icon" href="/static/logo.png">
    <link rel="stylesheet" href="/static/styles.css">
  </head>
  <body class="proxy-view-body">
    <header class="proxy-mode-bar">
      <div>
        <img src="/static/logo.png" alt="鹊桥" style="width:28px;height:28px;border-radius:7px;vertical-align:middle;margin-right:8px">
        <span>当前是透传模式</span>
        <strong>{title}</strong>
      </div>
      <a href="/" class="proxy-home-link">返回鹊桥</a>
    </header>
    <section class="proxy-info-panel proxy-info-panel-full">
      <div class="proxy-info-grid">
        <div>
          <span>优先访问</span>
          <strong>{target_url}</strong>
        </div>
        <div>
          <span>内网地址</span>
          <strong>{internal_url}</strong>
        </div>
        <div>
          <span>外网地址</span>
          <strong>{external_url}</strong>
        </div>
        <div>
          <span>透传入口</span>
          <strong>{proxy_url}</strong>
        </div>
      </div>
    </section>
    <section id="proxyStage" class="proxy-stage">
      <iframe id="proxyFrame" class="proxy-view-frame loaded" src="{proxy_url}" title="{title} 透传页面"></iframe>
    </section>
  </body>
</html>"""
        response = Response(html, mimetype="text/html; charset=utf-8")
        response.headers.add("Set-Cookie", f"queqiao_proxy_token={token}; Path=/; SameSite=Lax")
        response.headers.add("Set-Cookie", f"queqiao_proxy_link_id={link_id}; Path=/; SameSite=Lax")
        return response

    @app.route("/proxy/<int:link_id>/", defaults={"path": ""}, methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    @app.route("/proxy/<int:link_id>/<path:path>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def proxy(link_id: int, path: str) -> Response:
        token = request.args.get("token", "") or request.cookies.get("queqiao_proxy_token", "")
        return proxy_request(link_id, path, token)

    @app.get("/proxy-ws/<int:link_id>/")
    @app.get("/proxy-ws/<int:link_id>/virtual/", defaults={"virtual_path": ""})
    @app.get("/proxy-ws/<int:link_id>/virtual/<path:virtual_path>")
    def proxy_ws_view(link_id: int, virtual_path: str = "") -> Response:
        token = request.args.get("token", "") or request.cookies.get("queqiao_proxy_token", "")
        if db.user_for_token(DATABASE, token) is None:
            abort(401)

        link = db.get_link(DATABASE, link_id)
        if link is None or not link["proxy_enabled"] or not link["internal_url"]:
            abort(404)

        config = {
            "linkId": link_id,
            "token": token,
            "title": link["title"],
            "initialUrl": ws_proxy_initial_url(link["internal_url"], virtual_path),
            "idleSeconds": PROXY_IDLE_SECONDS,
        }
        html = f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{escape(link["title"])} - WS 透传</title>
    <link rel="icon" type="image/png" href="/static/logo.png">
    <link rel="apple-touch-icon" href="/static/logo.png">
    <style>
      html, body, #stage {{ width: 100%; height: 100%; margin: 0; }}
      body {{ background: #f8fafc; color: #1f2937; font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
      #status {{ position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; }}
      #brand {{ position: fixed; right: 16px; top: 16px; z-index: 2; display: inline-flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.72); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #17212b; font-weight: 700; transition: opacity 140ms ease, transform 140ms ease; }}
      #brand:hover {{ opacity: 0; transform: translateY(-4px); }}
      #brand img {{ width: 24px; height: 24px; border-radius: 6px; }}
      #stage {{ display: none; border: 0; background: #fff; }}
      body.loaded #status {{ display: none; }}
      body.loaded #stage {{ display: block; }}
    </style>
  </head>
  <body>
    <div id="brand"><img src="/static/logo.png" alt="鹊桥"><span>鹊桥</span></div>
    <div id="status">正在加载页面</div>
    <iframe id="stage" title="{escape(link["title"])} WS 透传页面"></iframe>
    <script>
      window.__QUEQIAO_PROXY__ = {json.dumps(config, ensure_ascii=False)};
    </script>
    <script src="/static/proxy-ws-client.js?v=3"></script>
  </body>
</html>"""
        response = Response(html, mimetype="text/html; charset=utf-8")
        response.headers.add("Set-Cookie", f"queqiao_proxy_token={token}; Path=/; SameSite=Lax")
        response.headers.add("Set-Cookie", f"queqiao_proxy_link_id={link_id}; Path=/; SameSite=Lax")
        return response

    @app.get("/chromium-launch/<int:link_id>/")
    def chromium_launch(link_id: int) -> Response:
        token = request.args.get("token", "") or request.cookies.get("queqiao_token", "")
        user = db.user_for_token(DATABASE, token)
        if user is None:
            abort(401)

        link = db.get_link(DATABASE, link_id)
        if link is None or not link["proxy_enabled"] or not link["internal_url"]:
            abort(404)

        auth_token = issue_chromium_auth_token(int(user["id"]), link_id)
        target_url = str(link["internal_url"])
        command = chromium_open_command(target_url)
        cleanup_command = chromium_cleanup_command()
        title = escape(link["title"])
        chromium_url = "/chromium/?autoconnect=1&resize=remote"
        html = f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{title} - Chromium 透传</title>
    <link rel="icon" type="image/png" href="/static/logo.png">
    <link rel="apple-touch-icon" href="/static/logo.png">
    <style>
      html, body, iframe {{ width: 100%; height: 100%; margin: 0; }}
      body {{ background: #000; overflow: hidden; }}
      iframe {{ display: block; border: 0; }}
      #brand {{ position: fixed; right: 16px; top: 16px; z-index: 3; display: inline-flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.16); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #fff; font: 700 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; transition: opacity 140ms ease, transform 140ms ease; }}
      #brand:hover {{ opacity: 0; transform: translateY(-4px); }}
      #brand img {{ width: 24px; height: 24px; border-radius: 6px; }}
    </style>
  </head>
  <body>
    <div id="brand"><img src="/static/logo.png" alt="鹊桥"><span>鹊桥</span></div>
    <iframe id="chromiumFrame" src="{chromium_url}" title="{title} Chromium 透传"></iframe>
    <script>
      const frame = document.querySelector("#chromiumFrame");
      const command = {json.dumps(command, ensure_ascii=False)};
      const cleanupCommand = {json.dumps(cleanup_command, ensure_ascii=False)};
      const idleMs = {max(PROXY_IDLE_SECONDS, 0) * 1000};
      let released = false;
      let openTimer = 0;
      let idleTimer = 0;

      function sendCommand() {{
        if (released) return;
        if (!frame.contentWindow) return;
        frame.contentWindow.postMessage({{ type: "command", value: command }}, window.location.origin);
      }}

      function sendCleanupCommand() {{
        if (!frame.contentWindow) return;
        frame.contentWindow.postMessage({{ type: "command", value: cleanupCommand }}, window.location.origin);
      }}

      function releaseChromium(reason) {{
        if (released) return;
        released = true;
        clearInterval(openTimer);
        clearTimeout(idleTimer);
        sendCleanupCommand();
        setTimeout(() => {{
          frame.removeAttribute("src");
          document.body.innerHTML = '<div style="height:100%;display:grid;place-items:center;color:#fff;font:15px system-ui">透传已释放，可关闭此页面</div>';
        }}, reason === "idle" ? 400 : 0);
      }}

      function resetIdleTimer() {{
        if (!idleMs || released) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => releaseChromium("idle"), idleMs);
      }}

      function bindActivity(target) {{
        for (const name of ["pointerdown", "mousemove", "keydown", "wheel", "touchstart"]) {{
          target.addEventListener(name, resetIdleTimer, {{ passive: true, capture: true }});
        }}
      }}

      function shellQuote(value) {{
        return "'" + String(value).replace(/'/g, "'\\''") + "'";
      }}

      function makeTypeCommand(text) {{
        const script =
          'xdotool keyup Shift_L Shift_R Control_L Control_R Alt_L Alt_R Meta_L Meta_R Super_L Super_R Caps_Lock >/tmp/queqiao-ime.log 2>&1 || true; ' +
          'printf %s "$1" | wl-copy --type text/plain >>/tmp/queqiao-ime.log 2>&1 && ' +
          'xdotool key --clearmodifiers ctrl+v >>/tmp/queqiao-ime.log 2>&1 || ' +
          'wtype "$1" >>/tmp/queqiao-ime.log 2>&1';
        return "sh -lc " + shellQuote(script) + " sh " + shellQuote(text);
      }}

      function sendText(text) {{
        if (!text || !frame.contentWindow) return;
        resetIdleTimer();
        frame.contentWindow.postMessage({{ type: "command", value: makeTypeCommand(text) }}, window.location.origin);
      }}

      function installMacImeBridge() {{
        let doc;
        let win;
        try {{
          doc = frame.contentDocument;
          win = frame.contentWindow;
        }} catch (error) {{
          return false;
        }}
        if (!doc || !win || doc.documentElement.dataset.queqiaoImeBridge === "1") return Boolean(doc);

        const assist = doc.querySelector("#keyboard-input-assist");
        const stream = doc.querySelector("#stream");
        if (!assist || !stream) return false;
        doc.documentElement.dataset.queqiaoImeBridge = "1";
        bindActivity(doc);

        let composing = false;
        let pending = "";
        let pendingTimer = 0;
        let lastSent = "";
        let lastSentAt = 0;

        assist.readOnly = false;
        assist.setAttribute("inputmode", "text");
        assist.setAttribute("lang", "zh-CN");

        function resetRemoteKeyboard() {{
          try {{
            win.dispatchEvent(new Event("blur"));
          }} catch (error) {{
            // Synthetic blur is only used to release Selkies' tracked modifier keys.
          }}
        }}

        function focusAssist() {{
          setTimeout(() => {{
            try {{
              assist.focus({{ preventScroll: true }});
            }} catch (error) {{
              assist.focus();
            }}
          }}, 0);
        }}

        function queueText(text) {{
          if (!text) return;
          pending += text;
          clearTimeout(pendingTimer);
          pendingTimer = setTimeout(() => {{
            const value = pending;
            pending = "";
            const now = Date.now();
            if (value === lastSent && now - lastSentAt < 250) return;
            lastSent = value;
            lastSentAt = now;
            resetRemoteKeyboard();
            sendText(value);
          }}, 20);
        }}

        doc.addEventListener("mousedown", focusAssist, true);
        doc.addEventListener("touchstart", focusAssist, true);
        stream.addEventListener("focus", focusAssist, true);
        stream.addEventListener("click", focusAssist, true);

        assist.addEventListener("compositionstart", (event) => {{
          composing = true;
          resetRemoteKeyboard();
          event.stopImmediatePropagation();
        }}, true);

        assist.addEventListener("compositionupdate", (event) => {{
          event.stopImmediatePropagation();
        }}, true);

        assist.addEventListener("compositionend", (event) => {{
          composing = false;
          const text = event.data || assist.value;
          assist.value = "";
          queueText(text);
          event.preventDefault();
          event.stopImmediatePropagation();
        }}, true);

        assist.addEventListener("beforeinput", (event) => {{
          if (event.isComposing || event.inputType === "insertCompositionText") {{
            event.stopImmediatePropagation();
            return;
          }}
          if (event.inputType === "insertText" && event.data) {{
            queueText(event.data);
            event.preventDefault();
            event.stopImmediatePropagation();
          }}
        }}, true);

        assist.addEventListener("input", (event) => {{
          const text = assist.value;
          assist.value = "";
          if (text && !composing) queueText(text);
          event.preventDefault();
          event.stopImmediatePropagation();
        }}, true);

        function stopRawKey(event) {{
          if (
            composing ||
            event.isComposing ||
            event.key === "CapsLock" ||
            event.key === "Shift" ||
            event.key === "Meta" ||
            event.key === "Alt" ||
            event.key === "Control" ||
            (event.key && event.key.length === 1)
          ) {{
            event.stopImmediatePropagation();
          }}
        }}

        assist.addEventListener("keydown", (event) => {{
          if (event.key === "CapsLock" || event.key === "Shift" || event.key === "Meta" || event.key === "Alt") {{
            resetRemoteKeyboard();
          }}
          stopRawKey(event);
        }}, true);

        assist.addEventListener("keypress", stopRawKey, true);
        assist.addEventListener("keyup", stopRawKey, true);

        focusAssist();
        return true;
      }}

      function waitForImeBridge() {{
        let attempts = 0;
        const timer = setInterval(() => {{
          attempts += 1;
          if (installMacImeBridge() || attempts > 80) clearInterval(timer);
        }}, 250);
      }}

      frame.addEventListener("load", () => {{
        waitForImeBridge();
        setTimeout(sendCommand, 2500);
        setTimeout(sendCommand, 6000);
        setTimeout(sendCommand, 10000);
        resetIdleTimer();
      }});
      bindActivity(window);
      setTimeout(sendCommand, 12000);
      openTimer = setInterval(sendCommand, 15000);
      resetIdleTimer();
      window.addEventListener("pagehide", () => releaseChromium("disconnect"));
      window.addEventListener("beforeunload", () => releaseChromium("disconnect"));
      window.addEventListener("storage", (event) => {{
        if (event.key === "queqiao.proxy.release") releaseChromium("manual");
      }});
    </script>
  </body>
</html>"""
        response = Response(html, mimetype="text/html; charset=utf-8")
        secure_cookie = (request.headers.get("X-Forwarded-Proto", "") == "https") or request.is_secure
        response.set_cookie(
            CHROMIUM_AUTH_COOKIE,
            auth_token,
            max_age=CHROMIUM_AUTH_TTL,
            httponly=True,
            samesite="Lax",
            path="/chromium",
            secure=secure_cookie,
        )
        return response

    @app.get("/chromium-release/")
    def chromium_release() -> Response:
        token = request.args.get("token", "") or request.cookies.get("queqiao_token", "")
        user = db.user_for_token(DATABASE, token)
        if user is None:
            abort(401)

        auth_token = issue_chromium_auth_token(int(user["id"]), 0)
        cleanup_command = chromium_cleanup_command()
        html = f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>释放透传 - 鹊桥</title>
    <link rel="icon" type="image/png" href="/static/logo.png">
    <style>
      html, body, iframe {{ width: 100%; height: 100%; margin: 0; }}
      body {{ background: #050505; color: #fff; overflow: hidden; font: 15px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
      iframe {{ position: absolute; inset: 0; border: 0; opacity: 0.01; pointer-events: none; }}
      .release-status {{ position: fixed; inset: 0; display: grid; place-items: center; gap: 12px; text-align: center; }}
      .release-logo {{ width: 42px; height: 42px; border-radius: 10px; }}
    </style>
  </head>
  <body>
    <iframe id="chromiumFrame" src="/chromium/?autoconnect=1&resize=remote" title="Chromium 释放通道"></iframe>
    <div class="release-status">
      <div>
        <img class="release-logo" src="/static/logo.png" alt="鹊桥">
        <div id="releaseText">正在释放透传资源</div>
      </div>
    </div>
    <script>
      const frame = document.querySelector("#chromiumFrame");
      const releaseText = document.querySelector("#releaseText");
      const cleanupCommand = {json.dumps(cleanup_command, ensure_ascii=False)};
      function sendCleanupCommand() {{
        if (!frame.contentWindow) return;
        frame.contentWindow.postMessage({{ type: "command", value: cleanupCommand }}, window.location.origin);
      }}
      frame.addEventListener("load", () => {{
        setTimeout(sendCleanupCommand, 600);
        setTimeout(sendCleanupCommand, 1800);
        setTimeout(() => {{
          sendCleanupCommand();
          releaseText.textContent = "透传资源已释放";
          frame.removeAttribute("src");
        }}, 3200);
      }});
    </script>
  </body>
</html>"""
        response = Response(html, mimetype="text/html; charset=utf-8")
        secure_cookie = (request.headers.get("X-Forwarded-Proto", "") == "https") or request.is_secure
        response.set_cookie(
            CHROMIUM_AUTH_COOKIE,
            auth_token,
            max_age=120,
            httponly=True,
            samesite="Lax",
            path="/chromium",
            secure=secure_cookie,
        )
        return response

    @app.get("/auth/chromium")
    def chromium_auth() -> Response:
        auth_token = request.cookies.get(CHROMIUM_AUTH_COOKIE, "")
        payload = verify_chromium_auth_token(auth_token)
        if payload is None:
            abort(401)
        return Response("ok", mimetype="text/plain; charset=utf-8")

    @app.route("/<path:path>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def proxy_absolute_path(path: str) -> Response:
        if path.startswith(("static/", "proxy/", "proxy-view/", "proxy-ws/", "img/")) or path == "ws":
            abort(404)

        token = request.cookies.get("queqiao_proxy_token", "")
        link_id = request.cookies.get("queqiao_proxy_link_id", "")
        if not token or not link_id:
            abort(404)
        return proxy_request(int(link_id), path, token)

    def proxy_request(link_id: int, path: str, token: str) -> Response:
        if db.user_for_token(DATABASE, token) is None:
            abort(401)

        link = db.get_link(DATABASE, link_id)
        if link is None or not link["proxy_enabled"]:
            abort(404)

        base_url = link["internal_url"]
        if not base_url:
            abort(404)

        target = urljoin(base_url.rstrip("/") + "/", path)
        query = request.query_string.decode("utf-8")
        query = "&".join(part for part in query.split("&") if not part.startswith("token="))
        if query:
            target = f"{target}?{query}"

        try:
            upstream = requests.request(
                request.method,
                target,
                data=request.get_data(),
                headers=forward_headers(request.headers),
                cookies=upstream_cookies(request.cookies),
                allow_redirects=False,
                stream=True,
                timeout=20,
            )
        except requests.RequestException as exc:
            return Response(f"透传失败：{exc}", status=502, mimetype="text/plain; charset=utf-8")

        headers = response_headers(getattr(upstream.raw, "headers", upstream.headers), link_id)
        headers.add("Set-Cookie", f"queqiao_proxy_token={token}; Path=/; SameSite=Lax")
        headers.add("Set-Cookie", f"queqiao_proxy_link_id={link_id}; Path=/; SameSite=Lax")
        if upstream.is_redirect and "Location" in upstream.headers:
            headers["Location"] = rewrite_location(upstream.headers["Location"], link_id, base_url)
        content_type = upstream.headers.get("Content-Type", "")
        if "text/html" in content_type.lower():
            html = rewrite_html_for_proxy(upstream.text, link_id)
            return Response(html, status=upstream.status_code, headers=headers)
        if "text/css" in content_type.lower():
            css = rewrite_css_for_proxy(upstream.text, link_id)
            return Response(css, status=upstream.status_code, headers=headers)

        return Response(upstream.iter_content(chunk_size=8192), status=upstream.status_code, headers=headers)

    @sock.route("/ws")
    def websocket(ws: Any) -> None:
        authed_token = ""
        proxy_sessions: Dict[int, requests.Session] = {}
        proxy_release_generation = current_proxy_release_generation()
        while True:
            try:
                raw = ws.receive()
            except Exception:
                break
            if raw is None:
                break
            message: Dict[str, Any] = {}
            try:
                message = json.loads(raw)
                action = message.get("action")
                request_id = message.get("request_id")
                payload = message.get("payload") or {}

                if action == "ping":
                    send(ws, action, request_id, payload={"ok": True})
                    continue

                if action == "auth.login":
                    result = db.authenticate(DATABASE, str(payload.get("username", "")), str(payload.get("password", "")))
                    if result is None:
                        send(ws, action, request_id, ok=False, error="账号或密码错误")
                    else:
                        authed_token = result["token"]
                        send(ws, action, request_id, payload={"user": {"id": result["id"], "username": result["username"]}, "token": result["token"]})
                    continue

                token = str(payload.get("token") or authed_token or "")
                user = db.user_for_token(DATABASE, token)
                if user is None:
                    send(ws, action, request_id, ok=False, error="未登录或会话已失效")
                    continue
                authed_token = token

                if action == "auth.me":
                    send(ws, action, request_id, payload={"user": user})
                elif action == "auth.logout":
                    db.logout(DATABASE, token)
                    authed_token = ""
                    send(ws, action, request_id, payload={"ok": True})
                elif action == "user.change_password":
                    db.change_password(
                        DATABASE,
                        int(user["id"]),
                        str(payload.get("current_password", "")),
                        str(payload.get("new_password", "")),
                    )
                    send(ws, action, request_id, payload={"ok": True})
                elif action == "links.list":
                    send(ws, action, request_id, payload={"links": list(db.list_links(DATABASE))})
                elif action == "links.save":
                    link = db.save_link(DATABASE, payload.get("link") or {})
                    broadcast_link_state(ws, action, request_id, link)
                elif action == "links.delete":
                    db.delete_link(DATABASE, int(payload.get("id")))
                    send(ws, action, request_id, payload={"id": int(payload.get("id"))})
                    send(ws, "links.changed", None, payload={"links": list(db.list_links(DATABASE))})
                elif action == "links.reorder":
                    db.reorder_links(DATABASE, payload.get("ids") or [])
                    send(ws, action, request_id, payload={"ok": True})
                    send(ws, "links.changed", None, payload={"links": list(db.list_links(DATABASE))})
                elif action == "links.proxy_url":
                    link_id = int(payload.get("id"))
                    link = db.get_link(DATABASE, link_id)
                    if link is None or not link["proxy_enabled"] or not link["internal_url"]:
                        send(ws, action, request_id, ok=False, error="该链接没有启用透传")
                    else:
                        send(
                            ws,
                            action,
                            request_id,
                            payload={
                                "id": link_id,
                                "channel": f"proxy:{link_id}",
                                "chromium_url": f"/chromium-launch/{link_id}/",
                                "view_url": f"/proxy-view/{link_id}/?token={token}",
                                "proxy_url": f"/proxy-ws/{link_id}/?token={token}",
                            },
                        )
                elif action == "proxy.fetch":
                    link_id = int(payload.get("id"))
                    link = db.get_link(DATABASE, link_id)
                    if link is None or not link["proxy_enabled"] or not link["internal_url"]:
                        send(ws, action, request_id, ok=False, error="该链接没有启用透传")
                    else:
                        send(
                            ws,
                            action,
                            request_id,
                            payload={
                                "id": link_id,
                                "channel": f"proxy:{link_id}",
                                "proxy_url": f"/proxy-ws/{link_id}/?token={token}",
                            },
                        )
                elif action == "proxy.release_all":
                    released = release_all_proxy_sessions()
                    proxy_sessions.clear()
                    proxy_release_generation = current_proxy_release_generation()
                    send(
                        ws,
                        action,
                        request_id,
                        payload={
                            "released_sessions": released,
                            "chromium_release_url": "/chromium-release/",
                        },
                    )
                elif action == "proxy.ws_request":
                    link_id = int(payload.get("id"))
                    latest_release_generation = current_proxy_release_generation()
                    if latest_release_generation != proxy_release_generation:
                        close_proxy_sessions(proxy_sessions)
                        proxy_release_generation = latest_release_generation
                    session = proxy_session_for_link(proxy_sessions, link_id)
                    result = ws_proxy_request(link_id, payload, session)
                    send(ws, action, request_id, payload=result)
                else:
                    send(ws, action, request_id, ok=False, error=f"未知操作：{action}")
            except ValueError as exc:
                send(ws, message.get("action") if isinstance(message, dict) else "", message.get("request_id") if isinstance(message, dict) else None, ok=False, error=str(exc))
            except Exception as exc:
                send(ws, message.get("action") if isinstance(message, dict) else "", message.get("request_id") if isinstance(message, dict) else None, ok=False, error=f"服务端错误：{exc}")
        close_proxy_sessions(proxy_sessions)

    return app


def send(ws: Any, action: str, request_id: Any, ok: bool = True, payload: Optional[Dict[str, Any]] = None, error: str = "") -> None:
    ws.send(json.dumps({"action": action, "request_id": request_id, "ok": ok, "payload": payload or {}, "error": error}, ensure_ascii=False))


def broadcast_link_state(ws: Any, action: str, request_id: Any, link: Dict[str, Any]) -> None:
    send(ws, action, request_id, payload={"link": link})
    send(ws, "links.changed", None, payload={"links": list(db.list_links(DATABASE))})


def current_proxy_release_generation() -> int:
    with PROXY_SESSION_LOCK:
        return PROXY_RELEASE_GENERATION


def proxy_session_for_link(proxy_sessions: Dict[int, requests.Session], link_id: int) -> requests.Session:
    session = proxy_sessions.get(link_id)
    if session is None:
        session = requests.Session()
        proxy_sessions[link_id] = session
        with PROXY_SESSION_LOCK:
            ACTIVE_PROXY_SESSIONS.add(session)
    return session


def release_all_proxy_sessions() -> int:
    global PROXY_RELEASE_GENERATION
    with PROXY_SESSION_LOCK:
        sessions = list(ACTIVE_PROXY_SESSIONS)
        ACTIVE_PROXY_SESSIONS.clear()
        PROXY_RELEASE_GENERATION += 1
    for session in sessions:
        session.close()
    return len(sessions)


def close_proxy_sessions(proxy_sessions: Dict[int, requests.Session]) -> None:
    sessions = list(proxy_sessions.values())
    proxy_sessions.clear()
    with PROXY_SESSION_LOCK:
        for session in sessions:
            ACTIVE_PROXY_SESSIONS.discard(session)
    for session in sessions:
        session.close()


def ws_proxy_initial_url(base_url: str, virtual_path: str = "") -> str:
    target = urljoin(base_url.rstrip("/") + "/", virtual_path or "")
    query = request.query_string.decode("utf-8")
    query = "&".join(part for part in query.split("&") if part and not part.startswith("token="))
    if query:
        separator = "&" if "?" in target else "?"
        target = f"{target}{separator}{query}"
    return target


def ws_proxy_request(link_id: int, payload: Dict[str, Any], session: requests.Session) -> Dict[str, Any]:
    link = db.get_link(DATABASE, link_id)
    if link is None or not link["proxy_enabled"] or not link["internal_url"]:
        raise ValueError("该链接没有启用透传")

    target = resolve_ws_proxy_url(link["internal_url"], str(payload.get("url") or ""))
    method = str(payload.get("method") or "GET").upper()
    if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        raise ValueError("不支持的透传请求方法")

    body = payload.get("body")
    if payload.get("body_base64") and isinstance(body, str):
        request_body: Optional[bytes] = base64.b64decode(body)
    elif isinstance(body, str):
        request_body = body.encode("utf-8")
    else:
        request_body = None

    try:
        upstream = session.request(
            method,
            target,
            data=request_body,
            headers=forward_ws_proxy_headers(payload.get("headers") or {}),
            allow_redirects=True,
            stream=True,
            timeout=20,
        )
        body_bytes = read_limited_response(upstream)
    except (requests.RequestException, ValueError) as exc:
        raise ValueError(f"WS 透传失败：{exc}") from exc

    content_type = upstream.headers.get("Content-Type", "") or "application/octet-stream"
    text_body = is_ws_text_response(content_type)
    text_encoding = upstream.encoding or response_text_encoding(content_type)
    result: Dict[str, Any] = {
        "status": upstream.status_code,
        "ok": upstream.ok,
        "url": upstream.url,
        "content_type": content_type,
        "headers": {
            key: value
            for key, value in upstream.headers.items()
            if key.lower() in {"content-type", "cache-control", "expires", "last-modified", "etag"}
        },
    }
    if text_body:
        result["body"] = body_bytes.decode(text_encoding, errors="replace")
        result["base64"] = False
    else:
        result["body"] = base64.b64encode(body_bytes).decode("ascii")
        result["base64"] = True
    return result


def resolve_ws_proxy_url(base_url: str, value: str) -> str:
    if not value:
        return base_url
    parsed = urlparse(value)
    if parsed.scheme and parsed.scheme not in {"http", "https"}:
        raise ValueError("仅支持 http/https 透传资源")
    if parsed.scheme in {"http", "https"}:
        return value
    return urljoin(base_url.rstrip("/") + "/", value)


def forward_ws_proxy_headers(headers: Dict[str, Any]) -> Dict[str, str]:
    blocked = {"host", "connection", "content-length", "cookie", "origin", "referer", "accept-encoding"}
    forwarded = {
        str(key): str(value)
        for key, value in headers.items()
        if str(key).lower() not in blocked and value is not None
    }
    forwarded.setdefault(
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 QueqiaoWSProxy/1.0",
    )
    forwarded.setdefault("Accept", "*/*")
    forwarded.setdefault("Accept-Encoding", "gzip, deflate, br")
    return forwarded


def response_text_encoding(content_type: str) -> str:
    match = re.search(r"charset=([^;\s]+)", content_type, flags=re.IGNORECASE)
    if match:
        return match.group(1).strip("\"'")
    return "utf-8"


def read_limited_response(upstream: requests.Response) -> bytes:
    content_length = upstream.headers.get("Content-Length", "")
    if content_length.isdigit() and int(content_length) > WS_PROXY_MAX_BYTES:
        raise ValueError(
            f"WS 透传资源过大：{format_bytes(int(content_length))}，"
            f"当前上限 {format_bytes(WS_PROXY_MAX_BYTES)}，URL={upstream.url}"
        )
    chunks = []
    total = 0
    for chunk in upstream.iter_content(chunk_size=8192):
        if not chunk:
            continue
        total += len(chunk)
        if total > WS_PROXY_MAX_BYTES:
            raise ValueError(
                f"WS 透传资源过大：已读取 {format_bytes(total)}，"
                f"当前上限 {format_bytes(WS_PROXY_MAX_BYTES)}，URL={upstream.url}"
            )
        chunks.append(chunk)
    return b"".join(chunks)


def format_bytes(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def is_allowed_image_signature(ext: str, head: bytes) -> bool:
    if ext == "png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if ext in {"jpg", "jpeg"}:
        return head.startswith(b"\xff\xd8\xff")
    if ext == "gif":
        return head.startswith((b"GIF87a", b"GIF89a"))
    if ext == "webp":
        return head.startswith(b"RIFF") and head[8:12] == b"WEBP"
    return False


def save_limited_upload(upload: Any, destination: Path) -> None:
    total = 0
    try:
        with destination.open("wb") as handle:
            while True:
                chunk = upload.stream.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > IMAGE_MAX_BYTES:
                    raise ValueError("图片不能超过大小限制")
                handle.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def issue_chromium_auth_token(user_id: int, link_id: int) -> str:
    payload = {
        "uid": int(user_id),
        "lid": int(link_id),
        "exp": int(time.time()) + max(CHROMIUM_AUTH_TTL, 60),
        "nonce": secrets.token_hex(8),
    }
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("ascii").rstrip("=")
    signature = hmac.new(SECRET_KEY.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def chromium_open_command(target_url: str) -> str:
    nonce = secrets.token_hex(8)
    state_file = f"/tmp/queqiao-open-{nonce}.pid"
    script = (
        f"state={shlex.quote(state_file)}; "
        "current=$(pgrep -o -u abc -f '/usr/lib/chromium/chromium --show-component' || true); "
        'last=$(cat "$state" 2>/dev/null || true); '
        'if [ -z "$current" ] || [ "$current" != "$last" ]; then '
        'wrapped-chromium "$1" >/tmp/queqiao-open.log 2>&1 & '
        "sleep 1; "
        "current=$(pgrep -o -u abc -f '/usr/lib/chromium/chromium --show-component' || true); "
        'printf "%s" "$current" > "$state"; '
        "fi"
    )
    return f"sh -lc {shlex.quote(script)} sh {shlex.quote(target_url)}"


def chromium_cleanup_command() -> str:
    script = (
        "rm -f /tmp/queqiao-open-*.pid; "
        "pkill -u abc -f '/usr/lib/chromium/chromium --show-component' >/tmp/queqiao-cleanup.log 2>&1 || true"
    )
    return f"sh -lc {shlex.quote(script)}"


def verify_chromium_auth_token(token: str) -> Optional[Dict[str, Any]]:
    if not token or "." not in token:
        return None
    body, signature = token.rsplit(".", 1)
    expected = hmac.new(SECRET_KEY.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    padded = body + "=" * ((4 - len(body) % 4) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    exp = int(payload.get("exp") or 0)
    if exp < int(time.time()):
        return None
    return payload


def is_ws_text_response(content_type: str) -> bool:
    lower = content_type.lower()
    return (
        lower.startswith("text/")
        or "javascript" in lower
        or "json" in lower
        or "xml" in lower
        or "svg" in lower
        or "wasm" not in lower and "application/x-www-form-urlencoded" in lower
    )


def rewrite_html_for_proxy(html: str, link_id: int) -> str:
    html = inject_html_base(html, f"/proxy/{link_id}/")
    prefix = f"/proxy/{link_id}"

    def replace_attr(match: re.Match[str]) -> str:
        name, quote, value = match.group(1), match.group(2), match.group(3)
        if should_rewrite_absolute_path(value):
            return f'{name}={quote}{prefix}{value}{quote}'
        return match.group(0)

    return re.sub(r'\b(href|src|action|poster)=([\'"])(/[^\'"]*)\2', replace_attr, html, flags=re.IGNORECASE)


def rewrite_css_for_proxy(css: str, link_id: int) -> str:
    prefix = f"/proxy/{link_id}"

    def replace_url(match: re.Match[str]) -> str:
        quote = match.group(1) or ""
        value = match.group(2)
        if should_rewrite_absolute_path(value):
            return f"url({quote}{prefix}{value}{quote})"
        return match.group(0)

    return re.sub(r'url\(\s*([\'"]?)(/[^\'")]+)\1\s*\)', replace_url, css, flags=re.IGNORECASE)


def should_rewrite_absolute_path(value: str) -> bool:
    return value.startswith("/") and not value.startswith(("/proxy/", "/static/", "//"))


def inject_html_base(html: str, href: str) -> str:
    marker = "<head>"
    index = html.lower().find(marker)
    if index == -1:
        return html
    insert_at = index + len(marker)
    return f'{html[:insert_at]}<base href="{href}">{html[insert_at:]}'


def forward_headers(headers: Dict[str, str]) -> Dict[str, str]:
    blocked = {"host", "connection", "content-length", "accept-encoding", "cookie"}
    return {key: value for key, value in headers.items() if key.lower() not in blocked}


def upstream_cookies(cookies: Dict[str, str]) -> Dict[str, str]:
    blocked = {"queqiao_proxy_token", "queqiao_proxy_link_id"}
    return {key: value for key, value in cookies.items() if key not in blocked}


def response_headers(headers: Dict[str, str], link_id: int) -> Headers:
    blocked = {"content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"}
    result = Headers()
    for key, value in headers.items():
        if key.lower() not in blocked:
            result.add(key, value)
    for cookie in upstream_set_cookie_values(headers):
        result.add("Set-Cookie", rewrite_set_cookie(cookie, link_id))
    result["X-Frame-Options"] = "SAMEORIGIN"
    return result


def upstream_set_cookie_values(headers: Dict[str, str]) -> list[str]:
    getlist = getattr(headers, "getlist", None)
    if callable(getlist):
        return getlist("Set-Cookie")
    get_all = getattr(headers, "get_all", None)
    if callable(get_all):
        return get_all("Set-Cookie") or []
    value = headers.get("Set-Cookie") if hasattr(headers, "get") else None
    return [value] if value else []


def rewrite_set_cookie(cookie: str, link_id: int) -> str:
    parts = [part.strip() for part in cookie.split(";")]
    rewritten = [parts[0]]
    saw_path = False
    for part in parts[1:]:
        lower = part.lower()
        if lower.startswith("domain="):
            continue
        if lower.startswith("path="):
            saw_path = True
            path = part.split("=", 1)[1] or "/"
            rewritten.append(f"Path={proxy_cookie_path(path, link_id)}")
            continue
        rewritten.append(part)
    if not saw_path:
        rewritten.append(f"Path=/proxy/{link_id}/")
    return "; ".join(rewritten)


def proxy_cookie_path(path: str, link_id: int) -> str:
    if not path.startswith("/"):
        path = "/" + path
    if path == "/":
        return f"/proxy/{link_id}/"
    return f"/proxy/{link_id}{path}"


def rewrite_location(location: str, link_id: int, base_url: str) -> str:
    if location.startswith("/"):
        return f"/proxy/{link_id}{location}"
    parsed_location = urlparse(location)
    parsed_base = urlparse(base_url)
    if parsed_location.scheme in {"http", "https"} and parsed_location.netloc == parsed_base.netloc:
        path = parsed_location.path or "/"
        query = f"?{parsed_location.query}" if parsed_location.query else ""
        fragment = f"#{parsed_location.fragment}" if parsed_location.fragment else ""
        return f"/proxy/{link_id}{path}{query}{fragment}"
    return location


def main() -> None:
    app = create_app()
    app.run(host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8000")))


app = create_app()


if __name__ == "__main__":
    main()
