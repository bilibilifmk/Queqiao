const state = {
  socket: null,
  token: localStorage.getItem("queqiao.remember") === "1" ? localStorage.getItem("queqiao.token") || "" : "",
  user: null,
  links: [],
  pending: new Map(),
  requestId: 0,
  inlineProxyId: null,
  selectedLink: null,
  morphing: false,
  editMode: false,
  draggingLinkId: null,
  heartbeatTimer: null,
  heartbeatId: 0,
};

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const els = {
  loginView: document.querySelector("#loginView"),
  dashboardView: document.querySelector("#dashboardView"),
  loginForm: document.querySelector("#loginForm"),
  loginError: document.querySelector("#loginError"),
  username: document.querySelector("#username"),
  password: document.querySelector("#password"),
  rememberLogin: document.querySelector("#rememberLogin"),
  connectionState: document.querySelector("#connectionState"),
  logoutBtn: document.querySelector("#logoutBtn"),
  addLinkBtn: document.querySelector("#addLinkBtn"),
  editModeBtn: document.querySelector("#editModeBtn"),
  settingsBtn: document.querySelector("#settingsBtn"),
  settingsMenuBtn: document.querySelector("#settingsMenuBtn"),
  settingsMenu: document.querySelector("#settingsMenu"),
  workspace: document.querySelector(".workspace"),
  tileGrid: document.querySelector("#tileGrid"),
  tileTemplate: document.querySelector("#tileTemplate"),
  linkCount: document.querySelector("#linkCount"),
  searchInput: document.querySelector("#searchInput"),
  dialog: document.querySelector("#linkDialog"),
  linkForm: document.querySelector("#linkForm"),
  linkError: document.querySelector("#linkError"),
  deleteLinkBtn: document.querySelector("#deleteLinkBtn"),
  closeDialogBtn: document.querySelector("#closeDialogBtn"),
  cancelDialogBtn: document.querySelector("#cancelDialogBtn"),
  proxyPane: document.querySelector("#proxyPane"),
  proxyTitle: document.querySelector("#proxyTitle"),
  closeProxyBtn: document.querySelector("#closeProxyBtn"),
  inlineProxyBtn: document.querySelector("#inlineProxyBtn"),
  inlineEditBtn: document.querySelector("#inlineEditBtn"),
  inlineInternalUrl: document.querySelector("#inlineInternalUrl"),
  inlineExternalUrl: document.querySelector("#inlineExternalUrl"),
  avatarPreviewBox: document.querySelector("#avatarPreviewBox"),
  avatarFallback: document.querySelector("#avatarFallback"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsForm: document.querySelector("#settingsForm"),
  settingsError: document.querySelector("#settingsError"),
  releaseProxyBtn: document.querySelector("#releaseProxyBtn"),
  closeSettingsBtn: document.querySelector("#closeSettingsBtn"),
  cancelSettingsBtn: document.querySelector("#cancelSettingsBtn"),
  currentPassword: document.querySelector("#currentPassword"),
  newPassword: document.querySelector("#newPassword"),
  confirmPassword: document.querySelector("#confirmPassword"),
  appLoader: document.querySelector("#appLoader"),
};

const fields = {
  id: document.querySelector("#linkId"),
  title: document.querySelector("#linkTitle"),
  description: document.querySelector("#linkDescription"),
  image_url: document.querySelector("#linkImage"),
  image_upload: document.querySelector("#linkImageUpload"),
  external_url: document.querySelector("#linkExternal"),
  internal_url: document.querySelector("#linkInternal"),
  sort_order: document.querySelector("#linkOrder"),
  proxy_enabled: document.querySelector("#linkProxy"),
};

function connect() {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${scheme}://${window.location.host}/ws`);

  state.socket.addEventListener("open", async () => {
    setConnection("已连接");
    startHeartbeat();
    if (state.token) {
      try {
        const result = await send("auth.me", {});
        state.user = result.user;
        syncAuthCookie(state.token);
        showDashboard();
        await loadLinks();
      } catch {
        localStorage.removeItem("queqiao.token");
        state.token = "";
        showLogin();
      }
    } else {
      showLogin();
    }
  });

  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.action === "links.changed") {
      state.links = message.payload.links || [];
      renderLinks();
      return;
    }
    const entry = state.pending.get(message.request_id);
    if (!entry) return;
    state.pending.delete(message.request_id);
    if (message.ok) {
      entry.resolve(message.payload);
    } else {
      entry.reject(new Error(message.error || "请求失败"));
    }
  });

  state.socket.addEventListener("close", () => {
    stopHeartbeat();
    setConnection("连接断开，正在重连");
    setTimeout(connect, 900);
  });
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(() => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    state.heartbeatId += 1;
    state.socket.send(
      JSON.stringify({
        action: "ping",
        request_id: `ping-${state.heartbeatId}`,
        payload: {},
      })
    );
  }, 20000);
}

