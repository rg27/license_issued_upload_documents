/* ---------------------------------------------------------------
   Upload Documents widget  (WorkDrive version, with address capture)

   1. Calls the Deluge function "license_issued_upload_documents" once to get the
      WorkDrive folder ID (legal_doc_id), the account ID and the jurisdiction.
   2. Stores every selected file temporarily in Zoho CRM's file storage (NOT in the
      Attachments related list) and gets a file ID for each one.
   3. Reads the company address with "tl_address_ocr_zia":
        - lease-type documents first (ULA, Ejari, Tenancy Contract, Lease Agreement,
          Lease Document, Facility Agreement, Co-Working Agreement), street of at least 5 characters;
        - if none gives a street, the TL, street of at least 10 characters;
        - if the TL also fails, the address is left blank.
        - SRTIP documents are accepted whatever the street length.
      The address is not shown in the widget. It is only passed to the Deluge side.
   4. Calls "update_account_from_widget" once per file, passing the folder values,
      the file ID and the address. That function uploads the file to WorkDrive
      and updates the Billing Address of the Account.
   5. When everything is uploaded, shows a success toast, then proceeds the
      Blueprint transition and closes the widget.
--------------------------------------------------------------- */
const MAX_FILE_MB = 40;
const MAX_FILES = 20;
const ALLOWED_EXT = ["pdf", "doc", "docx", "xls", "xlsx", "csv", "txt", "png", "jpg", "jpeg", "zip"];

const FOLDER_FUNCTION  = "license_issued_upload_documents";   // returns legal_doc_id, account_id, tl_jurisdiction
const EXTRACT_FUNCTION = "tl_address_ocr_zia";                // reads street and city from a document
const UPLOAD_FUNCTION  = "update_account_from_widget";        // uploads one file to WorkDrive and gets the address

let currentRecordId = null, currentEntity = null, triggeredByUser = null;
let files = [];          // { id, file, status: "pending" | "uploading" | "done" | "error", error, stage, fileId }
let isUploading = false;
let nextId = 1;
let folderInfo = null;   // { legal_doc_id, account_id, tl_jurisdiction }
let addressInfo = null;  // { street_address, city, country, source } once an address was captured

/* Names are matched ignoring capital / small letters (the "i" flag).
   Short tags like ULA and TL must stand alone as words, so "Title.pdf" does not match.
   group "lease" = read first. group "tl" = fallback.
   minStreet = the shortest street (in characters) that counts as a real address. */
const DOC_TYPES = [
    { label: "ULA",                  group: "lease", minStreet: 5,  re: /(^|[^a-z])ula([^a-z]|$)/i },
    { label: "Ejari",                group: "lease", minStreet: 5,  re: /ejari/i },
    { label: "Tenancy Contract",     group: "lease", minStreet: 5,  re: /tenancy[\s_-]*contract/i },
    { label: "Lease Agreement",      group: "lease", minStreet: 5,  re: /lease[\s_-]*agreement/i },
    { label: "Lease Document",       group: "lease", minStreet: 5,  re: /lease[\s_-]*document/i },
    { label: "Facility Agreement",   group: "lease", minStreet: 5,  re: /facilit(y|ies)[\s_-]*agreements?/i },
    { label: "Co-Working Agreement", group: "lease", minStreet: 5,  re: /co[\s_-]*working[\s_-]*agreements?/i },
    { label: "TL",                   group: "tl",    minStreet: 10, re: /(^|[^a-z])tl([^a-z]|$)/i }
];
const READABLE_EXT = ["pdf", "png", "jpg", "jpeg"];   // file types the OCR can read

const $ = (id) => document.getElementById(id);

const WARN_ICON = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>';
const CHECK_ICON = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
const CLOSE_ICON = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';

