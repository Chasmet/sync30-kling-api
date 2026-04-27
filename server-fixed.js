import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_SYNCUP_VERSION = process.env.REPLICATE_SYNCUP_VERSION;

if (!SUPABASE_URL) throw new Error("SUPABASE_URL manquante");
if (!SUPABASE_KEY) throw new Error("SUPABASE_SERVICE_KEY ou SUPABASE_SERVICE_ROLE_KEY manquante");
if (!REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN manquante");
if (!REPLICATE_SYNCUP_VERSION) throw new Error("REPLICATE_SYNCUP_VERSION manquante");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const BUCKET = "videos";
const ENGINE_FOLDER = "syncup";
const BALANCE_TYPE = "syncup";
const MAX_SYNCUP_SECONDS = 9;
const MAX_VIDEOS_PER_USER = 3;
const MAX_VIDEO_AGE_HOURS = 24;
const JOB_TIMEOUT_MINUTES = 20;
const PRICE_PER_30_SECONDS_EUR = 2.19;
const ADMIN_EMAIL = "skypieachannel" + "@" + "gmail.com";
const jobs = new Map();

function clean(value) { return String(value || "").trim().toLowerCase(); }
function getUserId(req) { return String(req.headers["x-user-id"] || "public").trim() || "public"; }
function safeErrorMessage(error) { return error?.message || "Erreur inconnue"; }
function safeDate(value) { const d = new Date(value || 0); return Number.isNaN(d.getTime()) ? new Date(0) : d; }
function buildFolderPath(userId) { return `${userId}/${ENGINE_FOLDER}`; }
function buildStoragePath(userId, fileName) { return `${userId}/${ENGINE_FOLDER}/${fileName}`; }
function buildPlayUrl(fileName) { return `/open-video/${encodeURIComponent(fileName)}`; }
function buildDownloadUrl(fileName) { return `/download-video/${encodeURIComponent(fileName)}`; }
function getJobTimeoutMs() { return JOB_TIMEOUT_MINUTES * 60 * 1000; }
function getUnlimitedWallet(userId) { return { userId, isAdmin: true, unlimited: true, secondsBalance: 999999, standardSecondsBalance: 999999, premiumSecondsBalance: 999999, syncupSecondsBalance: 999999 }; }

async function isAdminRequest(req) {
  const userId = getUserId(req);
  if (!userId || userId === "public") return false;
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error) return false;
    return clean(data?.user?.email) === ADMIN_EMAIL;
  } catch {
    return false;
  }
}

function parseDurationSeconds(rawValue, maxSeconds) {
  const value = Number(String(rawValue ?? "").replace(",", "."));
  if (!Number.isFinite(value) || value <= 0 || value > maxSeconds) return null;
  return value;
}