function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

function restoreLoginPreference() {
  const remembered = localStorage.getItem("queqiao.remember") === "1";
  els.rememberLogin.checked = remembered;
  if (remembered) {
    els.username.value = localStorage.getItem("queqiao.username") || "";
  } else {
    els.username.value = "";
    els.password.value = "";
    localStorage.removeItem("queqiao.token");
    localStorage.removeItem("queqiao.username");
  }
}

function send(action, payload) {
  const requestId = ++state.requestId;
  const body = { ...payload, token: state.token };
  state.socket.send(JSON.stringify({ action, request_id: requestId, payload: body }));
  return new Promise((resolve, reject) => {
    state.pending.set(requestId, { resolve, reject });
    setTimeout(() => {
      if (state.pending.has(requestId)) {
        state.pending.delete(requestId);
        reject(new Error("请求超时"));
      }
    }, 12000);
  });
}

function setConnection(text) {
  els.connectionState.textContent = text;
  els.connectionState.classList.remove("connected", "connecting", "error");
  if (text === "已连接") {
    els.connectionState.classList.add("connected");
  } else if (text.includes("断开")) {
    els.connectionState.classList.add("error");
  } else {
    els.connectionState.classList.add("connecting");
  }
}

function syncAuthCookie(token) {
  document.cookie = `queqiao_token=${encodeURIComponent(token || "")}; Path=/; SameSite=Lax`;
}

function showLogin() {
  els.loginView.classList.remove("hidden");
  els.dashboardView.classList.add("hidden");
}

function showDashboard() {
  els.loginView.classList.add("hidden");
  els.dashboardView.classList.remove("hidden");
}

async function loadLinks() {
  const result = await send("links.list", {});
  state.links = result.links || [];
  renderLinks();
}

function renderLinks() {
  const query = els.searchInput.value.trim().toLowerCase();
  const links = state.links.filter((link) => {
    const haystack = `${link.title} ${link.description} ${link.external_url} ${link.internal_url}`.toLowerCase();
    return haystack.includes(query);
  });
  els.linkCount.textContent = `${links.length} 个链接`;
  els.tileGrid.replaceChildren();

  let tileIndex = 0;
  for (const link of links) {
    const tile = els.tileTemplate.content.firstElementChild.cloneNode(true);
    tile.style.setProperty("--stagger", `${Math.min(tileIndex, 14) * 36}ms`);
    tileIndex += 1;
    const image = tile.querySelector(".tile-media");
    const title = tile.querySelector(".tile-title");
    const subtitle = tile.querySelector(".tile-desc");
    const main = tile.querySelector(".tile-content");
    const external = tile.querySelector(".external-btn");
    const internal = tile.querySelector(".internal-btn");
    const proxy = tile.querySelector(".proxy-btn");
    const edit = tile.querySelector(".edit-btn");

    title.textContent = link.title;
    subtitle.textContent = link.description || link.external_url || link.internal_url || "未设置地址";
    renderImage(image, link);

    const canProxy = Boolean(link.internal_url && link.proxy_enabled);
    tile.dataset.linkId = link.id;
    tile.draggable = state.editMode;
    tile.classList.toggle("editing", state.editMode);
    main.addEventListener("click", () => {
      if (!state.editMode) {
        morphTileToPanel(tile, link);
      }
    });
    external.classList.toggle("hidden", state.editMode || !link.external_url);
    internal.classList.toggle("hidden", state.editMode || !link.internal_url);
    proxy.classList.toggle("hidden", state.editMode || !canProxy);
    edit.classList.toggle("hidden", !state.editMode);
    external.addEventListener("click", (event) => {
      event.stopPropagation();
      window.open(link.external_url, "_blank", "noopener");
    });
    internal.addEventListener("click", (event) => {
      event.stopPropagation();
      window.open(link.internal_url, "_blank", "noopener");
    });
    proxy.addEventListener("click", (event) => {
      event.stopPropagation();
      openProxyPage(link);
    });
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      openEditor(link);
    });
    tile.addEventListener("dragstart", (event) => {
      if (!state.editMode) return;
      state.draggingLinkId = link.id;
      tile.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(link.id));
    });
    tile.addEventListener("dragover", (event) => {
      if (!state.editMode || state.draggingLinkId === link.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      tile.classList.add("drag-over");
    });
    tile.addEventListener("dragleave", () => tile.classList.remove("drag-over"));
    tile.addEventListener("drop", (event) => {
      if (!state.editMode) return;
      event.preventDefault();
      tile.classList.remove("drag-over");
      const draggedId = Number(event.dataTransfer.getData("text/plain") || state.draggingLinkId);
      reorderByDrag(draggedId, link.id);
    });
    tile.addEventListener("dragend", () => {
      state.draggingLinkId = null;
      tile.classList.remove("dragging");
      tile.classList.remove("drag-over");
    });

    els.tileGrid.appendChild(tile);
  }
}