/* ---------- Helpers ---------- */
const getExt = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stem = (name) => name.replace(/\.[^.]+$/, "");
const docTypeOf = (name) => DOC_TYPES.find(t => t.re.test(stem(name))) || null;
const safeParse = (text) => { try { return JSON.parse(String(text).trim()); } catch (e) { return null; } };

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function badgeClass(ext) {
    if (ext === "pdf") return "pdf";
    if (["doc", "docx", "txt"].includes(ext)) return "doc";
    if (["xls", "xlsx", "csv"].includes(ext)) return "sheet";
    if (["png", "jpg", "jpeg"].includes(ext)) return "image";
    if (ext === "zip") return "zip";
    return "";
}

/* ---------- Loader & toast ---------- */
function showLoader(text = "Loading...") {
    $("loader-text").textContent = text;
    const o = $("loader-overlay");
    o.classList.remove("hidden"); o.setAttribute("aria-hidden", "false");
}
function hideLoader() {
    const o = $("loader-overlay");
    o.classList.add("hidden"); o.setAttribute("aria-hidden", "true");
}

function showToast(message, type = "success", duration = 4000, onClose = null) {
    $("app-toast")?.remove();
    const toast = document.createElement("div");
    toast.id = "app-toast";
    toast.className = `toast ${type}`;
    toast.innerHTML = `<div class="toast-progress" style="animation-duration: ${duration}ms;"></div><div class="toast-body"><div class="toast-icon-badge">${type === "success" ? CHECK_ICON : WARN_ICON}</div><div class="toast-content"><span class="toast-title">${type === "success" ? "Success" : "Action Required"}</span><span class="toast-text">${escapeHtml(message)}</span></div></div>`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(0.5rem) scale(0.96)";
        toast.style.transition = "all 0.3s";
        setTimeout(() => {
            toast.remove();
            if (typeof onClose === "function") onClose();
        }, 300);
    }, duration);
}

/* ---------- Calling Deluge functions ---------- */

/* Logs the execute() result in a readable way: status, the Deluge info logs, and the function output */
function logFunctionResult(response) {
    const d = response?.details || {};
    console.log("Result code:", response?.code, "| message:", response?.message);
    console.log("Deluge info logs (userMessage):", JSON.stringify(d.userMessage ?? [], null, 2));
    console.log("Function output:", d.output);
}

/* Runs a Deluge function and logs arguments + result for every attempt.
   Retries with the next argument format only when CRM answers INVALID_DATA. */
async function executeFunction(name, attempts) {
    let response = null;
    for (const a of attempts) {
        console.log("=== EXECUTING FUNCTION:", name, "===", "(" + a.label + ")");
        console.log("Arguments / Parameters:", a.argsString);
        response = await ZOHO.CRM.FUNCTIONS.execute(name, { arguments: a.argsString });
        console.log("=== RESULT FOR:", name, "===");
        console.log("Raw Response:", JSON.stringify(response, null, 2));
        logFunctionResult(response);
        if (response?.code !== "INVALID_DATA") break;
        console.warn("INVALID_DATA for format '" + a.label + "'. Trying the next format if there is one.");
    }
    return response;
}

/* The function output arrives as text. Returns the parsed value, or the text if it is not JSON */
function readOutput(response) {
    const raw = response?.details?.output;
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") return raw;
    const parsed = safeParse(raw);
    return parsed !== null ? parsed : raw;
}

