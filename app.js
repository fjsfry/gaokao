const sampleVolunteerText = `1 河北大学 法学 本科批
2 燕山大学 机械类 本科批
3 河北师范大学 汉语言文学 本科批
4 石家庄铁道大学 土木工程 本科批
5 河北工业大学 计算机类 本科批
6 华北理工大学 临床医学 本科批
7 河北经贸大学 金融学 本科批
8 河北科技大学 软件工程 本科批
9 保定学院 小学教育 本科批
10 河北东方学院 数据科学与大数据技术 本科批`;

let latestLeadSummary = "我想咨询河北省96个志愿逐条风险体检。";
let latestReportPayload = null;
let latestLicenseState = null;
let latestVerifiedLicenseCode = "";
let selectedFileName = "";
let latestAdminDashboard = null;

function createIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

const viewAliases = {
  top: "home",
  product: "product",
  features: "product",
  workflow: "product",
  checkup: "checkup",
  volunteers: "volunteers",
  volunteer: "volunteers",
  "volunteer-table": "volunteers",
  "license-admin": "license-admin",
  sources: "product",
  dimensions: "product",
  sample: "sample",
  audience: "pricing",
  pricing: "pricing",
  faq: "pricing"
};

const volunteerStorageKey = "xunlu.volunteerTable.standardText.v2";

function getAvailableViews() {
  return new Set(Array.from(document.querySelectorAll(".app-view[data-view]")).map((section) => section.dataset.view));
}

function getRouteView() {
  const pathname = window.location.pathname.replace(/^\/+|\/+$/g, "");
  const hashValue = window.location.hash || (pathname ? `#/${pathname}` : "");
  const raw = decodeURIComponent(hashValue)
    .replace(/^#\/?/, "")
    .split(/[?&]/)[0]
    .trim();
  const requested = viewAliases[raw] || raw || "home";
  return getAvailableViews().has(requested) ? requested : "home";
}

function setActiveView(view = getRouteView(), options = {}) {
  const { scroll = true, normalizeHash = false } = options;
  if (view !== "volunteers") {
    setVolunteerWindowExpanded(false);
  }
  if (view !== "checkup") {
    setRiskWindowExpanded(false);
  }
  document.querySelectorAll(".app-view[data-view]").forEach((section) => {
    section.classList.toggle("is-active", section.dataset.view === view);
  });
  document.querySelectorAll("[data-nav-view]").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.navView === view);
  });
  document.body.dataset.currentView = view;
  if (normalizeHash && window.location.hash !== `#/${view}`) {
    window.history.replaceState(null, "", `/#/${view}`);
  }
  if (scroll) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  createIcons();
}