async function reorderByDrag(draggedId, targetId) {
  if (!draggedId || draggedId === targetId) return;
  const index = state.links.findIndex((link) => link.id === draggedId);
  const nextIndex = state.links.findIndex((link) => link.id === targetId);
  if (index < 0 || nextIndex < 0) return;
  const nextLinks = [...state.links];
  const [moved] = nextLinks.splice(index, 1);
  nextLinks.splice(nextIndex, 0, moved);
  state.links = nextLinks.map((link, idx) => ({ ...link, sort_order: (idx + 1) * 10 }));
  renderLinks();
  try {
    await send("links.reorder", { ids: state.links.map((link) => link.id) });
  } catch (error) {
    alert(error.message);
    await loadLinks();
  }
}

function renderImage(container, link) {
  const img = container.querySelector(".tile-img");
  const letter = container.querySelector(".tile-letter");
  if (link.image_url) {
    img.src = link.image_url;
    img.alt = link.title || "";
    img.classList.remove("hidden");
    letter.classList.add("hidden");
    img.onerror = () => {
      img.classList.add("hidden");
      letter.classList.remove("hidden");
      letter.textContent = firstLetter(link.title);
    };
  } else {
    img.removeAttribute("src");
    img.classList.add("hidden");
    letter.classList.remove("hidden");
    letter.textContent = firstLetter(link.title);
  }
}

function renderEditorImagePreview(url, title = "") {
  els.avatarPreviewBox.replaceChildren();
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = title || "";
    img.onerror = () => {
      els.avatarPreviewBox.replaceChildren(els.avatarFallback);
      els.avatarFallback.textContent = firstLetter(title);
    };
    els.avatarPreviewBox.appendChild(img);
  } else {
    els.avatarFallback.textContent = firstLetter(title);
    els.avatarPreviewBox.appendChild(els.avatarFallback);
  }
}

function firstLetter(text) {
  return (text || "Q").trim().slice(0, 1).toUpperCase();
}

function openPreferred(link) {
  if (link.internal_url && link.proxy_enabled) {
    openProxyInline(link);
  } else if (link.external_url) {
    window.open(link.external_url, "_blank", "noopener");
  } else if (link.internal_url) {
    window.open(link.internal_url, "_blank", "noopener");
  }
}

function preparePanel(link) {
  const canProxy = Boolean(link.internal_url && link.proxy_enabled);
  state.selectedLink = link;
  state.inlineProxyId = canProxy ? link.id : null;
  els.proxyTitle.textContent = link.title;
  els.inlineInternalUrl.textContent = link.internal_url || "未设置";
  els.inlineExternalUrl.textContent = link.external_url || "未设置";
  els.inlineProxyBtn.classList.toggle("hidden", !canProxy);
  els.inlineProxyBtn.disabled = !canProxy;
  els.inlineProxyBtn.textContent = "透传";
  if (canProxy) {
    setProxyContextCookies(link.id);
  }
}

