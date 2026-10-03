#!/usr/bin/env python3
"""
BridgeClip Bridge Runner

Thin bridge between Electron and BridgeClip clipping engine.
Accepts a JSON config on stdin, runs the pipeline in LOCAL_MODE,
and streams structured JSON-line progress to stdout for Electron to consume.

Usage:
    python bridge_runner.py < job-config.json
"""

import asyncio
import json
import logging
import os
import shutil
import sys
import threading
import time
import re
import uuid
from urllib.parse import urlsplit

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("bridge_runner")

# Protocol stream set by reserve_stdout_for_protocol(); tests use sys.stdout.
_protocol = None

# Aggregated download progress is updated from huggingface_hub's tqdm bars.
_progress_lock = threading.Lock()

# Mirrors DURATION_OPTIONS in src/shared/job-contract.ts.
DURATION_RANGE_IDS = ("xshort", "short", "medium", "long", "xlong", "extended", "feature")

# Known failure classes -> (message, hint). Raw engine errors can contain
# request URLs, proxy credentials and local paths, so only these fixed strings
# reach the UI. First match wins.
FAILURES = (
    (("selected planner requires a video with speech",),
     "The selected planning model cannot analyze a video without speech.",
     "Choose a planning model that supports silent-video planning in Advanced mode, or use Quality or Economy."),
    (("unsupported twitch source",),
     "Choose a public, completed Twitch VOD.",
     "Copy the video link from a saved Twitch video. Live channels, collections and Twitch clips are not supported."),
    (("twitch vod is not completed",),
     "This Twitch video is still live or processing.",
     "Wait until the broadcast has ended and its saved video is ready, then retry."),
    (("twitch vod duration is invalid or too long",),
     "This Twitch video has no usable duration or exceeds the six hour limit.",
     "Choose a completed video under six hours, or trim a downloaded file before adding it."),
    (("twitch vod unavailable",),
     "The Twitch VOD could not be downloaded.",
     "Check that the saved video plays while signed out. Deleted, expired and subscriber-only videos are not supported. You can also use a local file."),
    (("not enough disk space to save clips",),
     "There is not enough free disk space to finish this video.",
     "Free space on your startup disk and the output drive, then retry. Source videos can use several GB while clipping."),
    (("transcription authentication failed",),
     "OpenRouter rejected the transcription request.",
     "Check the OpenRouter API key in Settings."),
    (("transcription providers are temporarily rate limited",),
     "Transcription providers are busy after automatic recovery attempts.",
     "Wait a few minutes, then run again. If this persists, check the OpenRouter account's rate limits."),
    (("transcription account credit limit reached",),
     "OpenRouter could not transcribe the video because the account has insufficient credit or a spending limit.",
     "Check the OpenRouter balance and API key spending limit, then run again."),
    (("transcription quota or rate limit reached",),
     "OpenRouter could not transcribe the video because its quota or rate limit was reached.",
     "Check the OpenRouter account, then retry later."),
    (("transcription service unavailable",),
     "OpenRouter could not be reached for transcription.",
     "Check your connection and retry."),
    (("transcription request rejected by provider",),
     "OpenRouter rejected the transcription audio request.",
     "The selected model may not support WAV audio and word timestamps. In Advanced mode, choose a timestamp-capable model such as Whisper Large V3 or MAI Transcribe 2."),
    (("transcription response lacked word timestamps",),
     "OpenRouter returned a transcript without word timestamps.",
     "Choose a transcription model with word timestamps in Advanced mode, such as Whisper Large V3 or MAI Transcribe 2, or retry using a preset."),
    (("transcription response was invalid", "transcription response was too large"),
     "OpenRouter returned an unusable transcription response.",
     "Retry the run. If it persists, report this run so the provider response can be investigated."),
    (("audio extraction failed", "audio duration could not be determined", "transcription audio preparation failed"),
     "BridgeClip could not prepare this video's audio for transcription.",
     "Run Settings → System check. If the tools are ready, report this run with its failure code."),
    (("transcription audio chunk exceeded the size limit",),
     "The transcription audio exceeded BridgeClip's size limit.",
     "Set a shorter start and end time, or report this run so the chunk size can be adjusted."),
    (("transcription failed",),
     "Audio transcription failed.",
     "Check that the video has a playable audio track, then retry."),
    (("video render failed",),
     "Clip rendering failed.",
     "Run Settings → System check. If all tools are ready, report this run so the render can be diagnosed."),
    (("http error 403", "sign in to confirm", "blocking this request"),
     "The video service refused the download.",
     "Update BridgeClip and retry. If it keeps happening, download the video yourself and clip it as a local file."),
    (("video unavailable", "private video", "members-only", "has been removed", "not available in your country"),
     "This video is private, removed or unavailable in your region.",
     "Check the link opens in a signed-out browser window, or clip a local file instead."),
    (("exceeds maximum allowed duration",),
     "This video is longer than BridgeClip can process.",
     "Choose a shorter source video, or trim a downloaded file before adding it."),
    (("insufficient credits for jev review",),
     "OpenRouter ran out of credits during Jev review; no clips were exported.",
     "Add OpenRouter credits or raise your key's limit, then re-run. To clip without review, turn off Jev review in Settings → TypeSafe Jev."),
    (("jev review was unavailable for every candidate",),
     "Jev review was unavailable, so no clips were exported.",
     "This does not mean the video has no suitable clips. Retry later, or turn off Jev review in Settings → TypeSafe Jev and re-run to clip without it."),
    (("review could not finish",),
     "Clip review could not finish; no clips were exported.",
     "A review or repair response was incomplete, unavailable, or hit a limit. This does not mean the video has no suitable clips. Inspect transcript & edits in Jobs for the failed requests, then retry."),
    (("no clips passed the coherence review", "clip omitted:"),
     "No clips passed the coherence review.",
     "Inspect transcript & edits in Jobs to see which context, ending, title or cut checks failed. No clip was forced."),
    (("no moments matched the clip request",),
     "No moments matched what you asked to clip.",
     "Try describing it more broadly, or leave What to clip blank to get the best moments. Inspect transcript & edits in Jobs shows the planner's explanation."),
    (("the planner returned no clip candidates",),
     "The planner returned no clip candidates.",
     "Open Inspect transcript & edits in Jobs and check the planner response for its explanation. The video may still contain suitable clips; this is not a rendering or system-check failure."),
    (("playlist or channel",),
     "This link is a playlist or channel, not a single video.",
     "Paste the link of one video."),
    (("duration is unavailable", "video is live or upcoming"),
     "This video is live or not yet available.",
     "Wait until the stream has ended and the saved video is ready, then retry."),
    (("no clip-worthy moments",),
     "BridgeClip couldn't find any clips in this video.",
     "No clear spoken or visual moment met the selected clip length. If you set a start and end time, widen it or pick a shorter clip length."),
    (("out of credits", "quota exceeded"),
     "Your OpenRouter key is out of credits.",
     "Add credits at openrouter.ai/credits or raise the key's limit at openrouter.ai/keys."),
    (("(401)", "status_code: 401", "unauthorized", "invalid api key", "invalid_api_key"),
     "An API key was rejected.",
     "Check your OpenRouter key in Settings."),
    (("timed out", "connection", "name resolution", "network is unreachable"),
     "A network request failed.",
     "Check your internet connection and retry."),
    (("video download failed",),
     "The video could not be downloaded.",
     "Check the link opens in a browser and your connection works, then retry. You can also clip a local file instead."),
)


