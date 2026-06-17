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
  "license-admin": "license-admin",
  sources: "product",
  dimensions: "product",
  sample: "sample",
  audience: "pricing",
  pricing: "pricing",
  faq: "pricing"
};

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

async function verifyLicenseCode(button) {
  const licenseCode = getLicenseCode();
  if (!licenseCode) {
    latestLicenseState = null;
    renderLicenseStatus("免费预览不需要授权码；生成完整报告前请填写购买后获得的报告码。", "warn");
    toast("请输入授权码");
    document.querySelector("#licenseCode")?.focus();
    return;
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
    renderLicenseStatus(describeLicense(data.license), "success");
    toast("授权码验证通过");
  } catch (error) {
    latestLicenseState = null;
    const suffix = /联系顾问|联系客服/.test(error.message) ? "" : " 请联系顾问核对。";
    renderLicenseStatus(`${error.message}${suffix}`, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original || '<i data-lucide="key-round" aria-hidden="true"></i> 验证授权码';
      createIcons();
    }
  }
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
  if (diff < -12000 || relativeDiff < -0.18) return "极冲";
  if (diff < 0) return "冲";
  if (diff < 5000 || swing > 8500) return "边缘稳";
  if (diff < 16000) return "稳";
  if (diff < 36000) return "保";
  return "强保";
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

  const needsChemistry = /临床|口腔|医学|药学|化学|化工|材料|机械|电气|计算机|软件|人工智能|电子|自动化/.test(major);
  const selectionMismatch = formData.subject.includes("物理") && needsChemistry && electives.length > 0 && !electives.some((item) => /化学/.test(item));
  const avoidMatch = avoid.some((item) => item && major.includes(item));
  const preferenceMatch = preferred.length === 0 || preferred.some((item) => major.includes(item));
  const highFee = /中外|国际|软件|校企|民办/.test(`${volunteer.schoolName}${major}`) || /2万|20000|高收费/.test(formData.budget || "");
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
  if (highFee) score -= 7;
  if (avoidMatch) score -= 18;
  if (selectionMismatch) score -= 35;
  if (belowBatchLine) score -= 45;
  score = Math.max(0, Math.min(100, score));

  const flags = { selectionMismatch, avoidMatch, highFee, trendRisk, volatilityRisk, preferenceMatch, belowBatchLine };
  const risk = getRiskLevel(score);
  const action = getAction(score, flags);
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
  if (highFee) reasons.push("存在高收费、中外合作或预算冲突提示。");

  return {
    ...volunteer,
    score,
    risk,
    action,
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
  const rush = diagnoses.filter((item) => item.type.includes("冲")).length;
  const stable = diagnoses.filter((item) => item.type.includes("稳")).length;
  const safe = diagnoses.filter((item) => item.type.includes("保")).length;
  const high = diagnoses.filter((item) => item.risk.tone === "high").length;
  const medium = diagnoses.filter((item) => item.risk.tone === "medium").length;
  const low = diagnoses.filter((item) => item.risk.tone === "low").length;
  const replace = diagnoses.filter((item) => /替换|删除/.test(item.action)).length;

  const comments = [];
  if (rush / total > 0.42) comments.push("冲刺志愿占比偏高，建议补足中段稳妥承接。");
  if (safe / total < 0.2) comments.push("保底志愿数量不足，最后10-20个志愿需要重新核验有效性。");
  if (replace > 0) comments.push(`当前至少有${replace}个志愿需要优先替换或删除。`);
  if (!comments.length) comments.push("当前志愿表结构相对均衡，建议继续核对当年招生计划和院校章程。");

  return { total, rush, stable, safe, high, medium, low, replace, comments };
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
志愿数量：${summary.total}条
结构概览：冲刺${summary.rush}、稳妥${summary.stable}、保底${summary.safe}
高风险志愿：${summary.high}条
优先处理：
${topItems || "暂无明显高风险项，建议接入官方数据后复核。"}
上传文件：${formData.selectedFileName || "未上传"}
`;
}

function markdownToHTML(markdown) {
  return String(markdown || "")
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").filter(Boolean);
      if (!lines.length) return "";
      const first = lines[0].trim();
      if (/^#{1,3}\s+/.test(first)) {
        return `<h4>${escapeHTML(first.replace(/^#{1,3}\s+/, ""))}</h4>`;
      }
      if (lines.every((line) => /^(\d+\.|-|•)\s+/.test(line.trim()))) {
        return `<ul>${lines
          .map((line) => `<li>${escapeHTML(line.replace(/^(\d+\.|-|•)\s+/, ""))}</li>`)
          .join("")}</ul>`;
      }
      return `<p>${escapeHTML(lines.join("\n"))}</p>`;
    })
    .join("");
}

function renderAiReport(content, meta = {}) {
  const target = document.querySelector("#aiReport");
  if (!target) return;
  target.innerHTML = `
    <div class="ai-report-head">
      <span>完整解读报告</span>
      <strong>${escapeHTML(meta.model ? "AI已生成" : "规则解读")}</strong>
    </div>
    <div class="ai-report-body">${markdownToHTML(content)}</div>
  `;
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

async function generateAiReport(button) {
  if (!latestReportPayload) {
    toast("请先生成逐条风险预览");
    return;
  }
  const licenseCode = getLicenseCode();
  if (!licenseCode) {
    renderLicenseStatus("生成完整报告需要授权码。免费预览可以继续使用，付费后由顾问发送报告码。", "warn");
    toast("请输入授权码");
    document.querySelector("#licenseCode")?.focus();
    return;
  }

  const originalHTML = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i data-lucide="loader-circle" aria-hidden="true"></i> 报告生成中';
    createIcons();
  }
  renderAiStatus("授权码校验通过后会扣减一次完整报告生成次数，正在整理报告。");

  try {
    const response = await fetch("/api/ai-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...latestReportPayload, licenseCode })
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
    renderAiStatus(`${error.message}。如果已付款，请联系顾问核对授权码。`, "error");
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
  target.innerHTML = `
    <div class="live-empty">
      <i data-lucide="circle-alert" aria-hidden="true"></i>
      <h3>暂时无法读取公开数据</h3>
      <p>${escapeHTML(message)}。可以先生成基础结构预览，完整结论建议由顾问复核。</p>
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
    body: JSON.stringify({ formData, volunteers })
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "公开数据匹配失败");
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
  return "本条未匹配到足够公开历史记录，当前仅作为结构预览。";
}

async function renderReport(formData) {
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
  latestReportPayload = { formData, summary, diagnoses, dataContext };

  const previewItems = diagnoses.slice(0, 8);
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
          <strong>${summary.high > 0 || summary.rush / summary.total > 0.42 ? "中高" : "中"}</strong>
        </div>
      </div>

      <div class="result-cards">
        <article class="result-card"><span>冲刺志愿</span><strong>${summary.rush}</strong><small>极冲/冲</small></article>
        <article class="result-card"><span>稳妥志愿</span><strong>${summary.stable}</strong><small>边缘稳/稳</small></article>
        <article class="result-card"><span>保底志愿</span><strong>${summary.safe}</strong><small>保/强保</small></article>
      </div>

      <div class="diagnosis-card">
        <span>整表结构诊断</span>
        ${summary.comments.map((comment) => `<p>${escapeHTML(comment)}</p>`).join("")}
      </div>

      <div class="diagnosis-list">
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
                  <span class="tag">${escapeHTML(item.action)}</span>
                  <span class="tag">风险分 ${item.score}</span>
                  <span class="tag">${item.ranks.source === "public-data" ? "已匹配公开记录" : "需复核"}</span>
                </div>
                <p>${escapeHTML(item.reasons[0] || "该志愿需要结合官方数据进一步复核。")}</p>
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
          <span>逐条体检结果已生成。输入购买后获得的授权码，即可整理成家长可读的完整报告。</span>
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

  const syncVisibility = () => {
    mobileCta.classList.toggle("is-visible", window.scrollY > 520);
  };

  syncVisibility();
  window.addEventListener("scroll", syncVisibility, { passive: true });
}

function downloadTemplate() {
  const rows = [
    ["志愿序号", "学校代码", "学校名称", "专业代码", "专业名称", "批次", "科目组合", "学制", "学费", "校区", "备注"],
    ["1", "", "河北大学", "", "法学", "本科批", "物理科目组合", "4年", "5060", "", ""],
    ["2", "", "燕山大学", "", "机械类", "本科批", "物理科目组合", "4年", "5390", "", ""]
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
        textarea.value = String(reader.result || "");
        status.textContent = `已解析：${file.name}，识别到${parseVolunteers(textarea.value).length}条志愿。请确认下方内容后生成报告。`;
      });
      reader.readAsText(file, "utf-8");
    } else if (/\.(xlsx|xls)$/i.test(file.name)) {
      status.textContent = `正在解析：${file.name}`;
      parseWorkbookFile(
        file,
        (text, sheetName) => {
          textarea.value = text;
          status.textContent = `已解析：${file.name} / ${sheetName}，识别到${parseVolunteers(text).length}条志愿。`;
        },
        (error) => {
          status.textContent = `${error.message}。可以复制表格内容粘贴到下方继续生成预览。`;
        }
      );
    } else {
      status.textContent = `已选择：${file.name}。当前支持 Excel、CSV、TXT，其他格式请复制表格内容粘贴到下方。`;
    }
  });
}

function initInteractions() {
  initNavigation();

  const volunteerTextarea = document.querySelector("#volunteers");
  if (volunteerTextarea && !volunteerTextarea.value.trim()) {
    volunteerTextarea.value = sampleVolunteerText;
  }

  const form = document.querySelector("#riskForm");
  const licenseAdminForm = document.querySelector("#licenseAdminForm");
  document.querySelector("#licenseCode")?.addEventListener("input", () => {
    latestLicenseState = null;
    renderLicenseStatus("授权码已修改，请重新验证；生成完整报告时会再次服务端校验。", "muted");
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
    const data = getFormData(form);
    try {
      await renderReport(data);
      document.querySelector("#liveReport")?.scrollIntoView({ behavior: "smooth", block: "center" });
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.innerHTML = original || '<i data-lucide="activity" aria-hidden="true"></i> 生成逐条风险预览';
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
      const volunteers = document.querySelector("#volunteers");
      volunteers?.scrollIntoView({ behavior: "smooth", block: "center" });
      volunteers?.focus({ preventScroll: true });
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
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModals();
  });

  initMobileCta();
  loadDataOverview();
}

initInteractions();
createIcons();