function morphTileToPanel(tile, link) {
  if (state.morphing) return;
  state.morphing = true;
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  preparePanel(link);

  const sourceRect = tile.getBoundingClientRect();
  const clone = tile.cloneNode(true);
  clone.classList.add("tile-ghost");
  clone.style.position = "fixed";
  clone.style.left = "0px";
  clone.style.top = "0px";
  clone.style.margin = "0";
  clone.style.width = sourceRect.width + "px";
  clone.style.height = sourceRect.height + "px";
  clone.style.transformOrigin = "center center";
  clone.style.zIndex = "40";
  const startTransform = `translate3d(${sourceRect.left}px, ${sourceRect.top}px, 0) scale(1) rotate(0deg)`;
  clone.style.transform = startTransform;
  document.body.appendChild(clone);
  tile.style.visibility = "hidden";

  const finishMorph = () => {
    clone.remove();
    tile.style.visibility = "";
    els.proxyPane.classList.remove("morphing");
    els.proxyPane.classList.remove("hidden");
    document.body.classList.add("detail-open");
    els.proxyPane.focus({ preventScroll: true });
    state.morphing = false;
  };

  const animation = clone.animate(
    [
      {
        transform: startTransform,
        opacity: 1,
        filter: "blur(0px)",
      },
      {
        transform: `translate3d(${sourceRect.left}px, ${sourceRect.top - 4}px, 0) scale(1.018) rotate(0deg)`,
        opacity: 0.92,
        filter: "blur(0px)",
        offset: 0.42,
      },
      {
        transform: `translate3d(${sourceRect.left}px, ${sourceRect.top}px, 0) scale(0.985) rotate(0deg)`,
        opacity: 0,
        filter: "blur(8px)",
      },
    ],
    { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" }
  );
  animation.onfinish = finishMorph;
  animation.oncancel = finishMorph;
}

function openProxyInline(link) {
  preparePanel(link);
  els.proxyPane.classList.remove("hidden");
  document.body.classList.add("detail-open");
  els.proxyPane.focus({ preventScroll: true });
}

async function openProxyPage(link) {
  const newWindow = window.open("about:blank", "_blank");
  if (newWindow) {
    newWindow.opener = null;
  }
  try {
    const result = await send("links.proxy_url", { id: link.id });
    const target = result.chromium_url || result.view_url;
    if (newWindow) {
      newWindow.location.href = target;
    } else {
      window.open(target, "_blank", "noopener");
    }
  } catch (error) {
    if (newWindow) {
      newWindow.close();
    }
    alert(error.message);
  }
}

function openEditor(link) {
  document.querySelector("#dialogTitle").textContent = link ? "编辑链接" : "新建链接";
  els.linkError.textContent = "";
  fields.id.value = link?.id || "";
  fields.title.value = link?.title || "";
  fields.description.value = link?.description || "";
  fields.image_url.value = link?.image_url || "";
  fields.image_upload.value = "";
  renderEditorImagePreview(fields.image_url.value, fields.title.value);
  fields.external_url.value = link?.external_url || "";
  fields.internal_url.value = link?.internal_url || "";
  fields.sort_order.value = link?.sort_order || 0;
  fields.proxy_enabled.checked = link ? Boolean(link.internal_url && link.proxy_enabled) : true;
  els.deleteLinkBtn.classList.toggle("hidden", !link);
  els.dialog.showModal();
}

function readForm() {
  return {
    id: fields.id.value ? Number(fields.id.value) : null,
    title: fields.title.value,
    description: fields.description.value,
    image_url: fields.image_url.value,
    external_url: fields.external_url.value,
    internal_url: fields.internal_url.value,
    sort_order: Number(fields.sort_order.value || 0),
    proxy_enabled: fields.proxy_enabled.checked,
  };
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.loginError.textContent = "";
  try {
    const result = await send("auth.login", {
      username: els.username.value,
      password: els.password.value,
    });
    state.token = result.token;
    state.user = result.user;
    syncAuthCookie(state.token);
    if (els.rememberLogin.checked) {
      localStorage.setItem("queqiao.remember", "1");
      localStorage.setItem("queqiao.token", state.token);
      localStorage.setItem("queqiao.username", els.username.value);
    } else {
      localStorage.removeItem("queqiao.remember");
      localStorage.removeItem("queqiao.token");
      localStorage.removeItem("queqiao.username");
    }
    els.password.value = "";
    showDashboard();
    await loadLinks();
  } catch (error) {
    els.loginError.textContent = error.message;
  }
});