function roundSecondsForBilling(durationSeconds) {
  const value = Number(durationSeconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const lower = Math.floor(value);
  return Math.max(1, value - lower <= 0.5 ? lower : lower + 1);
}

async function ensureWallet(userId) {
  const fields = "user_id, seconds_balance, standard_seconds_balance, premium_seconds_balance, syncup_seconds_balance";
  const { data, error } = await supabase.from("time_wallets").select(fields).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (data) return data;
  const { data: inserted, error: insertError } = await supabase.from("time_wallets").insert({ user_id: userId, seconds_balance: 0, standard_seconds_balance: 0, premium_seconds_balance: 0, syncup_seconds_balance: 0 }).select(fields).single();
  if (insertError) throw insertError;
  return inserted;
}

async function getWalletState(userId) {
  const wallet = await ensureWallet(userId);
  return { userId: wallet.user_id, isAdmin: false, unlimited: false, secondsBalance: Number(wallet.seconds_balance || 0), standardSecondsBalance: Number(wallet.standard_seconds_balance || 0), premiumSecondsBalance: Number(wallet.premium_seconds_balance || 0), syncupSecondsBalance: Number(wallet.syncup_seconds_balance || 0) };
}

async function getBalanceByType(userId, type) {
  const wallet = await ensureWallet(userId);
  if (type === "syncup") return Number(wallet.syncup_seconds_balance || 0);
  if (type === "premium") return Number(wallet.premium_seconds_balance || 0);
  return Number(wallet.standard_seconds_balance || 0);
}

async function updateBalances(userId, updates) {
  const { error } = await supabase.from("time_wallets").update(updates).eq("user_id", userId);
  if (error) throw error;
}

async function debitBalanceByType(userId, type, billedSeconds) {
  const wallet = await ensureWallet(userId);
  let currentBalance = Number(wallet.syncup_seconds_balance || 0);
  let field = "syncup_seconds_balance";
  if (type === "premium") { currentBalance = Number(wallet.premium_seconds_balance || 0); field = "premium_seconds_balance"; }
  if (type !== "syncup" && type !== "premium") { currentBalance = Number(wallet.standard_seconds_balance || 0); field = "standard_seconds_balance"; }
  if (currentBalance < billedSeconds) throw new Error("Pas assez de temps disponible");
  const newBalance = currentBalance - billedSeconds;
  const updates = { [field]: newBalance };
  if (type === "standard") updates.seconds_balance = newBalance;
  await updateBalances(userId, updates);
  return newBalance;
}

async function refundBalanceByType(userId, type, refundedSeconds) {
  const wallet = await ensureWallet(userId);
  let currentBalance = Number(wallet.syncup_seconds_balance || 0);
  let field = "syncup_seconds_balance";
  if (type === "premium") { currentBalance = Number(wallet.premium_seconds_balance || 0); field = "premium_seconds_balance"; }
  if (type !== "syncup" && type !== "premium") { currentBalance = Number(wallet.standard_seconds_balance || 0); field = "standard_seconds_balance"; }
  const newBalance = currentBalance + refundedSeconds;
  const updates = { [field]: newBalance };
  if (type === "standard") updates.seconds_balance = newBalance;
  await updateBalances(userId, updates);
  return newBalance;
}

async function refundJobIfNeeded(job) {
  if (!job || !job.debited || job.refunded || job.isAdmin || !job.billedSeconds || job.billedSeconds <= 0) return job?.balanceAfterDebit ?? null;
  const balanceAfterRefund = await refundBalanceByType(job.userId, job.balanceType, job.billedSeconds);
  job.refunded = true;
  job.balanceAfterRefund = balanceAfterRefund;
  return balanceAfterRefund;
}

async function listRawVideos(userId) {
  const { data, error } = await supabase.storage.from(BUCKET).list(buildFolderPath(userId), { limit: 100, sortBy: { column: "created_at", order: "desc" } });
  if (error) throw error;
  return data || [];
}

async function deleteStoredVideo(userId, fileName) {
  const { error } = await supabase.storage.from(BUCKET).remove([buildStoragePath(userId, fileName)]);
  if (error) throw error;
}

async function enforceVideoRetention(userId) {
  if (!userId) return;
  const files = await listRawVideos(userId);
  const now = Date.now();
  const maxAgeMs = MAX_VIDEO_AGE_HOURS * 60 * 60 * 1000;
  const expired = files.filter((file) => now - safeDate(file.created_at).getTime() > maxAgeMs);
  const expiredNames = new Set(expired.map((file) => file.name));
  const fresh = files.filter((file) => !expiredNames.has(file.name)).sort((a, b) => safeDate(a.created_at).getTime() - safeDate(b.created_at).getTime());
  const overflow = fresh.length > MAX_VIDEOS_PER_USER ? fresh.slice(0, fresh.length - MAX_VIDEOS_PER_USER) : [];
  for (const file of [...expired, ...overflow]) {
    try { await deleteStoredVideo(userId, file.name); } catch (error) { console.error("RETENTION DELETE ERROR:", file.name, error.message); }
  }
}

async function getUserVideos(userId) {
  await enforceVideoRetention(userId);
  const files = await listRawVideos(userId);
  return files.map((file) => ({ name: file.name, playUrl: buildPlayUrl(file.name), downloadUrl: buildDownloadUrl(file.name), created_at: file.created_at, metadata: file.metadata }));
}

app.get("/", (_req, res) => {
  res.json({ ok: true, status: "Sync30 Kling API sécurisée", engine: ENGINE_FOLDER, balanceType: BALANCE_TYPE, adminMode: "email admin uniquement", billing: { mode: "seconds", maxSyncupSeconds: MAX_SYNCUP_SECONDS, pricePer30SecondsEur: PRICE_PER_30_SECONDS_EUR } });
});

app.get("/wallet", async (req, res) => {
  try {
    const userId = getUserId(req);
    const isAdmin = await isAdminRequest(req);
    if (isAdmin) return res.json({ ok: true, ...getUnlimitedWallet(userId) });
    const wallet = await getWalletState(userId);
    return res.json({ ok: true, ...wallet });
  } catch (error) {
    console.error("WALLET ERROR:", error);
    return res.status(500).json({ ok: false, error: safeErrorMessage(error) });
  }
});

app.post("/sync", upload.fields([{ name: "video", maxCount: 1 }, { name: "audio", maxCount: 1 }]), async (req, res) => {
  let userId = null;
  let billedSeconds = 0;
  let debited = false;
  try {
    userId = getUserId(req);
    const isAdmin = await isAdminRequest(req);
    console.log("SYNC START", { userId, isAdmin });
    const videoFile = req.files?.video?.[0];
    const audioFile = req.files?.audio?.[0];
    if (!videoFile || !audioFile) return res.status(400).json({ ok: false, error: "Fichiers manquants" });
    const detectedDuration = parseDurationSeconds(req.body?.duration_seconds, MAX_SYNCUP_SECONDS);
    if (!detectedDuration) return res.status(400).json({ ok: false, error: `Durée vidéo invalide ou manquante. Maximum autorisé : ${MAX_SYNCUP_SECONDS} secondes` });
    billedSeconds = roundSecondsForBilling(detectedDuration);
    let balanceAfterDebit = null;
    if (!isAdmin) {
      const balanceBeforeDebit = await getBalanceByType(userId, BALANCE_TYPE);
      if (balanceBeforeDebit < billedSeconds) return res.status(403).json({ ok: false, error: "Pas assez de temps disponible", balanceType: BALANCE_TYPE, syncupSecondsBalance: balanceBeforeDebit, requiredSeconds: billedSeconds });
      balanceAfterDebit = await debitBalanceByType(userId, BALANCE_TYPE, billedSeconds);
      debited = true;
    }
    const b64 = "base" + "64";
    const replicateResponse = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: REPLICATE_SYNCUP_VERSION, input: { video: `data:${videoFile.mimetype};${b64},${videoFile.buffer.toString(b64)}`, audio: `data:${audioFile.mimetype};${b64},${audioFile.buffer.toString(b64)}` } })
    });
    const prediction = await replicateResponse.json();
    if (!replicateResponse.ok || !prediction?.id || !prediction?.urls?.get) {
      if (debited && billedSeconds > 0) await refundBalanceByType(userId, BALANCE_TYPE, billedSeconds);
      return res.status(500).json({ ok: false, error: prediction?.detail || prediction?.error || "Erreur lancement Replicate" });
    }
    jobs.set(prediction.id, { userId, isAdmin, engine: ENGINE_FOLDER, status: prediction.status || "starting", createdAt: new Date().toISOString(), replicateGetUrl: prediction.urls.get, outputUrl: null, storedFilePath: null, fileName: null, error: null, billedSeconds, balanceType: BALANCE_TYPE, debited: !isAdmin, refunded: false, balanceAfterDebit });
    return res.json({ ok: true, jobId: prediction.id, status: prediction.status || "starting", billedSeconds, balanceType: BALANCE_TYPE, isAdmin, unlimited: isAdmin, syncupSecondsBalance: isAdmin ? 999999 : balanceAfterDebit });
  } catch (error) {
    console.error("SYNC START ERROR:", error);
    if (debited && billedSeconds > 0 && userId) {
      try { await refundBalanceByType(userId, BALANCE_TYPE, billedSeconds); } catch (refundError) { console.error("START REFUND ERROR:", refundError); }
    }
    return res.status(500).json({ ok: false, error: safeErrorMessage(error) });
  }
});

