from typing import Optional
import uuid
import modal
import os
import boto3
from pydantic import BaseModel
import requests

from prompts import LYRICS_GENERATOR_PROMPT, PROMPT_GENERATOR_PROMPT

app = modal.App("music-generator")

image = (
    modal.Image.debian_slim()
    .apt_install("git")
    .pip_install_from_requirements("requirements.txt")
    .run_commands(["git clone https://github.com/ace-step/ACE-Step.git /tmp/ACE-Step", "cd /tmp/ACE-Step && pip install .", "pip install git+https://github.com/huggingface/transformers.git"])
    .env({"HF_HOME": "/.cache/huggingface"})
    .add_local_python_source("prompts")
)

web_image = (
    modal.Image.debian_slim()
    .pip_install("fastapi[standard]", "pydantic", "boto3", "requests")
    .add_local_python_source("prompts")
)

model_volume = modal.Volume.from_name(
    "ace-step-models", create_if_missing=True)
hf_volume = modal.Volume.from_name("qwen-hf-cache", create_if_missing=True)

music_gen_secrets = modal.Secret.from_name("music-gen-secrets")


class AudioGenerationBase(BaseModel):
    audio_duration: float = 180.0
    seed: int = -1
    guidance_scale: float = 15.0
    infer_step: int = 60
    instrumental: bool = False


class GenerateFromDescriptionRequest(AudioGenerationBase):
    full_described_song: str


class GenerateWithCustomLyricsRequest(AudioGenerationBase):
    prompt: str
    lyrics: str


class GenerateWithDescribedLyricsRequest(AudioGenerationBase):
    prompt: str
    described_lyrics: str


class GenerateMusicResponseS3(BaseModel):
    s3_key: str
    cover_image_s3_key: str


class SubmitJobResponse(BaseModel):
    call_id: str


class JobStatusResponse(BaseModel):
    status: str  # "pending" | "done" | "failed"
    s3_key: Optional[str] = None
    cover_image_s3_key: Optional[str] = None
    error: Optional[str] = None


@app.cls(
    image=image,
    gpu="L40S",
    volumes={"/models": model_volume, "/.cache/huggingface": hf_volume},
    secrets=[music_gen_secrets],
    scaledown_window=15,
    timeout=900,
)
class MusicGenServer:
    @modal.enter()
    def load_model(self):
        from acestep.pipeline_ace_step import ACEStepPipeline
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from diffusers import AutoPipelineForText2Image
        import torch

        # Music Generation Model
        self.music_model = ACEStepPipeline(
            checkpoint_dir="/models",
            dtype="bfloat16",
            torch_compile=False,
            cpu_offload=False,
            overlapped_decode=False
        )

        # Large Language Model
        model_id = "Qwen/Qwen2-7B-Instruct"
        self.tokenizer = AutoTokenizer.from_pretrained(model_id)

        self.llm_model = AutoModelForCausalLM.from_pretrained(
            model_id,
            torch_dtype="auto",
            device_map="auto",
            cache_dir="/.cache/huggingface"
        )

        # Stable Diffusion Model (thumbnails)
        self.image_pipe = AutoPipelineForText2Image.from_pretrained(
            "stabilityai/sdxl-turbo", torch_dtype=torch.float16, variant="fp16", cache_dir="/.cache/huggingface")
        self.image_pipe.to("cuda")

    def prompt_qwen(self, question: str):
        messages = [
            {"role": "user", "content": question}
        ]
        text = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True
        )
        model_inputs = self.tokenizer(
            [text], return_tensors="pt").to(self.llm_model.device)

        generated_ids = self.llm_model.generate(
            model_inputs.input_ids,
            max_new_tokens=512
        )
        generated_ids = [
            output_ids[len(input_ids):] for input_ids, output_ids in zip(model_inputs.input_ids, generated_ids)
        ]

        response = self.tokenizer.batch_decode(
            generated_ids, skip_special_tokens=True)[0]

        return response

    def generate_prompt(self, description: str):
        # Insert description into template
        full_prompt = PROMPT_GENERATOR_PROMPT.format(user_prompt=description)

        # Run LLM inference and return that
        return self.prompt_qwen(full_prompt)

    def generate_lyrics(self, description: str):
        # Insert description into template
        full_prompt = LYRICS_GENERATOR_PROMPT.format(description=description)

        # Run LLM inference and return that
        return self.prompt_qwen(full_prompt)

    def generate_and_upload_to_s3(
            self,
            prompt: str,
            lyrics: str,
            instrumental: bool,
            audio_duration: float,
            infer_step: int,
            guidance_scale: float,
            seed: int,
    ) -> GenerateMusicResponseS3:
        final_lyrics = "[instrumental]" if instrumental else lyrics
        print(f"Generated lyrics: \n{final_lyrics}")
        print(f"Prompt: \n{prompt}")

        s3_client = boto3.client("s3")
        bucket_name = os.environ["S3_BUCKET_NAME"]

        output_dir = "/tmp/outputs"
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, f"{uuid.uuid4()}.wav")

        self.music_model(
            prompt=prompt,
            lyrics=final_lyrics,
            audio_duration=audio_duration,
            infer_step=infer_step,
            guidance_scale=guidance_scale,
            save_path=output_path,
            manual_seeds=str(seed)
        )

        audio_s3_key = f"{uuid.uuid4()}.wav"
        s3_client.upload_file(output_path, bucket_name, audio_s3_key)
        os.remove(output_path)

        # Thumbnail generation
        thumbnail_prompt = f"{prompt}, album cover art"
        image = self.image_pipe(
            prompt=thumbnail_prompt, num_inference_steps=2, guidance_scale=0.0).images[0]

        image_output_path = os.path.join(output_dir, f"{uuid.uuid4()}.png")
        image.save(image_output_path)

        image_s3_key = f"{uuid.uuid4()}.png"
        s3_client.upload_file(image_output_path, bucket_name, image_s3_key)
        os.remove(image_output_path)

        return GenerateMusicResponseS3(
            s3_key=audio_s3_key,
            cover_image_s3_key=image_s3_key,
        )

    @modal.method()
    def run_job(self, mode: str, payload: dict) -> dict:
        if mode == "description":
            request = GenerateFromDescriptionRequest(**payload)
            prompt = self.generate_prompt(request.full_described_song)
            lyrics = ""
            if not request.instrumental:
                lyrics = self.generate_lyrics(request.full_described_song)
            params = request.model_dump(exclude={"full_described_song"})
        elif mode == "lyrics":
            request = GenerateWithCustomLyricsRequest(**payload)
            prompt = request.prompt
            lyrics = request.lyrics
            params = request.model_dump(exclude={"prompt", "lyrics"})
        elif mode == "described_lyrics":
            request = GenerateWithDescribedLyricsRequest(**payload)
            prompt = request.prompt
            lyrics = ""
            if not request.instrumental:
                lyrics = self.generate_lyrics(request.described_lyrics)
            params = request.model_dump(exclude={"described_lyrics", "prompt"})
        else:
            raise ValueError(f"Unknown generation mode: {mode}")

        result = self.generate_and_upload_to_s3(
            prompt=prompt, lyrics=lyrics, **params)
        return result.model_dump()