els.logoutBtn.addEventListener("click", async () => {
  closeSettingsMenu();
  try {
    await send("auth.logout", {});
  } catch {}
  localStorage.removeItem("queqiao.token");
  localStorage.removeItem("queqiao.remember");
  localStorage.removeItem("queqiao.username");
  els.rememberLogin.checked = false;
  els.username.value = "";
  els.password.value = "";
  state.token = "";
  state.user = null;
  syncAuthCookie("");
  showLogin();
});

function closeSettingsMenu() {
  els.settingsMenu.classList.add("hidden");
  els.settingsMenuBtn.setAttribute("aria-expanded", "false");
}

els.settingsMenuBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  const opened = els.settingsMenu.classList.toggle("hidden");
  els.settingsMenuBtn.setAttribute("aria-expanded", String(!opened));
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".settings-menu")) {
    closeSettingsMenu();
  }
});

els.addLinkBtn.addEventListener("click", () => {
  closeSettingsMenu();
  openEditor(null);
});
els.editModeBtn.addEventListener("click", () => {
  closeSettingsMenu();
  state.editMode = !state.editMode;
  els.dashboardView.classList.toggle("edit-mode", state.editMode);
  els.editModeBtn.textContent = state.editMode ? "完成编辑" : "编辑模式";
  renderLinks();
});
els.settingsBtn.addEventListener("click", () => {
  closeSettingsMenu();
  els.settingsError.textContent = "";
  els.currentPassword.value = "";
  els.newPassword.value = "";
  els.confirmPassword.value = "";
  els.settingsDialog.showModal();
});
els.searchInput.addEventListener("input", renderLinks);
els.closeDialogBtn.addEventListener("click", () => els.dialog.close());
els.cancelDialogBtn.addEventListener("click", () => els.dialog.close());
els.closeSettingsBtn.addEventListener("click", () => els.settingsDialog.close());
els.cancelSettingsBtn.addEventListener("click", () => els.settingsDialog.close());

async function runChromiumReleaseFrame(url) {
  if (!url) return;
  const frame = document.createElement("iframe");
  frame.src = url;
  frame.title = "释放透传资源";
  frame.style.position = "fixed";
  frame.style.width = "1px";
  frame.style.height = "1px";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.style.left = "-10px";
  frame.style.top = "-10px";
  document.body.appendChild(frame);
  setTimeout(() => frame.remove(), 7000);
}

els.releaseProxyBtn.addEventListener("click", async () => {
  closeSettingsMenu();
  els.releaseProxyBtn.disabled = true;
  els.releaseProxyBtn.textContent = "释放中";
  try {
    const result = await send("proxy.release_all", {});
    localStorage.setItem("queqiao.proxy.release", String(Date.now()));
    await runChromiumReleaseFrame(result.chromium_release_url);
    els.releaseProxyBtn.textContent = "已释放";
    setTimeout(() => {
      els.releaseProxyBtn.disabled = false;
      els.releaseProxyBtn.textContent = "立即释放透传";
    }, 1600);
  } catch (error) {
    els.releaseProxyBtn.textContent = error.message || "释放失败";
    els.releaseProxyBtn.disabled = false;
    setTimeout(() => {
      els.releaseProxyBtn.textContent = "立即释放透传";
    }, 2200);
  }
});

els.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.settingsError.textContent = "";
  if (els.newPassword.value !== els.confirmPassword.value) {
    els.settingsError.textContent = "两次输入的新密码不一致";
    return;
  }
  try {
    await send("user.change_password", {
      current_password: els.currentPassword.value,
      new_password: els.newPassword.value,
    });
    els.settingsDialog.close();
  } catch (error) {
    els.settingsError.textContent = error.message;
  }
});

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("图片读取失败")));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("图片读取失败")));
    image.src = src;
  });
}