def describe_failure(error: object) -> dict:
    """Map an engine error to a safe, actionable message and hint."""
    text = str(error or "").lower()
    for markers, message, hint in FAILURES:
        if any(marker in text for marker in markers):
            return {"message": message, "hint": hint}
    return {"message": "The clipping pipeline failed.", "hint": "Check System check and retry. If it persists, report the steps that reproduce it."}


def reserve_stdout_for_protocol() -> None:
    """Keep stdout for JSON lines and send all other output to stderr.

    yt-dlp progress bars and FFmpeg children write to stdout. A partial line
    (no newline) glues itself to the next JSON message, and Electron then
    drops that message as non-JSON.
    """
    global _protocol
    _protocol = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)


def emit(msg: dict) -> None:
    """Write a JSON line to the protocol stream for Electron to read."""
    stream = _protocol or sys.stdout
    stream.write(json.dumps(msg) + "\n")
    stream.flush()


def progress_callback(progress) -> None:
    """Forward pipeline progress as JSON-line."""
    emit({
        "type": "progress",
        "status": progress.status.value if hasattr(progress.status, 'value') else str(progress.status),
        "percent": progress.progress_percent,
        "step": progress.current_step,
        "clips_done": progress.clips_completed,
        "clips_total": progress.total_clips,
        "stages": getattr(progress, "stages", None),
        "diagnostics": getattr(progress, "diagnostics", None),
    })


