import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post("/generate", async (req, res) => {
  try {
    const { video_url, audio_url } = req.body;

    const { data, error } = await supabase
      .from("jobs")
      .insert([
        {
          status: "pending",
          engine: "replicate"
        }
      ])
      .select()
      .single();

    if (error) throw error;

    const jobId = data.id;

    res.json({
      job_id: jobId,
      status: "processing"
    });

    // appel replicate
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        version: process.env.REPLICATE_MODEL,
        input: {
          video: video_url,
          audio: audio_url
        }
      })
    });

    const prediction = await response.json();

    let outputUrl = null;

    while (!outputUrl) {
      await new Promise(r => setTimeout(r, 5000));

      const check = await fetch(
        `https://api.replicate.com/v1/predictions/${prediction.id}`,
        {
          headers: {
            Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`
          }
        }
      );

      const result = await check.json();

      if (result.status === "succeeded") {
        outputUrl = result.output;
      }

      if (result.status === "failed") {
        throw new Error("replicate failed");
      }
    }

    await supabase
      .from("jobs")
      .update({
        status: "done",
        video_url: outputUrl
      })
      .eq("id", jobId);

  } catch (err) {
    console.error(err);
  }
});

app.get("/jobs/:id", async (req, res) => {
  const { id } = req.params;

  const { data } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .single();

  res.json(data);
});

app.listen(3000, () => {
  console.log("server running");
});