/* Step 1: get the WorkDrive folder ID, account ID and jurisdiction for this record */
async function loadFolderInfo() {
    if (!/^\d+$/.test(String(currentRecordId))) {
        throw new Error("The record ID was not received correctly.");
    }
    // The ID is written into the text as it is, so a 19-digit ID does not lose digits
    const response = await executeFunction(FOLDER_FUNCTION, [
        { label: "number", argsString: '{"application_id":' + currentRecordId + '}' },
        { label: "text",   argsString: '{"application_id":"' + currentRecordId + '"}' }
    ]);

    if (response?.code && response.code !== "success") {
        throw new Error(`CRM returned ${response.code}: ${response.message || "no message"}`);
    }

    let out = readOutput(response);
    if (Array.isArray(out)) out = out[0];

    // If the output is Deluge text and not JSON, pick the values out of the text
    if (typeof out === "string") {
        const text = out;
        const pick = (key) => {
            const m = text.match(new RegExp('"?' + key + '"?\\s*[:=]\\s*"?([^",}\\]]+)'));
            return m ? m[1].trim() : "";
        };
        out = { legal_doc_id: pick("legal_doc_id"), account_id: pick("account_id"), tl_jurisdiction: pick("tl_jurisdiction") };
    }

    // Keep only the folder ID, in case the link had a trailing slash or a query
    const folderId = String(out?.legal_doc_id ?? "").split(/[?#/]/)[0].trim();
    if (!folderId || folderId.toLowerCase() === "null") {
        throw new Error("This application has no WorkDrive folder link (Legal Docs Link), so files cannot be uploaded.");
    }

    const info = {
        legal_doc_id: folderId,
        account_id: String(out?.account_id ?? "").trim(),
        tl_jurisdiction: String(out?.tl_jurisdiction ?? "").trim()
    };
    console.log("Folder info:", info);
    return info;
}

/* ---------- Storing a file temporarily in CRM file storage (not in Attachments) ---------- */

/* Finds the file ID in the response of the upload call */
function findFileId(node, depth = 0) {
    if (!node || depth > 6) return null;
    if (typeof node === "string") { const p = safeParse(node); return p ? findFileId(p, depth + 1) : null; }
    if (Array.isArray(node)) { for (const i of node) { const r = findFileId(i, depth + 1); if (r) return r; } return null; }
    if (typeof node === "object") {
        if (typeof node.code === "string" && /error|invalid|fail/i.test(node.code)) return null;
        for (const key of ["id", "file_id", "File_Id", "fileId"]) {
            if (typeof node[key] === "string" && node[key].length > 8) return node[key];
        }
        for (const v of Object.values(node)) { const r = findFileId(v, depth + 1); if (r) return r; }
    }
    return null;
}

/* Tries the upload call with the request formats the SDK accepts, and returns the file ID */
async function uploadToStorage(file) {
    const requests = [
        { label: "multipart", build: () => ({ CONTENT_TYPE: "multipart", PARTS: [{ headers: { "Content-Disposition": "file;" } }], FILE: { fileParam: "file", file } }) },
        { label: "name and content", build: () => ({ File: { Name: file.name, Content: file } }) }
    ];
    for (const r of requests) {
        try {
            const resp = await ZOHO.CRM.API.uploadFile(r.build());
            console.log("=== RESULT FOR: uploadFile (" + file.name + ", " + r.label + ") ===");
            console.log("Raw Response:", JSON.stringify(resp, null, 2));
            const id = findFileId(resp);
            if (id) return id;
        } catch (err) {
            console.warn("uploadFile failed for format '" + r.label + "':", err);
        }
    }
    throw new Error("The file could not be prepared for upload. Check the console.");
}

/* ---------- Address capture ---------- */

/* Finds the { status, street_address, city, ... } map inside the execute() response */
function findExtraction(node, depth = 0) {
    if (!node || depth > 6) return null;
    if (typeof node === "string") {
        try { return findExtraction(JSON.parse(node.trim()), depth + 1); } catch (e) { return null; }
    }
    if (Array.isArray(node)) { for (const i of node) { const r = findExtraction(i, depth + 1); if (r) return r; } return null; }
    if (typeof node === "object") {
        if (["success", "error"].includes(node.status) && ("street_address" in node || "city" in node || "message" in node)) return node;
        for (const v of Object.values(node)) { const r = findExtraction(v, depth + 1); if (r) return r; }
    }
    return null;
}

/* Calls the Deluge function for one stored file and returns its result (never shows UI) */
async function runExtraction(item) {
    let out;
    try {
        const args = { application_id: String(currentRecordId), file_id: item.fileId };
        const response = await executeFunction(EXTRACT_FUNCTION, [
            // The Deluge function is declared as (String arguments), so the values must arrive inside that one parameter.
            // No second format is tried: an error from the function would make it run (and call Zia) twice.
            { label: "wrapped in arguments", argsString: JSON.stringify({ arguments: JSON.stringify(args) }) }
        ]);

        out = findExtraction(response);
        console.log("Parsed result:", out);
        if (!out) {
            const o = response?.details?.output;
            const crmFailed = response?.code && response.code !== "success";
            out = {
                status: "error",
                message: crmFailed
                    ? `CRM returned ${response.code}: ${response.message || "no message"}`
                    : `The function returned no usable result${o ? ": " + String(o).slice(0, 200) : " (empty output)."}`
            };
        }
    } catch (err) {
        console.error("Error in runExtraction:", err);
        out = { status: "error", message: "The extraction function failed. Check the console." };
    }
    return out;
}

/* Prepared files that can be read, lease-type documents first, then TL */
function sourceCandidates() {
    const list = files.filter(x =>
        x.fileId &&
        docTypeOf(x.file.name) &&
        READABLE_EXT.includes(getExt(x.file.name))
    );
    const rank = (x) => (docTypeOf(x.file.name).group === "lease" ? 0 : 1);
    return list.sort((a, b) => rank(a) - rank(b));   // stable: keeps upload order inside each group
}

/* Reads the lease-type document first. If its street is empty or shorter than 5 characters,
   goes straight to the TL, whose street must have at least 10 characters.
   SRTIP documents are accepted at any length (the Deluge function sets skip_min_length).
   Returns { street_address, city, country, source } or null when nothing passes.
   The result is only logged to the console, it is not shown in the widget. */
async function extractAddress() {
    const candidates = sourceCandidates();
    if (candidates.length === 0) {
        console.warn("No readable ULA, Ejari, Tenancy Contract, Lease Agreement, Lease Document, Facility Agreement, Co-Working Agreement or TL file (PDF or image) was found, so the address was left blank.");
        return null;
    }

    const reasons = [];   // why each document did not give an address (logged if all fail)
    for (const item of candidates) {
        const type = docTypeOf(item.file.name);
        item.stage = "Uploading the files..."; render();
        showLoader("Uploading the files...");
        const out = await runExtraction(item);
        const street = String(out.street_address || "").trim();
        const exempt = String(out.skip_min_length) === "true";
        console.log("Result from", item.file.name, "(" + type.label + "):", out, "| street length:", street.length, "| minimum:", exempt ? "none (SRTIP)" : type.minStreet);

        if (out.status === "success" && street.length > 0 && (exempt || street.length >= type.minStreet)) {
            hideLoader();
            const captured = { street_address: street, city: String(out.city || "").trim(), country: String(out.country || "United Arab Emirates").trim(), source: type.label };
            console.log("Address captured from the " + type.label + " document:", captured);
            return captured;
        }
        console.warn(`${type.label} gave no usable street (needs at least ${type.minStreet} characters).`);
        reasons.push(`${type.label}: ${out.message || ("street too short (" + street.length + " characters)")}`);
    }

    // No document gave a long enough street: leave everything blank
    hideLoader();
    console.warn("No valid street address was found in the uploaded documents, so it was left blank. " + reasons.join(" | "));
    return null;
}

/* ---------- Error helpers ---------- */
function setFilesError(message) {
    $("dropzone").classList.add("input-error");
    const err = $("files-error");
    err.innerHTML = `${WARN_ICON}<span>${escapeHtml(message)}</span>`;
    err.classList.remove("hidden");
}
function clearFilesError() {
    $("dropzone").classList.remove("input-error");
    $("files-error").classList.add("hidden");
}

/* ---------- File list rendering ---------- */
function render() {
    const list = $("file-list");
    list.innerHTML = files.map(item => {
        const ext = getExt(item.file.name);
        const type = docTypeOf(item.file.name);
        const meta = item.status === "uploading" ? escapeHtml(item.stage || "Uploading...")
                   : item.status === "done"      ? `Uploaded to WorkDrive · ${formatSize(item.file.size)}`
                   : item.status === "error"     ? escapeHtml(item.error || "Upload failed. Try again.")
                   : formatSize(item.file.size) + (type ? ` · Required ${escapeHtml(type.label)} file` : "");
        const state = item.status === "uploading" ? '<div class="file-spinner"></div>'
                    : item.status === "done"      ? `<span class="ok">${CHECK_ICON}</span>`
                    : "";
        const removable = item.status !== "uploading" && item.status !== "done";
        return `<li class="file-item is-${item.status}" data-id="${item.id}">
            <div class="file-badge ${badgeClass(ext)}">${escapeHtml(ext.slice(0, 4) || "file")}</div>
            <div class="file-info">
                <p class="file-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</p>
                <p class="file-meta">${meta}</p>
            </div>
            <div class="file-state">${state}</div>
            ${removable ? `<button type="button" class="file-remove" data-remove="${item.id}" aria-label="Remove ${escapeHtml(item.file.name)}">${CLOSE_ICON}</button>` : ""}
            <div class="file-bar"></div>
        </li>`;
    }).join("");

    const total = files.reduce((n, f) => n + f.file.size, 0);
    $("file-summary").classList.toggle("hidden", files.length === 0);
    $("file-count").textContent = `${files.length} ${files.length === 1 ? "file" : "files"} · ${formatSize(total)}`;
    $("clear-all").classList.toggle("hidden", isUploading);

    $("dropzone").classList.toggle("disabled", isUploading);
    $("upload-btn").disabled = isUploading;
}

/* ---------- Adding files ---------- */
function addFiles(fileList) {
    if (isUploading) return;
    $("upload-btn-label").textContent = "Upload Files";
    const problems = [];

    [...fileList].forEach(file => {
        const ext = getExt(file.name);
        if (!ALLOWED_EXT.includes(ext)) {
            problems.push(`${file.name}: file type .${ext || "unknown"} is not supported.`);
        } else if (file.size === 0) {
            problems.push(`${file.name}: the file is empty.`);
        } else if (file.size > MAX_FILE_MB * 1024 * 1024) {
            problems.push(`${file.name}: larger than ${MAX_FILE_MB} MB.`);
        } else if (files.some(f => f.file.name === file.name && f.file.size === file.size)) {
            problems.push(`${file.name}: already added.`);
        } else if (files.length >= MAX_FILES) {
            problems.push(`${file.name}: you can upload up to ${MAX_FILES} files at a time.`);
        } else {
            files.push({ id: nextId++, file, status: "pending", error: null, stage: "", fileId: null });
        }
    });

    if (problems.length) setFilesError(problems.join("\n"));
    else clearFilesError();

    render();
}

/* ---------- Upload ---------- */

/* Phase 1, for one file: store it temporarily in CRM file storage and keep its file ID */
async function prepareOne(item) {
    item.status = "uploading"; item.error = null; item.stage = "Preparing the file..."; render();
    try {
        item.fileId = await uploadToStorage(item.file);
        item.stage = "Waiting...";
    } catch (err) {
        console.error("prepareOne error:", err);
        item.status = "error";
        item.error = err?.message || "The file could not be prepared. Try again.";
    }
    render();
}

/* Phase 3, for one file: the Deluge function puts it in WorkDrive. The address goes along with every call. */
async function sendToWorkDrive(item) {
    item.status = "uploading"; item.error = null; item.stage = "Uploading to WorkDrive..."; render();
    try {
        const payload = {
            application_id: String(currentRecordId),
            account_id: folderInfo.account_id,
            legal_doc_id: folderInfo.legal_doc_id,
            tl_jurisdiction: folderInfo.tl_jurisdiction,
            file_id: item.fileId,
            file_name: item.file.name,
            street_address: addressInfo?.street_address || "",
            city: addressInfo?.city || "",
            country: addressInfo?.country || "",
            address_source: addressInfo?.source || "",
            address_status: addressInfo ? "captured" : "not_found"
        };

        // The Deluge function is declared as (String arguments), so everything goes inside that one parameter.
        // Only one format is tried, so a failed call can never upload the same file twice.
        const response = await executeFunction(UPLOAD_FUNCTION, [
            { label: "wrapped in arguments", argsString: JSON.stringify({ arguments: JSON.stringify(payload) }) }
        ]);

        if (response?.code && response.code !== "success") {
            throw new Error(`CRM returned ${response.code}: ${response.message || "no message"}`);
        }

        let out = readOutput(response);
        if (typeof out === "string") out = safeParse(out) || { status: "error", message: "Unexpected answer from the function: " + out.slice(0, 150) };
        if (!out) out = { status: "error", message: "The function returned no result." };

        if (out.status === "success") {
            item.status = "done";
        } else {
            item.status = "error";
            item.error = out.message || "Upload failed. Try again.";
        }
    } catch (err) {
        console.error("sendToWorkDrive error:", err);
        item.status = "error";
        item.error = err?.message || "Upload failed. Try again.";
    }
    render();
}

function closeWidget() {
    try { ZOHO.CRM.UI.Popup.closeReload(); }
    catch (e) { (window.top && window.top !== window ? window.top : window).location.reload(); }
}

/* Moves the Blueprint to the next stage, then closes the widget.
   If the proceed call is not available or fails, the widget still closes. */
async function finishWidget() {
    try {
        if (ZOHO.CRM.BLUEPRINT && typeof ZOHO.CRM.BLUEPRINT.proceed === "function") {
            await ZOHO.CRM.BLUEPRINT.proceed();
        } else {
            console.warn("ZOHO.CRM.BLUEPRINT.proceed is not available.");
        }
    } catch (err) {
        console.error("Blueprint proceed failed:", err);
    }
    closeWidget();
}

async function handleSubmit(event) {
    event.preventDefault();
    if (isUploading) return;

    if (!currentRecordId) {
        showToast("The record details were not received, so files cannot be uploaded.", "error");
        return;
    }
    if (files.length === 0) {
        setFilesError("Supporting Files is required. Please add at least one file.");
        $("dropzone").scrollIntoView({ behavior: "smooth", block: "center" });
        return;
    }
    if (!files.some(f => docTypeOf(f.file.name))) {
        setFilesError(`Add at least one file with "ULA", "Ejari", "Tenancy Contract", "Lease Agreement", "Lease Document", "Facility Agreement", "Co-Working Agreement" or "TL" in its filename.`);
        $("dropzone").scrollIntoView({ behavior: "smooth", block: "center" });
        return;
    }

    const queue = files.filter(f => f.status !== "done");
    if (queue.length === 0) { finishWidget(); return; }

    clearFilesError();
    isUploading = true; render();

    // Step 1: the folder details (asked once, then kept)
    if (!folderInfo) {
        showLoader("Preparing the document folder...");
        try {
            folderInfo = await loadFolderInfo();
        } catch (err) {
            console.error("loadFolderInfo error:", err);
            hideLoader();
            isUploading = false; render();
            showToast(err?.message || "The document folder could not be found.", "error", 6000);
            return;
        }
        hideLoader();
    }

    // Step 2: store every file temporarily (one at a time keeps each call short)
    for (const item of queue) {
        if (!item.fileId) await prepareOne(item);
    }

    // Step 3: read the address (lease-type document first, then TL). Skipped when it was already captured.
    if (!addressInfo) {
        addressInfo = await extractAddress();
    }

    // Step 4: upload each prepared file to WorkDrive, with the address passed along
    for (const item of queue) {
        if (item.fileId && item.status !== "done") await sendToWorkDrive(item);
    }

    isUploading = false; render();

    const failed = files.filter(f => f.status === "error").length;
    if (failed === 0) {
        $("upload-btn-label").textContent = "Done";
        // const note = addressInfo ? "" : " The address was not captured, so it needs to be entered manually.";
        // The toast fades out by itself, then the Blueprint moves on and the widget closes
        // Always the same success toast, whether or not an address was captured.
        // The toast fades out by itself, then the Blueprint moves on and the widget closes.
        showToast(
            `${files.length} ${files.length === 1 ? "file was" : "files were"} uploaded to WorkDrive.`,
            "success",
            3000,
            finishWidget
        );
    } else {
        showToast(`${failed} ${failed === 1 ? "file" : "files"} failed to upload. Remove or retry using Upload Files.`, "error", 4000);
    }
}

/* ---------- Setup ---------- */
function setupDropzone() {
    const dz = $("dropzone"), input = $("file-input");

    $("dz-hint").textContent = `${ALLOWED_EXT.map(e => e.toUpperCase()).join(", ")} · up to ${MAX_FILE_MB} MB each · max ${MAX_FILES} files`;

    dz.addEventListener("click", () => input.click());
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });

    ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
    dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

    // Stop the browser from opening a file dropped outside the zone
    ["dragover", "drop"].forEach(ev => window.addEventListener(ev, (e) => e.preventDefault()));

    $("file-list").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-remove]");
        if (!btn || isUploading) return;
        files = files.filter(f => f.id !== Number(btn.dataset.remove));
        clearFilesError(); render();
    });
    $("clear-all").addEventListener("click", () => {
        if (isUploading) return;
        files = files.filter(f => f.status === "done");
        clearFilesError(); render();
    });
    $("close-btn").addEventListener("click", () => { try { ZOHO.CRM.UI.Popup.close(); } catch (e) {} });
    $("record-form").addEventListener("submit", handleSubmit);
}

