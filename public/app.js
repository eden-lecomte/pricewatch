// Pricewatch dashboard. Plain JS, no build step, no third-party requests.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  const state = { items: [], health: null, filter: store.get("pw-filter") || "all", token: store.get("pw-token"), editing: null, sourceFor: null };
  let currency = "NZD";
  const money = (v) => (v == null || isNaN(v) ? "—" : "$" + Math.round(v).toLocaleString("en-NZ"));

  function ago(iso) {
    if (!iso) return "never";
    const h = (Date.now() - new Date(iso).getTime()) / 36e5;
    if (isNaN(h)) return "—";
    if (h < 1) return Math.max(1, Math.round(h * 60)) + " min ago";
    if (h < 48) return Math.round(h) + " h ago";
    return Math.round(h / 24) + " days ago";
  }

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = "Bearer " + state.token;
    const res = await fetch(path, { ...opts, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || "HTTP " + res.status), { status: res.status });
    return body;
  }

  function spark(hist) {
    const pts = (hist || []).slice(-120);
    if (pts.length < 2) return `<svg class="spark" viewBox="0 0 180 56" role="img" aria-label="Not enough history yet"><text x="0" y="32">History builds over time</text></svg>`;
    const W = 180, H = 56, pad = 4, top = 6, bot = 44;
    const xs = pts.map((p) => new Date(p.t).getTime()), ys = pts.map((p) => p.best);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys), hi = Math.max(...ys);
    const sx = (t) => pad + (W - 2 * pad) * ((t - x0) / ((x1 - x0) || 1));
    const sy = (v) => (hi === lo ? (top + bot) / 2 : bot - (bot - top) * ((v - lo) / (hi - lo)));
    const line = pts.map((p, i) => (i ? "L" : "M") + sx(xs[i]).toFixed(1) + " " + sy(ys[i]).toFixed(1)).join(" ");
    const area = `${line} L${sx(x1).toFixed(1)} ${bot} L${sx(x0).toFixed(1)} ${bot} Z`;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Best price history, low ${money(lo)}, high ${money(hi)}">
      <line x1="${pad}" x2="${W - pad}" y1="${bot}" y2="${bot}" stroke="var(--line)" stroke-width="1"/>
      <path d="${area}" fill="var(--spark-fill)" stroke="none"/>
      <path d="${line}" fill="none" stroke="var(--spark)" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="${sx(xs.at(-1))}" cy="${sy(ys.at(-1))}" r="3" fill="var(--spark)"/>
      <text x="${pad}" y="${H - 1}">low ${money(lo)}</text><text x="${W - pad}" y="${H - 1}" text-anchor="end">high ${money(hi)}</text></svg>`;
  }

  const weekAgo = () => Date.now() - 7 * 864e5;
  function currentAlert(it) {
    const a = (it.alerts || []).find((x) => new Date(x.t).getTime() >= weekAgo());
    if (a) return a;
    if (it.best?.total != null && it.target != null && it.best.total <= it.target) return { kind: "target", msg: "At or under your target" };
    return null;
  }

  function offerRows(it) {
    if (!it.offers.length) return `<p class="extra">No seller pages yet.${state.token ? " Add one below, or add PriceSpy IDs to the item." : ""}</p>`;
    return `<div class="tablewrap"><table><thead><tr><th>Seller</th><th>From</th><th class="r">Price</th><th class="r">Shipping</th><th class="r">Import</th><th class="r">Total</th><th>Stock</th><th>Checked</th></tr></thead><tbody>${
      it.offers.map((o) => {
        const u = safeUrl(o.url);
        const orig = o.currency && o.currency !== currency && o.price != null ? `<div class="muted">${esc(o.currency)} ${Number(o.price).toLocaleString("en-NZ")}</div>` : "";
        const stock = o.inStock === true ? `<span class="chip good">In stock</span>` : o.inStock === false ? `<span class="chip bad">Out</span>` : `<span class="chip">Unknown</span>`;
        const cond = o.condition !== "new" ? ` <span class="chip warn">${esc(o.condition)}</span>` : "";
        const raw = o.raw ? `<div class="muted">${esc(o.raw.slice(0, 140))}</div>` : "";
        const isBest = it.best && it.best.sourceId === o.sourceId;
        return `<tr class="${isBest ? "best" : ""} ${o.stale ? "stale" : ""}"><td>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(o.seller)}</a>` : esc(o.seller)}${cond}<div class="muted">${esc(o.kind)}</div>${raw}${state.token ? `<div class="rm"><button type="button" class="btn danger small" data-rmsrc="${o.sourceId}">Remove</button></div>` : ""}</td><td>${esc(o.country || "—")}</td><td class="r num">${o.price == null ? "—" : money(o.price)}${orig}</td><td class="r num">${o.shipping == null ? "?" : money(o.shipping)}</td><td class="r num">${o.importFees == null ? "—" : money(o.importFees)}</td><td class="r num"><b>${money(o.total)}</b></td><td>${stock}</td><td class="muted">${ago(o.checkedAt)}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  }

  function render() {
    const items = state.items;
    let alerts = 0, drop = null;
    for (const it of items) {
      if (currentAlert(it)) alerts++;
      if (it.vsTrendPct != null && (drop == null || it.vsTrendPct < drop.v)) drop = { v: it.vsTrendPct, name: it.name };
    }
    $("#sCount").textContent = items.length;
    $("#sAlerts").textContent = alerts;
    $("#sDrop").textContent = drop && drop.v < -0.5 ? `${Math.abs(drop.v).toFixed(1)}%` : "None";
    $("#sDrop").title = drop ? drop.name : "";
    document.querySelectorAll("[data-admin]").forEach((el) => (el.hidden = !state.token));
    $("#unlock").textContent = state.token ? "Lock" : "Edit";

    const shown = items.filter((it) =>
      state.filter === "buy" ? it.priority !== "bargain" :
      state.filter === "bargain" ? it.priority === "bargain" :
      state.filter === "alert" ? !!currentAlert(it) : true);
    shown.sort((a, b) => (a.priority === "bargain") - (b.priority === "bargain"));

    const list = $("#list");
    if (!items.length) { list.innerHTML = `<div class="empty"><h2>Nothing on the list yet</h2><p>${state.token ? "Add a product with <b>Add item</b>." : "Click <b>Edit</b> and enter the admin token to add products."}</p></div>`; return; }
    if (!shown.length) { list.innerHTML = `<div class="empty">Nothing matches this filter.</div>`; return; }

    list.innerHTML = shown.map((it) => {
      const a = currentAlert(it), best = it.best, bu = best && safeUrl(best.url);
      const vsT = it.target != null && best?.total != null ? best.total - it.target : null;
      const chips = [
        it.priority === "bargain" ? `<span class="chip">Bargain hunt</span>` : `<span class="chip accent">Shortlist</span>`,
        a ? `<span class="chip ${a.kind === "target" ? "good" : "warn"}">${esc(({ target: "Target hit", drop: "Price drop", discovery: "New seller", restock: "Back in stock" })[a.kind] || a.kind)}</span>` : "",
      ].join("");
      const disc = it.discoveries.length ? `<div><div class="label">Found recently</div><ul>${it.discoveries.map((d) => `<li>${safeUrl(d.url) ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.text)}</a>` : esc(d.text)} <span class="muted">· ${esc(d.origin)}, ${ago(d.t)}</span></li>`).join("")}</ul></div>` : "";
      const alertsHtml = it.alerts.length ? `<div><div class="label">Alerts</div><ul>${it.alerts.map((x) => `<li>${esc(x.msg)} <span class="muted">· ${ago(x.t)}</span></li>`).join("")}</ul></div>` : "";
      const notes = it.notes ? `<div><span class="label">Notes</span> ${esc(it.notes)}</div>` : "";
      const admin = state.token ? `<div class="item-actions"><button type="button" class="btn ghost small" data-edit="${esc(it.id)}">Edit</button><button type="button" class="btn ghost small" data-src="${esc(it.id)}">Add seller page</button><button type="button" class="btn danger small" data-del="${esc(it.id)}">Remove</button><span class="toast" data-msg="${esc(it.id)}" role="status"></span></div>` : "";
      return `<article class="tag" id="${esc(it.id)}" data-alert="${a ? esc(a.kind) : ""}">
        <div class="tag-main">
          <div style="min-width:0">
            <div class="title-row"><h2>${esc(it.name)}</h2>${chips}</div>
            <div class="sub">${esc(it.query)} · ${esc(it.category)}</div>
            <div class="sub">${it.offers.length} seller page${it.offers.length === 1 ? "" : "s"}${best?.checkedAt ? ` · best checked ${ago(best.checkedAt)}` : ""}</div>
          </div>
          <div style="min-width:0">
            <div class="label">Best delivered</div>
            <div class="price num">${money(best?.total)} ${best ? `<small>${bu ? `<a href="${esc(bu)}" target="_blank" rel="noopener noreferrer">${esc(best.seller)}</a>` : esc(best.seller)}</small>` : ""}</div>
            <div class="deltas num">
              ${it.target != null ? `<span class="${vsT != null && vsT <= 0 ? "down" : ""}">target ${money(it.target)}${vsT != null ? ` (${vsT > 0 ? "+" : "−"}${money(Math.abs(vsT))})` : ""}</span>` : `<span class="muted">no target</span>`}
              ${it.vsTrendPct != null ? `<span class="${it.vsTrendPct <= -0.5 ? "down" : it.vsTrendPct >= 0.5 ? "up" : "muted"}">${it.vsTrendPct > 0 ? "+" : ""}${it.vsTrendPct.toFixed(1)}% vs 7-day trend</span>` : ""}
            </div>
          </div>
          <div style="min-width:0">${spark(it.history)}</div>
        </div>
        ${disc || alertsHtml || notes ? `<div class="extra">${disc}${alertsHtml}${notes}</div>` : ""}
        <details class="offers"><summary>All sellers</summary>${offerRows(it)}${admin}</details>
      </article>`;
    }).join("");
  }

  function renderUnlinked(list) {
    const box = $("#unlinked");
    if (!state.token || !list.length) { box.hidden = true; return; }
    const opts = state.items.map((it) => `<option value="${esc(it.id)}">${esc(it.name)}</option>`).join("");
    $("#unlinkedList").innerHTML = list.map((w) => `<div class="uw">
      <div class="t"><b>${esc(w.title)}</b>${w.paused ? ' <span class="chip">Paused</span>' : ""}<div>${safeUrl(w.url) ? `<a href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${esc(w.url)}</a>` : esc(w.url)}</div></div>
      <select aria-label="Item for ${esc(w.title)}" data-uw="${esc(w.uuid)}"><option value="">Choose item…</option>${opts}</select>
      <button type="button" class="btn small" data-link="${esc(w.uuid)}">Link</button></div>`).join("");
    box.hidden = false;
  }

  async function loadUnlinked() {
    if (!state.token) return renderUnlinked([]);
    try { renderUnlinked(await api("/api/watches/unlinked")); } catch { renderUnlinked([]); }
  }

  async function load() {
    try {
      const [health, items] = await Promise.all([api("/api/health"), api("/api/items")]);
      state.health = health; state.items = items; currency = health.baseCurrency || "NZD";
      $("#currencyLabel").textContent = `${currency} · delivered prices`;
      const ls = [health.lastSync.changedetection, health.lastSync.pricespy].filter(Boolean).sort().at(-1);
      $("#lastSync").textContent = ls ? ago(ls) : "not yet";
      const r = health.fx?.rates || {};
      const fxBits = ["USD", "AUD"].filter((c) => r[c] && c !== currency).map((c) => `1 ${c} = ${r[c].toFixed(3)} ${currency}`);
      $("#fx").textContent = fxBits.length ? `FX: ${fxBits.join(" · ")}` : "";
      $("#state").hidden = true;
      render();
      await loadUnlinked();
      if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    } catch (e) {
      $("#state").hidden = false; $("#state").className = "notice warn";
      $("#state").textContent = e.status === 401 ? "This dashboard is private. Click Edit and enter the admin token." : `Couldn't load prices: ${e.message}`;
    }
  }

  // ----- filters
  document.querySelectorAll(".seg button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.f === state.filter));
    b.addEventListener("click", () => {
      state.filter = b.dataset.f; store.set("pw-filter", state.filter);
      document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      render();
    });
  });

  // ----- admin token (kept only in this browser)
  $("#unlock").addEventListener("click", () => {
    if (state.token) { state.token = null; store.set("pw-token", null); render(); renderUnlinked([]); return; }
    const box = $("#state");
    box.hidden = false; box.className = "notice";
    box.innerHTML = `<form id="tokForm" class="formrow"><label class="f" style="flex:1">Admin token<input id="tok" type="password" autocomplete="current-password"></label><button class="btn" type="submit">Unlock</button></form>`;
    $("#tok").focus();
    $("#tokForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      state.token = $("#tok").value.trim();
      try { await api("/api/auth", { method: "POST" }); store.set("pw-token", state.token); box.hidden = true; await load(); }
      catch { state.token = null; box.className = "notice warn"; box.textContent = "That token was not accepted."; }
    });
  });

  // ----- item form
  const form = $("#itemForm");
  function openItemForm(id) {
    state.editing = id || null;
    const it = state.items.find((x) => x.id === id) || {};
    $("#formTitle").textContent = id ? "Edit item" : "Add an item";
    $("#fName").value = it.name || ""; $("#fQuery").value = it.query || ""; $("#fCat").value = it.category || "monitor";
    $("#fPri").value = it.priority || "buy"; $("#fTarget").value = it.target ?? ""; $("#fPs").value = (it.pricespyIds || []).join(", ");
    $("#fUsed").checked = !!it.allowUsed; $("#fNotes").value = it.notes || ""; $("#fMsg").textContent = "";
    $("#sourceForm").hidden = true; form.hidden = false; form.scrollIntoView({ behavior: "smooth" }); $("#fName").focus();
  }
  $("#openAdd").addEventListener("click", () => openItemForm(null));
  $("#fCancel").addEventListener("click", () => (form.hidden = true));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      name: $("#fName").value, query: $("#fQuery").value, category: $("#fCat").value, priority: $("#fPri").value,
      target: $("#fTarget").value === "" ? null : Number($("#fTarget").value),
      pricespyIds: $("#fPs").value.split(/[\s,]+/).filter(Boolean), allowUsed: $("#fUsed").checked, notes: $("#fNotes").value,
    };
    $("#fMsg").textContent = "Saving…";
    try {
      await api(state.editing ? `/api/items/${encodeURIComponent(state.editing)}` : "/api/items", { method: state.editing ? "PATCH" : "POST", body: JSON.stringify(body) });
      form.hidden = true; await load();
    } catch (err) { $("#fMsg").textContent = "Couldn't save: " + err.message; }
  });

  // ----- source form
  const sform = $("#sourceForm");
  $("#sWatch").addEventListener("change", () => ($("#sManual").hidden = $("#sWatch").checked));
  $("#sCancel").addEventListener("click", () => (sform.hidden = true));
  sform.addEventListener("submit", async (e) => {
    e.preventDefault();
    const num = (v) => (v === "" ? null : Number(v));
    const body = { url: $("#sUrl").value, seller: $("#sSeller").value, country: $("#sCountry").value, watch: $("#sWatch").checked,
      price: num($("#sPrice").value), currency: $("#sCur").value, shipping: num($("#sShip").value), importFees: num($("#sImport").value) };
    $("#sMsg").textContent = "Adding…";
    try {
      const r = await api(`/api/items/${encodeURIComponent(state.sourceFor)}/sources`, { method: "POST", body: JSON.stringify(body) });
      $("#sMsg").textContent = r.note || "Added."; sform.reset(); $("#sManual").hidden = true; await load();
    } catch (err) { $("#sMsg").textContent = "Couldn't add: " + err.message; }
  });

  // ----- per-item buttons
  const pendingDelete = new Set();
  $("#list").addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-edit]");
    if (ed) return openItemForm(ed.dataset.edit);
    const src = e.target.closest("[data-src]");
    if (src) {
      state.sourceFor = src.dataset.src;
      $("#sourceTitle").textContent = `Add a seller page: ${state.items.find((x) => x.id === state.sourceFor)?.name || ""}`;
      form.hidden = true; sform.hidden = false; $("#sMsg").textContent = ""; sform.scrollIntoView({ behavior: "smooth" }); $("#sUrl").focus();
      return;
    }
    const del = e.target.closest("[data-del]");
    if (!del) return;
    const id = del.dataset.del, msg = document.querySelector(`[data-msg="${CSS.escape(id)}"]`);
    if (!pendingDelete.has(id)) {
      pendingDelete.add(id); del.textContent = "Click again to remove";
      setTimeout(() => { pendingDelete.delete(id); if (del.isConnected) del.textContent = "Remove"; }, 4000);
      return;
    }
    try { await api(`/api/items/${encodeURIComponent(id)}`, { method: "DELETE" }); await load(); }
    catch (err) { if (msg) msg.textContent = "Couldn't remove: " + err.message; }
  });

  $("#unlinkedList").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-link]");
    if (!b) return;
    const sel = document.querySelector(`select[data-uw="${CSS.escape(b.dataset.link)}"]`);
    if (!sel?.value) { sel?.focus(); return; }
    b.disabled = true; b.textContent = "Linking…";
    try { await api(`/api/watches/${encodeURIComponent(b.dataset.link)}/link`, { method: "POST", body: JSON.stringify({ itemId: sel.value }) }); await load(); }
    catch (err) { b.disabled = false; b.textContent = "Link"; alertBox("Couldn't link: " + err.message); }
  });

  function alertBox(msg) { const st = $("#state"); st.hidden = false; st.className = "notice warn"; st.textContent = msg; }

  const pendingRm = new Set();
  $("#list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-rmsrc]");
    if (!b) return;
    const id = b.dataset.rmsrc;
    if (!pendingRm.has(id)) {
      pendingRm.add(id); b.textContent = "Click again";
      setTimeout(() => { pendingRm.delete(id); if (b.isConnected) b.textContent = "Remove"; }, 4000);
      return;
    }
    try { await api(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" }); await load(); }
    catch (err) { alertBox("Couldn't remove: " + err.message); }
  });

  $("#syncNow").addEventListener("click", async () => {
    $("#syncNow").disabled = true;
    try { await api("/api/sync", { method: "POST" }); setTimeout(load, 15000); } finally { setTimeout(() => ($("#syncNow").disabled = false), 15000); }
  });

  load();
  setInterval(load, 5 * 60_000);
})();