function initNavigation() {
  setActiveView(getRouteView(), { scroll: false, normalizeHash: true });
  window.addEventListener("hashchange", () => setActiveView(getRouteView(), { scroll: true, normalizeHash: true }));
  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#/"]');
    if (!link) return;
    const view = viewAliases[link.getAttribute("href").replace(/^#\/?/, "")] || "home";
    if (view === document.body.dataset.currentView) {
      event.preventDefault();
      setActiveView(view, { scroll: true });
    }
  });
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeNumber(value) {
  const numeric = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function hashString(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function getFormData(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    ...data,
    score: normalizeNumber(data.score),
    rank: normalizeNumber(data.rank),
    volunteers: data.volunteers || "",
    selectedFileName
  };
}

function getLicenseCode() {
  return String(document.querySelector("#licenseCode")?.value || "").trim();
}

function normalizeEnteredLicenseCode(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function isPreviewLicense(license) {
  return String(license?.plan || "") === "preview" || Boolean(license?.previewOnly);
}

function formatDate(value) {
  if (!value) return "长期有效";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "有效期以顾问说明为准";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function describeLicense(license) {
  if (!license) return "";
  if (isPreviewLicense(license)) {
    return `${license.planLabel || "体验预览码"}已通过；可不限次查看每个志愿的往年位次，不生成AI完整报告；有效期：${formatDate(license.expiresAt)}。`;
  }
  if (license.unlimited) {
    const limit = Number(license.maxUsesPerDay || 0);
    return `${license.planLabel}已通过；${limit > 0 ? `每日最多生成${limit}次完整报告` : "不限制生成次数"}；有效期：${formatDate(license.expiresAt)}。`;
  }
  return `${license.planLabel}已通过；剩余 ${license.remainingUses}/${license.totalUses} 次完整报告；有效期：${formatDate(license.expiresAt)}。`;
}

function renderLicenseStatus(message, tone = "muted") {
  const target = document.querySelector("#licenseStatus");
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

function renderAdminStatus(message, tone = "muted") {
  const target = document.querySelector("#licenseAdminStatus");
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

async function verifyLicenseCode(button, options = {}) {
  const { required = false, successToast = true } = options;
  const licenseCode = getLicenseCode();
  if (!licenseCode) {
    latestLicenseState = null;
    latestVerifiedLicenseCode = "";
    renderLicenseStatus("请先输入授权码。未验证前不能生成报告或预览。", "warn");
    toast("请输入授权码");
    document.querySelector("#licenseCode")?.focus();
    if (required) throw new Error("请先输入授权码");
    return null;
  }

  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i data-lucide="loader-circle" aria-hidden="true"></i> 验证中';
    createIcons();
  }

  try {
    const response = await fetch("/api/license/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseCode })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "授权码验证失败");
    }
    latestLicenseState = data.license;
    latestVerifiedLicenseCode = normalizeEnteredLicenseCode(licenseCode);
    renderLicenseStatus(describeLicense(data.license), "success");
    if (successToast) toast("授权码验证通过");
    return data.license;
  } catch (error) {
    latestLicenseState = null;
    latestVerifiedLicenseCode = "";
    const suffix = /联系顾问|联系客服/.test(error.message) ? "" : " 请联系顾问核对。";
    renderLicenseStatus(`${error.message}${suffix}`, "error");
    if (required) throw error;
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original || '<i data-lucide="key-round" aria-hidden="true"></i> 验证授权码';
      createIcons();
    }
  }
}

async function ensureLicenseReady() {
  const licenseCode = getLicenseCode();
  const normalized = normalizeEnteredLicenseCode(licenseCode);
  if (!normalized) {
    latestLicenseState = null;
    latestVerifiedLicenseCode = "";
    renderLicenseStatus("请先输入授权码并验证，通过后才能生成报告或预览。", "warn");
    document.querySelector("#licenseCode")?.focus();
    throw new Error("请先输入授权码");
  }
  if (latestLicenseState && latestVerifiedLicenseCode === normalized) {
    return latestLicenseState;
  }
  renderLicenseStatus("正在验证授权码，通过后即可生成报告或预览。", "muted");
  return verifyLicenseCode(null, { required: true, successToast: false });
}

function getLicenseAdminPayload(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    adminToken: String(data.adminToken || "").trim(),
    plan: String(data.plan || "single"),
    count: Number.parseInt(data.count || "1", 10),
    note: String(data.note || "").trim(),
    expiresAt: String(data.expiresAt || "").trim()
  };
}

function describeCreatedLicense(license) {
  if (isPreviewLicense(license)) {
    return `${license.planLabel || "体验预览码"}，不限次数查看每条志愿往年位次，不生成AI完整报告`;
  }
  if (license.unlimited) {
    const limit = Number(license.maxUsesPerDay || 0);
    return `${license.planLabel}，填报季内可重复生成${limit > 0 ? `，每日上限${limit}次` : ""}`;
  }
  return `${license.planLabel}，共 ${license.totalUses} 次`;
}

function renderAdminLicenses(licenses = []) {
  const target = document.querySelector("#licenseAdminResult");
  if (!target) return;
  if (!licenses.length) {
    target.innerHTML = `
      <div class="admin-empty">
        <i data-lucide="key-round" aria-hidden="true"></i>
        <strong>生成的授权码会显示在这里</strong>
        <p>明文授权码只返回一次，请生成后立即复制给客户或保存到你的私密记录。</p>
      </div>
    `;
    createIcons();
    return;
  }

  const codeLines = licenses.map((item) => item.code).join("\n");
  target.innerHTML = `
    <div class="admin-result-head">
      <div>
        <span>本次已生成</span>
        <strong>${licenses.length} 个授权码</strong>
      </div>
      <button class="outline-button compact" type="button" data-copy-admin-codes>
        <i data-lucide="copy" aria-hidden="true"></i>
        复制全部
      </button>
    </div>
    <div class="admin-code-list">
      ${licenses
        .map(
          (license) => `
            <article class="admin-code-row">
              <div>
                <code class="admin-code-value">${escapeHTML(license.code)}</code>
                <small>${escapeHTML(describeCreatedLicense(license))}；有效期：${escapeHTML(formatDate(license.expiresAt))}</small>
              </div>
              <button class="icon-button" type="button" data-copy-admin-code="${escapeHTML(license.code)}" aria-label="复制授权码">
                <i data-lucide="copy" aria-hidden="true"></i>
              </button>
            </article>
          `
        )
        .join("")}
    </div>
    <textarea class="sr-only" id="licenseAdminCopyText" readonly>${escapeHTML(codeLines)}</textarea>
  `;
  createIcons();
}

async function copyPlainText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.className = "sr-only";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  toast(successMessage);
}

async function createAdminLicenses(form, button) {
  const payload = getLicenseAdminPayload(form);
  if (!payload.adminToken) {
    renderAdminStatus("请输入内部发码口令。", "error");
    form.querySelector("#adminToken")?.focus();
    return;
  }

  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i data-lucide="loader-circle" aria-hidden="true"></i> 生成中';
    createIcons();
  }
  renderAdminStatus("正在写入授权码系统。", "muted");

  try {
    const response = await fetch("/api/admin/license/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "授权码生成失败");
    }
    renderAdminLicenses(data.licenses || []);
    renderAdminStatus("授权码已生成，请立即复制并发给客户。", "success");
    toast("授权码已生成");
    await loadAdminDashboard(null, { silent: true });
  } catch (error) {
    renderAdminStatus(`${error.message} 请检查口令或稍后重试。`, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original || '<i data-lucide="key-round" aria-hidden="true"></i> 生成授权码';
      createIcons();
    }
  }
}

function getAdminDashboardPayload() {
  return {
    adminToken: String(document.querySelector("#adminToken")?.value || "").trim(),
    query: String(document.querySelector("#adminSearch")?.value || "").trim(),
    plan: String(document.querySelector("#adminPlanFilter")?.value || "all"),
    status: String(document.querySelector("#adminStatusFilter")?.value || "all")
  };
}

function adminEventLabel(type) {
  return {
    verify: "验证",
    preview: "生成体验预览",
    consume: "生成报告",
    refund: "返还次数",
    disable: "状态变更"
  }[type] || type || "-";
}

function adminStatusTone(label) {
  if (label === "可使用") return "success";
  if (label === "已过期") return "warn";
  return "muted";
}

function renderAdminMetricGrid(stats = {}) {
  const target = document.querySelector("#adminMetricGrid");
  if (!target) return;
  const cards = [
    ["授权客户数", stats.customerCount ?? 0, "按授权码/备注统计", "users"],
    ["实际使用设备", stats.uniqueDeviceCount ?? 0, "按使用事件统计", "monitor-check"],
    ["已生成报告", stats.reportCount ?? 0, "成功扣次记录", "file-check-2"],
    ["今日生成", stats.todayReportCount ?? 0, "今日完整报告", "calendar-check"],
    ["可用授权码", stats.activeLicenseCount ?? 0, "当前可验证使用", "badge-check"],
    ["剩余次数", stats.remainingFiniteUses ?? 0, "不含填报季卡", "gauge"],
    ["已使用授权码", stats.usedLicenseCount ?? 0, "至少生成过报告", "activity"],
    ["即将到期", stats.expiringSoonCount ?? 0, "14天内到期", "clock-alert"]
  ];
  target.innerHTML = cards
    .map(
      ([label, value, help, icon]) => `
        <article>
          <i data-lucide="${icon}" aria-hidden="true"></i>
          <span>${label}</span>
          <strong>${Number(value || 0).toLocaleString("zh-CN")}</strong>
          <small>${help}</small>
        </article>
      `
    )
    .join("");
  createIcons();
}

function renderAdminLicenseTable(data = {}) {
  const target = document.querySelector("#adminLicenseTable");
  const countNode = document.querySelector("#adminLicenseCount");
  if (!target) return;
  const licenses = data.licenses || [];
  if (countNode) {
    countNode.textContent = `显示 ${data.resultCount || licenses.length} / 共 ${data.totalCount || licenses.length} 个授权码`;
  }
  if (!licenses.length) {
    target.innerHTML = `
      <div class="admin-empty compact">
        <i data-lucide="search-x" aria-hidden="true"></i>
        <strong>没有匹配的授权码</strong>
        <p>请调整搜索词、套餐或状态筛选后再试。</p>
      </div>
    `;
    createIcons();
    return;
  }
  target.innerHTML = `
    <table class="admin-data-table">
      <thead>
        <tr>
          <th>授权码</th>
          <th>客户/套餐</th>
          <th>使用次数</th>
          <th>状态</th>
          <th>最近使用</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${licenses
          .map(
            (item) => `
              <tr>
                <td data-label="授权码">
                  <code>${escapeHTML(item.codeDisplay || item.codePrefix || "-")}</code>
                  <small>${item.canReveal ? "可复制完整码" : "历史旧码仅保留前缀"}</small>
                </td>
                <td data-label="客户/套餐">
                  <strong>${escapeHTML(item.customerNote || "未填写备注")}</strong>
                  <small>${escapeHTML(item.planLabel || "-")} · ${escapeHTML(formatDate(item.expiresAt))}</small>
                </td>
                <td data-label="使用次数">
                  <strong>${item.unlimited ? `${item.usedUses || 0} 次` : `${item.usedUses || 0}/${item.totalUses || 0}`}</strong>
                  <small>${item.unlimited ? `每日上限 ${item.maxUsesPerDay || "不限"}` : `剩余 ${item.remainingUses ?? 0} 次`}</small>
                </td>
                <td data-label="状态">
                  <span class="admin-status ${adminStatusTone(item.statusLabel)}">${escapeHTML(item.statusLabel || "-")}</span>
                </td>
                <td data-label="最近使用">
                  <strong>${escapeHTML(formatDate(item.lastUsedAt || item.lastEventAt))}</strong>
                  <small>${escapeHTML(adminEventLabel(item.lastEventType))}</small>
                </td>
                <td data-label="操作">
                  <div class="admin-row-actions">
                    <button class="icon-button" type="button" data-admin-copy-code="${escapeHTML(item.code || "")}" ${item.code ? "" : "disabled"} aria-label="复制授权码">
                      <i data-lucide="copy" aria-hidden="true"></i>
                    </button>
                    <button class="outline-button compact" type="button" data-admin-license-status="${escapeHTML(item.id || "")}" data-status="${item.status === "active" ? "disabled" : "active"}">
                      ${item.status === "active" ? "停用" : "启用"}
                    </button>
                  </div>
                </td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
  createIcons();
}

function renderAdminEventTable(events = []) {
  const target = document.querySelector("#adminEventTable");
  if (!target) return;
  if (!events.length) {
    target.innerHTML = `
      <div class="admin-empty compact">
        <i data-lucide="activity" aria-hidden="true"></i>
        <strong>暂无使用记录</strong>
        <p>用户验证授权码或生成完整报告后，会在这里出现记录。</p>
      </div>
    `;
    createIcons();
    return;
  }
  target.innerHTML = `
    <table class="admin-data-table compact-table">
      <thead>
        <tr>
          <th>时间</th>
          <th>事件</th>
          <th>授权码</th>
          <th>客户/场景</th>
        </tr>
      </thead>
      <tbody>
        ${events
          .map(
            (item) => `
              <tr>
                <td data-label="时间">${escapeHTML(formatDate(item.createdAt))}</td>
                <td data-label="事件"><span class="admin-status ${["consume", "preview"].includes(item.eventType) ? "success" : "muted"}">${escapeHTML(adminEventLabel(item.eventType))}</span></td>
                <td data-label="授权码">${escapeHTML(item.codePrefix || "-")}<small>${escapeHTML(item.planLabel || "")}</small></td>
                <td data-label="客户/场景">
                  <strong>${escapeHTML(item.customerNote || "未填写备注")}</strong>
                  <small>${escapeHTML([item.subject, item.batch, item.rank ? `位次${item.rank}` : "", item.diagnosisCount ? `${item.diagnosisCount}条志愿` : ""].filter(Boolean).join(" / ") || `设备 ${item.device || "-"}`)}</small>
                </td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
  createIcons();
}

function renderAdminDashboard(data) {
  latestAdminDashboard = data;
  renderAdminMetricGrid(data.stats || {});
  renderAdminLicenseTable(data);
  renderAdminEventTable(data.events || []);
  if (!data.canRevealCodes) {
    renderAdminStatus("后台已读取旧表结构。历史授权码只能显示前缀；应用数据库迁移后，新码可在后台查看完整码。", "warn");
  }
}

async function loadAdminDashboard(button, options = {}) {
  const payload = getAdminDashboardPayload();
  if (!payload.adminToken) {
    renderAdminStatus("请输入管理员口令后再刷新后台。", "error");
    document.querySelector("#adminToken")?.focus();
    return;
  }
  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i data-lucide="loader-circle" aria-hidden="true"></i> 刷新中';
    createIcons();
  }
  if (!options.silent) renderAdminStatus("正在读取后台数据。", "muted");
  try {
    const response = await fetch("/api/admin/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "后台数据读取失败");
    renderAdminDashboard(data);
    if (!options.silent) {
      renderAdminStatus("后台数据已刷新。", "success");
      toast("后台数据已刷新");
    }
  } catch (error) {
    renderAdminStatus(`${error.message} 请检查口令或稍后重试。`, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original || '<i data-lucide="refresh-cw" aria-hidden="true"></i> 刷新后台';
      createIcons();
    }
  }
}

function exportAdminLicensesCsv() {
  const licenses = latestAdminDashboard?.licenses || [];
  if (!licenses.length) {
    toast("请先刷新后台数据");
    return;
  }
  const rows = [
    ["授权码", "客户备注", "套餐", "状态", "已用次数", "总次数", "剩余次数", "创建时间", "最近使用", "有效期"],
    ...licenses.map((item) => [
      item.codeDisplay || item.codePrefix || "",
      item.customerNote || "",
      item.planLabel || "",
      item.statusLabel || "",
      item.usedUses ?? "",
      item.unlimited ? "不限" : item.totalUses ?? "",
      item.unlimited ? "不限" : item.remainingUses ?? "",
      formatDate(item.createdAt),
      formatDate(item.lastUsedAt || item.lastEventAt),
      formatDate(item.expiresAt)
    ])
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `寻鹿升学-授权码列表-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("授权码列表已导出");
}

async function updateAdminLicenseStatus(button) {
  const licenseId = button.dataset.adminLicenseStatus || "";
  const status = button.dataset.status || "";
  const payload = { adminToken: getAdminDashboardPayload().adminToken, licenseId, status };
  if (!payload.adminToken) {
    renderAdminStatus("请输入管理员口令后再操作。", "error");
    return;
  }
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = "处理中";
  try {
    const response = await fetch("/api/admin/license/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "状态更新失败");
    toast(status === "active" ? "授权码已启用" : "授权码已停用");
    await loadAdminDashboard(null, { silent: true });
  } catch (error) {
    renderAdminStatus(`${error.message} 请稍后重试。`, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

function splitKeywords(value) {
  return String(value || "")
    .split(/[、,，\s/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const batchPattern = /本科提前批|本科批|专科批|提前批|普通类本科批|普通本科批|普通类专科批|普通专科批/;
const subjectPattern = /物理科目组合|历史科目组合|物理类|历史类|理工类|文史类|综合改革|不限|首选物理|首选历史/;
const schoolNamePattern =
  /[\u4e00-\u9fa5A-Za-z0-9·（）()]+?(?:高等专科学校|职业技术大学|职业学院|专科学校|医学院|警官学院|师范学院|财经学院|理工学院|科技学院|工程学院|艺术学院|体育学院|政法学院|外国语学院|大学|学院|学校)/;
const headerNoisePattern = /志愿|序号|学校|院校|专业|批次|科目|科类|代码|代号|备注|计划|学制|学费|校区|选科/;

function normalizeCellText(value) {
  return String(value ?? "")
    .replace(/\uFEFF/g, "")
    .replace(/[　\r\n\t]+/g, " ")
    .replace(/[【】\[\]]/g, " ")
    .replace(/[（）]/g, (char) => (char === "（" ? "(" : ")"))
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingCode(value) {
  return normalizeCellText(value)
    .replace(/^(?:第)?\d{1,3}(?:个)?志愿[:：、.\s-]*/u, "")
    .replace(/^(?:院校|学校|专业|计划)?(?:代码|代号|编号)[:：\s]*/u, "")
    .replace(/^[A-Z]?\d{2,8}[A-Z]?(?:组)?[:：、.\s-]*/iu, "")
    .trim();
}

function stripCommonLabel(value) {
  return stripLeadingCode(value)
    .replace(
      /^(?:学校名称|院校名称|招生院校|院校|学校|专业名称|招生专业|专业\(类\)|专业类|专业|录取批次|批次|科目组合|选科要求|科类)[:：\s]*/u,
      ""
    )
    .trim();
}

function stripMetaText(value) {
  return normalizeCellText(value)
    .replace(batchPattern, " ")
    .replace(subjectPattern, " ")
    .replace(/\S*校区/g, " ")
    .replace(/(?:学制|学费|收费|校区|备注|计划数|招生计划)[:：]?\s*[^,，;；]*/g, " ")
    .replace(/\b\d+(?:\.\d+)?(?:分|名|元|年|人)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSchoolDisplay(value) {
  let text = stripCommonLabel(value)
    .replace(/\([^)]*(?:公办|民办|独立学院|中外合作办学|校企合作)[^)]*\)/g, " ")
    .replace(/(?:公办|民办|独立学院|本科|专科|普通类|招生计划|计划数).*$/g, " ")
    .replace(batchPattern, " ")
    .replace(subjectPattern, " ")
    .replace(/\s+/g, " ")
    .trim();
  const schoolMatch = text.match(schoolNamePattern);
  if (schoolMatch) text = schoolMatch[0];
  return text.replace(/[;；,，、]+$/g, "").trim();
}

function cleanMajorDisplay(value) {
  return stripCommonLabel(value)
    .replace(/\([^)]*(?:\d+\s*年|年制|学制)[^)]*\)/g, "")
    .replace(batchPattern, " ")
    .replace(subjectPattern, " ")
    .replace(/\S*校区/g, " ")
    .replace(/^(?:类中|普通类|本科|专科)\s*/g, "")
    .replace(/(?:学制|学费|收费|校区|备注|计划数|招生计划)[:：]?\s*[^,，;；]*/g, " ")
    .replace(/^[A-Z]?\d{2,8}[A-Z]?(?:组)?[:：、.\s-]*/iu, "")
    .replace(/\s+/g, " ")
    .replace(/^[;；,，、]+|[;；,，、]+$/g, "")
    .trim();
}

function simplifyMajorForMatch(value) {
  let text = cleanMajorDisplay(value)
    .replace(/\([^)]*(?:含|包含|方向|培养|校区|学费|年|授予|办学|合作|师范)[^)]*\)/g, "")
    .replace(/(?:含|包含).*/g, "")
    .replace(/[\/／|].*/g, "")
    .replace(/[;；,，、].*/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (/^[\u4e00-\u9fa5]{2,16}类/.test(text)) {
    text = text.replace(/类.*$/, "类");
  }
  return text || cleanMajorDisplay(value);
}

function extractBatchFromCells(cells, fallback = "本科批") {
  const text = cells.map(normalizeCellText).join(" ");
  const match = text.match(batchPattern);
  if (!match) return fallback;
  const value = match[0];
  if (value.includes("专科")) return "专科批";
  if (value.includes("提前")) return "本科提前批";
  return "本科批";
}

function parseOrderNoFromCells(cells, fallbackOrder) {
  for (const cell of cells) {
    const text = normalizeCellText(cell);
    const explicit = text.match(/(?:第)?\s*(\d{1,3})\s*(?:个)?志愿/u);
    const plain = text.match(/^\s*(\d{1,3})(?:[.、\s-]|$)/u);
    const value = Number((explicit || plain || [])[1]);
    if (Number.isInteger(value) && value >= 1 && value <= 200) return value;
  }
  return fallbackOrder;
}

function isHeaderLikeCell(value) {
  const text = normalizeCellText(value);
  return Boolean(text && headerNoisePattern.test(text) && text.length <= 12 && !schoolNamePattern.test(text));
}

function isNoiseCell(value) {
  const text = normalizeCellText(value);
  if (!text) return true;
  if (isHeaderLikeCell(text)) return true;
  if (!/[\u4e00-\u9fa5]/.test(text)) return true;
  if (batchPattern.test(text) || subjectPattern.test(text)) return true;
  if (/^(?:\d+(?:\.\d+)?)(?:分|名|元|年|人)?$/.test(text)) return true;
  if (/^(?:公办|民办|独立学院|中外合作办学|校企合作)$/.test(text)) return true;
  if (/^(?:学制|学费|收费|校区|备注|计划|选科|再选科|首选科目|专业组)[:：]?/.test(text)) return true;
  if (/^(?:不限|不提科目要求|物理|历史|化学|生物|政治|地理)(?:[,，、/ ]|$)/.test(text)) return true;
  return false;
}

function extractLabeledValue(cells, labelPattern) {
  for (const cell of cells) {
    const text = normalizeCellText(cell);
    const match = text.match(new RegExp(`(?:${labelPattern})[^:：]*[:：]\\s*(.+)$`));
    if (match?.[1]) return match[1];
  }
  return "";
}

function extractMajorAfterSchool(combinedText, schoolName) {
  if (!schoolName) return "";
  const start = combinedText.indexOf(schoolName);
  if (start < 0) return "";
  const afterSchool = combinedText.slice(start + schoolName.length);
  return cleanMajorDisplay(stripMetaText(afterSchool));
}

function inferVolunteerFromCells(row, fallbackOrder) {
  const cells = row.map(normalizeCellText).filter(Boolean);
  if (!cells.length) return null;
  const rowText = cells.join(" ");
  if (!/[\u4e00-\u9fa5]/.test(rowText) || /^说明|^注[:：]|合计|总计|志愿填报表|考生信息/.test(rowText)) return null;

  const orderNo = parseOrderNoFromCells(cells, fallbackOrder);
  const batch = extractBatchFromCells(cells);
  const labeledSchool = cleanSchoolDisplay(extractLabeledValue(cells, "学校|院校|招生院校|院校名称|学校名称"));
  const labeledMajor = cleanMajorDisplay(extractLabeledValue(cells, "专业|招生专业|专业名称|专业\\(类\\)|专业类"));

  let schoolName = labeledSchool;
  let schoolCellIndex = -1;
  if (!schoolName) {
    schoolCellIndex = cells.findIndex((cell) => schoolNamePattern.test(cleanSchoolDisplay(cell)));
    if (schoolCellIndex >= 0) {
      schoolName = cleanSchoolDisplay(cells[schoolCellIndex]);
    }
  }
  if (!schoolName) {
    const schoolMatch = rowText.match(schoolNamePattern);
    if (schoolMatch) schoolName = cleanSchoolDisplay(schoolMatch[0]);
  }
  if (!schoolName) return null;

  let majorName = labeledMajor;
  if (!majorName) {
    const afterSchool = extractMajorAfterSchool(rowText, schoolName);
    if (afterSchool) majorName = afterSchool;
  }
  if (!majorName) {
    const orderedCells =
      schoolCellIndex >= 0
        ? [...cells.slice(schoolCellIndex + 1), ...cells.slice(0, schoolCellIndex)]
        : cells;
    const candidates = orderedCells
      .map(cleanMajorDisplay)
      .filter((cell) => cell && !isNoiseCell(cell) && !schoolNamePattern.test(cell) && cell !== schoolName);
    majorName = candidates[0] || "";
  }
  if (!majorName) return null;

  majorName = majorName.replace(schoolName, "").trim();
  if (!majorName || isNoiseCell(majorName)) return null;

  return {
    orderNo,
    schoolName,
    majorName,
    batch,
    matchSchoolName: cleanSchoolDisplay(schoolName),
    matchMajorName: simplifyMajorForMatch(majorName)
  };
}

function parseVolunteerLine(line, fallbackOrder) {
  const cleaned = normalizeCellText(line)
    .replace(/[＋+]/g, " ")
    .trim();

  if (!cleaned || /志愿序号|学校名称|专业名称/.test(cleaned)) return null;

  const cells = cleaned
    .split(/\t|,|，/)
    .map((cell) => cell.trim())
    .filter(Boolean);
  const row = cells.length > 1 ? cells : [cleaned];
  const inferred = inferVolunteerFromCells(row, fallbackOrder);
  if (inferred) return inferred;

  const parts = cleaned
    .replace(/[，,]/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);
  let orderNo = Number.parseInt(parts[0], 10);
  if (Number.isFinite(orderNo)) {
    parts.shift();
  } else {
    orderNo = fallbackOrder;
  }

  const batchIndex = parts.findIndex((part) => batchPattern.test(part));
  const batch = batchIndex >= 0 ? extractBatchFromCells([parts[batchIndex]]) : "本科批";
  const usefulParts = batchIndex >= 0 ? parts.slice(0, batchIndex) : parts;

  if (usefulParts.length < 2) return null;

  const schoolName = cleanSchoolDisplay(usefulParts[0]);
  const majorName = cleanMajorDisplay(usefulParts.slice(1).join(" "));
  if (!schoolName || !majorName) return null;

  return {
    orderNo,
    schoolName,
    majorName,
    batch,
    matchSchoolName: schoolName,
    matchMajorName: simplifyMajorForMatch(majorName)
  };
}

function parseVolunteers(text) {
  const rawText = String(text || "");
  const tableRows = textToVolunteerRows(rawText);
  if (tableRows.length > 1 && (findHeaderIndex(tableRows) >= 0 || tableRows.some((row) => row.length >= 4))) {
    const normalizedText = rowsToVolunteerText(tableRows);
    if (normalizedText) {
      return normalizedText
        .split(/\r?\n/)
        .map((line, index) => parseVolunteerLine(line, index + 1))
        .filter(Boolean)
        .slice(0, 96);
    }
  }

  const rows = rawText
    .split(/\r?\n/)
    .map((line, index) => parseVolunteerLine(line, index + 1))
    .filter(Boolean);

  return rows.slice(0, 96);
}

function estimateHistoricalRanks(volunteer, userRank) {
  const seed = hashString(`${volunteer.schoolName}${volunteer.majorName}`);
  const diffBase = (seed % 30000) - 10000;
  const hotPenalty = /计算机|软件|人工智能|临床|口腔|电气|法学|汉语言/.test(volunteer.majorName) ? -5200 : 0;
  const localBonus = /学院|职业|民办/.test(volunteer.schoolName) ? 7000 : 0;
  const diff = diffBase + hotPenalty + localBonus;
  const weightedRank = Math.max(1, Math.round(userRank + diff));
  const swing = (seed % 9000) + 1800;

  return {
    "2023": Math.max(1, weightedRank + Math.round(swing * 0.42)),
    "2024": Math.max(1, weightedRank - Math.round(swing * 0.24)),
    "2025": Math.max(1, weightedRank - Math.round(swing * 0.18)),
    weightedRank,
    swing
  };
}

function classifyVolunteer(diff, relativeDiff, swing) {
  if (relativeDiff < -0.15) return "极冲";
  if (relativeDiff < -0.05) return "冲";
  if (relativeDiff < 0) return "小冲";
  if (relativeDiff < 0.15) return swing > 8500 ? "小冲" : "稳";
  if (relativeDiff < 0.35) return "保";
  return "垫";
}

function getRiskLevel(score) {
  if (score >= 85) return { label: "低风险", tone: "low" };
  if (score >= 75) return { label: "较低风险", tone: "low" };
  if (score >= 65) return { label: "中风险", tone: "medium" };
  if (score >= 50) return { label: "中高风险", tone: "medium" };
  return { label: "高风险", tone: "high" };
}

function getAction(score, flags) {
  if (flags.belowBatchLine) return "不建议填报";
  if (flags.selectionMismatch) return "建议删除或人工复核";
  if (flags.privateConflict || flags.coopConflict) return "建议替换或下移";
  if (flags.coopReviewNeeded || flags.feeReviewNeeded) return "先核实费用项目";
  if (flags.avoidMatch || flags.remoteConflict || flags.regionMismatch || !flags.preferenceMatch) return "建议沟通后调整";
  if (flags.highFee) return "谨慎填报";
  if (score >= 85) return "强烈建议保留";
  if (score >= 75) return "建议保留";
  if (score >= 65) return "可保留但调整顺序";
  if (score >= 50) return "谨慎填报";
  if (score >= 35) return "建议替换";
  return "建议删除";
}

function estimateAdmissionProbability(score, type, flags, ranks) {
  let value = score;
  if (type === "极冲") value -= 18;
  if (type === "冲") value -= 10;
  if (type === "小冲") value -= 4;
  if (type === "保") value += 7;
  if (type === "垫") value += 10;
  if (ranks.source === "public-data") value += 4;
  if (ranks.source === "score-only") value -= 6;
  if (ranks.source === "estimated") value -= 12;
  if (flags.selectionMismatch || flags.belowBatchLine) value = Math.min(value, 8);
  if (flags.privateConflict || flags.coopConflict) value -= 10;
  if (flags.coopReviewNeeded || flags.feeReviewNeeded) value -= 4;
  if (flags.avoidMatch || flags.remoteConflict || flags.regionMismatch || !flags.preferenceMatch) value -= 3;
  if (flags.planScarcityRisk || flags.newMajorRisk || flags.avgRankPressure || flags.statSpreadRisk) value -= 5;
  const confidence =
    ranks.source === "public-data" && (flags.planEvidenceMatched || flags.majorStatMatched)
      ? "较高"
      : ranks.source === "public-data"
        ? "中等"
        : "需复核";
  const clamped = Math.max(3, Math.min(96, Math.round(value)));
  const spread = confidence === "较高" ? 6 : confidence === "中等" ? 10 : 15;
  const low = Math.max(1, clamped - spread);
  const high = Math.min(98, clamped + spread);
  const label =
    clamped >= 82
      ? "较稳"
      : clamped >= 68
        ? "有机会"
        : clamped >= 48
          ? "不确定"
          : clamped >= 28
            ? "偏低"
            : "很低";
  return {
    value: clamped,
    range: `${low}%–${high}%`,
    label,
    confidence,
    note: confidence === "需复核" ? "公开证据不足，概率仅作结构预估" : "基于位次差、风险项和证据强度估算"
  };
}

function formatProbability(probability) {
  if (!probability) return "需复核";
  return `${probability.range}（${probability.label}）`;
}

function normalizeBatchName(value) {
  const text = String(value || "");
  if (text.includes("专科")) return "专科批";
  if (text.includes("提前")) return "本科提前批";
  return "本科批";
}

function getEvidenceRows(volunteer, dataContext) {
  const key = String(volunteer.orderNo || "");
  return dataContext?.admissionMatches?.[key] || [];
}

function getEnrollmentPlanRows(volunteer, dataContext) {
  const key = String(volunteer.orderNo || "");
  return dataContext?.enrollmentPlanMatches?.[key] || [];
}

function getMajorStatRows(volunteer, dataContext) {
  const key = String(volunteer.orderNo || "");
  return dataContext?.majorStatMatches?.[key] || [];
}

function firstUsefulRow(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function planRequiresChemistry(row) {
  const text = String(row?.selection_requirement || row?.major_remark || "");
  return /化学|物理.*化|化.*物理|再选.*化/.test(text);
}

function planRequiresSubject(row, subjectName) {
  const text = String(row?.selection_requirement || row?.major_remark || "");
  return subjectName ? text.includes(subjectName) : false;
}

function planIsNewMajor(row) {
  return /^(true|1|yes)$/i.test(String(row?.is_new_major || "")) || /新增|新设|首次招生/.test(String(row?.major_remark || ""));
}

function planProjectText(row) {
  return [
    row?.major_remark,
    row?.level,
    row?.major_name,
    row?.discipline_category,
    row?.major_category,
    row?.selection_requirement
  ]
    .filter(Boolean)
    .join(" ");
}

function planIsCooperationOrHighFee(row) {
  return /中外合作|合作办学|国际项目|国际班|高收费|较高收费|校企合作|联合培养/.test(planProjectText(row));
}

function compactPlanEvidence(rows) {
  const row = firstUsefulRow(rows);
  if (!row) return null;
  const projectText = planProjectText(row);
  return {
    year: row.year,
    planCount: normalizeNumber(row.plan_count),
    selectionRequirement: row.selection_requirement || "",
    tuition: normalizeNumber(row.tuition),
    duration: row.duration || "",
    majorRemark: row.major_remark || "",
    projectText,
    isCooperationOrHighFee: planIsCooperationOrHighFee(row),
    disciplineCategory: row.discipline_category || "",
    majorCategory: row.major_category || "",
    isNewMajor: planIsNewMajor(row),
    matchCount: rows.length,
    sourceUrl: row.source_url || ""
  };
}

function compactMajorStatEvidence(rows) {
  const row = firstUsefulRow(rows);
  if (!row) return null;
  return {
    year: row.year,
    admissionCount: normalizeNumber(row.admission_count),
    minScore: normalizeNumber(row.min_score),
    minRank: normalizeNumber(row.min_rank),
    avgScore: normalizeNumber(row.avg_score),
    avgRank: normalizeNumber(row.avg_rank),
    maxScore: normalizeNumber(row.max_score),
    maxRank: normalizeNumber(row.max_rank),
    matchCount: rows.length,
    sourceUrl: row.source_url || ""
  };
}

function buildRanksFromEvidence(volunteer, formData, dataContext) {
  const fallbackRank = formData.rank || dataContext?.scoreRank?.cumulative_rank || 50000;
  const fallback = estimateHistoricalRanks(volunteer, fallbackRank);
  const rows = getEvidenceRows(volunteer, dataContext);
  const rankedRows = rows.filter((row) => Number(row.min_rank || row.min_rank_estimated) > 0);

  if (!rankedRows.length) {
    return {
      ...fallback,
      source: rows.length ? "score-only" : "estimated",
      matches: rows,
      matchCount: rows.length
    };
  }

  const byYear = {};
  rankedRows.forEach((row) => {
    const year = String(row.year || "");
    const rank = normalizeNumber(row.min_rank || row.min_rank_estimated);
    if (!year || !rank) return;
    if (!byYear[year] || rank < byYear[year]) byYear[year] = rank;
  });
  const years = Object.keys(byYear).sort();
  const weightedRank =
    years.length === 1
      ? byYear[years[0]]
      : Math.round(
          years.reduce((sum, year, index) => sum + byYear[year] * (index + 1), 0) /
            years.reduce((sum, _year, index) => sum + index + 1, 0)
        );
  const rankValues = years.map((year) => byYear[year]);
  const swing = rankValues.length > 1 ? Math.max(...rankValues) - Math.min(...rankValues) : fallback.swing;

  return {
    ...fallback,
    ...byYear,
    weightedRank,
    swing,
    source: "public-data",
    matches: rows,
    matchCount: rows.length
  };
}

function getRelevantBatchLine(formData, dataContext) {
  const batch = normalizeBatchName(formData.batch);
  const rows = dataContext?.batchLines || [];
  return rows.find((row) => String(row.batch || "").includes(batch.replace("批", ""))) || null;
}

function parseBudgetLimit(text) {
  const raw = String(text || "");
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(万|w|W|元)?/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const unit = match[2] || "";
  if (/万|w/i.test(unit) || value < 1000) return Math.round(value * 10000);
  return Math.round(value);
}

function diagnoseVolunteer(volunteer, formData, dataContext = {}) {
  const userRank = formData.rank || dataContext?.scoreRank?.cumulative_rank || 50000;
  const ranks = buildRanksFromEvidence(volunteer, formData, dataContext);
  const diff = ranks.weightedRank - userRank;
  const relativeDiff = diff / Math.max(userRank, 1);
  const type = classifyVolunteer(diff, relativeDiff, ranks.swing);
  const preferred = splitKeywords(formData.preferredMajor);
  const avoid = splitKeywords(formData.avoidMajor);
  const electives = splitKeywords(formData.electives);
  const major = volunteer.majorName;
  const regionPreference = String(formData.regionPreference || "");
  const hebeiSchoolPattern = /河北|石家庄|保定|唐山|秦皇岛|邯郸|邢台|沧州|廊坊|衡水|承德|张家口/;
  const combinedName = `${volunteer.schoolName}${major}`;
  const planRows = getEnrollmentPlanRows(volunteer, dataContext);
  const statRows = getMajorStatRows(volunteer, dataContext);
  const planEvidence = compactPlanEvidence(planRows);
  const statEvidence = compactMajorStatEvidence(statRows);

  const needsChemistry = /临床|口腔|医学|药学|化学|化工|材料|机械|电气|计算机|软件|人工智能|电子|自动化/.test(major);
  const planChemistryMismatch = planRows.some((row) => planRequiresChemistry(row)) && electives.length > 0 && !electives.some((item) => /化学/.test(item));
  const planPhysicsMismatch = planRows.some((row) => planRequiresSubject(row, "物理")) && !String(formData.subject || "").includes("物理");
  const selectionMismatch =
    (formData.subject.includes("物理") && needsChemistry && electives.length > 0 && !electives.some((item) => /化学/.test(item))) ||
    planChemistryMismatch ||
    planPhysicsMismatch;
  const avoidMatch = avoid.some((item) => item && major.includes(item));
  const preferenceMatch = preferred.length === 0 || preferred.some((item) => major.includes(item));
  const regionMismatch = /不接受省外|只接受省内|仅河北|优先省内/.test(regionPreference) && !hebeiSchoolPattern.test(volunteer.schoolName);
  const planProjectEvidence = Boolean(planEvidence?.isCooperationOrHighFee);
  const nameProjectSignal = /中外合作|合作办学|国际项目|国际班|高收费|校企合作|联合培养/.test(combinedName);
  const privateConflict = formData.acceptPrivate === "否" && /民办|独立学院/.test(combinedName);
  const coopConflict = formData.acceptCoop === "否" && planProjectEvidence;
  const coopReviewNeeded = formData.acceptCoop === "否" && nameProjectSignal && !planProjectEvidence;
  const remoteConflict = formData.acceptRemote === "否" && !hebeiSchoolPattern.test(volunteer.schoolName) && /不接受太远|优先省内|河北|石家庄|保定|唐山/.test(regionPreference || "河北");
  const tuition = Number(planEvidence?.tuition || 0);
  const budgetLimit = parseBudgetLimit(formData.budget);
  const tuitionRisk = tuition >= 18000 || (budgetLimit > 0 && tuition > budgetLimit);
  const feeReviewNeeded = nameProjectSignal && !planProjectEvidence && !tuition;
  const planScarcityRisk = Number(planEvidence?.planCount || 0) > 0 && Number(planEvidence?.planCount || 0) <= 2;
  const newMajorRisk = Boolean(planEvidence?.isNewMajor);
  const avgRankPressure = Boolean(statEvidence?.avgRank && userRank > Number(statEvidence.avgRank) * 1.08);
  const statSpreadRisk = Boolean(
    statEvidence?.minRank &&
      statEvidence?.maxRank &&
      Math.abs(Number(statEvidence.maxRank) - Number(statEvidence.minRank)) > Math.max(userRank * 0.15, 6000)
  );
  const highFee = tuitionRisk || planProjectEvidence || (coopConflict && planProjectEvidence);
  const trendRisk = /计算机|软件|人工智能|临床|口腔|电气|法学|汉语言/.test(major) || avgRankPressure;
  const volatilityRisk = ranks.swing > 8000;
  const batchLine = getRelevantBatchLine(formData, dataContext);
  const belowBatchLine = Boolean(batchLine?.control_score && formData.score && formData.score < Number(batchLine.control_score));

  let score = 72;
  score += Math.max(-28, Math.min(24, Math.round(relativeDiff * 120)));
  if (ranks.source === "public-data") score += 4;
  if (planEvidence) score += 2;
  if (statEvidence) score += 2;
  if (ranks.source === "estimated") score -= 8;
  if (type === "强保") score += 8;
  if (type === "保") score += 5;
  if (type === "冲") score -= 10;
  if (type === "极冲") score -= 22;
  if (trendRisk) score -= 7;
  if (volatilityRisk) score -= 6;
  if (planScarcityRisk) score -= 8;
  if (newMajorRisk) score -= 5;
  if (avgRankPressure) score -= 8;
  if (statSpreadRisk) score -= 5;
  if (!preferenceMatch) score -= 2;
  if (regionMismatch) score -= 2;
  if (privateConflict) score -= 12;
  if (coopConflict) score -= 12;
  if (remoteConflict) score -= 3;
  if (coopReviewNeeded || feeReviewNeeded) score -= 4;
  if (highFee) score -= 7;
  if (avoidMatch) score -= 18;
  if (selectionMismatch) score -= 35;
  if (belowBatchLine) score -= 45;
  score = Math.max(0, Math.min(100, score));

  const flags = {
    selectionMismatch,
    avoidMatch,
    highFee,
    tuitionRisk,
    planProjectEvidence,
    nameProjectSignal,
    feeReviewNeeded,
    trendRisk,
    volatilityRisk,
    preferenceMatch,
    regionMismatch,
    privateConflict,
    coopConflict,
    coopReviewNeeded,
    remoteConflict,
    belowBatchLine,
    planScarcityRisk,
    newMajorRisk,
    avgRankPressure,
    statSpreadRisk,
    planEvidenceMatched: Boolean(planEvidence),
    majorStatMatched: Boolean(statEvidence)
  };
  const risk = getRiskLevel(score);
  const action = getAction(score, flags);
  const probability = estimateAdmissionProbability(score, type, flags, ranks);
  const qualification =
    belowBatchLine || selectionMismatch
      ? "不建议填报"
      : privateConflict || coopConflict || highFee
        ? "谨慎填报"
        : coopReviewNeeded || feeReviewNeeded
          ? "需核实费用"
        : remoteConflict || regionMismatch || avoidMatch || !preferenceMatch
          ? "可报，偏好需确认"
        : "可报";
  const reasons = [];

  if (belowBatchLine) reasons.push(`当前分数低于${batchLine.batch}${batchLine.control_score}分控制线，该批次志愿需要调整。`);
  if (ranks.source === "public-data") reasons.push(`匹配到${ranks.matchCount}条河北公开历史投档记录，参考年份为${dataContext.dataYear || "最新可用年份"}。`);
  if (planEvidence) {
    const planBits = [
      planEvidence.year ? `${planEvidence.year}年计划` : "招生计划",
      planEvidence.planCount ? `计划${planEvidence.planCount}人` : "",
      planEvidence.selectionRequirement ? `选科：${planEvidence.selectionRequirement}` : "",
      planEvidence.tuition ? `学费约${planEvidence.tuition}元/年` : "",
      planEvidence.isCooperationOrHighFee ? "备注提示中外合作/高收费项目" : ""
    ].filter(Boolean);
    reasons.push(`已匹配招生计划信息：${planBits.join("，")}。`);
  }
  if (statEvidence) {
    const statBits = [
      statEvidence.year ? `${statEvidence.year}年录取统计` : "录取统计",
      statEvidence.minRank ? `最低位次${statEvidence.minRank}` : "",
      statEvidence.avgRank ? `平均位次${statEvidence.avgRank}` : "",
      statEvidence.admissionCount ? `录取${statEvidence.admissionCount}人` : ""
    ].filter(Boolean);
    reasons.push(`已匹配专业录取统计：${statBits.join("，")}。`);
  }
  if (ranks.source === "score-only") reasons.push("匹配到该校该专业公开分数记录，但部分记录缺少位次，建议人工复核后再下结论。");
  if (ranks.source === "estimated") reasons.push("未匹配到足够公开历史投档记录，本条先按相近规则预估，建议人工复核。");
  if (diff < 0) reasons.push("加权历史最低投档位次高于当前位次，投档安全边际不足。");
  if (diff >= 0) reasons.push(`加权位次安全差约${Math.round(diff)}名，可作为${type}志愿继续核验。`);
  if (trendRisk) reasons.push("专业热度较高，不能只按去年最低位次做判断。");
  if (volatilityRisk) reasons.push("近三年位次波动较大，不适合作为核心保底志愿。");
  if (planScarcityRisk) reasons.push("当年计划人数较少，小计划专业波动更大，不建议作为核心保底。");
  if (newMajorRisk) reasons.push("该专业存在新增或首次招生提示，缺少稳定历史参照，需要人工复核培养方向和计划变化。");
  if (avgRankPressure) reasons.push("近年平均录取位次明显优于当前位次，仅看最低位次容易低估竞争压力。");
  if (statSpreadRisk) reasons.push("该专业录取位次跨度较大，说明冷热或分流波动明显。");
  if (selectionMismatch) reasons.push("该专业可能涉及物理+化学等选科要求，当前选科信息需要硬性核验。");
  if (avoidMatch) reasons.push("专业名称命中偏好提醒项，但用户已放入志愿表，不能仅凭偏好直接删除，建议结合课程和就业方向确认。");
  if (!preferenceMatch) reasons.push("专业名称与偏好方向存在差异，仅作为沟通提醒，不作为直接删除依据。");
  if (regionMismatch) reasons.push("院校地域与当前地域偏好存在差异，仅作为家庭沟通提醒，最终以志愿表真实选择为准。");
  if (privateConflict) reasons.push("家庭当前不接受民办，院校性质可能与偏好冲突。");
  if (coopConflict && planProjectEvidence) reasons.push("招生计划或备注提示中外合作/高收费项目，且家庭当前不接受，需要优先替换或确认费用。");
  if (coopReviewNeeded) reasons.push("名称提示可能涉及中外合作或高收费，当前未匹配到学费/项目备注，需先核实后再判断，不能仅凭名称直接删除。");
  if (remoteConflict) reasons.push("城市接受度需要重点复核，但地域偏好只作为参考，不单独决定删除。");
  if (tuitionRisk) reasons.push("已匹配到学费信息，学费金额可能高于常规或家庭预算，需要确认是否接受。");
  if (feeReviewNeeded) reasons.push("仅从名称看到合作/高收费线索，尚未匹配到学费或招生备注，不能直接按高收费下结论。");

  return {
    ...volunteer,
    score,
    risk,
    action,
    qualification,
    formTarget: formData.familyTarget || "稳妥录取",
    type,
    diff,
    ranks,
    evidenceRows: ranks.matches || [],
    flags,
    planEvidence,
    majorStatEvidence: statEvidence,
    probability,
    reasons: reasons.slice(0, 6)
  };
}

function buildStructureSummary(diagnoses) {
  const total = diagnoses.length || 1;
  const extremeRush = diagnoses.filter((item) => item.type === "极冲").length;
  const rushOnly = diagnoses.filter((item) => item.type === "冲").length;
  const smallRush = diagnoses.filter((item) => item.type === "小冲").length;
  const stable = diagnoses.filter((item) => item.type === "稳").length;
  const safeOnly = diagnoses.filter((item) => item.type === "保").length;
  const cushion = diagnoses.filter((item) => item.type === "垫").length;
  const rush = extremeRush + rushOnly + smallRush;
  const safe = safeOnly + cushion;
  const high = diagnoses.filter((item) => item.risk.tone === "high").length;
  const medium = diagnoses.filter((item) => item.risk.tone === "medium").length;
  const low = diagnoses.filter((item) => item.risk.tone === "low").length;
  const replace = diagnoses.filter((item) => /替换|删除/.test(item.action)).length;
  const invalid = diagnoses.filter((item) => /不建议|删除/.test(item.action) || item.qualification === "不建议填报").length;
  const retreatRisk = diagnoses.filter((item) => item.flags.selectionMismatch || item.flags.belowBatchLine).length;
  const highFeeRisk = diagnoses.filter((item) => {
    const flags = item.flags || {};
    return flags.highFee || flags.tuitionRisk || flags.privateConflict || (flags.coopConflict && flags.planProjectEvidence);
  }).length;
  const selectionMismatch = diagnoses.filter((item) => item.flags.selectionMismatch).length;
  const publicMatched = diagnoses.filter((item) => item.ranks.source === "public-data").length;
  const planMatched = diagnoses.filter((item) => item.flags.planEvidenceMatched).length;
  const statMatched = diagnoses.filter((item) => item.flags.majorStatMatched).length;
  const planScarcity = diagnoses.filter((item) => item.flags.planScarcityRisk).length;
  const newMajor = diagnoses.filter((item) => item.flags.newMajorRisk).length;
  const avgRankPressureCount = diagnoses.filter((item) => item.flags.avgRankPressure).length;
  const needReview = diagnoses.filter((item) => item.ranks.source !== "public-data").length;

  const target = getTargetDistribution(total, diagnoses[0]?.formTarget);
  const referenceRange = getReferenceDistributionRange(target);
  const stableGap = Math.max(0, target.stable - stable);
  const safeGap = Math.max(0, target.safe - safeOnly);
  const cushionGap = Math.max(0, target.cushion - cushion);
  const safetyCount = stable + safeOnly + cushion;
  const rushRatio = rush / total;
  const safetyRatio = safetyCount / total;
  const likelyHigh = diagnoses.filter((item) => Number(item.probability?.value || 0) < 45).length;
  const likelySafe = diagnoses.filter((item) => Number(item.probability?.value || 0) >= 75).length;

  const comments = [];
  comments.push("冲稳保垫分布只作为结构参照，不要求机械套用；最终要结合孩子偏好、位次证据、专业限制和家庭风险承受度动态判断。");
  if (rushRatio > 0.42) comments.push("当前前段冲刺密度偏高，若这些志愿不是强意愿选择，建议把一部分位置让给更能承接的稳妥或保底志愿。");
  if (safetyRatio < 0.42) comments.push("当前稳、保、垫合计承接能力偏弱，整体滑档缓冲不足，建议重点检查后段志愿是否真实可接受。");
  if (safe / total < 0.22) comments.push("后段保底垫底数量偏少或有效性不足，建议优先确认是否存在可接受的兜底院校和专业。");
  if (replace > 0) comments.push(`当前至少有${replace}个志愿需要优先替换或删除。`);
  if (planScarcity + newMajor + avgRankPressureCount > 0) comments.push(`有${planScarcity + newMajor + avgRankPressureCount}处计划人数、新增专业或平均位次压力风险，建议优先复核当年招生计划和专业热度。`);
  if (needReview > total * 0.35) comments.push("部分志愿未直接命中公开历史投档记录，完整报告会标注为需人工复核，不包装成确定结论。");
  if (likelyHigh > total * 0.3) comments.push("预估录取概率偏低的志愿占比较高，AI完整报告会重点判断是否属于有效冲刺还是无效占位。");
  if (likelySafe >= total * 0.45 && replace === 0) comments.push("当前有一定数量的较稳志愿，后续重点是核验专业取舍、费用和地域接受度。");

  const grade =
    invalid > 0 || retreatRisk > 0
      ? "E 严重风险"
      : high > total * 0.22 || rushRatio > 0.48 || likelyHigh > total * 0.36
        ? "D 高风险"
        : rushRatio > 0.42 || safetyRatio < 0.42
          ? "C 风险偏高"
          : replace > 0 || needReview > total * 0.25
            ? "B 基本合理"
            : "A 结构合理";

  return {
    total,
    extremeRush,
    rushOnly,
    smallRush,
    rush,
    stable,
    safeOnly,
    cushion,
    safe,
    high,
    medium,
    low,
    replace,
    invalid,
    retreatRisk,
    highFeeRisk,
    selectionMismatch,
    publicMatched,
    planMatched,
    statMatched,
    planScarcity,
    newMajor,
    avgRankPressureCount,
    needReview,
    target,
    referenceRange,
    stableGap,
    safeGap,
    cushionGap,
    safetyCount,
    likelyHigh,
    likelySafe,
    grade,
    comments
  };
}

function getReferenceDistributionRange(target) {
  return Object.fromEntries(
    Object.entries(target).map(([key, value]) => {
      const buffer = Math.max(1, Math.round(value * 0.25));
      return [key, `${Math.max(0, value - buffer)}–${value + buffer}`];
    })
  );
}

function getTargetDistribution(total, familyTarget = "稳妥录取") {
  const templates = {
    稳妥录取: { extremeRush: 3, rushOnly: 7, smallRush: 10, stable: 36, safe: 30, cushion: 10 },
    专业优先: { extremeRush: 2, rushOnly: 6, smallRush: 10, stable: 38, safe: 30, cushion: 10 },
    学校优先: { extremeRush: 6, rushOnly: 14, smallRush: 12, stable: 32, safe: 24, cushion: 8 },
    保本科优先: { extremeRush: 0, rushOnly: 6, smallRush: 8, stable: 28, safe: 38, cushion: 20 },
    城市优先: { extremeRush: 2, rushOnly: 8, smallRush: 10, stable: 36, safe: 30, cushion: 10 }
  };
  const base = templates[familyTarget] || templates.稳妥录取;
  if (total >= 90) return base;
  const ratio = total / 96;
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key, Math.max(0, Math.round(value * ratio))]));
}

function buildLeadSummary(formData, summary, diagnoses) {
  const clueItems = diagnoses
    .filter((item) => {
      const flags = item.flags || {};
      return (
        item.ranks.source !== "public-data" ||
        flags.selectionMismatch ||
        flags.highFee ||
        flags.feeReviewNeeded ||
        flags.planScarcityRisk ||
        flags.newMajorRisk
      );
    })
    .slice(0, 5)
    .map((item) => {
      const flags = item.flags || {};
      const clues = [
        item.ranks.source === "public-data" ? "命中公开记录" : "需补充公开证据",
        flags.selectionMismatch ? "选科需核验" : "",
        flags.highFee ? "学费/项目性质需确认" : "",
        flags.feeReviewNeeded ? "名称有合作项目线索，需核实学费" : "",
        flags.planScarcityRisk ? "计划数偏少" : "",
        flags.newMajorRisk ? "新增专业波动" : ""
      ]
        .filter(Boolean)
        .join("、");
      return `第${item.orderNo}志愿 ${item.schoolName}+${item.majorName}：${clues}`;
    })
    .join("\n");
  const publicMatched = diagnoses.filter((item) => item.ranks.source === "public-data").length;
  const scoreOnly = diagnoses.filter((item) => item.ranks.source === "score-only").length;
  const estimated = diagnoses.filter((item) => item.ranks.source === "estimated").length;

  return `河北志愿表风险体检咨询
年份：${formData.year}
科目组合：${formData.subject}
批次：${formData.batch}
分数/位次：${formData.score || "未填"} / ${formData.rank || "未填"}
地域偏好：${formData.regionPreference || "未填"}
家庭目标：${formData.familyTarget || "稳妥录取"}
民办/中外合作/偏远城市：${formData.acceptPrivate || "未填"} / ${formData.acceptCoop || "未填"} / ${formData.acceptRemote || "未填"}
志愿数量：${summary.total}条
结构概览：极冲${summary.extremeRush}、冲${summary.rushOnly}、小冲${summary.smallRush}、稳${summary.stable}、保${summary.safeOnly}、垫${summary.cushion}
公开证据覆盖：直接命中${publicMatched}条，分数记录${scoreOnly}条，需复核${estimated}条
计划/专业统计：招生计划${summary.planMatched}条，专业统计${summary.statMatched}条
重点复核线索：
${clueItems || "暂无明显证据缺口，最终概率和去留建议以AI完整报告为准。"}
上传文件：${formData.selectedFileName || "未上传"}
`;
}

function formatMarkdownInline(value) {
  return escapeHTML(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function reportTableWrapClass(columnCount) {
  return ["ai-table-wrap", columnCount >= 6 ? "is-wide" : "", columnCount >= 9 ? "is-extra-wide" : ""]
    .filter(Boolean)
    .join(" ");
}

function renderMarkdownTable(lines) {
  const rows = lines
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
    )
    .filter((row) => row.length > 1);
  if (rows.length < 2) return "";
  const header = rows[0];
  const body = rows.slice(2);
  return `<div class="${reportTableWrapClass(header.length)}" tabindex="0" aria-label="表格可横向滚动"><table class="ai-report-table"><thead><tr>${header
    .map((cell) => `<th>${formatMarkdownInline(cell)}</th>`)
    .join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${header.map((_cell, index) => `<td>${formatMarkdownInline(row[index] || "")}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function markdownToHTML(markdown) {
  const lines = String(markdown || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const html = [];
  let index = 0;

  const isTableDivider = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  const isListLine = (line) => /^(\d+\.|-|•)\s+/.test(line.trim());

  while (index < lines.length) {
    const current = lines[index].trim();
    if (!current) {
      index += 1;
      continue;
    }

    if (/^#{1,3}\s+/.test(current)) {
      html.push(`<h4>${formatMarkdownInline(current.replace(/^#{1,3}\s+/, ""))}</h4>`);
      index += 1;
      continue;
    }

    if (lines[index + 1] && current.includes("|") && isTableDivider(lines[index + 1])) {
      const tableLines = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      html.push(renderMarkdownTable(tableLines));
      continue;
    }

    if (isListLine(current)) {
      const listLines = [];
      while (index < lines.length && isListLine(lines[index])) {
        listLines.push(lines[index].trim());
        index += 1;
      }
      html.push(`<ul>${listLines.map((line) => `<li>${formatMarkdownInline(line.replace(/^(\d+\.|-|•)\s+/, ""))}</li>`).join("")}</ul>`);
      continue;
    }

    const paragraphLines = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^#{1,3}\s+/.test(lines[index].trim()) &&
      !(lines[index + 1] && lines[index].includes("|") && isTableDivider(lines[index + 1])) &&
      !isListLine(lines[index])
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${formatMarkdownInline(paragraphLines.join("\n")).replace(/\n/g, "<br />")}</p>`);
  }

  return html.join("");
}

function tableHTML(headers, rows) {
  return `<div class="${reportTableWrapClass(headers.length)}" tabindex="0" aria-label="表格可横向滚动"><table class="ai-report-table"><thead><tr>${headers
    .map((header) => `<th>${escapeHTML(header)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${headers.map((_header, index) => `<td>${escapeHTML(row[index] ?? "")}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function getDistributionRows(summary) {
  const range = summary.referenceRange || {};
  return [
    ["极冲", summary.extremeRush, range.extremeRush || "-", summary.extremeRush > summary.rush * 0.45 ? "极冲偏多，需确认是否真想冲" : "可保留少量高意愿冲刺"],
    ["冲", summary.rushOnly, range.rushOnly || "-", summary.rushOnly > summary.stable ? "冲刺密度偏高" : "结合意愿和位次差判断"],
    ["小冲", summary.smallRush, range.smallRush || "-", "可作为前中段试探，不宜替代稳妥志愿"],
    ["稳", summary.stable, range.stable || "-", summary.stable + summary.safeOnly < summary.total * 0.45 ? "承接层偏弱，建议重点复核" : "承担主体录取概率"],
    ["保", summary.safeOnly, range.safe || "-", summary.safeOnly + summary.cushion < summary.total * 0.22 ? "后段缓冲偏少" : "保证后段承接"],
    ["垫", summary.cushion, range.cushion || "-", "只保留真实愿意就读的兜底项"]
  ];
}

function getVolunteerReasonableness(item) {
  if (item.qualification === "不建议填报" || /不建议|删除/.test(item.action)) return "不合理";
  if (/替换/.test(item.action)) return "不建议保留原位置";
  if (/下移/.test(item.action)) return "可报但顺序需调整";
  if (item.score >= 85) return "合理";
  if (item.score >= 75) return "基本合理";
  return "需人工复核";
}

function getVolunteerRetentionDecision(item) {
  if (/删除|不建议/.test(item.action)) return "删除";
  if (/替换/.test(item.action)) return /下移/.test(item.action) ? "替换或下移" : "替换";
  if (/下调|下移/.test(item.action)) return "下移";
  if (/保留/.test(item.action)) return "保留";
  if (/复核/.test(item.action)) return "复核后决定";
  return item.action || "复核后决定";
}

function getVolunteerEvidenceLabel(item) {
  const extras = [];
  if (item.planEvidence) extras.push("计划");
  if (item.majorStatEvidence) extras.push("统计");
  const suffix = extras.length ? `+${extras.join("/")}` : "";
  if (item.ranks?.source === "public-data") return `公开记录${suffix}`;
  if (item.ranks?.source === "score-only") return `分数记录${suffix}`;
  return suffix ? `需复核${suffix}` : "需复核";
}

function getVolunteerPlanStatLabel(item) {
  const plan = item.planEvidence;
  const stat = item.majorStatEvidence;
  const parts = [];
  if (plan) {
    parts.push(
      [
        plan.planCount ? `计划${plan.planCount}人` : "",
        plan.selectionRequirement ? `选科${plan.selectionRequirement}` : "",
        plan.tuition ? `学费${plan.tuition}` : "",
        plan.isNewMajor ? "新增" : ""
      ]
        .filter(Boolean)
        .join("，")
    );
  }
  if (stat) {
    parts.push(
      [
        stat.minRank ? `最低位次${stat.minRank}` : "",
        stat.avgRank ? `平均位次${stat.avgRank}` : "",
        stat.admissionCount ? `录取${stat.admissionCount}人` : ""
      ]
        .filter(Boolean)
        .join("，")
    );
  }
  return parts.filter(Boolean).join("；") || "暂未命中";
}

function buildStructuredReportHTML(payload = latestReportPayload) {
  if (!payload?.summary || !payload?.diagnoses) return "";
  const { formData = {}, summary = {}, diagnoses = [] } = payload;
  const priorityRows = diagnoses
    .filter((item) => /替换|删除|下移|谨慎|复核|不建议/.test(item.action))
    .slice(0, 10)
    .map((item) => [
      `第${item.orderNo}志愿`,
      `${item.schoolName} / ${item.majorName}`,
      item.type,
      formatProbability(item.probability),
      item.qualification || item.risk?.label,
      getVolunteerRetentionDecision(item),
      item.reasons?.[0] || "需要结合当年招生计划复核"
    ]);
  const detailRows = diagnoses.map((item) => [
    item.orderNo,
    item.schoolName,
    item.majorName,
    item.type,
    formatProbability(item.probability),
    getVolunteerReasonableness(item),
    getVolunteerRetentionDecision(item),
    item.risk?.label || "",
    getVolunteerEvidenceLabel(item),
    getVolunteerPlanStatLabel(item)
  ]);
  const structureRows = getDistributionRows(summary);
  return `
    <div class="structured-report">
      <div class="report-kpi-grid">
        <article><span>整体风险等级</span><strong>${escapeHTML(summary.grade || "待判断")}</strong></article>
        <article><span>志愿总数</span><strong>${summary.total || 0}</strong></article>
        <article><span>需替换/删除</span><strong>${summary.replace || 0}</strong></article>
        <article><span>需人工复核</span><strong>${summary.needReview || 0}</strong></article>
      </div>
      <h4>考生基本信息</h4>
      ${tableHTML(["项目", "内容"], [
        ["分数 / 位次", `${formData.score || "未填"} / ${formData.rank || "未填"}`],
        ["科类 / 批次", `${formData.subject || "未填"} / ${formData.batch || "未填"}`],
        ["选科 / 目标", `${formData.electives || "未填"} / ${formData.familyTarget || "稳妥录取"}`],
        ["地域 / 费用", `${formData.regionPreference || "不限"} / ${formData.budget || "未填"}`],
        ["民办 / 中外合作 / 偏远城市", `${formData.acceptPrivate || "未填"} / ${formData.acceptCoop || "未填"} / ${formData.acceptRemote || "未填"}`]
      ])}
      <h4>志愿结构分布与参考区间</h4>
      ${tableHTML(["层次", "当前数量", "参考区间", "动态判断"], structureRows)}
      <h4>风险统计</h4>
      ${tableHTML(["指标", "数量", "说明"], [
        ["高风险志愿", summary.high || 0, "优先看位次、限制条件和是否需要替换"],
        ["无效/不建议风险", summary.invalid || 0, "批次、选科、身体或明确偏好冲突"],
        ["高退档风险", summary.retreatRisk || 0, "选科、批次或硬性条件需核验"],
        ["学费/项目性质需确认", summary.highFeeRisk || 0, "以学费、招生备注、项目性质和家庭预算为准；名称线索仅作待核实"],
        ["公开记录命中", summary.publicMatched || 0, "可追溯证据更强"],
        ["需人工复核", summary.needReview || 0, "不能包装成确定结论"]
      ])}
      <h4>优先修改清单</h4>
      ${tableHTML(["序号", "院校/专业", "层次", "预估概率", "可报判断", "去留建议", "主要原因"], priorityRows.length ? priorityRows : [["-", "暂无强制替换项", "-", "-", "可报", "继续核验", "建议核对当年招生计划和院校章程"]])}
      <h4>逐项诊断摘要（覆盖全部志愿）</h4>
      <p class="report-section-note">以下为当前志愿表的全量明细，按志愿顺序展示，不省略中间志愿；完整 PDF 会同步导出本表全部数据。</p>
      ${tableHTML(["序号", "院校", "专业", "层次", "预估概率", "合理性", "去留", "风险", "证据", "计划/统计资料"], detailRows)}
    </div>
  `;
}

function renderAiReport(content, meta = {}) {
  const target = document.querySelector("#aiReport");
  if (!target) return;
  const structuredHTML = buildStructuredReportHTML(latestReportPayload);
  target.innerHTML = `
    <div class="ai-complete-report" id="completeReportExport">
      <div class="ai-report-head">
        <span>完整志愿风险报告</span>
        <strong>${escapeHTML(meta.model ? "AI已生成" : "AI报告")}</strong>
      </div>
      <div class="ai-section-title">家长版完整解读</div>
      <div class="ai-report-body">
        ${structuredHTML}
        <div class="ai-narrative-report">${markdownToHTML(content)}</div>
      </div>
    </div>
    <div class="ai-report-actions">
      <button class="outline-button compact" type="button" data-export-pdf>
        <i data-lucide="download" aria-hidden="true"></i>
        导出完整报告PDF
      </button>
    </div>
  `;
  createIcons();
}

function renderAiStatus(message, tone = "loading") {
  const target = document.querySelector("#aiReport");
  if (!target) return;
  target.innerHTML = `
    <div class="ai-status ${tone}">
      <i data-lucide="${tone === "error" ? "circle-alert" : "loader-circle"}" aria-hidden="true"></i>
      <span>${escapeHTML(message)}</span>
    </div>
  `;
  createIcons();
}

async function refreshReportPayloadForAi() {
  await ensureLicenseReady();
  const basePayload = latestReportPayload || {};
  const formData = { ...(basePayload.formData || {}) };
  const sourceText = formData.volunteers || getStoredVolunteerText() || sampleVolunteerText;
  const volunteers = parseVolunteers(sourceText);
  if (!volunteers.length) {
    throw new Error("未识别到可用于完整报告的志愿表");
  }
  formData.volunteers = volunteers.map(volunteerToTextLine).join("\n");
  const dataContext = await requestDataContext(formData, volunteers);
  const diagnoses = volunteers.map((volunteer) => diagnoseVolunteer(volunteer, formData, dataContext));
  const summary = buildStructureSummary(diagnoses);
  const aiRematch = {
    mode: "pre-ai-public-data-refresh",
    refreshedAt: new Date().toISOString(),
    volunteerCount: volunteers.length,
    publicMatchedCount: diagnoses.filter((item) => item.ranks.source === "public-data").length,
    scoreOnlyCount: diagnoses.filter((item) => item.ranks.source === "score-only").length,
    estimatedCount: diagnoses.filter((item) => item.ranks.source === "estimated").length
  };
  latestLeadSummary = buildLeadSummary(formData, summary, diagnoses);
  latestReportPayload = { formData, sourceVolunteers: volunteers, summary, diagnoses, dataContext, aiRematch };
  return latestReportPayload;
}

function renderReportLoading(message = "正在整理志愿表并生成完整报告。") {
  const target = document.querySelector("#liveReport");
  if (!target) return;
  target.innerHTML = `
    <div class="live-empty live-loading">
      <i data-lucide="loader-circle" aria-hidden="true"></i>
      <h3>${escapeHTML(message)}</h3>
      <p>报告会优先围绕全省位次、近年专业录取位次、招生计划和限制条件进行复核。</p>
    </div>
  `;
  createIcons();
}

function renderReportError(message) {
  const target = document.querySelector("#liveReport");
  if (!target) return;
  const isLicenseError = /授权码|报告码|输入/.test(String(message || ""));
  const title = isLicenseError ? "需要先验证授权码" : "暂时无法读取位次资料";
  const detail = isLicenseError
    ? `${message}。验证通过后才会生成完整报告。`
    : `${message}。可以先联系顾问核对数据状态，完整结论建议在公开证据和AI报告基础上复核。`;
  target.innerHTML = `
    <div class="live-empty">
      <i data-lucide="circle-alert" aria-hidden="true"></i>
      <h3>${escapeHTML(title)}</h3>
      <p>${escapeHTML(detail)}</p>
    </div>
  `;
  createIcons();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("位次资料读取超时，暂未生成完整报告");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function requestDataContext(formData, volunteers) {
  const response = await fetchWithTimeout("/api/checkup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ formData, volunteers, licenseCode: getLicenseCode() })
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "位次资料读取失败");
  }
  if (data.license) {
    latestLicenseState = data.license;
    latestVerifiedLicenseCode = normalizeEnteredLicenseCode(getLicenseCode());
    renderLicenseStatus(describeLicense(data.license), "success");
  }
  return data.context || {};
}

function buildEvidencePreview(item) {
  if (item.ranks.source === "public-data") {
    const years = ["2023", "2024", "2025"]
      .filter((year) => item.ranks[year])
      .map((year) => `${year}最低位次 ${item.ranks[year]}`)
      .join("，");
    const source = item.evidenceRows?.[0]?.source_url;
    return `${years || "已匹配公开投档记录"}。${source ? "支持查看来源链接。" : "来源记录已保留在报告证据中。"}`;
  }
  if (item.ranks.source === "score-only") {
    return "匹配到公开分数记录，但缺少可直接比较的位次字段，建议人工复核。";
  }
  return "本条未精确命中该校该专业近年位次，已按别名、专业简称和更早年份进行核验，当前仅作为结构参照。";
}

function renderDiagnosisDetailCard(item) {
  return `
    <details class="risk-detail-card" ${Number(item.orderNo) <= 2 ? "open" : ""}>
      <summary>
        <span class="risk-order">第${item.orderNo}志愿</span>
        <strong>${escapeHTML(item.schoolName)} + ${escapeHTML(item.majorName)}</strong>
        <span class="tag ${item.risk.tone}">${item.risk.label}</span>
        <span class="tag probability-tag">概率 ${escapeHTML(formatProbability(item.probability))}</span>
        <span class="tag">${escapeHTML(getVolunteerRetentionDecision(item))}</span>
      </summary>
      <div class="risk-detail-body">
        <div class="risk-tags">
          <span class="tag">${item.type}</span>
          <span class="tag">${escapeHTML(item.qualification)}</span>
          <span class="tag">合理性：${escapeHTML(getVolunteerReasonableness(item))}</span>
          <span class="tag">证据：${getVolunteerEvidenceLabel(item)}</span>
          <span class="tag">${escapeHTML(getVolunteerPlanStatLabel(item))}</span>
        </div>
        <p><strong>判断：</strong>${escapeHTML(getVolunteerReasonableness(item))}，建议${escapeHTML(getVolunteerRetentionDecision(item))}。</p>
        <p><strong>原因：</strong>${escapeHTML(item.reasons.slice(0, 3).join("；") || "该志愿需要结合官方数据进一步复核。")}</p>
        <p><strong>概率说明：</strong>${escapeHTML(item.probability?.note || "概率为提交前风险体检估算，不代表录取承诺。")}</p>
        <p>证据摘要：${escapeHTML(buildEvidencePreview(item))}</p>
      </div>
    </details>
  `;
}

function renderRiskOverviewWindow(items, summary) {
  return `
    <div class="risk-overview-window" id="riskOverviewWindow">
      <div class="risk-window-bar">
        <div>
          <span><i data-lucide="panel-top" aria-hidden="true"></i> 逐条风险概览窗口</span>
          <small>默认折叠展示，点击每条可展开；支持放大窗口集中查看。</small>
        </div>
        <button class="outline-button compact window-expand-button" type="button" data-risk-window-expand aria-pressed="false">
          <i data-lucide="maximize-2" aria-hidden="true"></i>
          放大查看
        </button>
      </div>
      <div class="risk-window-scroll">
        ${items.map(renderDiagnosisDetailCard).join("")}
      </div>
      <div class="risk-window-footer">
        <span>已覆盖全部${summary.total}条志愿；概率为区间估算，不构成录取承诺。</span>
        <span>可先处理高风险、概率偏低和证据不足的志愿。</span>
      </div>
    </div>
  `;
}

function rankCell(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number.toLocaleString("zh-CN") : "-";
}

function rankSourceLabel(source) {
  return {
    "public-data": "命中位次记录",
    "score-only": "仅命中分数记录",
    estimated: "需人工复核"
  }[source] || "需人工复核";
}

function renderExperiencePreviewReport(formData, summary, diagnoses, dataContext) {
  const target = document.querySelector("#liveReport");
  if (!target) return;
  const rows = diagnoses.map((item) => [
    item.orderNo,
    item.schoolName,
    item.majorName,
    rankCell(item.ranks?.["2023"]),
    rankCell(item.ranks?.["2024"]),
    rankCell(item.ranks?.["2025"]),
    rankCell(item.ranks?.weightedRank),
    rankSourceLabel(item.ranks?.source),
    getVolunteerPlanStatLabel(item)
  ]);
  target.innerHTML = `
    <div class="live-result experience-preview-result">
      <div class="result-head">
        <div>
          <span class="eyebrow">体验预览已生成</span>
          <h3>${escapeHTML(formData.subject || "科类")} / ${escapeHTML(formData.batch || "批次")} / ${summary.total}条志愿</h3>
          <p class="result-subtitle">体验码仅展示每个志愿匹配到的往年位次和资料状态，帮助你先判断志愿表是否需要进一步复核。</p>
        </div>
        <div class="result-score ai-score-badge">
          <span>授权类型</span>
          <strong>体验码</strong>
        </div>
      </div>

      <div class="result-cards">
        <article class="result-card"><span>志愿数量</span><strong>${summary.total}</strong><small>按当前志愿表顺序</small></article>
        <article class="result-card"><span>位次命中</span><strong>${summary.publicMatched}</strong><small>直接匹配公开位次</small></article>
        <article class="result-card"><span>资料线索</span><strong>${summary.planMatched + summary.statMatched}</strong><small>招生计划/专业统计</small></article>
        <article class="result-card"><span>参考年份</span><strong>${escapeHTML(dataContext.dataYear || "近年")}</strong><small>以位次为主，不按分数判断</small></article>
      </div>

      <div class="diagnosis-card experience-note">
        <span>体验码说明</span>
        <h4>本次不生成AI完整报告，只做往年位次体验预览</h4>
        <p>如果需要逐条录取概率、合理性判断、去留建议、风险原因和PDF完整报告，请购买单次报告码、三次复查码或填报季卡后再生成。</p>
      </div>

      <div class="ai-report-panel experience-table-panel">
        <div class="ai-complete-report experience-preview-report">
          <div class="ai-report-head">
            <span>体验预览明细</span>
            <strong>往年位次表</strong>
          </div>
          <div class="ai-report-body">
            <h4>每个志愿的往年位次与资料状态</h4>
            <p class="report-section-note">表格覆盖当前输入的全部志愿。横向滑动可查看右侧“资料线索”列。</p>
            ${tableHTML(["序号", "院校", "专业", "2023最低位次", "2024最低位次", "2025最低位次", "加权参考位次", "匹配状态", "资料线索"], rows)}
          </div>
        </div>
      </div>

      <div class="next-actions ai-direct-actions">
        <button class="solid-button" type="button" data-open-modal="contactModal" data-package="单次报告码">
          <i data-lucide="key-round" aria-hidden="true"></i>
          购买完整报告码
        </button>
        <button class="outline-button" type="button" data-open-modal="contactModal" data-package="体验预览后咨询">
          <i data-lucide="message-square-text" aria-hidden="true"></i>
          咨询顾问
        </button>
      </div>
    </div>
  `;
  createIcons();
}

function setRiskWindowExpanded(expanded) {
  const windowNode = document.querySelector("#riskOverviewWindow");
  if (!windowNode) return;
  windowNode.classList.toggle("is-window-expanded", Boolean(expanded));
  document.body.classList.toggle("risk-overview-expanded", Boolean(expanded));
  const button = windowNode.querySelector("[data-risk-window-expand]");
  if (button) {
    button.setAttribute("aria-pressed", String(Boolean(expanded)));
    button.innerHTML = expanded
      ? '<i data-lucide="minimize-2" aria-hidden="true"></i> 收起窗口'
      : '<i data-lucide="maximize-2" aria-hidden="true"></i> 放大查看';
    createIcons();
  }
}

async function renderReport(formData) {
  const verifiedLicense = await ensureLicenseReady();
  formData.licenseCode = getLicenseCode();
  const sourceRows = parseVolunteers(formData.volunteers || sampleVolunteerText);
  const volunteers = sourceRows.length ? sourceRows : parseVolunteers(sampleVolunteerText);
  renderReportLoading(
    isPreviewLicense(verifiedLicense)
      ? "体验码已通过，正在按每个志愿匹配往年位次。"
      : "授权码已通过，正在按位次和志愿顺序生成完整报告。"
  );
  let dataContext = {};
  try {
    dataContext = await requestDataContext(formData, volunteers);
  } catch (error) {
    renderReportError(error.message);
    toast("位次资料读取失败，暂未生成报告");
    throw error;
  }

  const diagnoses = volunteers.map((volunteer) => diagnoseVolunteer(volunteer, formData, dataContext));
  const summary = buildStructureSummary(diagnoses);
  latestLeadSummary = buildLeadSummary(formData, summary, diagnoses);
  const aiRematch = {
    mode: "direct-ai-full-report",
    refreshedAt: new Date().toISOString(),
    volunteerCount: volunteers.length,
    publicMatchedCount: diagnoses.filter((item) => item.ranks.source === "public-data").length,
    scoreOnlyCount: diagnoses.filter((item) => item.ranks.source === "score-only").length,
    estimatedCount: diagnoses.filter((item) => item.ranks.source === "estimated").length
  };
  latestReportPayload = { formData, sourceVolunteers: volunteers, summary, diagnoses, dataContext, aiRematch };

  if (isPreviewLicense(latestLicenseState || verifiedLicense)) {
    renderExperiencePreviewReport(formData, summary, diagnoses, dataContext);
    toast("体验预览已生成");
    return;
  }

  document.querySelector("#liveReport").innerHTML = `
    <div class="live-result ai-direct-result">
      <div class="result-head">
        <div>
          <span class="eyebrow">完整报告生成中</span>
          <h3>${escapeHTML(formData.subject)} / ${escapeHTML(formData.batch)} / ${summary.total}条志愿</h3>
          <p class="result-subtitle">参考数据年份：${escapeHTML(dataContext.dataYear || "待匹配")}；${dataContext.scoreRank ? `当前分数约对应位次 ${dataContext.scoreRank.cumulative_rank}` : "位次以表单输入为准"}。报告会以位次为主线，结合志愿顺序、专业要求和家庭偏好判断风险。</p>
        </div>
        <div class="result-score ai-score-badge">
          <span>报告状态</span>
          <strong>生成中</strong>
        </div>
      </div>

      <div class="result-cards">
        <article class="result-card"><span>志愿数量</span><strong>${summary.total}</strong><small>按当前顺序分析</small></article>
        <article class="result-card"><span>公开记录</span><strong>${aiRematch.publicMatchedCount}</strong><small>直接命中投档记录</small></article>
        <article class="result-card"><span>计划/统计</span><strong>${summary.planMatched + summary.statMatched}</strong><small>辅助判断专业热度</small></article>
        <article class="result-card"><span>需复核线索</span><strong>${aiRematch.estimatedCount}</strong><small>由AI降级说明</small></article>
      </div>

      <div class="diagnosis-card">
        <span>分析原则</span>
        <h4>位次优先，分数只作辅助参照</h4>
        <p>报告会结合近年专业录取位次、招生计划、选科限制、地域偏好、费用接受度和当前志愿顺序进行判断。</p>
        <p>冲稳保垫只是参考框架，最终建议会根据当前志愿表的真实分布动态调整；证据不足的条目会标记为需复核。</p>
      </div>

      <div class="ai-report-panel" id="aiReport">
        <div class="ai-status">
          <i data-lucide="loader-circle" aria-hidden="true"></i>
          <span>正在生成完整报告。报告成功返回后才会扣减授权码次数。</span>
        </div>
      </div>

      <div class="next-actions ai-direct-actions">
        <button class="solid-button" type="button" data-open-modal="contactModal" data-package="河北96志愿完整报告">
          <i data-lucide="message-square-text" aria-hidden="true"></i>
          咨询完整报告
        </button>
        <button class="outline-button" type="button" data-copy-inline>
          <i data-lucide="copy" aria-hidden="true"></i>
          复制体检摘要
        </button>
      </div>
    </div>
  `;

  createIcons();

  try {
    const response = await fetchWithTimeout(
      "/api/ai-report",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...latestReportPayload, licenseCode: getLicenseCode() })
      },
      180000
    );
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "AI完整报告生成失败");
    }
    latestLicenseState = data.license || latestLicenseState;
    if (data.license) {
      renderLicenseStatus(describeLicense(data.license), "success");
    }
    renderAiReport(data.content, { model: data.model });
    toast("AI完整报告已生成");
  } catch (error) {
    const cleanMessage = String(error.message || "未知错误").replace(/[。.!！]+$/, "");
    renderAiStatus(`${cleanMessage}。完整报告未成功返回时不会扣减授权码；如果已付款，请联系顾问核对。`, "error");
  }
}

async function copyLeadSummary() {
  const text = latestLeadSummary;
  const textarea = document.querySelector("#leadSummary");
  if (textarea) textarea.value = text;

  try {
    await navigator.clipboard.writeText(text);
    toast("已复制体检摘要");
  } catch {
    if (textarea) {
      textarea.select();
      document.execCommand("copy");
    }
    toast("已复制体检摘要");
  }
}

function getPdfLibraries() {
  const jsPDF = window.jspdf?.jsPDF || window.jsPDF;
  const html2canvas = window.html2canvas;
  return { jsPDF, html2canvas };
}

function pdfTableColumns(count) {
  if (count >= 10) return "34px 1fr 1fr 46px 72px 58px 50px 50px 58px 1.2fr";
  if (count === 9) return "34px 0.95fr 0.95fr 64px 64px 64px 78px 76px 1.2fr";
  if (count === 8) return "38px 0.95fr 0.95fr 50px 76px 78px 1.25fr 0.78fr";
  if (count === 7) return "42px 1.3fr 54px 78px 66px 62px 1.4fr";
  if (count === 4) return "72px 90px 90px 1fr";
  if (count === 3) return "120px 80px 1fr";
  if (count === 2) return "145px 1fr";
  return `repeat(${Math.max(1, count)}, minmax(0, 1fr))`;
}

function convertTablesForPdf(root) {
  root.querySelectorAll(".ai-report-table").forEach((table) => {
    const headers = Array.from(table.querySelectorAll("thead th")).map((cell) => cell.textContent.trim());
    const bodyRows = Array.from(table.querySelectorAll("tbody tr")).map((row) =>
      Array.from(row.children).map((cell) => cell.textContent.trim())
    );
    const columnCount = Math.max(headers.length, ...bodyRows.map((row) => row.length), 1);
    const template = pdfTableColumns(columnCount);
    const grid = document.createElement("div");
    grid.className = "pdf-data-table";
    grid.style.setProperty("--pdf-table-columns", template);

    const makeRow = (cells, className) => {
      const row = document.createElement("div");
      row.className = className;
      row.style.gridTemplateColumns = template;
      for (let index = 0; index < columnCount; index += 1) {
        const cell = document.createElement("div");
        cell.textContent = cells[index] || "";
        row.appendChild(cell);
      }
      return row;
    };

    if (headers.length) grid.appendChild(makeRow(headers, "pdf-table-row pdf-table-head"));
    bodyRows.forEach((row) => grid.appendChild(makeRow(row, "pdf-table-row")));

    const wrap = table.closest(".ai-table-wrap");
    if (wrap) {
      wrap.classList.add("pdf-table-wrap");
      wrap.replaceChildren(grid);
    } else {
      table.replaceWith(grid);
    }
  });
}

function addPdfPageBreakSpacers(root, pageHeightPx) {
  const candidates = Array.from(
    root.querySelectorAll(
      ".ai-report-head, .ai-section-title, .structured-report h4, .ai-narrative-report h4, .report-kpi-grid, .ai-report-body > p, .ai-report-body > ul, .ai-narrative-report > p, .ai-narrative-report > ul, .ai-table-wrap, .pdf-table-row"
    )
  );

  candidates.forEach((element) => {
    if (element.classList.contains("pdf-table-head")) return;
    const rect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const top = rect.top - rootRect.top;
    const height = rect.height;
    if (!height || height > pageHeightPx * 0.86) return;
    const offsetInPage = top % pageHeightPx;
    const remaining = pageHeightPx - offsetInPage;
    if (remaining < Math.min(height + 18, pageHeightPx * 0.34)) {
      const spacer = document.createElement("div");
      spacer.className = "pdf-page-break-spacer";
      spacer.style.height = `${remaining + 10}px`;
      element.parentNode?.insertBefore(spacer, element);
    }
  });
}

async function buildReportCanvasForPdf(report) {
  const { html2canvas } = getPdfLibraries();
  const exportRoot = document.createElement("div");
  exportRoot.className = "pdf-export-root";
  const reportCopy = report.cloneNode(true);
  reportCopy.id = "completeReportExportPdf";
  reportCopy.classList.add("pdf-export-copy");
  convertTablesForPdf(reportCopy);
  exportRoot.appendChild(reportCopy);
  document.body.appendChild(exportRoot);

  try {
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const pageHeightPx = Math.floor(reportCopy.offsetWidth * (297 / 210));
    addPdfPageBreakSpacers(reportCopy, pageHeightPx);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return await html2canvas(reportCopy, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
      scrollX: 0,
      scrollY: 0,
      windowWidth: reportCopy.offsetWidth,
      width: reportCopy.offsetWidth,
      height: reportCopy.scrollHeight
    });
  } finally {
    exportRoot.remove();
  }
}

function saveCanvasAsA4Pdf(canvas, filename) {
  const { jsPDF } = getPdfLibraries();
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
  const pageWidthMm = 210;
  const pageHeightMm = 297;
  const pageHeightPx = Math.floor(canvas.width * (pageHeightMm / pageWidthMm));
  const pageCanvas = document.createElement("canvas");
  const pageContext = pageCanvas.getContext("2d");
  pageCanvas.width = canvas.width;

  let renderedHeight = 0;
  let pageIndex = 0;
  while (renderedHeight < canvas.height) {
    const sliceHeight = Math.min(pageHeightPx, canvas.height - renderedHeight);
    pageCanvas.height = sliceHeight;
    pageContext.fillStyle = "#ffffff";
    pageContext.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    pageContext.drawImage(canvas, 0, renderedHeight, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
    if (pageIndex > 0) pdf.addPage();
    const imageHeightMm = (sliceHeight / canvas.width) * pageWidthMm;
    pdf.addImage(pageCanvas.toDataURL("image/jpeg", 0.94), "JPEG", 0, 0, pageWidthMm, imageHeightMm, undefined, "FAST");
    renderedHeight += sliceHeight;
    pageIndex += 1;
  }

  pdf.save(filename);
  return pageIndex;
}

async function exportReportPdf() {
  const report = document.querySelector("#completeReportExport");
  if (!report) {
    toast("请先生成完整报告，再导出PDF");
    return;
  }
  const { jsPDF, html2canvas } = getPdfLibraries();
  if (typeof jsPDF !== "function" || typeof html2canvas !== "function") {
    toast("PDF导出组件加载失败，请刷新页面后重试");
    return;
  }

  const filename = `寻鹿升学-完整志愿风险报告-${new Date().toISOString().slice(0, 10)}.pdf`;
  try {
    toast("正在生成PDF");
    const canvas = await buildReportCanvasForPdf(report);
    const pageCount = saveCanvasAsA4Pdf(canvas, filename);
    toast(`PDF已生成，共${pageCount}页`);
  } catch (error) {
    toast(error.message || "PDF生成失败，请稍后重试");
  }
}

function toast(message) {
  let node = document.querySelector(".toast");
  if (!node) {
    node = document.createElement("div");
    node.className = "toast";
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add("is-visible");
  window.setTimeout(() => node.classList.remove("is-visible"), 1800);
}

async function loadDataOverview() {
  const nodes = document.querySelectorAll("[data-public-data-status]");
  if (!nodes.length) return;
  try {
    const response = await fetch("/api/data/overview");
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "读取失败");
    const latest = data.latest || {};
    const yearText = latest.year ? `${latest.year}年` : "最新";
    const admissionCount = Number(latest.admission_line_count || 0).toLocaleString("zh-CN");
    const rankCount = Number(latest.score_rank_count || 0).toLocaleString("zh-CN");
    nodes.forEach((node) => {
      node.textContent = `已覆盖至${yearText}：${admissionCount}条投档记录、${rankCount}条一分一档记录`;
    });
  } catch {
    nodes.forEach((node) => {
      node.textContent = "位次资料正在更新，报告会标注需要复核的条目";
    });
  }
}

function openModal(id, packageName) {
  const modal = document.querySelector(`#${id}`);
  if (!modal) return;
  if (packageName) {
    document.querySelector("#contactLead").textContent = `咨询项目：${packageName}。电话：18233662815。你也可以复制下方摘要，通过微信发给顾问。`;
  }
  document.querySelector("#leadSummary").value = latestLeadSummary;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeModals() {
  document.querySelectorAll(".modal").forEach((modal) => {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
  });
  document.body.style.overflow = "";
}

function initMobileCta() {
  const mobileCta = document.querySelector(".mobile-cta");
  if (!mobileCta) return;

  mobileCta.classList.add("is-visible");
}

function downloadTemplate() {
  const rows = [
    ["志愿序号", "学校代码", "学校名称", "专业代码", "专业名称", "学制", "学费", "校区", "备注"],
    ["1", "", "河北大学", "", "法学", "4年", "5060", "", ""],
    ["2", "", "燕山大学", "", "机械类", "4年", "5390", "", ""]
  ];
  const csv = `\uFEFF${rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "河北志愿风险体检模板.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function findHeaderIndex(rows) {
  return rows.findIndex((row) => {
    const text = row.map(normalizeCellText).join(" ");
    return /学校|院校|招生单位/.test(text) && /专业|专业类|专业\(类\)/.test(text);
  });
}

function findColumnIndex(headers, includePatterns, excludePatterns = []) {
  let best = -1;
  let bestScore = 0;
  headers.forEach((header, index) => {
    const text = normalizeCellText(header);
    if (!text || excludePatterns.some((pattern) => pattern.test(text))) return;
    const score = includePatterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

function volunteerToTextLine(record) {
  if (!record?.schoolName || !record?.majorName) return "";
  return [record.orderNo, record.schoolName, record.majorName, record.batch || "本科批"].filter(Boolean).join(" ");
}

function splitDelimitedTextLine(line) {
  const text = normalizeCellText(line);
  if (!text) return [];
  if (text.includes("\t")) return text.split("\t").map(normalizeCellText);
  const delimiter = text.includes(",") ? "," : text.includes("，") ? "，" : "";
  if (!delimiter) return [text];

  const cells = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      cells.push(normalizeCellText(current));
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(normalizeCellText(current));
  return cells;
}

function textToVolunteerRows(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(splitDelimitedTextLine)
    .filter((row) => row.some(Boolean));
}

function rowsToVolunteerText(rows) {
  const cleanedRows = rows
    .map((row) => row.map(normalizeCellText))
    .filter((row) => row.some(Boolean));
  if (!cleanedRows.length) return "";

  const headerIndex = findHeaderIndex(cleanedRows);
  if (headerIndex >= 0) {
    const headers = cleanedRows[headerIndex];
    const orderIndex = findColumnIndex(headers, [/志愿序号/, /志愿号/, /^序号$/, /^志愿$/, /志愿序/, /顺序/, /排序/]);
    const schoolIndex = findColumnIndex(
      headers,
      [/学校名称/, /院校名称/, /招生院校/, /^院校$/, /^学校$/, /招生单位/],
      [/代码/, /代号/, /编号/, /专业组/]
    );
    const majorIndex = findColumnIndex(
      headers,
      [/专业名称/, /招生专业/, /专业\(类\)/, /专业类/, /^专业$/],
      [/代码/, /代号/, /编号/, /组选科/, /组代码/]
    );
    const batchIndex = findColumnIndex(headers, [/批次/, /录取批次/, /层次/]);

    if (schoolIndex >= 0 && majorIndex >= 0) {
      return cleanedRows
        .slice(headerIndex + 1)
        .map((row, index) => {
          const directRecord = {
            orderNo: parseOrderNoFromCells([row[orderIndex]], index + 1),
            schoolName: cleanSchoolDisplay(row[schoolIndex]),
            majorName: cleanMajorDisplay(row[majorIndex]),
            batch: extractBatchFromCells([row[batchIndex]], "本科批")
          };
          const record =
            directRecord.schoolName && directRecord.majorName
              ? directRecord
              : inferVolunteerFromCells(row, index + 1);
          return volunteerToTextLine(record);
        })
        .filter((line) => /[\u4e00-\u9fa5]/.test(line))
        .slice(0, 96)
        .join("\n");
    }
  }

  return cleanedRows
    .map((row, index) => {
      const record = inferVolunteerFromCells(row, index + 1);
      if (record) return volunteerToTextLine(record);
      const hasOrder = /^\d+$/.test(row[0] || "");
      return [hasOrder ? "" : String(index + 1), ...row.slice(0, 8)].filter(Boolean).join(" ");
    })
    .map((line, index) => volunteerToTextLine(parseVolunteerLine(line, index + 1)))
    .filter((line) => /[\u4e00-\u9fa5]/.test(line))
    .slice(0, 96)
    .join("\n");
}

function parseWorkbookFile(file, onSuccess, onError) {
  if (!window.XLSX) {
    onError(new Error("Excel解析组件加载失败，请刷新页面或先导出CSV后上传"));
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const workbook = window.XLSX.read(reader.result, { type: "array" });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) throw new Error("工作簿没有可读取的工作表");
      const rows = window.XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { header: 1, defval: "" });
      const text = rowsToVolunteerText(rows);
      if (!text) throw new Error("没有识别到学校和专业信息");
      onSuccess(text, firstSheetName);
    } catch (error) {
      onError(error);
    }
  });
  reader.addEventListener("error", () => onError(new Error("文件读取失败")));
  reader.readAsArrayBuffer(file);
}

function getCurrentVolunteerBatch() {
  return document.querySelector("#batch")?.value || "本科批";
}

function getStoredVolunteerText() {
  try {
    return localStorage.getItem(volunteerStorageKey) || "";
  } catch {
    return "";
  }
}

function storeVolunteerText(text) {
  try {
    localStorage.setItem(volunteerStorageKey, text || "");
  } catch {
    // Some browsers disable localStorage; the hidden textarea still carries the current form content.
  }
}

function getVolunteerTableElements() {
  return {
    editor: document.querySelector("#volunteerTableEditor"),
    body: document.querySelector("#volunteerTableBody"),
    textarea: document.querySelector("#volunteers"),
    status: document.querySelector("#volunteerTableStatus")
  };
}

function toVolunteerEditorRow(record = {}) {
  return {
    batch: record.batch || "本科批",
    schoolName: record.schoolName || "",
    majorName: record.majorName || ""
  };
}

function normalizeVolunteerEditorRows(rows) {
  const normalized = (Array.isArray(rows) ? rows : [])
    .map(toVolunteerEditorRow)
    .slice(0, 96);
  return normalized.length ? normalized : [toVolunteerEditorRow()];
}

function renderVolunteerEditorRow(row, index) {
  const orderNo = index + 1;
  return `
    <tr data-volunteer-row>
      <td data-label="序号">
        <div class="volunteer-order-cell">
          <button class="drag-handle-button" type="button" draggable="true" data-volunteer-drag title="拖动调整顺序" aria-label="拖动第${orderNo}志愿调整顺序">
            <i data-lucide="grip-vertical" aria-hidden="true"></i>
          </button>
          <span class="volunteer-order" data-volunteer-order>${orderNo}</span>
        </div>
      </td>
      <td data-label="院校名称">
        <input data-volunteer-field="schoolName" value="${escapeHTML(row.schoolName)}" placeholder="如：河北大学" aria-label="第${orderNo}志愿院校名称" />
      </td>
      <td data-label="专业名称">
        <input data-volunteer-field="majorName" value="${escapeHTML(row.majorName)}" placeholder="如：法学" aria-label="第${orderNo}志愿专业名称" />
      </td>
      <td class="volunteer-row-actions" data-label="操作">
        <button class="row-action-button" type="button" data-volunteer-move="-1" title="上调位置" aria-label="上调第${orderNo}志愿">
          <i data-lucide="arrow-up" aria-hidden="true"></i><span>上调</span>
        </button>
        <button class="row-action-button" type="button" data-volunteer-move="1" title="下调位置" aria-label="下调第${orderNo}志愿">
          <i data-lucide="arrow-down" aria-hidden="true"></i><span>下调</span>
        </button>
        <button class="row-action-button danger" type="button" data-volunteer-remove title="删除本行" aria-label="删除第${orderNo}志愿">
          <i data-lucide="trash-2" aria-hidden="true"></i><span>删除</span>
        </button>
      </td>
    </tr>`;
}

function renumberVolunteerTableRows() {
  const { body } = getVolunteerTableElements();
  if (!body) return;
  const rows = Array.from(body.querySelectorAll("[data-volunteer-row]"));
  rows.forEach((row, index) => {
    const orderNo = index + 1;
    const order = row.querySelector("[data-volunteer-order]");
    if (order) order.textContent = String(orderNo);
    const school = row.querySelector('[data-volunteer-field="schoolName"]');
    const major = row.querySelector('[data-volunteer-field="majorName"]');
    if (school) school.setAttribute("aria-label", `第${orderNo}志愿院校名称`);
    if (major) major.setAttribute("aria-label", `第${orderNo}志愿专业名称`);

    const moveUp = row.querySelector('[data-volunteer-move="-1"]');
    const moveDown = row.querySelector('[data-volunteer-move="1"]');
    if (moveUp) {
      moveUp.disabled = index === 0;
      moveUp.setAttribute("aria-label", `上调第${orderNo}志愿`);
    }
    if (moveDown) {
      moveDown.disabled = index === rows.length - 1;
      moveDown.setAttribute("aria-label", `下调第${orderNo}志愿`);
    }
    row.querySelector("[data-volunteer-remove]")?.setAttribute("aria-label", `删除第${orderNo}志愿`);
    row.querySelector("[data-volunteer-drag]")?.setAttribute("aria-label", `拖动第${orderNo}志愿调整顺序`);
  });
}

function readVolunteerRowsFromTable({ completeOnly = false } = {}) {
  const { body } = getVolunteerTableElements();
  if (!body) return [];
  const batch = getCurrentVolunteerBatch();
  const rows = Array.from(body.querySelectorAll("[data-volunteer-row]")).map((row, index) => ({
    orderNo: index + 1,
    batch,
    schoolName: normalizeCellText(row.querySelector('[data-volunteer-field="schoolName"]')?.value || ""),
    majorName: normalizeCellText(row.querySelector('[data-volunteer-field="majorName"]')?.value || "")
  }));
  if (!completeOnly) return rows;
  return rows.filter((row) => row.schoolName && row.majorName);
}

function updateVolunteerTableStatus(summary = {}) {
  const { status } = getVolunteerTableElements();
  if (!status) return;
  const rows = readVolunteerRowsFromTable();
  const completeCount = summary.completeCount ?? rows.filter((row) => row.schoolName && row.majorName).length;
  const partialCount = rows.filter((row) => (row.schoolName || row.majorName) && !(row.schoolName && row.majorName)).length;
  const totalRows = rows.length;
  const warning = partialCount ? `，${partialCount}行缺少院校或专业，提交时会暂不计入` : "";
  status.textContent = `当前表格共${totalRows}行，已识别${completeCount}条完整志愿${warning}；最多支持96条。`;
}

function updateVolunteerSummary(summary = {}) {
  const { textarea } = getVolunteerTableElements();
  const count = summary.completeCount ?? parseVolunteers(textarea?.value || "").length;
  const countNode = document.querySelector("#volunteerSummaryCount");
  const detailNode = document.querySelector("#volunteerSummaryDetail");
  const statusNode = document.querySelector("#volunteerSummaryStatus");
  if (countNode) countNode.textContent = String(count);
  if (detailNode) {
    detailNode.textContent =
      count > 0
        ? `当前将按${count}条志愿生成报告；如需调整顺序，请先进入志愿表页面。`
        : "尚未识别到完整志愿，请先上传 Excel/CSV 或在线录入。";
  }
  if (statusNode) {
    statusNode.textContent =
      count >= 80
        ? "志愿数量已接近完整表，建议重点检查最后20个保底和垫底志愿。"
        : count > 0
          ? "已读取志愿表，数量较少时请确认是否只是局部测试或预览。"
          : "请先确认志愿表顺序，再生成志愿报告。";
  }
}

function syncVolunteerTextareaFromTable() {
  const { textarea } = getVolunteerTableElements();
  if (!textarea) return { completeCount: 0 };
  renumberVolunteerTableRows();
  const completeRows = readVolunteerRowsFromTable({ completeOnly: true }).slice(0, 96);
  textarea.value = completeRows.map((row, index) => volunteerToTextLine({ ...row, orderNo: index + 1 })).join("\n");
  const summary = { completeCount: completeRows.length };
  updateVolunteerTableStatus(summary);
  updateVolunteerSummary(summary);
  storeVolunteerText(textarea.value);
  return summary;
}

function renderVolunteerTableRows(rows) {
  const { body } = getVolunteerTableElements();
  if (!body) return 0;
  const normalizedRows = normalizeVolunteerEditorRows(rows);
  body.innerHTML = normalizedRows.map(renderVolunteerEditorRow).join("");
  createIcons();
  return syncVolunteerTextareaFromTable().completeCount;
}

function renderVolunteerTableFromText(text) {
  const parsedRows = parseVolunteers(text).map(toVolunteerEditorRow);
  return renderVolunteerTableRows(parsedRows);
}

function focusVolunteerRow(row, field = "schoolName") {
  row?.querySelector(`[data-volunteer-field="${field}"]`)?.focus({ preventScroll: true });
}

function setVolunteerWindowExpanded(expanded) {
  const editor = document.querySelector("#volunteerTableEditor");
  const button = document.querySelector("[data-volunteer-expand]");
  if (!editor || !button) return;
  editor.classList.toggle("is-window-expanded", expanded);
  document.body.classList.toggle("volunteer-editor-expanded", expanded);
  button.setAttribute("aria-pressed", String(expanded));
  button.innerHTML = expanded
    ? '<i data-lucide="minimize-2" aria-hidden="true"></i> 收起窗口'
    : '<i data-lucide="maximize-2" aria-hidden="true"></i> 放大编辑';
  createIcons();
}

function initVolunteerTableEditor() {
  const { body, textarea, editor } = getVolunteerTableElements();
  if (!body || !textarea || !editor) return;

  renderVolunteerTableFromText(textarea.value || getStoredVolunteerText() || sampleVolunteerText);
  let draggedVolunteerRow = null;

  body.addEventListener("input", () => {
    syncVolunteerTextareaFromTable();
  });

  body.addEventListener("change", () => {
    syncVolunteerTextareaFromTable();
  });

  body.addEventListener("click", (event) => {
    const moveButton = event.target.closest("[data-volunteer-move]");
    const removeButton = event.target.closest("[data-volunteer-remove]");

    if (moveButton) {
      const row = moveButton.closest("[data-volunteer-row]");
      const direction = Number(moveButton.dataset.volunteerMove);
      if (direction < 0 && row?.previousElementSibling) {
        body.insertBefore(row, row.previousElementSibling);
      }
      if (direction > 0 && row?.nextElementSibling) {
        body.insertBefore(row.nextElementSibling, row);
      }
      syncVolunteerTextareaFromTable();
      focusVolunteerRow(row, "schoolName");
      return;
    }

    if (removeButton) {
      const row = removeButton.closest("[data-volunteer-row]");
      if (body.querySelectorAll("[data-volunteer-row]").length <= 1) {
        renderVolunteerTableRows([toVolunteerEditorRow()]);
      } else {
        row?.remove();
        syncVolunteerTextareaFromTable();
      }
    }
  });

  body.addEventListener("dragstart", (event) => {
    const handle = event.target.closest("[data-volunteer-drag]");
    if (!handle) return;
    draggedVolunteerRow = handle.closest("[data-volunteer-row]");
    if (!draggedVolunteerRow) return;
    draggedVolunteerRow.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedVolunteerRow.querySelector("[data-volunteer-order]")?.textContent || "");
  });

  body.addEventListener("dragover", (event) => {
    if (!draggedVolunteerRow) return;
    const targetRow = event.target.closest("[data-volunteer-row]");
    if (!targetRow || targetRow === draggedVolunteerRow) return;
    event.preventDefault();
    const rect = targetRow.getBoundingClientRect();
    const insertAfter = event.clientY > rect.top + rect.height / 2;
    body.insertBefore(draggedVolunteerRow, insertAfter ? targetRow.nextElementSibling : targetRow);
  });

  body.addEventListener("drop", (event) => {
    if (!draggedVolunteerRow) return;
    event.preventDefault();
    draggedVolunteerRow.classList.remove("is-dragging");
    draggedVolunteerRow = null;
    syncVolunteerTextareaFromTable();
    toast("已按拖拽顺序更新志愿表");
  });

  body.addEventListener("dragend", () => {
    if (draggedVolunteerRow) {
      draggedVolunteerRow.classList.remove("is-dragging");
      draggedVolunteerRow = null;
    }
    syncVolunteerTextareaFromTable();
  });

  document.querySelector("[data-volunteer-add]")?.addEventListener("click", () => {
    const rows = readVolunteerRowsFromTable();
    if (rows.length >= 96) {
      toast("最多支持96条志愿");
      return;
    }
    renderVolunteerTableRows([...rows, toVolunteerEditorRow()]);
    const lastRow = body.querySelector("[data-volunteer-row]:last-child");
    focusVolunteerRow(lastRow, "schoolName");
  });

  document.querySelector("[data-volunteer-renumber]")?.addEventListener("click", () => {
    syncVolunteerTextareaFromTable();
    toast("已按当前表格顺序重新编号");
  });

  document.querySelector("[data-volunteer-expand]")?.addEventListener("click", () => {
    setVolunteerWindowExpanded(!editor.classList.contains("is-window-expanded"));
  });
}

function initFileUpload() {
  const input = document.querySelector("#volunteerFile");
  const status = document.querySelector("#fileStatus");
  const textarea = document.querySelector("#volunteers");
  if (!input || !status || !textarea) return;

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    selectedFileName = file.name;
    status.textContent = `已选择：${file.name}`;

    if (/\.(csv|txt)$/i.test(file.name)) {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const text = String(reader.result || "");
        textarea.value = text;
        storeVolunteerText(text);
        const count = renderVolunteerTableFromText(text);
        status.textContent = `已解析：${file.name}，识别到${count}条志愿。请在下方表格确认顺序后生成报告。`;
      });
      reader.readAsText(file, "utf-8");
    } else if (/\.(xlsx|xls)$/i.test(file.name)) {
      status.textContent = `正在解析：${file.name}`;
      parseWorkbookFile(
        file,
        (text, sheetName) => {
          textarea.value = text;
          storeVolunteerText(text);
          const count = renderVolunteerTableFromText(text);
          status.textContent = `已解析：${file.name} / ${sheetName}，识别到${count}条志愿。请在下方表格继续上调、下调或补充信息。`;
        },
        (error) => {
          status.textContent = `${error.message}。可以重新上传 Excel/CSV，或点击“在线录入志愿”逐行填写。`;
        }
      );
    } else {
      status.textContent = `已选择：${file.name}。当前支持 Excel、CSV、TXT，其他格式请转为表格文件或在线录入。`;
    }
  });
}

function initInteractions() {
  initNavigation();

  const volunteerTextarea = document.querySelector("#volunteers");
  if (volunteerTextarea && !volunteerTextarea.value.trim()) {
    volunteerTextarea.value = getStoredVolunteerText() || sampleVolunteerText;
  }
  initVolunteerTableEditor();

  const form = document.querySelector("#riskForm");
  const licenseAdminForm = document.querySelector("#licenseAdminForm");
  document.querySelector("#licenseCode")?.addEventListener("input", () => {
    latestLicenseState = null;
    latestVerifiedLicenseCode = "";
    renderLicenseStatus("授权码已修改，请重新验证；未通过前不能生成报告或预览。", "muted");
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector(".form-submit");
    const original = submit?.innerHTML;
    if (submit) {
      submit.disabled = true;
      submit.innerHTML = '<i data-lucide="loader-circle" aria-hidden="true"></i> 正在生成报告';
      createIcons();
    }
    syncVolunteerTextareaFromTable();
    const data = getFormData(form);
    try {
      await renderReport(data);
      document.querySelector("#liveReport")?.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) {
      renderReportError(error.message || "授权码校验失败");
      toast(error.message || "请先验证授权码");
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.innerHTML = original || '<i data-lucide="activity" aria-hidden="true"></i> 验证授权码并生成报告';
        createIcons();
      }
    }
  });

  licenseAdminForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createAdminLicenses(licenseAdminForm, licenseAdminForm.querySelector(".admin-submit"));
  });
  ["#adminSearch", "#adminPlanFilter", "#adminStatusFilter"].forEach((selector) => {
    document.querySelector(selector)?.addEventListener("change", () => loadAdminDashboard(null, { silent: true }));
  });
  document.querySelector("#adminSearch")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadAdminDashboard(null);
    }
  });

  document.querySelector("#downloadTemplate")?.addEventListener("click", downloadTemplate);
  initFileUpload();

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-volunteer-focus]")) {
      const focusEditor = () => {
        const editor = document.querySelector("#volunteerTableEditor");
        editor?.scrollIntoView({ behavior: "smooth", block: "center" });
        editor?.querySelector('[data-volunteer-field="schoolName"]')?.focus({ preventScroll: true });
      };
      if (document.body.dataset.currentView !== "volunteers") {
        window.location.hash = "#/volunteers";
        window.setTimeout(focusEditor, 120);
      } else {
        focusEditor();
      }
      return;
    }

    const copyAdminCode = event.target.closest("[data-copy-admin-code]");
    if (copyAdminCode) {
      copyPlainText(copyAdminCode.dataset.copyAdminCode || "", "已复制授权码");
      return;
    }

    if (event.target.closest("[data-copy-admin-codes]")) {
      const text = Array.from(document.querySelectorAll(".admin-code-value"))
        .map((node) => node.textContent.trim())
        .filter(Boolean)
        .join("\n");
      if (text) copyPlainText(text, "已复制全部授权码");
      return;
    }

    const adminRefresh = event.target.closest("[data-admin-refresh]");
    if (adminRefresh) {
      loadAdminDashboard(adminRefresh);
      return;
    }

    const adminCopyCode = event.target.closest("[data-admin-copy-code]");
    if (adminCopyCode && !adminCopyCode.disabled) {
      copyPlainText(adminCopyCode.dataset.adminCopyCode || "", "已复制授权码");
      return;
    }

    if (event.target.closest("[data-admin-export-licenses]")) {
      exportAdminLicensesCsv();
      return;
    }

    const adminStatusButton = event.target.closest("[data-admin-license-status]");
    if (adminStatusButton) {
      updateAdminLicenseStatus(adminStatusButton);
      return;
    }

    const licenseButton = event.target.closest("[data-license-check]");
    if (licenseButton) {
      verifyLicenseCode(licenseButton);
      return;
    }

    const modalButton = event.target.closest("[data-open-modal]");
    if (modalButton) {
      openModal(modalButton.dataset.openModal, modalButton.dataset.package);
      return;
    }

    if (event.target.closest("[data-close-modal]")) {
      closeModals();
      return;
    }

    if (event.target.closest("#copyLead") || event.target.closest("[data-copy-inline]")) {
      copyLeadSummary();
      return;
    }

    if (event.target.closest("[data-export-pdf]")) {
      exportReportPdf();
      return;
    }

    const riskWindowButton = event.target.closest("[data-risk-window-expand]");
    if (riskWindowButton) {
      const expanded = riskWindowButton.getAttribute("aria-pressed") !== "true";
      setRiskWindowExpanded(expanded);
      return;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModals();
      setVolunteerWindowExpanded(false);
      setRiskWindowExpanded(false);
    }
  });

  initMobileCta();
  loadDataOverview();
}

initInteractions();
createIcons();