function resolveRecordId(e) {
    if (!e) return null;
    const idKeys = ["recordId", "record_id", "id", "applicationId", "application_id", "dealId", "entityId", "EntityId"];
    const fromObj = (o) => {
        if (!o) return null;
        if (["string", "number"].includes(typeof o)) return String(o);
        if (Array.isArray(o)) return o.length ? String(o[0]) : null;
        if (typeof o === "object") for (const k of idKeys) if (o[k]) return Array.isArray(o[k]) ? String(o[k][0]) : String(o[k]);
        return null;
    };
    return fromObj(e.EntityId) || fromObj(e.value) || fromObj(e.data) || fromObj(e);
}

async function initializeWidget(e) {
    showLoader("Loading...");
    try {
        currentRecordId = resolveRecordId(e);
        currentEntity = e?.Entity || null;

        if (!currentRecordId) {
            const pageInfo = await ZOHO.CRM.INTERACTION.getPageInfo().catch(() => null);
            currentRecordId = currentRecordId || pageInfo?.recordId;
            currentEntity = currentEntity || pageInfo?.entity || pageInfo?.Entity;
        }

        const userInfo = await ZOHO.CRM.CONFIG.getCurrentUser().catch(() => null);
        if (userInfo?.users?.length) {
            triggeredByUser = userInfo.users[0].full_name;
            const g = $("user-greeting");
            g.textContent = `Hello ${triggeredByUser}!`;
            g.classList.add("visible");
        }

        ZOHO.CRM.UI.Resize({ height: "700", width: "900" });

        hideLoader();
        if (!currentRecordId) {
            showToast("The record ID was not received, so files cannot be uploaded.", "error");
        }
    } catch (err) {
        console.error("Error in initializeWidget:", err);
        hideLoader();
        showToast(`Hi ${triggeredByUser || "User"}, there is an issue with the internal system.`, "error");
    }
}

setupDropzone();
render();

ZOHO.embeddedApp.on("PageLoad", async (e) => await initializeWidget(e));
ZOHO.embeddedApp.init();