app.get("/sync-status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = getUserId(req);
    const isAdmin = await isAdminRequest(req);
    const job = jobs.get(jobId);
    if (!job) return res.status(404).json({ ok: false, error: "Job introuvable" });
    if (job.userId !== userId && !isAdmin) return res.status(403).json({ ok: false, error: "Accès refusé" });
    const createdAt = new Date(job.createdAt).getTime();
    if (!Number.isNaN(createdAt) && Date.now() - createdAt > getJobTimeoutMs() && job.status !== "succeeded" && job.status !== "failed") {
      job.status = "failed";
      job.error = "Timeout du job";
      const refundedBalance = await refundJobIfNeeded(job);
      jobs.set(jobId, job);
      return res.json({ ok: true, status: "failed", error: job.error, billedSeconds: job.billedSeconds, syncupSecondsBalance: job.isAdmin ? 999999 : refundedBalance });
    }
    if (job.status === "succeeded") return res.json({ ok: true, status: "succeeded", playUrl: buildPlayUrl(job.fileName), downloadUrl: buildDownloadUrl(job.fileName), fileName: job.fileName, billedSeconds: job.billedSeconds, isAdmin: job.isAdmin, unlimited: job.isAdmin });
    if (job.status === "failed") return res.json({ ok: true, status: "failed", error: job.error || "Le traitement a échoué", billedSeconds: job.billedSeconds, syncupSecondsBalance: job.isAdmin ? 999999 : (job.balanceAfterRefund ?? null) });
    const poll = await fetch(job.replicateGetUrl, { headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` } });
    const data = await poll.json();
    if (data.status === "starting" || data.status === "processing") {
      job.status = data.status;
      jobs.set(jobId, job);
      return res.json({ ok: true, status: data.status, billedSeconds: job.billedSeconds, isAdmin: job.isAdmin, unlimited: job.isAdmin });
    }
    if (data.status === "failed" || data.status === "canceled") {
      job.status = "failed";
      job.error = data?.error || "Replicate a échoué";
      const refundedBalance = await refundJobIfNeeded(job);
      jobs.set(jobId, job);
      return res.json({ ok: true, status: "failed", error: job.error, billedSeconds: job.billedSeconds, syncupSecondsBalance: job.isAdmin ? 999999 : refundedBalance });
    }
    if (data.status === "succeeded") {
      const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
      if (!outputUrl) {
        job.status = "failed";
        job.error = "Aucune vidéo de sortie";
        const refundedBalance = await refundJobIfNeeded(job);
        jobs.set(jobId, job);
        return res.json({ ok: true, status: "failed", error: job.error, billedSeconds: job.billedSeconds, syncupSecondsBalance: job.isAdmin ? 999999 : refundedBalance });
      }
      if (!job.storedFilePath) {
        try {
          const generatedVideoResponse = await fetch(outputUrl);
          if (!generatedVideoResponse.ok) throw new Error("Impossible de télécharger la vidéo générée");
          const generatedVideoBuffer = Buffer.from(await generatedVideoResponse.arrayBuffer());
          const fileName = `syncup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
          const filePath = buildStoragePath(job.userId, fileName);
          const { error: uploadError } = await supabase.storage.from(BUCKET).upload(filePath, generatedVideoBuffer, { contentType: "video/mp4", upsert: false });
          if (uploadError) throw uploadError;
          job.outputUrl = outputUrl;
          job.storedFilePath = filePath;
          job.fileName = fileName;
          await enforceVideoRetention(job.userId);
        } catch (storageError) {
          job.status = "failed";
          job.error = safeErrorMessage(storageError);
          const refundedBalance = await refundJobIfNeeded(job);
          jobs.set(jobId, job);
          return res.json({ ok: true, status: "failed", error: job.error, billedSeconds: job.billedSeconds, syncupSecondsBalance: job.isAdmin ? 999999 : refundedBalance });
        }
      }
      job.status = "succeeded";
      jobs.set(jobId, job);
      return res.json({ ok: true, status: "succeeded", playUrl: buildPlayUrl(job.fileName), downloadUrl: buildDownloadUrl(job.fileName), fileName: job.fileName, billedSeconds: job.billedSeconds, isAdmin: job.isAdmin, unlimited: job.isAdmin });
    }
    return res.json({ ok: true, status: data.status || "processing", billedSeconds: job.billedSeconds, isAdmin: job.isAdmin, unlimited: job.isAdmin });
  } catch (error) {
    console.error("SYNC STATUS ERROR:", error);
    return res.status(500).json({ ok: false, error: safeErrorMessage(error) });
  }
});

