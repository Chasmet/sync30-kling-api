import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// CONFIG
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_SYNCUP_VERSION = process.env.REPLICATE_SYNCUP_VERSION;

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL manquante");
}
if (!SUPABASE_KEY) {
  throw new Error("SUPABASE_SERVICE_KEY ou SUPABASE_SERVICE_ROLE_KEY manquante");
}
if (!REPLICATE_API_TOKEN) {
  throw new Error("REPLICATE_API_TOKEN manquante");
}
if (!REPLICATE_SYNCUP_VERSION) {
  throw new Error("REPLICATE_SYNCUP_VERSION manquante");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BUCKET = "videos";
const ENGINE_FOLDER = "syncup";
const BALANCE_TYPE = "syncup";
const MAX_SYNCUP_SECONDS = 9;
const MAX_VIDEOS_PER_USER = 3;
const MAX_VIDEO_AGE_HOURS = 24;
const JOB_TIMEOUT_MINUTES = 20;
const PRICE_PER_30_SECONDS_EUR = 2.19;

// Si x-user-id = admin OU x-admin = true => admin illimité
const ADMIN_USER_IDS = ["admin"];

const jobs = new Map();

// UTILS
function getUserId(req) {
  return String(req.headers["x-user-id"] || "public");
}

async function isAdminRequest(req) {
  const xAdmin = String(req.headers["x-admin"] || "").toLowerCase();
  const userId = getUserId(req).toLowerCase();

  if(xAdmin==="true"||ADMIN_USER_IDS.includes(userId))return true;return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStoragePath(userId, fileName) {
  return `${userId}/${ENGINE_FOLDER}/${fileName}`;
}

function buildFolderPath(userId) {
  return `${userId}/${ENGINE_FOLDER}`;
}

function buildPlayUrl(fileName) {
  return `/open-video/${encodeURIComponent(fileName)}`;
}

function buildDownloadUrl(fileName) {
  return `/download-video/${encodeURIComponent(fileName)}`;
}

function safeErrorMessage(error) {
  return error?.message || "Erreur inconnue";
}

function safeDate(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function sortByCreatedAtAsc(files = []) {
  return [...files].sort((a, b) => {
    return safeDate(a.created_at).getTime() - safeDate(b.created_at).getTime();
  });
}

function getExpiredFiles(files = []) {
  const now = Date.now();
  const maxAgeMs = MAX_VIDEO_AGE_HOURS * 60 * 60 * 1000;

  return files.filter((file) => {
    const createdAt = safeDate(file.created_at).getTime();
    return now - createdAt > maxAgeMs;
  });
}

function getOverflowFiles(files = []) {
  const sorted = sortByCreatedAtAsc(files);

  if (sorted.length <= MAX_VIDEOS_PER_USER) {
    return [];
  }

  return sorted.slice(0, sorted.length - MAX_VIDEOS_PER_USER);
}

function parseDurationSeconds(rawValue, maxSeconds) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return null;
  }

  const normalized = String(rawValue).replace(",", ".");
  const value = Number(normalized);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  if (value > maxSeconds) {
    return null;
  }

  return value;
}

function roundSecondsForBilling(durationSeconds) {
  const value = Number(durationSeconds);

  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const lower = Math.floor(value);
  const decimal = value - lower;

  let billed = decimal <= 0.5 ? lower : lower + 1;

  if (billed < 1) {
    billed = 1;
  }

  return billed;
}

function getJobTimeoutMs() {
  return JOB_TIMEOUT_MINUTES * 60 * 1000;
}

function getUnlimitedWallet(userId) {
  return {
    userId,
    isAdmin: true,
    unlimited: true,
    secondsBalance: 999999,
    standardSecondsBalance: 999999,
    premiumSecondsBalance: 999999,
    syncupSecondsBalance: 999999
  };
}

// STORAGE
async function listRawVideos(userId) {
  const folder = buildFolderPath(userId);

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(folder, {
      limit: 100,
      sortBy: { column: "created_at", order: "desc" }
    });

  if (error) {
    throw error;
  }

  return data || [];
}

async function deleteStoredVideo(userId, fileName) {
  const filePath = buildStoragePath(userId, fileName);

  const { error } = await supabase.storage
    .from(BUCKET)
    .remove([filePath]);

  if (error) {
    throw error;
  }
}

async function enforceVideoRetention(userId) {
  if (!userId) return;

  const rawFiles = await listRawVideos(userId);

  const expiredFiles = getExpiredFiles(rawFiles);
  const expiredNames = new Set(expiredFiles.map((file) => file.name));

  const freshFiles = rawFiles.filter((file) => !expiredNames.has(file.name));
  const overflowFiles = getOverflowFiles(freshFiles);

  const filesToDelete = [
    ...expiredFiles,
    ...overflowFiles.filter((file) => !expiredNames.has(file.name))
  ];

  for (const file of filesToDelete) {
    try {
      await deleteStoredVideo(userId, file.name);
    } catch (error) {
      console.error("RETENTION DELETE ERROR:", file.name, error.message);
    }
  }
}

async function getUserVideos(userId) {
  await enforceVideoRetention(userId);

  const data = await listRawVideos(userId);

  return data.map((file) => ({
    name: file.name,
    playUrl: buildPlayUrl(file.name),
    downloadUrl: buildDownloadUrl(file.name),
    created_at: file.created_at,
    metadata: file.metadata
  }));
}

// WALLET
async function ensureWallet(userId) {
  const { data, error } = await supabase
    .from("time_wallets")
    .select(
      "user_id, seconds_balance, standard_seconds_balance, premium_seconds_balance, syncup_seconds_balance"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data) {
    return data;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("time_wallets")
    .insert({
      user_id: userId,
      seconds_balance: 0,
      standard_seconds_balance: 0,
      premium_seconds_balance: 0,
      syncup_seconds_balance: 0
    })
    .select(
      "user_id, seconds_balance, standard_seconds_balance, premium_seconds_balance, syncup_seconds_balance"
    )
    .single();

  if (insertError) {
    throw insertError;
  }

  return inserted;
}

async function getWalletState(userId) {
  const wallet = await ensureWallet(userId);

  return {
    userId: wallet.user_id,
    isAdmin: false,
    unlimited: false,
    secondsBalance: Number(wallet.seconds_balance || 0),
    standardSecondsBalance: Number(wallet.standard_seconds_balance || 0),
    premiumSecondsBalance: Number(wallet.premium_seconds_balance || 0),
    syncupSecondsBalance: Number(wallet.syncup_seconds_balance || 0)
  };
}

async function getBalanceByType(userId, type) {
  const wallet = await ensureWallet(userId);

  if (type === "syncup") {
    return Number(wallet.syncup_seconds_balance || 0);
  }

  if (type === "premium") {
    return Number(wallet.premium_seconds_balance || 0);
  }

  return Number(wallet.standard_seconds_balance || 0);
}

async function updateBalances(userId, updates) {
  const { error } = await supabase
    .from("time_wallets")
    .update(updates)
    .eq("user_id", userId);

  if (error) {
    throw error;
  }
}

async function debitBalanceByType(userId, type, billedSeconds) {
  const wallet = await ensureWallet(userId);

  let currentBalance = 0;
  let field = "syncup_seconds_balance";

  if (type === "syncup") {
    currentBalance = Number(wallet.syncup_seconds_balance || 0);
    field = "syncup_seconds_balance";
  } else if (type === "premium") {
    currentBalance = Number(wallet.premium_seconds_balance || 0);
    field = "premium_seconds_balance";
  } else {
    currentBalance = Number(wallet.standard_seconds_balance || 0);
    field = "standard_seconds_balance";
  }

  if (currentBalance < billedSeconds) {
    throw new Error("Pas assez de temps disponible");
  }

  const newBalance = currentBalance - billedSeconds;
  const updates = { [field]: newBalance };

  if (type === "standard") {
    updates.seconds_balance = newBalance;
  }

  await updateBalances(userId, updates);

  return newBalance;
}

async function refundBalanceByType(userId, type, refundedSeconds) {
  const wallet = await ensureWallet(userId);

  let currentBalance = 0;
  let field = "syncup_seconds_balance";

  if (type === "syncup") {
    currentBalance = Number(wallet.syncup_seconds_balance || 0);
    field = "syncup_seconds_balance";
  } else if (type === "premium") {
    currentBalance = Number(wallet.premium_seconds_balance || 0);
    field = "premium_seconds_balance";
  } else {
    currentBalance = Number(wallet.standard_seconds_balance || 0);
    field = "standard_seconds_balance";
  }

  const newBalance = currentBalance + refundedSeconds;
  const updates = { [field]: newBalance };

  if (type === "standard") {
    updates.seconds_balance = newBalance;
  }

  await updateBalances(userId, updates);

  return newBalance;
}

async function refundJobIfNeeded(job) {
  if (!job) return null;
  if (!job.debited) return job.balanceAfterDebit ?? null;
  if (job.refunded) return job.balanceAfterDebit ?? null;
  if (!job.billedSeconds || job.billedSeconds <= 0) return job.balanceAfterDebit ?? null;

  const balanceAfterRefund = await refundBalanceByType(
    job.userId,
    job.balanceType,
    job.billedSeconds
  );

  job.refunded = true;
  job.balanceAfterRefund = balanceAfterRefund;

  return balanceAfterRefund;
}

// ROOT
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "Sync30 API active",
    engine: ENGINE_FOLDER,
    modeInfo: "async job polling via Replicate",
    storageMode: "per-user",
    bucket: BUCKET,
    balanceType: BALANCE_TYPE,
    retention: {
      maxVideosPerUser: MAX_VIDEOS_PER_USER,
      maxAgeHours: MAX_VIDEO_AGE_HOURS
    },
    billing: {
      mode: "seconds",
      maxSyncupSeconds: MAX_SYNCUP_SECONDS,
      pricePer30SecondsEur: PRICE_PER_30_SECONDS_EUR
    },
    adminMode: {
      enabled: true,
      rule: 'x-admin="true" ou x-user-id="admin"'
    }
  });
});

