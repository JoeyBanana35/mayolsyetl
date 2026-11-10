/* ================= EXTRACT ================= */

// IMPORT: read an uploaded CSV file and convert it into JavaScript objects.
function importCSVFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(parseCSV(r.result));
    r.onerror = () => reject(new Error("Could not read " + file.name));
    r.readAsText(file);
  });
}

// RFC4180-style CSV parser (quotes, commas/newlines in quotes, BOM, CRLF)
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter(r => r.some(v => v.trim() !== ""));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map(h => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return nonEmpty.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = r[i] !== undefined ? r[i] : "");
    return obj;
  });
}

/* ================= TRANSFORM ================= */

const PROGRAM_MAP = {
  BSIT: "Bachelor of Science in Information Technology",
  BSCS: "Bachelor of Science in Computer Science",
  BSIS: "Bachelor of Science in Information Systems"
};

const trim = v => (v === undefined || v === null) ? "" : String(v).trim();

// student_id -> Integer (identifier, not a quantity). Returns null if invalid.
function toStudentId(v) {
  const s = trim(v);
  if (!/^\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

// 'JUAN dela CRUZ' -> 'Juan Dela Cruz' (handles hyphens and apostrophes too)
function properCase(v) {
  return trim(v).replace(/\s+/g, " ").toLowerCase()
    .replace(/(^|[\s\-'])([a-zñ])/g, (m, p, c) => p + c.toUpperCase());
}

// Trim + uppercase code, then map to full program name
function toProgram(v, warnings, id) {
  const code = trim(v).toUpperCase();
  if (!code) return null;
  if (PROGRAM_MAP[code]) return PROGRAM_MAP[code];
  warnings.push(`Student ${id}: unknown program code "${code}" (kept as-is)`);
  return code;
}

const toEmail = v => trim(v).toLowerCase() || null;
const toUpperTrim = v => trim(v).toUpperCase() || null;

// Numeric grades -> Number. Non-numeric (INC, DRP, NG...) preserved as uppercase string.
function toGrade(v) {
  const s = trim(v);
  if (s === "") return null;
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s.toUpperCase();
}

// 'completed' -> 'Completed', 'IN PROGRESS' -> 'In Progress'
function toStatus(v) {
  const s = trim(v).replace(/\s+/g, " ").toLowerCase();
  if (!s) return null;
  return s.replace(/(^|\s)([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

// Strip currency symbols/commas/spaces then convert to number
function toBalance(v) {
  const s = trim(v).replace(/[^0-9.\-]/g, "");
  if (s === "" || isNaN(Number(s))) return null;
  return Number(s);
}

let lastWarnings = [];

function runETL(sisRows, lmsRows, accRows) {
  const warnings = [];

  // Group LMS rows by student (a student may have many courses)
  const lmsById = new Map();
  lmsRows.forEach((r, i) => {
    const id = toStudentId(r.student_id);
    if (id === null) { warnings.push(`LMS row ${i + 2}: invalid student_id "${trim(r.student_id)}" (skipped)`); return; }
    if (!lmsById.has(id)) lmsById.set(id, []);
    lmsById.get(id).push({
      courseCode: toUpperTrim(r.course_code),
      finalGrade: toGrade(r.final_grade),
      completionStatus: toStatus(r.completion_status)
    });
  });

  // Group Accounting rows by student
  const accById = new Map();
  accRows.forEach((r, i) => {
    const id = toStudentId(r.student_id);
    if (id === null) { warnings.push(`Accounting row ${i + 2}: invalid student_id "${trim(r.student_id)}" (skipped)`); return; }
    if (!accById.has(id)) accById.set(id, []);
    accById.get(id).push({
      outstandingBalance: toBalance(r.account_balance),
      currency: toUpperTrim(r.currency)
    });
  });

  // SIS is the master list: every SIS student is kept, even with no LMS/Accounting data
  const seen = new Set();
  const students = [];
  sisRows.forEach((r, i) => {
    const id = toStudentId(r.student_id);
    if (id === null) { warnings.push(`SIS row ${i + 2}: invalid student_id "${trim(r.student_id)}" (skipped)`); return; }
    if (seen.has(id)) warnings.push(`SIS: duplicate student_id ${id} (row ${i + 2})`);
    seen.add(id);

    const acc = accById.get(id) || [];
    students.push({
      studentId: id,
      studentName: properCase(r.student_name),
      program: toProgram(r.program_code, warnings, id),
      emailAddress: toEmail(r.email),
      lms: (lmsById.get(id) || [])[0] || null,
      accounting: acc[0] || null
    });
  });

  // Report orphan records (in LMS/Accounting but not in SIS)
  [...lmsById.keys()].filter(k => !seen.has(k)).forEach(k => warnings.push(`LMS: student_id ${k} not found in SIS (excluded)`));
  [...accById.keys()].filter(k => !seen.has(k)).forEach(k => warnings.push(`Accounting: student_id ${k} not found in SIS (excluded)`));

  lastWarnings = warnings;
  return students;
}

// load UI
const $ = id => document.getElementById(id);
let lastJSON = "";

// EXPORT: download the transformed JavaScript result as a JSON file.
function exportJSON(data) {
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "integrated_students.json";
  a.click();
  URL.revokeObjectURL(url);
}

$("runBtn").addEventListener("click", async () => {
  const files = [$("fileSIS").files[0], $("fileLMS").files[0], $("fileACC").files[0]];
  if (files.some(f => !f)) {
    $("status").textContent = "Please upload all three CSV files first.";
    return;
  }
  try {
    const [sis, lms, acc] = await Promise.all(files.map(importCSVFile));
    const result = runETL(sis, lms, acc);
    lastJSON = JSON.stringify(result, null, 2);
    $("output").textContent = lastJSON;
    $("status").textContent = `ETL complete: ${result.length} students, ${lastWarnings.length} warning(s).`;
    $("copyBtn").disabled = $("downloadBtn").disabled = false;
  } catch (e) {
    $("status").textContent = "Error: " + e.message;
  }
});

$("copyBtn").addEventListener("click", () => {
  navigator.clipboard.writeText(lastJSON).then(() => $("status").textContent = "JSON copied to clipboard.");
});

$("downloadBtn").addEventListener("click", () => {
  exportJSON(lastJSON);
});