def validate_download_config(config: object) -> dict:
    """Reject malformed model downloads before importing anything or writing files.

    The catalog lives in the app, so the bridge requires a fully specified
    request: model id, repository, pinned revision and absolute target folder.
    """
    if not isinstance(config, dict) or config.get("command") != "download_model":
        raise ValueError("Unsupported bridge command")
    model_id = config.get("model_id")
    if not isinstance(model_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", model_id):
        raise ValueError("Invalid model id")
    repo = config.get("repo")
    if not isinstance(repo, str) or len(repo) > 200 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", repo):
        raise ValueError("Invalid model repository")
    revision = config.get("revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Invalid model revision")
    model_dir = config.get("model_dir")
    if not isinstance(model_dir, str) or not os.path.isabs(model_dir) or "\0" in model_dir or len(model_dir) > 1024:
        raise ValueError("Invalid model directory")
    approx = config.get("approx_size_mb")
    if type(approx) is not int or not 1 <= approx <= 200000:
        raise ValueError("Invalid model size")
    return config


def _aggregate_tqdm(total_bytes: int):
    """One percentage from huggingface_hub's per-file tqdm bars."""
    from tqdm.auto import tqdm as _tqdm

    class AggregateTqdm(_tqdm):
        _done = 0.0
        _reported = -1

        def update(self, n=1):
            before = float(getattr(self, "n", 0) or 0)
            result = super().update(n)
            after = float(getattr(self, "n", 0) or 0)
            delta = max(0.0, after - before)
            if delta <= 0 or total_bytes <= 0:
                return result
            with _progress_lock:
                AggregateTqdm._done += delta
                percent = min(99, int(AggregateTqdm._done / total_bytes * 100))
                if percent > AggregateTqdm._reported:
                    AggregateTqdm._reported = percent
                    emit({"type": "progress", "status": "downloading", "percent": percent,
                          "bytes_done": int(AggregateTqdm._done), "bytes_total": total_bytes,
                          "step": "Downloading model files..."})
            return result

    return AggregateTqdm


def _download_total_bytes(repo: str, revision: str) -> int:
    """Total snapshot size from the Hub, or 0 when it cannot be read."""
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(repo, revision=revision, files_metadata=True)
        return sum(int(getattr(sibling, "size", 0) or 0) for sibling in (info.siblings or []))
    except Exception:
        return 0


async def run_model_download(config: dict) -> bool:
    """Download one catalog model into a temp sibling folder, then rename it.

    This is its own short-lived bridge process: it never touches the clipping
    queue, and cancelling kills it exactly like a job cancel does.
    """
    config = validate_download_config(config)
    from network_guard import install as install_network_guard
    install_network_guard()
    from clip_engine.logging_safety import install_safe_logging
    install_safe_logging()

    model_id = config["model_id"]
    repo = config["repo"]
    revision = config["revision"]
    model_dir = config["model_dir"]
    parent = os.path.dirname(model_dir)
    os.makedirs(parent, mode=0o700, exist_ok=True)
    required = int(int(config["approx_size_mb"]) * 1.3 * 1024 * 1024)
    try:
        free = shutil.disk_usage(parent).free
    except OSError:
        free = required
    if free < required:
        emit({"type": "error", "message": "Not enough free disk space to download this model."})
        return False

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        emit({"type": "error", "message": "The local transcription runtime is not installed.",
              "code": "local_runtime_missing"})
        return False

    staging = f"{model_dir}.downloading-{uuid.uuid4().hex[:8]}"
    total_bytes = await asyncio.to_thread(_download_total_bytes, repo, revision)
    emit({"type": "progress", "status": "downloading", "percent": 0,
          "bytes_done": 0, "bytes_total": total_bytes, "step": "Downloading model files..."})
    try:
        if os.path.exists(staging):
            shutil.rmtree(staging, ignore_errors=True)
        try:
            await asyncio.to_thread(
                snapshot_download,
                repo_id=repo, revision=revision, local_dir=staging,
                tqdm_class=_aggregate_tqdm(total_bytes),
            )
        except TypeError:
            # Older huggingface_hub builds do not accept a tqdm class.
            await asyncio.to_thread(snapshot_download, repo_id=repo, revision=revision, local_dir=staging)
        if not os.path.isdir(staging) or not os.listdir(staging):
            raise RuntimeError("empty download")
        if os.path.exists(model_dir):
            shutil.rmtree(model_dir)
        os.rename(staging, model_dir)
    except Exception:
        logger.error("Model download failed (%s)", model_id)
        shutil.rmtree(staging, ignore_errors=True)
        emit({"type": "error", "message": "The model download failed. Check your connection and try again."})
        return False
    emit({"type": "result", "status": "completed", "model_id": model_id, "model_dir": model_dir})
    return True


async def run(config: dict) -> bool:
    """Run the clipping pipeline with the given config."""
    config = validate_config(config)
    # Configure before BridgeClip imports: settings are cached by the engine.
    os.environ["LOCAL_MODE"] = "true"
    if config.get("output_dir"):
        os.environ["LOCAL_OUTPUT_DIR"] = config["output_dir"]
    # Downloads use the user's own connection. A developer's BridgeClip .env can
    # hold the server's proxy pool, and environment variables beat .env values.
    os.environ["YTDLP_PROXIES"] = ""
    os.environ["YTDLP_PROXY"] = ""
    # yt-dlp otherwise imports plugin code from config folders, including
    # /etc/yt-dlp, which Windows resolves to C:\etc (creatable by any user).
    os.environ["YTDLP_NO_PLUGINS"] = "1"
    os.environ["LAYOUT_VISION_ENABLED"] = "true" if config["layout_vision_enabled"] else "false"
    os.environ["CLIPPING_MODE"] = config.get("clipping_mode", "quality")
    # Local transcription never calls a provider for audio, and a downloaded
    # model is used offline: no Hugging Face metadata or fallback lookups.
    os.environ["TRANSCRIPTION_PROVIDER"] = config.get("transcription_provider", "openrouter")
    if config.get("transcription_provider") == "local":
        os.environ["LOCAL_TRANSCRIPTION_MODEL_ID"] = config["local_transcription_model_id"]
        os.environ["LOCAL_TRANSCRIPTION_MODEL_DIR"] = config["local_transcription_model_dir"]
        os.environ["LOCAL_TRANSCRIPTION_BACKEND"] = config["local_transcription_backend"]
        os.environ["LOCAL_TRANSCRIPTION_DEVICE"] = config["local_transcription_device"]
        os.environ["LOCAL_TRANSCRIPTION_COMPUTE_TYPE"] = config["local_transcription_compute_type"]
        os.environ["HF_HUB_OFFLINE"] = "1"
    # Clip planning source, resolved by the desktop from saved settings. The
    # default keeps the existing OpenRouter path; anything else uses one
    # OpenAI-compatible provider (OpenCode Zen/Go, a custom endpoint or a local
    # server). The provider key arrives only through the worker environment.
    planning_provider = config.get("planning_provider", "openrouter")
    os.environ["PLANNING_SOURCE"] = config.get("planning_source", "cloud")
    os.environ["PLANNING_PROVIDER"] = planning_provider
    if planning_provider != "openrouter":
        os.environ["PLANNING_BASE_URL"] = config["planning_base_url"]
        os.environ["PLANNING_MODEL_ID"] = config["planning_model_id"]
    if planning_provider == "local":
        os.environ["PLANNING_LOCAL_HOST"] = config["planning_local_host"]
        os.environ["PLANNING_LOCAL_PORT"] = str(config["planning_local_port"])
        os.environ["PLANNING_CONTEXT_TOKENS"] = str(config.get("planning_context_tokens", 8192))

    if config.get("clipping_mode", "quality") == "economy":
        # Each job has its own bridge process, so model choices cannot leak to
        # another queued or concurrent run. Do not fall back to higher-cost planners.
        os.environ["PLANNER_MODEL"] = "z-ai/glm-5.3-flash"
        os.environ["EDITORIAL_REPAIR_MODEL"] = "google/gemini-3.8-flash"
        os.environ["PLANNER_FALLBACK_MODELS"] = ""
        os.environ["LAYOUT_VISION_ENABLED"] = "false"
    elif config.get("clipping_mode") == "advanced":
        os.environ["PLANNER_MODEL"] = config["planner_model"]
        os.environ["PLANNER_FALLBACK_MODELS"] = ""
        os.environ["ADVANCED_TRANSCRIPTION_MODEL"] = config["transcription_model"]
        os.environ["PLANNER_MAX_OUTPUT_TOKENS"] = str(config.get("planner_max_output_tokens", 32000))
        os.environ["PLANNER_SUPPORTS_IMAGES"] = str(config.get("planner_supports_images", False)).lower()
        for name in ("planner_input_price", "planner_output_price"):
            if config.get(name) is not None:
                os.environ[name.upper()] = str(config[name])

    from network_guard import install as install_network_guard
    install_network_guard()

    from clip_engine.logging_safety import install_safe_logging
    install_safe_logging()

    from clip_engine.bridge_contract import BRIDGE_CONTRACT_VERSION
    if config["contract_version"] != BRIDGE_CONTRACT_VERSION:
        emit({"type": "error", "message": "The bundled clipping engine is incompatible with this BridgeClip version."})
        return False

    from clip_engine.config import get_settings, get_caption_preset
    from clip_engine.services.ai_clipping_pipeline import (
        AIClippingPipeline,
        ClippingJobRequest,
        JobStatus,
    )

    settings = get_settings()

    missing = []
    # OpenRouter planning and Jev review need the OpenRouter key. Local,
    # OpenCode and custom planning do not.
    if not settings.openrouter_api_key and (planning_provider == "openrouter" or settings.jev_enabled):
        missing.append("OPENROUTER_API_KEY")
    if missing:
        emit({"type": "error", "message": f"Missing required API keys: {', '.join(missing)}"})
        return False

    caption_style = None
    preset_name = config.get("caption_preset", "pop")
    if config.get("include_captions", True):
        try:
            caption_style = get_caption_preset(preset_name)
        except ValueError:
            try:
                caption_style = get_caption_preset("pop")
            except ValueError:
                pass

    duration_ranges = config.get("duration_ranges")

    video_source = config.get("video_url", "")
    if os.path.isfile(video_source):
        video_source = os.path.abspath(video_source)

    request = ClippingJobRequest(
        video_url=video_source,
        workflow=config.get('workflow', 'automatic'),
        caption_preset=preset_name,
        job_id=config.get("job_id"),
        max_clips=config.get("max_clips"),
        auto_clip_count=config.get("auto_clip_count", True),
        duration_ranges=duration_ranges,
        aspect_ratio=config.get("aspect_ratio", "9:16"),
        layout_style=config.get("layout_style") or "auto",
        debug_capture=config.get("debug_capture", False),
        pacing=config.get("pacing") or "tight",
        video_speed=config.get("video_speed", 1.0),
        include_captions=config.get("include_captions", True),
        caption_style=caption_style,
        include_title=config.get("include_title", True),
        start_time_seconds=config.get("start_time_seconds"),
        end_time_seconds=config.get("end_time_seconds"),
        banner_platform=config.get("banner_platform"),
        banner_channel_url=config.get("banner_channel_url"),
        keyterms=config.get("keyterms") or None,
        clip_request=config.get("clip_request"),
    )

    emit({
        "type": "progress",
        "status": "pending",
        "percent": 0,
        "step": "Starting pipeline...",
        "clips_done": 0,
        "clips_total": 0,
    })

    pipeline = AIClippingPipeline(progress_callback=progress_callback)
    start = time.monotonic()
    result = await pipeline.process_video(request)
    elapsed = time.monotonic() - start

    if result.status == JobStatus.COMPLETED and result.output:
        from dataclasses import asdict
        output_data = asdict(result.output)
        emit({
            "type": "result",
            "status": "completed",
            "job_id": result.job_id,
            "processing_time_seconds": elapsed,
            "output": output_data,
        })
        return True
    failure_code = getattr(result, "failure_code", None)
    failure_stage = getattr(result, "failure_stage", None)
    http_status = getattr(result, "http_status", None)
    diagnostic = {}
    if isinstance(failure_code, str) and re.fullmatch(r"[a-z]+(?:[._][a-z]+)*", failure_code) and len(failure_code) <= 64:
        diagnostic["code"] = failure_code
    if failure_stage in {"setup", "download", "transcription", "planning", "rendering", "saving", "uploading"}:
        diagnostic["stage"] = failure_stage
    if type(http_status) is int and 100 <= http_status <= 599:
        diagnostic["http_status"] = http_status
    emit({"type": "error", **describe_failure(result.error), **diagnostic})
    return False


LOOPBACK_PLANNING_HOSTS = {"127.0.0.1", "::1", "localhost"}
PLANNING_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}")