async function uploadImageFile(blob) {
  if (blob.size > IMAGE_MAX_BYTES) {
    throw new Error("图片不能超过 8MB");
  }
  const formData = new FormData();
  formData.append("file", blob, "upload.png");
  formData.append("token", state.token);
  const resp = await fetch("/img/upload", { method: "POST", body: formData });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || "图片上传失败");
  }
  const data = await resp.json();
  fields.image_url.value = data.url;
  renderEditorImagePreview(data.url, fields.title.value);
}

const crop = {
  dialog: document.querySelector("#cropDialog"),
  form: document.querySelector("#cropForm"),
  image: document.querySelector("#cropImage"),
  stage: document.querySelector("#cropStage"),
  box: document.querySelector("#cropBox"),
  size: document.querySelector("#cropSize"),
  error: document.querySelector("#cropError"),
  closeBtn: document.querySelector("#closeCropBtn"),
  cancelBtn: document.querySelector("#cancelCropBtn"),
  img: null,
  naturalW: 0,
  naturalH: 0,
  dispW: 0,
  dispH: 0,
  minDim: 0,
  boxSize: 0,
  boxX: 0,
  boxY: 0,
  dragging: false,
  startX: 0,
  startY: 0,
  origX: 0,
  origY: 0,
};

function renderCropBox() {
  crop.box.style.width = crop.boxSize + "px";
  crop.box.style.height = crop.boxSize + "px";
  crop.box.style.left = crop.boxX + "px";
  crop.box.style.top = crop.boxY + "px";
}

function clampCropBox() {
  crop.boxX = Math.min(Math.max(crop.boxX, 0), crop.dispW - crop.boxSize);
  crop.boxY = Math.min(Math.max(crop.boxY, 0), crop.dispH - crop.boxSize);
}

function openCropper(src, img) {
  crop.img = img;
  crop.naturalW = img.naturalWidth;
  crop.naturalH = img.naturalHeight;
  crop.error.textContent = "";
  const MAX = 380;
  const scale = Math.min(1, MAX / Math.max(crop.naturalW, crop.naturalH));
  crop.dispW = Math.max(1, Math.round(crop.naturalW * scale));
  crop.dispH = Math.max(1, Math.round(crop.naturalH * scale));
  crop.minDim = Math.min(crop.dispW, crop.dispH);
  crop.image.src = src;
  crop.image.style.width = crop.dispW + "px";
  crop.image.style.height = crop.dispH + "px";
  crop.size.value = 100;
  crop.boxSize = crop.minDim;
  crop.boxX = (crop.dispW - crop.boxSize) / 2;
  crop.boxY = (crop.dispH - crop.boxSize) / 2;
  renderCropBox();
  crop.dialog.showModal();
}

crop.size.addEventListener("input", () => {
  const pct = Number(crop.size.value) / 100;
  const newSize = Math.max(20, Math.round(crop.minDim * pct));
  const cx = crop.boxX + crop.boxSize / 2;
  const cy = crop.boxY + crop.boxSize / 2;
  crop.boxSize = newSize;
  crop.boxX = cx - newSize / 2;
  crop.boxY = cy - newSize / 2;
  clampCropBox();
  renderCropBox();
});

crop.box.addEventListener("pointerdown", (event) => {
  crop.dragging = true;
  crop.startX = event.clientX;
  crop.startY = event.clientY;
  crop.origX = crop.boxX;
  crop.origY = crop.boxY;
  crop.box.setPointerCapture(event.pointerId);
  crop.box.style.cursor = "grabbing";
});

crop.box.addEventListener("pointermove", (event) => {
  if (!crop.dragging) return;
  crop.boxX = crop.origX + (event.clientX - crop.startX);
  crop.boxY = crop.origY + (event.clientY - crop.startY);
  clampCropBox();
  renderCropBox();
});

const endCropDrag = () => {
  if (!crop.dragging) return;
  crop.dragging = false;
  crop.box.style.cursor = "grab";
};

crop.box.addEventListener("pointerup", endCropDrag);
crop.box.addEventListener("pointercancel", endCropDrag);

crop.closeBtn.addEventListener("click", () => crop.dialog.close());
crop.cancelBtn.addEventListener("click", () => crop.dialog.close());