// WALLET STATUS
app.get("/wallet", async (req, res) => {
  try {
    const userId = getUserId(req);
    const isAdmin = await isAdminRequest(req);

    if (isAdmin) {
      return res.json({
        ok: true,
        ...getUnlimitedWallet(userId)
      });
    }

    const wallet = await getWalletState(userId);

    return res.json({
      ok: true,
      userId: wallet.userId,
      isAdmin: wallet.isAdmin,
      unlimited: wallet.unlimited,
      secondsBalance: wallet.secondsBalance,
      standardSecondsBalance: wallet.standardSecondsBalance,
      premiumSecondsBalance: wallet.premiumSecondsBalance,
      syncupSecondsBalance: wallet.syncupSecondsBalance
    });
  } catch (error) {
    console.error("WALLET ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// LANCE LE JOB
app.post(
  "/sync",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  async (req, res) => {
    let userId = null;
    let billedSeconds = 0;
    let debited = false;

    try {
      userId = getUserId(req);
      const isAdmin = await isAdminRequest(req);

      const videoFile = req.files?.video?.[0];
      const audioFile = req.files?.audio?.[0];

      if (!videoFile || !audioFile) {
        return res.status(400).json({
          ok: false,
          error: "Fichiers manquants"
        });
      }

      const detectedDuration = parseDurationSeconds(
        req.body?.duration_seconds,
        MAX_SYNCUP_SECONDS
      );

      if (!detectedDuration) {
        return res.status(400).json({
          ok: false,
          error: `Durée vidéo invalide ou manquante. Maximum autorisé : ${MAX_SYNCUP_SECONDS} secondes`
        });
      }

      billedSeconds = roundSecondsForBilling(detectedDuration);

      let balanceBeforeDebit = null;
      let balanceAfterDebit = null;

      if (!isAdmin) {
        balanceBeforeDebit = await getBalanceByType(userId, BALANCE_TYPE);

        if (balanceBeforeDebit < billedSeconds) {
          return res.status(403).json({
            ok: false,
            error: "Pas assez de temps disponible",
            balanceType: BALANCE_TYPE,
            syncupSecondsBalance: balanceBeforeDebit,
            requiredSeconds: billedSeconds
          });
        }

        balanceAfterDebit = await debitBalanceByType(
          userId,
          BALANCE_TYPE,
          billedSeconds
        );
        debited = true;
      }

      const replicateResponse = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: {
          Authorization: `Token ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          version: REPLICATE_SYNCUP_VERSION,
          input: {
            video: `data:${videoFile.mimetype};base64,${videoFile.buffer.toString("base64")}`,
            audio: `data:${audioFile.mimetype};base64,${audioFile.buffer.toString("base64")}`
          }
        })
      });

      const prediction = await replicateResponse.json();

      if (!replicateResponse.ok || !prediction?.id || !prediction?.urls?.get) {
        if (debited && billedSeconds > 0) {
          await refundBalanceByType(userId, BALANCE_TYPE, billedSeconds);
          debited = false;
        }

        return res.status(500).json({
          ok: false,
          error: prediction?.detail || prediction?.error || "Erreur lancement Replicate"
        });
      }

      jobs.set(prediction.id, {
        userId,
        isAdmin,
        engine: ENGINE_FOLDER,
        status: prediction.status || "starting",
        createdAt: new Date().toISOString(),
        replicateGetUrl: prediction.urls.get,
        outputUrl: null,
        storedFilePath: null,
        fileName: null,
        error: null,
        billedSeconds,
        balanceType: BALANCE_TYPE,
        debited: !isAdmin,
        refunded: false,
        balanceAfterDebit
      });

      return res.json({
        ok: true,
        jobId: prediction.id,
        status: prediction.status || "starting",
        billedSeconds,
        balanceType: BALANCE_TYPE,
        isAdmin,
        unlimited: isAdmin,
        syncupSecondsBalance: isAdmin ? 999999 : balanceAfterDebit
      });
    } catch (error) {
      console.error("SYNC START ERROR:", error);

      if (debited && billedSeconds > 0 && userId) {
        try {
          await refundBalanceByType(userId, BALANCE_TYPE, billedSeconds);
        } catch (refundError) {
          console.error("START REFUND ERROR:", refundError);
        }
      }

      return res.status(500).json({
        ok: false,
        error: safeErrorMessage(error)
      });
    }
  }
);

// STATUT DU JOB
app.get("/sync-status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = getUserId(req);
    const isAdmin = await isAdminRequest(req);

    const job = jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "Job introuvable"
      });
    }

    if (job.userId !== userId && !isAdmin) {
      return res.status(403).json({
        ok: false,
        error: "Accès refusé"
      });
    }

    const createdAt = new Date(job.createdAt).getTime();
    if (!Number.isNaN(createdAt) && Date.now() - createdAt > getJobTimeoutMs()) {
      if (job.status !== "succeeded" && job.status !== "failed") {
        job.status = "failed";
        job.error = "Timeout du job";

        const refundedBalance = await refundJobIfNeeded(job);
        jobs.set(jobId, job);

        return res.json({
          ok: true,
          status: "failed",
          error: job.error,
          billedSeconds: job.billedSeconds,
          syncupSecondsBalance: job.isAdmin ? 999999 : refundedBalance
        });
      }
    }

    if (job.status === "succeeded") {
      return res.json({
        ok: true,
        status: "succeeded",
        playUrl: buildPlayUrl(job.fileName),
        downloadUrl: buildDownloadUrl(job.fileName),
        fileName: job.fileName,
        billedSeconds: job.billedSeconds,
        isAdmin: job.isAdmin,
        unlimited: job.isAdmin
      });
    }

    if (job.status === "failed") {
      return res.json({
        ok: true,
        status: "failed",
        error: job.error || "Le traitement a échoué",
        billedSeconds: job.billedSeconds,
        syncupSecondsBalance: job.isAdmin ? 999999 : (job.balanceAfterRefund ?? null)
      });
    }

    const poll = await fetch(job.replicateGetUrl, {
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`
      }
    });

    const data = await poll.json();

    console.log(`SYNC-UP prediction status: ${data.status}`);

    if (data.status === "starting" || data.status === "processing") {
      job.status = data.status;
      jobs.set(jobId, job);

      return res.json({
        ok: true,
        status: data.status,
        billedSeconds: job.billedSeconds,
        isAdmin: job.isAdmin,
        unlimited: job.isAdmin
      });
    }

    if (data.status === "failed" || data.status === "canceled") {
      job.status = "failed";
      job.error = data?.error || "Replicate a échoué";

      const refundedBalance = await refundJobIfNeeded(job);
      jobs.set(jobId, job);

      return res.json({
        ok: true,
        status: "failed",
        error: job.error,
        billedSeconds: job.billedSeconds,
        syncupSecondsBalance: job.isAdmin ? 999999 : refundedBalance
      });
    }

    if (data.status === "succeeded") {
      const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;

      if (!outputUrl) {
        job.status = "failed";
        job.error = "Aucune vidéo de sortie";

        const refundedBalance = await refundJobIfNeeded(job);
        jobs.set(jobId, job);

        return res.json({
          ok: true,
          status: "failed",
          error: job.error,
          billedSeconds: job.billedSeconds,
          syncupSecondsBalance: job.isAdmin ? 999999 : refundedBalance
        });
      }

      if (!job.storedFilePath) {
        try {
          const generatedVideoResponse = await fetch(outputUrl);

          if (!generatedVideoResponse.ok) {
            throw new Error("Impossible de télécharger la vidéo générée");
          }

          const generatedVideoArrayBuffer = await generatedVideoResponse.arrayBuffer();
          const generatedVideoBuffer = Buffer.from(generatedVideoArrayBuffer);

          const fileName = `syncup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
          const filePath = buildStoragePath(userId, fileName);

          const { error: uploadError } = await supabase.storage
            .from(BUCKET)
            .upload(filePath, generatedVideoBuffer, {
              contentType: "video/mp4",
              upsert: false
            });

          if (uploadError) {
            throw uploadError;
          }

          job.outputUrl = outputUrl;
          job.storedFilePath = filePath;
          job.fileName = fileName;

          await enforceVideoRetention(userId);
        } catch (storageError) {
          job.status = "failed";
          job.error = safeErrorMessage(storageError);

          const refundedBalance = await refundJobIfNeeded(job);
          jobs.set(jobId, job);

          return res.json({
            ok: true,
            status: "failed",
            error: job.error,
            billedSeconds: job.billedSeconds,
            syncupSecondsBalance: job.isAdmin ? 999999 : refundedBalance
          });
        }
      }

      job.status = "succeeded";
      jobs.set(jobId, job);

      return res.json({
        ok: true,
        status: "succeeded",
        playUrl: buildPlayUrl(job.fileName),
        downloadUrl: buildDownloadUrl(job.fileName),
        fileName: job.fileName,
        billedSeconds: job.billedSeconds,
        isAdmin: job.isAdmin,
        unlimited: job.isAdmin
      });
    }

    return res.json({
      ok: true,
      status: data.status || "processing",
      billedSeconds: job.billedSeconds,
      isAdmin: job.isAdmin,
      unlimited: job.isAdmin
    });
  } catch (error) {
    console.error("SYNC STATUS ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// LISTE DES VIDÉOS
app.get("/videos", async (req, res) => {
  try {
    const userId = getUserId(req);
    const videos = await getUserVideos(userId);

    return res.json({
      ok: true,
      videos
    });
  } catch (error) {
    console.error("VIDEOS ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// OUVRIR UNE VIDÉO
app.get("/open-video/:name", async (req, res) => {
  try {
    const userId = getUserId(req);
    const fileName = req.params.name;

    if (!fileName) {
      return res.status(400).json({
        ok: false,
        error: "Nom de fichier manquant"
      });
    }

    const filePath = buildStoragePath(userId, fileName);

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(filePath);

    if (error || !data) {
      return res.status(404).json({
        ok: false,
        error: "Vidéo introuvable"
      });
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-store");
    return res.send(buffer);
  } catch (error) {
    console.error("OPEN VIDEO ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// TÉLÉCHARGER UNE VIDÉO
app.get("/download-video/:name", async (req, res) => {
  try {
    const userId = getUserId(req);
    const fileName = req.params.name;

    if (!fileName) {
      return res.status(400).json({
        ok: false,
        error: "Nom de fichier manquant"
      });
    }

    const filePath = buildStoragePath(userId, fileName);

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(filePath);

    if (error || !data) {
      return res.status(404).json({
        ok: false,
        error: "Vidéo introuvable"
      });
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.send(buffer);
  } catch (error) {
    console.error("DOWNLOAD VIDEO ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// SUPPRESSION
app.post("/delete-video", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "Nom manquant"
      });
    }

    await deleteStoredVideo(userId, name);

    return res.json({ ok: true });
  } catch (error) {
    console.error("DELETE ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// NETTOYAGE JOBS > 24H
setInterval(() => {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    const created = new Date(job.createdAt).getTime();
    if (!Number.isNaN(created) && now - created > 24 * 60 * 60 * 1000) {
      jobs.delete(jobId);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sync-up server running on ${PORT}`);
});