def _validate_planning_config(config: dict) -> bool:
    """Validate the resolved planning stage.

    Built-in providers must use their documented host, a local server must be
    plain http on loopback, and a custom endpoint must be https. Anything else
    is rejected here as well as by the socket guard.
    """
    source = config.get("planning_source", "cloud")
    provider = config.get("planning_provider", "openrouter")
    if source not in ("cloud", "local"):
        return False
    if provider not in ("openrouter", "opencode-zen", "opencode-go", "custom", "local"):
        return False
    if provider == "openrouter":
        return source == "cloud" and not any(
            field in config for field in (
                "planning_base_url", "planning_model_id", "planning_local_host",
                "planning_local_port", "planning_context_tokens",
            )
        )
    model_id = config.get("planning_model_id")
    if not isinstance(model_id, str) or not PLANNING_MODEL_ID.fullmatch(model_id):
        return False
    base = config.get("planning_base_url")
    if not isinstance(base, str) or not base or len(base) > 512 or "\0" in base:
        return False
    try:
        url = urlsplit(base)
    except ValueError:
        return False
    if url.username or url.password or not url.hostname:
        return False
    if provider == "local":
        if source != "local" or url.scheme != "http":
            return False
        if (url.hostname or "").lower() not in LOOPBACK_PLANNING_HOSTS:
            return False
        try:
            port = url.port
        except ValueError:
            return False
        if port is None or not 1 <= port <= 65535:
            return False
        if config.get("planning_local_host") != url.hostname or config.get("planning_local_port") != port:
            return False
        tokens = config.get("planning_context_tokens")
        if type(tokens) is not int or not 1024 <= tokens <= 1048576:
            return False
        return True
    if source != "cloud" or url.scheme != "https":
        return False
    if provider == "opencode-zen":
        return url.geturl().rstrip("/") == "https://opencode.ai/zen/v1"
    if provider == "opencode-go":
        return url.geturl().rstrip("/") == "https://opencode.ai/zen/go/v1"
    # Custom: an https host; the socket guard checks the resolved address.
    return bool(url.hostname)