crop.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!crop.img) return;
  crop.error.textContent = "";
  const scaleN = crop.naturalW / crop.dispW;
  const sx = crop.boxX * scaleN;
  const sy = crop.boxY * scaleN;
  const sSize = crop.boxSize * scaleN;
  const size = Math.max(1, Math.round(sSize));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(crop.img, sx, sy, sSize, sSize, 0, 0, size, size);
  canvas.toBlob(async (blob) => {
    if (!blob) {
      crop.error.textContent = "裁剪失败，请重试";
      return;
    }
    try {
      await uploadImageFile(blob);
      crop.dialog.close();
      fields.image_upload.value = "";
    } catch (error) {
      crop.error.textContent = error.message || "图片上传失败";
    }
  }, "image/png");
});

fields.image_upload.addEventListener("change", async () => {
  const file = fields.image_upload.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    els.linkError.textContent = "请选择图片文件";
    fields.image_upload.value = "";
    return;
  }
  if (file.size > IMAGE_MAX_BYTES) {
    els.linkError.textContent = "图片不能超过 8MB";
    fields.image_upload.value = "";
    return;
  }
  els.linkError.textContent = "";
  try {
    const src = await readFileAsDataURL(file);
    const img = await loadImage(src);
    if (img.naturalWidth === img.naturalHeight) {
      await uploadImageFile(file);
      fields.image_upload.value = "";
    } else {
      openCropper(src, img);
    }
  } catch (error) {
    els.linkError.textContent = error.message || "图片处理失败";
    fields.image_upload.value = "";
  }
});

els.linkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.linkError.textContent = "";
  try {
    await send("links.save", { link: readForm() });
    els.dialog.close();
  } catch (error) {
    els.linkError.textContent = error.message;
  }
});

els.deleteLinkBtn.addEventListener("click", async () => {
  const id = Number(fields.id.value);
  if (!id || !confirm("确定删除这个链接？")) return;
  await send("links.delete", { id });
  els.dialog.close();
});

els.closeProxyBtn.addEventListener("click", () => {
  state.inlineProxyId = null;
  state.selectedLink = null;
  els.proxyPane.classList.add("hidden");
  els.proxyPane.classList.remove("morphing");
  els.proxyPane.style.visibility = "";
  els.proxyPane.style.opacity = "";
  document.body.classList.remove("detail-open");
});

els.inlineEditBtn.addEventListener("click", () => {
  if (state.selectedLink) {
    openEditor(state.selectedLink);
  }
});

els.inlineProxyBtn.addEventListener("click", async () => {
  if (!state.selectedLink || !state.inlineProxyId) return;
  els.inlineProxyBtn.disabled = true;
  els.inlineProxyBtn.textContent = "打开中";
  try {
    await openProxyPage(state.selectedLink);
  } finally {
    if (state.selectedLink && state.inlineProxyId) {
      els.inlineProxyBtn.disabled = false;
      els.inlineProxyBtn.textContent = "透传";
    }
  }
});

function setProxyContextCookies(linkId) {
  document.cookie = `queqiao_proxy_token=${encodeURIComponent(state.token)}; Path=/; SameSite=Lax`;
  document.cookie = `queqiao_proxy_link_id=${encodeURIComponent(linkId)}; Path=/; SameSite=Lax`;
}

function showAppReady() {
  document.body.classList.add("app-ready");
  if (!els.appLoader) return;
  els.appLoader.classList.add("hidden");
  els.appLoader.setAttribute("aria-hidden", "true");
}

function bindClickRipple() {
  document.addEventListener("pointerdown", (event) => {
    const target = event.target.closest("button, .tile-content");
    if (!(target instanceof HTMLElement)) return;
    if (target.classList.contains("icon-btn") || target.classList.contains("gear-btn")) {
      target.classList.add("tap-bounce");
      setTimeout(() => target.classList.remove("tap-bounce"), 220);
      return;
    }
    const rect = target.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.className = "click-ripple";
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    target.appendChild(ripple);
    setTimeout(() => ripple.remove(), 520);
  });
}

restoreLoginPreference();
bindClickRipple();
connect();
window.addEventListener("load", () => {
  setTimeout(showAppReady, 420);
});
