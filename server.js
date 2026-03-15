import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import Replicate from "replicate";

const app = express();
const PORT = process.env.PORT || 3000;

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

const MODEL =
"xconda/sync-up:65f20c2c3f6c3cdd1d1a1dd8a6c87173ebe64906ee4bddf3ae7ba41d0a684325";

app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

function wait(ms){
  return new Promise(r=>setTimeout(r,ms));
}

function safeDelete(file){
  try{
    if(file && fs.existsSync(file)) fs.unlinkSync(file);
  }catch{}
}

async function download(url, out){
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  fs.writeFileSync(out, Buffer.from(buf));
}

app.get("/",(req,res)=>{
  res.json({
    status:"sync-up server running"
  });
});

app.post(
"/sync",
upload.fields([
{ name:"video",maxCount:1 },
{ name:"audio",maxCount:1 }
]),
async(req,res)=>{

const video=req.files?.video?.[0];
const audio=req.files?.audio?.[0];

let outputFile=null;

try{

if(!video||!audio){
return res.status(400).json({error:"video ou audio manquant"});
}

console.log("sync-up start");

const prediction=await replicate.predictions.create({
version:"65f20c2c3f6c3cdd1d1a1dd8a6c87173ebe64906ee4bddf3ae7ba41d0a684325",
input:{
video:fs.createReadStream(video.path),
audio:fs.createReadStream(audio.path),
guidance_scale:2,
inference_steps:20,
seed:0
}
});

let result=prediction;

while(
result.status!=="succeeded" &&
result.status!=="failed" &&
result.status!=="canceled"
){
await wait(2000);
result=await replicate.predictions.get(prediction.id);
console.log("status:",result.status);
}

if(result.status!=="succeeded"){
throw new Error("prediction failed");
}

let videoUrl=null;

if(typeof result.output==="string"){
videoUrl=result.output;
}
else if(Array.isArray(result.output)){
videoUrl=result.output[0];
}
else if(result.output?.url){
videoUrl=result.output.url();
}

if(!videoUrl){
throw new Error("aucune url retournée");
}

outputFile=path.join("uploads",`syncup_${Date.now()}.mp4`);

await download(videoUrl,outputFile);

safeDelete(video.path);
safeDelete(audio.path);

res.download(outputFile,"sync-up.mp4",()=>{
safeDelete(outputFile);
});

}catch(err){

console.error(err);

safeDelete(video?.path);
safeDelete(audio?.path);
safeDelete(outputFile);

res.status(500).json({
error:"sync-up error",
details:err.message
});
}
});

app.listen(PORT,()=>{
console.log("Sync-up server running on",PORT);
});