def validate_config(config: object) -> dict:
    """Reject malformed bridge requests before loading the engine or writing files."""
    if not isinstance(config, dict):
        raise ValueError("Config must be a JSON object")
    if type(config.get("contract_version")) is not int or config["contract_version"] != 3:
        raise ValueError("Unsupported clipping engine contract version")
    if type(config.get("layout_vision_enabled")) is not bool:
        raise ValueError("layout_vision_enabled must be a boolean")
    job_id = config.get("job_id")
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id):
        raise ValueError("A valid job_id is required")
    source = config.get("video_url")
    if not isinstance(source, str) or not source.strip() or len(source) > 8192:
        raise ValueError("A video source is required")
    if not os.path.isfile(source):
        try:
            url = urlsplit(source)
            if url.scheme not in ("https", "http") or not url.hostname or url.username or url.password:
                raise ValueError()
        except ValueError:
            raise ValueError("Video source must be a local file or HTTP(S) URL") from None
    output = config.get("output_dir")
    if output is not None and (not isinstance(output, str) or not os.path.isabs(output) or "\0" in output):
        raise ValueError("Output directory must be an absolute path")
    for field in ("include_captions", "include_title", "auto_clip_count", "layout_vision_enabled", "debug_capture"):
        if field in config and not isinstance(config[field], bool):
            raise ValueError(f"{field} must be a boolean")
    if config.get('workflow', 'automatic') not in ('automatic', 'review'):
        raise ValueError('Invalid workflow')
    count = config.get("max_clips")
    if count is not None and (type(count) is not int or not 1 <= count <= 100):
        raise ValueError("max_clips must be between 1 and 100")
    if config.get("aspect_ratio", "9:16") not in ("9:16", "16:9"):
        raise ValueError("Invalid aspect ratio")
    if config.get("layout_style", "auto") not in ("auto", "fill", "fit"):
        raise ValueError("Invalid layout style")
    if config.get("pacing", "tight") not in ("tight", "natural"):
        raise ValueError("Invalid pacing")
    speed = config.get("video_speed", 1.0)
    if type(speed) not in (int, float) or not 1 <= speed <= 2:
        raise ValueError("Video speed must be between 1x and 2x")
    if config.get("clipping_mode", "quality") not in ("quality", "economy", "advanced"):
        raise ValueError("Invalid clipping mode")
    if config.get("transcription_provider", "openrouter") not in ("openrouter", "local"):
        raise ValueError("Invalid transcription provider")
    if not _validate_planning_config(config):
        raise ValueError("Invalid planning configuration")
    if config.get("transcription_provider") == "local":
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", str(config.get("local_transcription_model_id") or "")):
            raise ValueError("Invalid local transcription model")
        model_dir = config.get("local_transcription_model_dir")
        if not isinstance(model_dir, str) or not os.path.isabs(model_dir) or "\0" in model_dir or len(model_dir) > 1024:
            raise ValueError("Invalid local transcription model directory")
        if config.get("local_transcription_backend") not in ("faster-whisper", "onnx-parakeet"):
            raise ValueError("Invalid local transcription backend")
        if config.get("local_transcription_device") not in ("cuda", "cpu"):
            raise ValueError("Invalid local transcription device")
        if config.get("local_transcription_compute_type") not in ("float16", "int8"):
            raise ValueError("Invalid local transcription compute type")
    for field in ("planner_model", "transcription_model"):
        if config.get("clipping_mode") == "advanced":
            value = config.get(field)
            if not isinstance(value, str) or len(value) > 120 or not re.fullmatch(r"~?[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*", value):
                raise ValueError("Choose both models in Advanced mode")
        elif field in config:
            raise ValueError("Custom models require Advanced mode")
    if "planner_max_output_tokens" in config and (type(config["planner_max_output_tokens"]) is not int or not 1 <= config["planner_max_output_tokens"] <= 32000):
        raise ValueError("Invalid planner output limit")
    if "planner_supports_images" in config and type(config["planner_supports_images"]) is not bool:
        raise ValueError("Invalid planner image capability")
    for field in ("planner_input_price", "planner_output_price"):
        value = config.get(field)
        if value is not None and (type(value) not in (int, float) or not 0 <= value <= 1000):
            raise ValueError("Invalid planner price")
    keyterms = config.get("keyterms")
    if keyterms is not None and (
        not isinstance(keyterms, list) or len(keyterms) > 1000 or
        any(not isinstance(term, str) or not term.strip() or len(term) > 49 for term in keyterms)
    ):
        raise ValueError("Invalid keyterms")
    clip_request = config.get("clip_request")
    if clip_request is not None and (
        not isinstance(clip_request, str) or not clip_request.strip() or len(clip_request) > 1000 or "\0" in clip_request
    ):
        raise ValueError("Invalid clip request")
    ranges = config.get("duration_ranges")
    if ranges is not None and (
        not isinstance(ranges, list) or len(ranges) > len(DURATION_RANGE_IDS) or
        any(item not in DURATION_RANGE_IDS for item in ranges)
    ):
        raise ValueError("Invalid clip duration")
    return config