app.get("/videos", async (req, res) => {
  try { return res.json({ ok: true, videos: await getUserVideos(getUserId(req)) }); }
  catch (error) { console.error("VIDEOS ERROR:", error); return res.status(500).json({ ok: false, error: safeErrorMessage(error) }); }
});

app.get("/open-video/:name", async (req, res) => {
  try {
    const fileName = req.params.name;
    if (!fileName) return res.status(400).json({ ok: false, error: "Nom de fichier manquant" });
    const { data, error } = await supabase.storage.from(BUCKET).download(buildStoragePath(getUserId(req), fileName));
    if (error || !data) return res.status(404).json({ ok: false, error: "Vidéo introuvable" });
    const buffer = Buffer.from(await data.arrayBuffer());
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-store");
    return res.send(buffer);
  } catch (error) { console.error("OPEN VIDEO ERROR:", error); return res.status(500).json({ ok: false, error: safeErrorMessage(error) }); }
});

app.get("/download-video/:name", async (req, res) => {
  try {
    const fileName = req.params.name;
    if (!fileName) return res.status(400).json({ ok: false, error: "Nom de fichier manquant" });
    const { data, error } = await supabase.storage.from(BUCKET).download(buildStoragePath(getUserId(req), fileName));
    if (error || !data) return res.status(404).json({ ok: false, error: "Vidéo introuvable" });
    const buffer = Buffer.from(await data.arrayBuffer());
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.send(buffer);
  } catch (error) { console.error("DOWNLOAD VIDEO ERROR:", error); return res.status(500).json({ ok: false, error: safeErrorMessage(error) }); }
});

app.post("/delete-video", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: "Nom manquant" });
    await deleteStoredVideo(getUserId(req), name);
    return res.json({ ok: true });
  } catch (error) { console.error("DELETE ERROR:", error); return res.status(500).json({ ok: false, error: safeErrorMessage(error) }); }
});

setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    const created = new Date(job.createdAt).getTime();
    if (!Number.isNaN(created) && now - created > 24 * 60 * 60 * 1000) jobs.delete(jobId);
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sync-up secure server running on ${PORT}`));
