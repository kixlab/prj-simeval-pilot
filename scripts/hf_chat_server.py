#!/usr/bin/env python3
"""OpenAI-compatible chat server for Hugging Face models.

Serves what scripts/agentDriver.mjs --provider local talks to:

  POST /v1/chat/completions   messages (text, and data-URL images), max_tokens,
                              temperature, top_p, seed
  GET  /v1/models

Prefer vLLM (`vllm serve <model>`) for any model it supports: it loads the same
Hugging Face weights and is much faster. This server is for models vLLM does
not run, and it needs only the standard library until a model is loaded.

  # a model from the hub or a local snapshot, through transformers' generic path
  python scripts/hf_chat_server.py --model Qwen/Qwen3-VL-2B-Thinking --port 8001

  # a model that needs its own loading code: the file defines load(model_path),
  # returning an object with generate(messages, params) -> text
  python scripts/hf_chat_server.py --adapter my_adapter.py --model /models/AndesVL --port 8004

  # no model at all - replies with --echo-reply, to check the HTTP contract
  python scripts/hf_chat_server.py --backend echo --echo-reply '{"tool":"submit_task"}' --port 8011

Replies are returned verbatim, thinking included: the driver reads the trace
from <think> spans itself, so nothing is stripped or rewritten here.
"""

import argparse
import base64
import importlib.util
import io
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def decode_image(url):
    """A data: URL to a PIL image. Remote URLs are refused: the driver never sends one."""
    if not url.startswith("data:"):
        raise ValueError("Only data: image URLs are accepted.")
    from PIL import Image

    payload = url.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")


def to_hf_messages(messages):
    """OpenAI chat messages to the content-part form transformers chat templates take."""
    converted = []
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            parts = [{"type": "text", "text": content}]
        else:
            parts = []
            for part in content or []:
                if part.get("type") == "text":
                    parts.append({"type": "text", "text": part.get("text", "")})
                elif part.get("type") == "image_url":
                    parts.append({"type": "image", "image": decode_image(part["image_url"]["url"])})
                else:
                    raise ValueError(f"Unsupported content part: {part.get('type')}")
        converted.append({"role": message["role"], "content": parts})
    return converted


class EchoBackend:
    """Runs the same message conversion a model gets, then answers with a fixed reply."""

    def __init__(self, reply):
        self.reply = reply

    def generate(self, messages, params):
        to_hf_messages(messages)
        return self.reply


class TransformersBackend:
    """The generic transformers path: one processor, one chat template, generate()."""

    def __init__(self, model_path, dtype, device_map):
        import torch
        from transformers import AutoModelForCausalLM, AutoModelForImageTextToText, AutoProcessor

        self.torch = torch
        self.processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
        kwargs = {"torch_dtype": dtype, "device_map": device_map, "trust_remote_code": True}
        try:
            self.model = AutoModelForImageTextToText.from_pretrained(model_path, **kwargs)
        except (ValueError, KeyError):
            # Text-only checkpoints have no image-text head.
            self.model = AutoModelForCausalLM.from_pretrained(model_path, **kwargs)
        self.model.eval()

    def generate(self, messages, params):
        torch = self.torch
        inputs = self.processor.apply_chat_template(
            to_hf_messages(messages),
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        ).to(self.model.device)
        options = {"max_new_tokens": params["max_tokens"]}
        if params["temperature"] > 0:
            options.update(do_sample=True, temperature=params["temperature"], top_p=params["top_p"])
        else:
            options.update(do_sample=False)
        if params.get("seed") is not None:
            torch.manual_seed(int(params["seed"]))
        with torch.inference_mode():
            output = self.model.generate(**inputs, **options)
        prompt_tokens = inputs["input_ids"].shape[1]
        new_tokens = output[0, prompt_tokens:]
        text = self.processor.decode(new_tokens, skip_special_tokens=True)
        finish = "length" if len(new_tokens) >= params["max_tokens"] else "stop"
        usage = {
            "prompt_tokens": int(prompt_tokens),
            "completion_tokens": int(len(new_tokens)),
            "total_tokens": int(prompt_tokens + len(new_tokens)),
        }
        return text, finish, usage


def load_adapter(path, model_path):
    spec = importlib.util.spec_from_file_location("hf_chat_adapter", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "load"):
        raise SystemExit(f"{path} must define load(model_path).")
    return module.load(model_path)


def make_handler(backend, served_name, max_tokens_cap):
    # One model on one device: generations run one at a time.
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def send_json(self, status, body):
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.rstrip("/") == "/v1/models":
                return self.send_json(200, {"object": "list", "data": [{"id": served_name, "object": "model"}]})
            self.send_json(404, {"error": {"message": f"Unknown endpoint: {self.path}"}})

        def do_POST(self):
            if self.path.rstrip("/") != "/v1/chat/completions":
                return self.send_json(404, {"error": {"message": f"Unknown endpoint: {self.path}"}})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                params = {
                    "max_tokens": min(int(body.get("max_tokens") or 4096), max_tokens_cap),
                    "temperature": float(body.get("temperature", 0.7)),
                    "top_p": float(body.get("top_p", 1.0)),
                    "seed": body.get("seed"),
                }
                started = time.time()
                with lock:
                    result = backend.generate(body.get("messages", []), params)
                text, finish, usage = result if isinstance(result, tuple) else (result, "stop", None)
            except ValueError as error:
                return self.send_json(400, {"error": {"message": str(error)}})
            except Exception as error:  # a failed generation must not take the server down
                return self.send_json(500, {"error": {"message": f"{type(error).__name__}: {error}"}})
            self.send_json(200, {
                "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
                "object": "chat.completion",
                "created": int(started),
                "model": served_name,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish}],
                "usage": usage,
            })

        def log_message(self, format, *args):
            print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {format % args}", flush=True)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", help="Hub id or local path of the model.")
    parser.add_argument("--served-name", help="Name reported in replies; defaults to --model.")
    parser.add_argument("--backend", choices=["transformers", "echo"], default="transformers")
    parser.add_argument("--adapter", help="Python file defining load(model_path) for a model with its own loading code.")
    parser.add_argument("--echo-reply", default='{"tool":"submit_task"}', help="The echo backend's reply.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--dtype", default="auto")
    parser.add_argument("--device-map", default="auto")
    parser.add_argument("--max-tokens-cap", type=int, default=32768, help="Upper bound on max_tokens per request.")
    args = parser.parse_args()

    if args.backend == "echo":
        backend = EchoBackend(args.echo_reply)
        served_name = args.served_name or "echo"
    else:
        if not args.model:
            raise SystemExit("--model is required unless --backend echo.")
        print(f"loading {args.model} ...", flush=True)
        backend = load_adapter(args.adapter, args.model) if args.adapter else TransformersBackend(args.model, args.dtype, args.device_map)
        served_name = args.served_name or args.model

    server = ThreadingHTTPServer((args.host, args.port), make_handler(backend, served_name, args.max_tokens_cap))
    print(f"serving {served_name} on http://{args.host}:{args.port}/v1/chat/completions", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