def main() -> int:
    if len(sys.argv) > 2:
        emit({"type": "error", "message": "Pass JSON config on stdin."})
        return 1
    try:
        # Legacy CLI argument remains accepted; Electron uses stdin to keep
        # private source URLs out of process listings. Bound either transport.
        raw = sys.argv[1] if len(sys.argv) == 2 else sys.stdin.read(65537)
        if len(raw) > 65536:
            raise ValueError("Config too large")
        config = json.loads(raw)
        if isinstance(config, dict) and config.get("command") == "download_model":
            try:
                return 0 if asyncio.run(run_model_download(config)) else 1
            except KeyboardInterrupt:
                emit({"type": "error", "message": "Model download cancelled"})
                return 130
        config = validate_config(config)
    except (ValueError, TypeError):
        emit({"type": "error", "message": "Invalid clipping configuration."})
        return 1
    try:
        return 0 if asyncio.run(run(config)) else 1
    except KeyboardInterrupt:
        emit({"type": "error", "message": "Pipeline cancelled by user"})
        return 130
    except Exception as error:
        # Provider exceptions can include request URLs, credentials and local paths.
        logger.error("Bridge runner failed (%s)", type(error).__name__)
        emit({"type": "error", "message": "The clipping engine failed. Check your setup and retry."})
        return 1


if __name__ == "__main__":
    reserve_stdout_for_protocol()
    sys.exit(main())