# Lightweight CPU endpoints: they queue work on the GPU class and return immediately,
# so a request never blocks for the length of a generation.
def spawn_job(mode: str, payload: dict) -> SubmitJobResponse:
    call = MusicGenServer().run_job.spawn(mode, payload)
    return SubmitJobResponse(call_id=call.object_id)


@app.function(image=web_image)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
def generate_from_description(request: GenerateFromDescriptionRequest) -> SubmitJobResponse:
    return spawn_job("description", request.model_dump())


@app.function(image=web_image)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
def generate_with_lyrics(request: GenerateWithCustomLyricsRequest) -> SubmitJobResponse:
    return spawn_job("lyrics", request.model_dump())


@app.function(image=web_image)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
def generate_with_described_lyrics(request: GenerateWithDescribedLyricsRequest) -> SubmitJobResponse:
    return spawn_job("described_lyrics", request.model_dump())


@app.function(image=web_image)
@modal.fastapi_endpoint(method="GET", requires_proxy_auth=True)
def generation_status(call_id: str) -> JobStatusResponse:
    try:
        result = modal.FunctionCall.from_id(call_id).get(timeout=0)
    except (TimeoutError, modal.exception.TimeoutError):
        return JobStatusResponse(status="pending")
    except Exception as e:
        return JobStatusResponse(status="failed", error=str(e))

    return JobStatusResponse(status="done", **result)


@app.local_entrypoint()
def main():
    import time

    submit_url = generate_with_described_lyrics.get_web_url()
    status_url = generation_status.get_web_url()

    request_data = GenerateWithDescribedLyricsRequest(
        prompt="rave, funk, 140BPM, disco",
        described_lyrics="lyrics about water bottles",
        guidance_scale=15
    )

    headers = {
        "Modal-Key": os.environ.get("MODAL_KEY", ""),
        "Modal-Secret": os.environ.get("MODAL_SECRET", ""),
    }

    response = requests.post(
        submit_url, json=request_data.model_dump(), headers=headers, timeout=30)
    response.raise_for_status()
    call_id = SubmitJobResponse(**response.json()).call_id
    print(f"Submitted job: {call_id}")

    while True:
        time.sleep(10)
        response = requests.get(status_url, params={"call_id": call_id},
                                headers=headers, timeout=15)
        response.raise_for_status()
        status = JobStatusResponse(**response.json())
        print(f"Status: {status.status}")
        if status.status != "pending":
            break

    if status.status == "done":
        print(f"Success: {status.s3_key} {status.cover_image_s3_key}")
    else:
        print(f"Failed: {status.error}")
