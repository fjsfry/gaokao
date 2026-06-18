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

function formatDate(value) {
  if (!value) return "长期有效";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "有效期以顾问说明为准";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function describeLicense(license) {
  if (!license) return "";
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
    renderLicenseStatus("请先输入授权码。未验证授权码时，系统不会匹配公开数据或生成完整报告。", "warn");
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
    renderLicenseStatus("请先输入授权码并验证，通过后才能匹配公开数据。", "warn");
    document.querySelector("#licenseCode")?.focus();
    throw new Error("请先输入授权码");
  }
  if (latestLicenseState && latestVerifiedLicenseCode === normalized) {
    return latestLicenseState;
  }
  renderLicenseStatus("正在验证授权码，通过后开始匹配公开数据。", "muted");
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
  if (flags.avoidMatch) return "建议替换";
  if (flags.privateConflict || flags.coopConflict || flags.remoteConflict) return "建议替换或下移";
  if (flags.highFee) return "谨慎填报";
  if (score >= 85) return "强烈建议保留";
  if (score >= 75) return "建议保留";
  if (score >= 65) return "可保留但调整顺序";
  if (score >= 50) return "谨慎填报";
  if (score >= 35) return "建议替换";
  return "建议删除";
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

  const needsChemistry = /临床|口腔|医学|药学|化学|化工|材料|机械|电气|计算机|软件|人工智能|电子|自动化/.test(major);
  const selectionMismatch = formData.subject.includes("物理") && needsChemistry && electives.length > 0 && !electives.some((item) => /化学/.test(item));
  const avoidMatch = avoid.some((item) => item && major.includes(item));
  const preferenceMatch = preferred.length === 0 || preferred.some((item) => major.includes(item));
  const regionMismatch = /不接受省外|只接受省内|仅河北|优先省内/.test(regionPreference) && !hebeiSchoolPattern.test(volunteer.schoolName);
  const privateConflict = formData.acceptPrivate === "否" && /民办|独立学院/.test(combinedName);
  const coopConflict = formData.acceptCoop === "否" && /中外|合作|国际|高收费|校企/.test(combinedName);
  const remoteConflict = formData.acceptRemote === "否" && !hebeiSchoolPattern.test(volunteer.schoolName) && /不接受太远|优先省内|河北|石家庄|保定|唐山/.test(regionPreference || "河北");
  const highFee = /中外|国际|软件|校企|民办/.test(combinedName) || /2万|20000|高收费/.test(formData.budget || "") || privateConflict || coopConflict;
  const trendRisk = /计算机|软件|人工智能|临床|口腔|电气|法学|汉语言/.test(major);
  const volatilityRisk = ranks.swing > 8000;
  const batchLine = getRelevantBatchLine(formData, dataContext);
  const belowBatchLine = Boolean(batchLine?.control_score && formData.score && formData.score < Number(batchLine.control_score));

  let score = 72;
  score += Math.max(-28, Math.min(24, Math.round(relativeDiff * 120)));
  if (ranks.source === "public-data") score += 4;
  if (ranks.source === "estimated") score -= 8;
  if (type === "强保") score += 8;
  if (type === "保") score += 5;
  if (type === "冲") score -= 10;
  if (type === "极冲") score -= 22;
  if (trendRisk) score -= 7;
  if (volatilityRisk) score -= 6;
  if (!preferenceMatch) score -= 8;
  if (regionMismatch) score -= 6;
  if (privateConflict) score -= 12;
  if (coopConflict) score -= 12;
  if (remoteConflict) score -= 8;
  if (highFee) score -= 7;
  if (avoidMatch) score -= 18;
  if (selectionMismatch) score -= 35;
  if (belowBatchLine) score -= 45;
  score = Math.max(0, Math.min(100, score));

  const flags = {
    selectionMismatch,
    avoidMatch,
    highFee,
    trendRisk,
    volatilityRisk,
    preferenceMatch,
    regionMismatch,
    privateConflict,
    coopConflict,
    remoteConflict,
    belowBatchLine
  };
  const risk = getRiskLevel(score);
  const action = getAction(score, flags);
  const qualification =
    belowBatchLine || selectionMismatch
      ? "不建议填报"
      : privateConflict || coopConflict || remoteConflict || highFee || avoidMatch
        ? "谨慎填报"
        : "可报";
  const reasons = [];

  if (belowBatchLine) reasons.push(`当前分数低于${batchLine.batch}${batchLine.control_score}分控制线，该批次志愿需要调整。`);
  if (ranks.source === "public-data") reasons.push(`匹配到${ranks.matchCount}条河北公开历史投档记录，参考年份为${dataContext.dataYear || "最新可用年份"}。`);
  if (ranks.source === "score-only") reasons.push("匹配到该校该专业公开分数记录，但部分记录缺少位次，建议人工复核后再下结论。");
  if (ranks.source === "estimated") reasons.push("未匹配到足够公开历史投档记录，本条先按相近规则预估，建议人工复核。");
  if (diff < 0) reasons.push("加权历史最低投档位次高于当前位次，投档安全边际不足。");
  if (diff >= 0) reasons.push(`加权位次安全差约${Math.round(diff)}名，可作为${type}志愿继续核验。`);
  if (trendRisk) reasons.push("专业热度较高，不能只按去年最低位次做判断。");
  if (volatilityRisk) reasons.push("近三年位次波动较大，不适合作为核心保底志愿。");
  if (selectionMismatch) reasons.push("该专业可能涉及物理+化学等选科要求，当前选科信息需要硬性核验。");
  if (avoidMatch) reasons.push("专业名称命中用户明确不能接受方向。");
  if (!preferenceMatch) reasons.push("专业名称与用户偏好方向存在差异，建议确认课程和培养方向。");
  if (regionMismatch) reasons.push("院校地域与当前地域偏好存在冲突，需要确认是否接受省外或远距离城市。");
  if (privateConflict) reasons.push("家庭当前不接受民办，院校性质可能与偏好冲突。");
  if (coopConflict) reasons.push("家庭当前不接受中外合作或高收费项目，需要优先替换或确认费用。");
  if (remoteConflict) reasons.push("家庭当前不接受偏远城市，本条志愿的城市接受度需要重点复核。");
  if (highFee) reasons.push("存在高收费、中外合作或预算冲突提示。");

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
    reasons: reasons.slice(0, 4)
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
  const highFeeRisk = diagnoses.filter((item) => item.flags.highFee || item.flags.privateConflict || item.flags.coopConflict).length;
  const selectionMismatch = diagnoses.filter((item) => item.flags.selectionMismatch).length;
  const publicMatched = diagnoses.filter((item) => item.ranks.source === "public-data").length;
  const needReview = diagnoses.filter((item) => item.ranks.source !== "public-data").length;

  const target = getTargetDistribution(total, diagnoses[0]?.formTarget);
  const stableGap = Math.max(0, target.stable - stable);
  const safeGap = Math.max(0, target.safe - safeOnly);
  const cushionGap = Math.max(0, target.cushion - cushion);

  const comments = [];
  if (rush / total > 0.34) comments.push("冲刺志愿占比偏高，建议减少无效冲刺，把位置留给可承接的稳妥志愿。");
  if (stableGap > 0) comments.push(`稳妥志愿不足，建议至少补充${stableGap}个稳定承接志愿。`);
  if (safeGap + cushionGap > 0) comments.push(`保底与垫底志愿不足，建议补充${safeGap + cushionGap}个真实可接受的兜底选择。`);
  if (replace > 0) comments.push(`当前至少有${replace}个志愿需要优先替换或删除。`);
  if (needReview > total * 0.35) comments.push("部分志愿未直接命中公开历史投档记录，完整报告会标注为需人工复核，不包装成确定结论。");
  if (!comments.length) comments.push("当前志愿表结构相对均衡，建议继续核对当年招生计划和院校章程。");

  const grade =
    invalid > 0 || retreatRisk > 0
      ? "E 严重风险"
      : high > total * 0.22 || rush > total * 0.45
        ? "D 高风险"
        : rush > total * 0.34 || stableGap + safeGap + cushionGap > 0
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
    needReview,
    target,
    stableGap,
    safeGap,
    cushionGap,
    grade,
    comments
  };
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
  const topItems = diagnoses
    .filter((item) => /替换|删除|谨慎|复核/.test(item.action))
    .slice(0, 5)
    .map((item) => `第${item.orderNo}志愿 ${item.schoolName}+${item.majorName}：${item.action}`)
    .join("\n");

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
整体等级：${summary.grade}
高风险志愿：${summary.high}条
优先处理：
${topItems || "暂无明显高风险项，建议接入官方数据后复核。"}
上传文件：${formData.selectedFileName || "未上传"}
`;
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
  return `<div class="ai-table-wrap"><table class="ai-report-table"><thead><tr>${header
    .map((cell) => `<th>${escapeHTML(cell)}</th>`)
    .join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${header.map((_cell, index) => `<td>${escapeHTML(row[index] || "")}</td>`).join("")}</tr>`)
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
      html.push(`<h4>${escapeHTML(current.replace(/^#{1,3}\s+/, ""))}</h4>`);
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
      html.push(`<ul>${listLines.map((line) => `<li>${escapeHTML(line.replace(/^(\d+\.|-|•)\s+/, ""))}</li>`).join("")}</ul>`);
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
    html.push(`<p>${escapeHTML(paragraphLines.join("\n")).replace(/\n/g, "<br />")}</p>`);
  }

  return html.join("");
}

function tableHTML(headers, rows) {
  return `<div class="ai-table-wrap"><table class="ai-report-table"><thead><tr>${headers
    .map((header) => `<th>${escapeHTML(header)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${headers.map((_header, index) => `<td>${escapeHTML(row[index] ?? "")}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
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
  if (item.ranks?.source === "public-data") return "公开记录";
  if (item.ranks?.source === "score-only") return "分数记录";
  return "需复核";
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
      item.qualification || item.risk?.label,
      getVolunteerRetentionDecision(item),
      item.reasons?.[0] || "需要结合当年招生计划复核"
    ]);
  const detailRows = diagnoses.map((item) => [
    item.orderNo,
    item.schoolName,
    item.majorName,
    item.type,
    getVolunteerReasonableness(item),
    getVolunteerRetentionDecision(item),
    item.risk?.label || "",
    getVolunteerEvidenceLabel(item)
  ]);
  const structureRows = [
    ["极冲", summary.extremeRush, summary.target?.extremeRush ?? "-", "控制数量，只保留真正想冲的志愿"],
    ["冲", summary.rushOnly, summary.target?.rushOnly ?? "-", "避免前段过密"],
    ["小冲", summary.smallRush, summary.target?.smallRush ?? "-", "可作为前中段试探"],
    ["稳", summary.stable, summary.target?.stable ?? "-", summary.stableGap ? `建议补充${summary.stableGap}个` : "承担主体录取概率"],
    ["保", summary.safeOnly, summary.target?.safe ?? "-", summary.safeGap ? `建议补充${summary.safeGap}个` : "保证后段承接"],
    ["垫", summary.cushion, summary.target?.cushion ?? "-", summary.cushionGap ? `建议补充${summary.cushionGap}个` : "兜底防滑档"]
  ];
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
      <h4>志愿结构分布与建议目标</h4>
      ${tableHTML(["层次", "当前数量", "建议目标", "处理建议"], structureRows)}
      <h4>风险统计</h4>
      ${tableHTML(["指标", "数量", "说明"], [
        ["高风险志愿", summary.high || 0, "优先看位次、限制条件和是否需要替换"],
        ["无效/不建议风险", summary.invalid || 0, "批次、选科、身体或明确偏好冲突"],
        ["高退档风险", summary.retreatRisk || 0, "选科、批次或硬性条件需核验"],
        ["高学费/性质风险", summary.highFeeRisk || 0, "民办、中外合作、高收费或预算冲突"],
        ["公开记录命中", summary.publicMatched || 0, "可追溯证据更强"],
        ["需人工复核", summary.needReview || 0, "不能包装成确定结论"]
      ])}
      <h4>优先修改清单</h4>
      ${tableHTML(["序号", "院校/专业", "层次", "可报判断", "去留建议", "主要原因"], priorityRows.length ? priorityRows : [["-", "暂无强制替换项", "-", "可报", "继续核验", "建议核对当年招生计划和院校章程"]])}
      <h4>逐项诊断摘要（覆盖全部志愿）</h4>
      ${tableHTML(["序号", "院校", "专业", "层次", "合理性", "去留", "风险", "证据"], detailRows)}
    </div>
  `;
}

function renderAiReport(content, meta = {}) {
  const target = document.querySelector("#aiReport");
  if (!target) return;
  target.innerHTML = `
    <div class="ai-report-head">
      <span>完整解读报告</span>
      <strong>${escapeHTML(meta.model ? "AI已生成" : "规则解读")}</strong>
    </div>
    ${buildStructuredReportHTML()}
    <div class="ai-section-title">AI家长版解释</div>
    <div class="ai-report-body">${markdownToHTML(content)}</div>
    <div class="ai-report-actions">
      <button class="outline-button compact" type="button" data-export-pdf>
        <i data-lucide="download" aria-hidden="true"></i>
        导出PDF
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

async function generateAiReport(button) {
  if (!latestReportPayload) {
    toast("请先生成逐条风险预览");
    return;
  }
  const licenseCode = getLicenseCode();
  if (!licenseCode) {
    renderLicenseStatus("生成完整报告需要授权码。请先输入并验证顾问发送的报告码。", "warn");
    toast("请输入授权码");
    document.querySelector("#licenseCode")?.focus();
    return;
  }

  try {
    await ensureLicenseReady();
  } catch (error) {
    renderAiStatus("授权码未通过校验，未进行公开数据二次匹配，也不会生成完整报告。", "error");
    toast("请先验证授权码");
    return;
  }

  const originalHTML = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i data-lucide="loader-circle" aria-hidden="true"></i> 二次匹配中';
    createIcons();
  }
  renderAiStatus("正在重新匹配公开投档数据，匹配成功后将生成 AI 智能完整报告。");

  let rematchCompleted = false;
  try {
    const refreshedPayload = await refreshReportPayloadForAi();
    rematchCompleted = true;
    renderAiStatus(
      `二次匹配完成：${refreshedPayload.aiRematch.publicMatchedCount}条直接命中公开记录，${refreshedPayload.aiRematch.estimatedCount}条需要人工复核。正在生成完整报告。`
    );
    if (button) {
      button.innerHTML = '<i data-lucide="loader-circle" aria-hidden="true"></i> 报告生成中';
      createIcons();
    }
    const response = await fetch("/api/ai-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...refreshedPayload, licenseCode })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "AI报告生成失败");
    }
    latestLicenseState = data.license || latestLicenseState;
    if (data.license) {
      renderLicenseStatus(describeLicense(data.license), "success");
    }
    renderAiReport(data.content, { model: data.model });
    toast("完整报告已生成");
  } catch (error) {
    const prefix = rematchCompleted ? "二次匹配已完成，但完整报告生成未继续：" : "";
    const cleanMessage = String(error.message || "未知错误").replace(/[。.!！]+$/, "");
    renderAiStatus(`${prefix}${cleanMessage}。完整报告未生成时不会扣减授权码；如果已付款，请联系顾问核对。`, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = originalHTML || '<i data-lucide="sparkles" aria-hidden="true"></i> 生成完整报告';
      createIcons();
    }
  }
}

function renderReportLoading(message = "正在读取河北公开数据并匹配志愿表。") {
  const target = document.querySelector("#liveReport");
  if (!target) return;
  target.innerHTML = `
    <div class="live-empty live-loading">
      <i data-lucide="loader-circle" aria-hidden="true"></i>
      <h3>${escapeHTML(message)}</h3>
      <p>系统会优先匹配一分一档、批次线和近年投档记录；缺少证据的志愿会提示人工复核。</p>
    </div>
  `;
  createIcons();
}

function renderReportError(message) {
  const target = document.querySelector("#liveReport");
  if (!target) return;
  const isLicenseError = /授权码|报告码|输入/.test(String(message || ""));
  const title = isLicenseError ? "需要先验证授权码" : "暂时无法读取公开数据";
  const detail = isLicenseError
    ? `${message}。验证通过后，系统才会开始匹配公开投档数据并生成风险预览。`
    : `${message}。可以先联系顾问核对数据状态，完整结论建议由顾问复核。`;
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
      throw new Error("公开数据匹配超时，已切换为基础风险预览");
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
    throw new Error(data.error || "公开数据匹配失败");
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
  return "本条未在当前收录数据中精确命中该校该专业近年位次，系统已尝试别名、专业简称、批次放宽和更早年份，当前仅作为结构预览。";
}

async function renderReport(formData) {
  await ensureLicenseReady();
  formData.licenseCode = getLicenseCode();
  const sourceRows = parseVolunteers(formData.volunteers || sampleVolunteerText);
  const volunteers = sourceRows.length ? sourceRows : parseVolunteers(sampleVolunteerText);
  renderReportLoading();
  let dataContext = {};
  try {
    dataContext = await requestDataContext(formData, volunteers);
  } catch (error) {
    renderReportError(error.message);
    toast("公开数据读取失败，已降级为基础预览");
  }

  const diagnoses = volunteers.map((volunteer) => diagnoseVolunteer(volunteer, formData, dataContext));
  const summary = buildStructureSummary(diagnoses);
  latestLeadSummary = buildLeadSummary(formData, summary, diagnoses);
  latestReportPayload = { formData, sourceVolunteers: volunteers, summary, diagnoses, dataContext };

  const previewItems = diagnoses;
  const priorityItems = diagnoses
    .slice()
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);

  document.querySelector("#liveReport").innerHTML = `
    <div class="live-result">
      <div class="result-head">
        <div>
          <span class="eyebrow">河北志愿表风险体检</span>
          <h3>${escapeHTML(formData.subject)} / ${escapeHTML(formData.batch)} / ${summary.total}条志愿</h3>
          <p class="result-subtitle">参考公开数据年份：${escapeHTML(dataContext.dataYear || "待匹配")}；${dataContext.scoreRank ? `当前分数约对应位次 ${dataContext.scoreRank.cumulative_rank}` : "位次以表单输入为准"}</p>
        </div>
        <div class="result-score">
          <span>整表风险</span>
          <strong>${escapeHTML(String(summary.grade || "待判断").split(" ")[0])}</strong>
        </div>
      </div>

      <div class="result-cards">
        <article class="result-card"><span>冲刺志愿</span><strong>${summary.rush}</strong><small>极冲/冲/小冲</small></article>
        <article class="result-card"><span>稳妥志愿</span><strong>${summary.stable}</strong><small>建议目标 ${summary.target.stable}</small></article>
        <article class="result-card"><span>保底垫底</span><strong>${summary.safe}</strong><small>保/垫</small></article>
        <article class="result-card"><span>需处理</span><strong>${summary.replace}</strong><small>替换/删除/下移</small></article>
      </div>

      <div class="diagnosis-card">
        <span>整表结构诊断</span>
        <h4>${escapeHTML(summary.grade)}</h4>
        ${summary.comments.map((comment) => `<p>${escapeHTML(comment)}</p>`).join("")}
      </div>

      <div class="diagnosis-card structured-preview-card">
        <span>冲稳保垫分布</span>
        ${tableHTML(["层次", "当前数量", "建议目标", "提示"], [
          ["极冲", summary.extremeRush, summary.target.extremeRush, "控制数量"],
          ["冲", summary.rushOnly, summary.target.rushOnly, "避免前段过密"],
          ["小冲", summary.smallRush, summary.target.smallRush, "可作为前中段试探"],
          ["稳", summary.stable, summary.target.stable, summary.stableGap ? `缺${summary.stableGap}个` : "主体承接"],
          ["保", summary.safeOnly, summary.target.safe, summary.safeGap ? `缺${summary.safeGap}个` : "后段承接"],
          ["垫", summary.cushion, summary.target.cushion, summary.cushionGap ? `缺${summary.cushionGap}个` : "防滑档"]
        ])}
      </div>

      <div class="diagnosis-card structured-preview-card">
        <span>风险统计</span>
        ${tableHTML(["指标", "数量", "说明"], [
          ["无效风险", summary.invalid, "不建议或需删除项"],
          ["高退档风险", summary.retreatRisk, "选科/批次等硬性风险"],
          ["高学费风险", summary.highFeeRisk, "民办/中外合作/高收费冲突"],
          ["选科不匹配", summary.selectionMismatch, "需核验专业选科要求"],
          ["公开记录命中", summary.publicMatched, "证据更强"],
          ["需人工复核", summary.needReview, "不能包装成确定结论"]
        ])}
      </div>

      <div class="diagnosis-section-head">
        <div>
          <span>逐条志愿分析</span>
          <strong>已覆盖全部${summary.total}条志愿</strong>
        </div>
        <small>每条都包含合理性、去留建议、风险原因和证据状态。</small>
      </div>

      <div class="diagnosis-list full-diagnosis-list">
        ${previewItems
          .map(
            (item) => `
              <article class="diagnosis-card">
                <header>
                  <div>
                    <span>第${item.orderNo}志愿</span>
                    <h4>${escapeHTML(item.schoolName)} + ${escapeHTML(item.majorName)}</h4>
                  </div>
                  <strong class="tag ${item.risk.tone}">${item.risk.label}</strong>
                </header>
                <div class="risk-tags">
                  <span class="tag">${item.type}</span>
                  <span class="tag">${escapeHTML(item.qualification)}</span>
                  <span class="tag">合理性：${escapeHTML(getVolunteerReasonableness(item))}</span>
                  <span class="tag">去留：${escapeHTML(getVolunteerRetentionDecision(item))}</span>
                  <span class="tag">风险分 ${item.score}</span>
                  <span class="tag">${getVolunteerEvidenceLabel(item)}</span>
                </div>
                <p><strong>判断：</strong>${escapeHTML(getVolunteerReasonableness(item))}，建议${escapeHTML(getVolunteerRetentionDecision(item))}。</p>
                <p><strong>原因：</strong>${escapeHTML(item.reasons.slice(0, 2).join("；") || "该志愿需要结合官方数据进一步复核。")}</p>
                <p>证据摘要：${escapeHTML(buildEvidencePreview(item))}</p>
              </article>
            `
          )
          .join("")}
      </div>

      <div class="diagnosis-card">
        <span>优先修改清单</span>
        ${priorityItems
          .map((item) => `<p>第${item.orderNo}志愿：${escapeHTML(item.schoolName)} + ${escapeHTML(item.majorName)}，${escapeHTML(item.action)}。</p>`)
          .join("")}
      </div>

      <div class="ai-report-panel" id="aiReport">
        <div class="ai-status">
          <i data-lucide="sparkles" aria-hidden="true"></i>
          <span>逐条体检结果已生成。可先导出预览PDF；完整报告会再次安全校验授权码，并在生成成功后扣减次数。</span>
        </div>
      </div>

      <div class="next-actions">
        <button class="solid-button" type="button" data-ai-report>
          <i data-lucide="sparkles" aria-hidden="true"></i>
          生成完整报告
        </button>
        <button class="solid-button" type="button" data-open-modal="contactModal" data-package="河北96志愿完整报告">
          <i data-lucide="message-square-text" aria-hidden="true"></i>
          咨询完整报告
        </button>
        <button class="outline-button" type="button" data-copy-inline>
          <i data-lucide="copy" aria-hidden="true"></i>
          复制体检摘要
        </button>
        <button class="outline-button" type="button" data-export-pdf>
          <i data-lucide="download" aria-hidden="true"></i>
          导出PDF
        </button>
      </div>
    </div>
  `;

  createIcons();
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

function exportReportPdf() {
  const report = document.querySelector("#liveReport .live-result");
  if (!report) {
    toast("请先生成风险预览报告");
    return;
  }
  document.body.classList.add("print-report-mode");
  const originalTitle = document.title;
  document.title = `寻鹿升学-志愿风险评估报告-${new Date().toISOString().slice(0, 10)}`;
  const cleanup = () => {
    document.body.classList.remove("print-report-mode");
    document.title = originalTitle;
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.setTimeout(() => {
    window.print();
    window.setTimeout(cleanup, 1200);
  }, 80);
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
      node.textContent = "公开数据正在更新，体检结果会标注需要复核的条目";
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
        ? `当前将按${count}条志愿生成预览报告；如需调整顺序，请先进入志愿表页面。`
        : "尚未识别到完整志愿，请先上传 Excel/CSV 或在线录入。";
  }
  if (statusNode) {
    statusNode.textContent =
      count >= 80
        ? "志愿数量已接近完整表，建议重点检查最后20个保底和垫底志愿。"
        : count > 0
          ? "已读取志愿表，数量较少时请确认是否只是局部测试或预览。"
          : "请先确认志愿表顺序，再生成风险预览。";
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
    renderLicenseStatus("授权码已修改，请重新验证；未通过前不会匹配公开数据。", "muted");
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector(".form-submit");
    const original = submit?.innerHTML;
    if (submit) {
      submit.disabled = true;
      submit.innerHTML = '<i data-lucide="loader-circle" aria-hidden="true"></i> 正在匹配公开数据';
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
        submit.innerHTML = original || '<i data-lucide="activity" aria-hidden="true"></i> 验证授权码并生成风险预览';
        createIcons();
      }
    }
  });

  licenseAdminForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createAdminLicenses(licenseAdminForm, licenseAdminForm.querySelector(".admin-submit"));
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

    const aiButton = event.target.closest("[data-ai-report]");
    if (aiButton) {
      generateAiReport(aiButton);
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
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModals();
      setVolunteerWindowExpanded(false);
    }
  });

  initMobileCta();
  loadDataOverview();
}

initInteractions();
createIcons();
