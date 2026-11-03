/* ---------------------------------------------------------------
   Upload Documents widget
   Attaches every selected file to the CRM record's Attachments.
--------------------------------------------------------------- */
const MAX_FILE_MB = 20;
const MAX_FILES = 10;
const ALLOWED_EXT = ["pdf", "doc", "docx", "xls", "xlsx", "csv", "txt", "png", "jpg", "jpeg", "zip"];

let currentRecordId = null, currentEntity = null, triggeredByUser = null;
let files = [];          // { id, file, status: "pending" | "uploading" | "done" | "error", error }
let isUploading = false;
let nextId = 1;

/* Document priority: a file with "ULA" in its name is used first. Only if there is none, a file with "TL" is used. */
const DOC_TAGS = ["ULA", "TL"];   // priority order
const EXTRACT_FUNCTION = "tl_address_ocr_zia";   // API name of the Deluge function that reads street and city

const hasTag = (name, tag) => name.toUpperCase().includes(tag);
const tagOf = (name) => DOC_TAGS.find(t => hasTag(name, t)) || null;
const matchesRequired = (name) => tagOf(name) !== null;

/* Picks the uploaded file to read: the first ULA file, otherwise the first TL file */
function pickSourceFile() {
    for (const tag of DOC_TAGS) {
        const f = files.find(x => x.status === "done" && hasTag(x.file.name, tag));
        if (f) return f;
    }
    return null;
}

const $ = (id) => document.getElementById(id);

const WARN_ICON = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>';
const CHECK_ICON = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
const CLOSE_ICON = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';

/* ---------- Helpers ---------- */
const getExt = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
    toast.innerHTML = `<div class="toast-progress" style="animation-duration: ${duration}ms;"></div><div class="toast-body"><div class="toast-icon-badge">${type === "success" ? CHECK_ICON : WARN_ICON}</div><div class="toast-content"><span class="toast-title">${type === "success" ? "Success" : "Action Required"}</span><span class="toast-text">${message}</span></div></div>`;
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

/* Logs the execute() result in a readable way: status, the Deluge info logs, and the function output as JSON */
function logFunctionResult(name, response) {
    const d = response?.details || {};
    console.log("Result code:", response?.code, "| message:", response?.message);
    console.log("Deluge info logs (userMessage):", JSON.stringify(d.userMessage ?? [], null, 2));
    let outputJson;
    try { outputJson = typeof d.output === "string" ? JSON.parse(d.output) : d.output; }
    catch (e) { console.warn("Function output is not valid JSON:", d.output); return; }
    console.log("Function output (JSON):", JSON.stringify(outputJson ?? null, null, 2));
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
        logFunctionResult(name, response);
        if (response?.code !== "INVALID_DATA") break;
        console.warn("INVALID_DATA for format '" + a.label + "'. Trying the next format if there is one.");
    }
    return response;
}

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

/* Temporary preview of what the function captured */
function showResult(out) {
    const ok = out.status === "success";
    $("result-section").classList.remove("hidden");
    const s = $("result-status");
    s.className = `result-status ${ok ? "ok" : "error"}`;
    s.innerHTML = `${ok ? CHECK_ICON : WARN_ICON}<span>${ok ? "Address captured from the document." : escapeHtml(out.message || "The address could not be captured.")}</span>`;
    $("res-street").value = out.street_address || "";
    $("res-city").value = out.city || "";
    $("res-country").value = ok ? (out.country || "United Arab Emirates") : "";
    $("result-section").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function runExtraction(item) {
    showLoader("Reading the document...");
    let out;
    try {
        const args = { application_id: String(currentRecordId), attachment_id: item.attachmentId };
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
    item.extracted = true;
    hideLoader();
    showResult(out);
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
        const meta = item.status === "uploading" ? "Uploading..."
                   : item.status === "done"      ? `Uploaded · ${formatSize(item.file.size)}`
                   : item.status === "error"     ? escapeHtml(item.error || "Upload failed. Try again.")
                   : formatSize(item.file.size) + (tagOf(item.file.name) ? ` · Required ${tagOf(item.file.name)} file` : "");
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
            files.push({ id: nextId++, file, status: "pending", error: null });
        }
    });

    if (problems.length) setFilesError(problems.join("\n"));
    else clearFilesError();

    render();
}

/* ---------- Upload ---------- */
async function uploadOne(item) {
    item.status = "uploading"; item.error = null; render();
    try {
        const resp = await ZOHO.CRM.API.attachFile({
            Entity: currentEntity,
            RecordID: currentRecordId,
            File: { Name: item.file.name, Content: item.file }
        });
        console.log("=== RESULT FOR: attachFile (" + item.file.name + ") ===");
        console.log("Raw Response:", JSON.stringify(resp, null, 2));
        const result = Array.isArray(resp?.data) ? resp.data[0] : null;
        if (result?.code === "SUCCESS" || result?.status === "success") {
            item.status = "done";
            item.attachmentId = result?.details?.id || null;
        } else {
            item.status = "error";
            item.error = result?.message || "Upload failed. Try again.";
        }
    } catch (err) {
        console.error("attachFile error:", err);
        item.status = "error";
        item.error = "Upload failed. Try again.";
    }
    render();
}

function closeWidget() {
    try { ZOHO.CRM.UI.Popup.closeReload(); }
    catch (e) { (window.top && window.top !== window ? window.top : window).location.reload(); }
}

async function handleSubmit(event) {
    event.preventDefault();
    if (isUploading) return;

    if (!currentRecordId || !currentEntity) {
        showToast("The record details were not received, so files cannot be uploaded.", "error");
        return;
    }
    if (files.length === 0) {
        setFilesError("Supporting Files is required. Please add at least one file.");
        $("dropzone").scrollIntoView({ behavior: "smooth", block: "center" });
        return;
    }

    if (!files.some(f => matchesRequired(f.file.name))) {
        setFilesError(`A file with "ULA" or "TL" in its name is required. Add it before uploading.`);
        $("dropzone").scrollIntoView({ behavior: "smooth", block: "center" });
        return;
    }

    const queue = files.filter(f => f.status !== "done");
    if (queue.length === 0) { closeWidget(); return; }

    clearFilesError();
    isUploading = true; render();

    for (const item of queue) await uploadOne(item);   // one at a time keeps CRM happy

    isUploading = false; render();

    const failed = files.filter(f => f.status === "error").length;

    // Read the address from the ULA file first; only if there is none, from the TL file (once per file)
    const docItem = pickSourceFile();
    console.log("Source document for address:", docItem ? docItem.file.name + " (" + tagOf(docItem.file.name) + ")" : "none");
    if (docItem && !docItem.extracted) {
        if (docItem.attachmentId) {
            await runExtraction(docItem);
        } else {
            docItem.extracted = true;
            console.warn("attachFile did not return an attachment id. Check the Raw Response log above.");
            showResult({ status: "error", message: "CRM did not return the attachment ID, so the document could not be read." });
        }
    }

    if (failed === 0) {
        $("upload-btn-label").textContent = "Done";
        showToast(`${files.length} ${files.length === 1 ? "file was" : "files were"} uploaded successfully.`, "success", 3000);
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

        if (!currentRecordId || !currentEntity) {
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
        if (!currentRecordId || !currentEntity) {
            showToast("The record ID or module was not received, so files cannot be uploaded.", "error");
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